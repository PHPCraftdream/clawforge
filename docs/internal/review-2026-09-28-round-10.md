# Ревью ClawForge, раунд 10 — после второго цикла доработок

Дата: 2026-09-28. База: `main` @ 4da64e5 (CI зелёный на Linux и Windows).
Предыдущее ревью: `docs/internal/review-2026-09-28-round-2.md` — его N1–N8, S1–S4 и решения
пользователя закрыты коммитами 5332c21…5072a92; устаревшие пути Windows-набора в `ci.yml`
исправлены в 4da64e5.

Метод: прогон CLI на временном развёртывании (`new-app r10-probe`, без bootstrap, удалено
после; на target ничего не создавалось), чтение кода `plan`, `watch`, хуков backup, парсера
аргументов, гейта и блокировки, сверка `docs/guide/` с поведением. Вывод, сделанный
рассуждением, а не воспроизведением, помечен «по коду».

Шкала: P1 — ломает основное обещание; P2 — неверное поведение в реальном сценарии; P3 —
шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| R1 | P2 | `plan` | «is what this repository declares — nothing to do» при `healthy: false`: 19 из 36 кодов проблем (10 блокирующих) не дают ни одного шага |
| R2 | P2 | блокировка | `--break-foreign-lock` принимают 9 команд, 7 других с той же блокировкой отвечают «unknown argument»; сообщение об отказе флаг не называет |
| R3 | P2 | `watch` | сбой доставки alert и ошибки конфигурации не оставляют следа: cron глушит вывод, `watch status` не показывает ни несвежесть, ни недоставленный alert; проверить webhook нечем |
| R4 | P2 | JSON | `status`, `secrets`, `verify` не знают `--json`; `expose status` и `recipe list` молча игнорируют его и печатают текст |
| R5 | P3 | argv | `expose status --bogus`, `recipe list --bogus extra` молча принимаются; `logs` передаёт лишние слова в `docker compose logs` как имена сервисов |
| R6 | P3 | help/docs | `control-mcp` нет в `./clawforge help`; строка `--app` не говорит «до команды»; в `docs/guide/commands.md` нет `set` и `exec` |
| R7 | P3 | help | значение любой опции печатается как `<value>`; рендер usage продублирован в `entry/cli.ts` и `integration/gate.ts` |
| R8 | P3 | argv | «unknown argument: --dry-run» без подсказки ближайшей опции и `--help`, в отличие от неизвестной команды |
| R9 | P3 | argv | `--set` — опция с артефактом у `plan`/`apply`/`accept`, но булев флаг у `rollback` |
| R10 | P3 | backup | нет списка архивов; `restore` без аргумента молча берёт новейший; копии `<data>.replaced-*` копятся без учёта и очистки |
| R11 | P3 | `watch` | alert только при смене уровня: `degraded` → `degraded` с новой причиной не сообщается |
| R12 | P3 | код | эфемерные ID ревью в комментариях: `R9-R1` в коде фреймворка, `N1`/`N2`/`B1`–`B9` в проверках |
| R13 | P3 | структура | `service/archive.ts` 696, `commands/lifecycle/smoke.ts` 696, `inspect/observe.ts` 682 из 700 строк |
| R14 | P3 | help | `details` у `incident`, `watch` и др. — абзацы по 1–2 тыс. символов одной строкой |
| R15 | P3 | CI | проверки `runtime/watch/{health,heartbeat,webhook}` не входят в Windows-набор |

## 2. Ошибки

### R1 (P2). `plan` говорит «nothing to do», когда проблемы есть

Воспроизведено: на развёртывании без bootstrap `./clawforge doctor` и `inspect` сообщают
блокирующую `NOT_BOOTSTRAPPED`, а `./clawforge plan` печатает
`r10-probe is what this repository declares — nothing to do` и выходит с 0.

Причина — `commands/orchestration/plan.ts`: `planActions()` строит шаги только для 17 кодов,
а `plan()` при пустом списке шагов печатает «nothing to do», не глядя на `healthy` и
`problems`. Без шага остаются (по `PROBLEM_CODES`):

- блокирующие: `NOT_BOOTSTRAPPED`, `GATEWAY_UNHEALTHY`, `SET_RECIPE_INCOMPLETE`,
  `SET_REFERENCE_BROKEN`, `SET_SCHEDULE_INVALID`, `SET_SECRET_UNDECLARED`,
  `SET_DECLARATION_INVALID`, `SET_IMAGE_UNPINNED`, `SECURITY_AUDIT_CRITICAL`,
  `GATEWAY_PUBLICLY_BOUND`;
- предупреждения: `EGRESS_UNREACHABLE`, `PROVIDER_MISSING`, `IMAGE_UNPINNED`,
  `IMAGE_TAG_MOVED`, `SET_REQUIREMENT_UNMET`, `SECURITY_AUDIT_WARN`,
  `GATEWAY_EXPOSURE_ACKNOWLEDGED`, `UFW_DOCKER_BYPASS`, `PRIVATE_FILE_INSECURE`.

`apply` этот случай уже обрабатывает (`apply.ts`: пустой план всё равно подтверждается
инспекцией и падает на блокирующем остатке), `plan` — нет. Для агента это худший вариант:
команда, которую он спрашивает «что делать», отвечает «ничего», пока инстанс не работает.

Исправление: каждая проблема, которую не покрыл ни один шаг, становится advisory-шагом со
своим `nextAction` (для `NOT_BOOTSTRAPPED` — `./clawforge bootstrap`); «nothing to do» —
только при `healthy && problems.length === 0`. Проверка: для каждого `ProblemCode` из
`PROBLEM_CODES` план с одной этой проблемой не пуст.

### R2 (P2). `--break-foreign-lock` принимают не все команды, которые берут блокировку

Воспроизведено: `apply`, `rollback`, `provision-agent`, `set forget`, `restore`,
`secrets --apply`, `apply-config` отвечают `unknown argument: --break-foreign-lock`. Флаг
объявлен (`BREAK_FOREIGN_LOCK_ARGUMENT`) только у `bootstrap`, `up`/`restart`/`down`/`upgrade`,
`push`, `expose`, `incident`, `watch install`. При этом `apply.ts`, `provision-agent` и
`set.ts` явно читают его через `parseBreakForeignLockHost()` (`runtime/instance-lock.ts:609`
прямо это говорит), а `guarded()` читает его из argv у всех — но парсер отвергает флаг раньше.

Вдобавок отказ по чужой блокировке (`security/instance-mutation-guard.ts`, `busy()`) для
владельца на другой машине говорит только «check whether it is still running on <machine>» —
ни флага, ни ссылки на runbook в `docs/architecture.md`.

Итог: осиротевший guard с другой машины можно снять только «обходом» через `up` — если
оператор вообще знает о флаге.

Исправление: `BREAK_FOREIGN_LOCK_ARGUMENT` рядом с каждым `BREAK_LOCK_ARGUMENT`; проверка
«объявлен `break-lock` ⇒ объявлен `break-foreign-lock`»; сообщение `busy()` для чужой машины
называет `--break-foreign-lock <machine>` и runbook.

### R3 (P2). Сбои `watch` не видны никому

`watch install` ставит cron-строку с `>/dev/null 2>&1` (`watch/install.ts:98`). Всё, что
`watch check` может сказать о своих сбоях, уходит в никуда:

- недоставленный alert (`runWatchCycle`: `die(...)`, state намеренно не пишется, чтобы
  повторить) — следующий цикл снова не доставит, и так бесконечно;
- ошибка конфигурации — невалидный `OC_WATCH_WEBHOOK`, неизвестный
  `OC_WATCH_WEBHOOK_FORMAT`, telegram без `OC_WATCH_TELEGRAM_CHAT_ID` — бросается до цикла,
  state тоже не пишется.

`watch status` при этом показывает последний записанный уровень и «webhook: configured» — ни
возраста последней проверки относительно интервала, ни «alert не доставлен с …». Без
heartbeat оператор узнаёт о сломанном webhook только тогда, когда alert был нужен. Проверить
доставку заранее нечем: нет `watch test`.

Исправление: в state — `lastRunAt`/`lastError` и `alertPending` (уровень не трогать, чтобы
повтор остался); `watch status` предупреждает о несвежей проверке и о недоставленном alert;
`watch test` шлёт пробный alert в выбранном формате и пингует heartbeat.

### R4 (P2). JSON-вывод неполон — для инструмента, который читают агенты

Воспроизведено:

- `status --json`, `secrets --json`, `verify --json` → `unknown argument: --json`;
- `expose status --json` и `recipe list --json` → печатают текст, флаг молча проигнорирован.

Остальные читающие команды (`inspect`, `doctor`, `plan`, `operations`, `lock`, `list`,
`mcp-creds`, `watch`) JSON умеют. Пользователь определил ClawForge как инструмент для
агентов; эти пять — как раз то, что агент спрашивает перед действием. Работает ли для них
MCP-путь через `isCaptured()` — не проверялось.

Исправление: `--json` у всех пяти по образцу `watch status`; проверка «команда, объявившая
`json`, при `--json` выдаёт разбираемый JSON».

## 3. Шероховатости

### R5 (P3). Необъявленные аргументы всё ещё проходят молча

После решения «лишний аргумент — ошибка» (#56):

- `./clawforge expose status --bogus` — выполняется, как будто флага нет;
- `./clawforge recipe list --bogus extra` — то же (у `recipe` свой порядкозависимый парсер);
- `logs` (`commands/lifecycle/lifecycle.ts:182`) не использует `parseDeclaredArgs`: после
  `--tail`/`--since`/`--grep` остаток уходит в `docker compose logs … <service> <rest>`
  (`runtime/docker/compose-operations.ts:218,224`), то есть `./clawforge logs extra` просит у
  compose логи сервиса `extra`. Вреда нет (чтение), но декларация `logs` passthrough не
  объявляет. По коду: локально без bootstrap проверка упирается в «never bootstrapped»
  раньше.

### R6 (P3). Help и справочник команд

- `control-mcp` — вход для агентов — есть в `docs/guide/commands.md` и в диспетчере
  (`entry/cli.ts:195`), но не в списке `./clawforge help`.
- Строка `--app <name>  pick another deployment` в общем help не говорит, что `--app` теперь
  только до команды; ошибка это объясняет, help — нет.
- `docs/guide/commands.md` — в таблице нет `set` и `exec`.

### R7 (P3). `<value>` вместо имени значения; дублированный рендер

`label()` печатает любую опцию как `--name <value>`: `--break-foreign-lock <value>` (описание
говорит `<hostId>`), `--tail <value>`, `--from <value>`, `--local-port <value>`. В
`docs/guide/commands.md` имена правильные (`<hostId>`, `<n>`, `<artifact>`) — справочник и
help расходятся. Нужен `valueName` в `CommandArgument`.

`label()` и цикл печати аргументов (`padEnd(22)`) продублированы в `entry/cli.ts:43,122` и
`integration/gate.ts:34,50`; версия в гейте теряет `choices`.

### R8 (P3). Ошибка неизвестного аргумента без подсказки

`./clawforge backup --dry-run` → `error: unknown argument: --dry-run` и всё. Для неизвестной
команды уже есть «did you mean» и указатель на help (`reportUnknownCommand`); для опции —
нет. `closestCommand()` применим к объявленным опциям команды как есть.

### R9 (P3). Одно имя `--set` — два смысла

`plan`/`apply`/`accept`: `--set <artifact>` (опция). `rollback`: `--set` — булев флаг
«переустановить предыдущий set». Через MCP это разные типы в схеме у одного имени.
Переименовать флаг `rollback` (например, `--previous-set`).

### R10 (P3). Нет инвентаря архивов и заменённых копий

- Списка backup-архивов нет ни у одной команды: имя, размер, профиль, дата, purpose.
  `restore` без аргумента берёт новейший (`restore.ts:78` `newestArchive`) — какой именно,
  оператор видит только в логе уже идущего restore.
- `restore` сохраняет прежние данные как `<data>.replaced-<timestamp>` — полная копия
  каталога данных. Ничто их не показывает и не удаляет; `DISK_LOW` у `watch` на них не
  указывает.

Кандидат: `backup list [--json]` (архивы и `.replaced-*` с размерами) и явное
`backup prune --replaced [--apply]`.

### R11 (P3). `watch` молчит о новой причине при том же уровне

`runWatchCycle` сравнивает только `level`. `degraded` (`CHANNEL_UNHEALTHY`) → `degraded`
(`CHANNEL_UNHEALTHY`, `DISK_LOW`) — alert не отправляется, хотя появилась новая проблема.
Вариант: считать переходом изменение множества кодов причин.

## 4. Код и структура

### R12 (P3). Эфемерные ID в комментариях

Коммит 81d8a10 убрал ID задач из комментариев, но остались:

- код фреймворка: `commands/interface/groups/shared-arguments.ts:26`,
  `runtime/instance-lock.ts:528,610` (`R9-R1`);
- проверки: `N1`/`N2` (`cli-helper.check.ts:582`, `gate-dispatch.check.ts:176`,
  `folder.check.ts:503`, `restart.check.ts:118,160`), `B1`–`B9`
  (`arguments.check.ts:177`, `folder.check.ts:167,187`, `watch/check.check.ts:68,282`,
  `watch/install.check.ts:69`, `security-audit.check.ts:262`,
  `reconcile-history.check.ts:324,339`), `R9-R1` (`instance-lock/takeover.check.ts:103`).

Эти ID ничего не говорят читателю без архива ревью; инвариант надо назвать словами.

### R13 (P3). Три файла у лимита

`service/archive.ts` — 696, `commands/lifecycle/smoke.ts` — 696,
`commands/orchestration/inspect/observe.ts` — 682 из 700. По принятому правилу следующая
правка в них — перегруппировка по смыслу. Лучше сделать её заранее и отдельно, а не внутри
функциональной правки: `archive.ts` — профили/исключения отдельно от упаковки; `smoke.ts` —
фазы round-trip и приватности отдельно от проб здоровья.

### R14 (P3). Help-абзацы в тысячу символов

`details` у `incident` — один абзац около 2 000 символов одной строкой, у `watch` в
`commands.md` — около 1 700. В терминале это стена текста, а MCP-клиенту достаётся как
описание инструмента целиком. Разбить на строки по фазам/действиям (формат `\n` в `details`
уже поддерживается).

### R15 (P3). Windows-набор CI без трёх проверок watch

`tools/checks/runtime/watch/{health,heartbeat,webhook}.check.ts` не входят в список
Windows-задачи `ci.yml` (их соседи `check`/`index`/`install`/`status` входят). Выглядят как
чистая логика со stub-сервером — по коду; на Windows не запускались. Проверить и добавить.
(Защита от устаревших путей в этом списке добавлена в 4da64e5: `layout.check.ts`.)

## 5. Что хорошо

- Решения пользователя реализованы полностью: `--app` после команды отвергается с понятной
  подсказкой, `down` больше не пропускает аргументы в compose, `--opt=value` и «лишний
  позиционный — ошибка» работают в общем парсере.
- `list` показывает фактический транспорт (`wsl:Ubuntu-24.04`), лишнего «using the only
  deployment» нет.
- Хуки `afterBackup`/`beforeRestore` сделаны аккуратно: не вызываются для `internal`,
  сбой хука не прячет уже опубликованный архив, `beforeRestore` срабатывает до любых
  изменений.
- Форматы webhook и heartbeat: секрет URL не попадает в вывод, heartbeat пингуется только
  при `ok`, недоставленный alert повторяется.
- `runtime/docker/` и `runtime/transport/` разбиты по ответственности, крупнейший файл
  рантайма — 238 строк.

## 6. Порядок работ

1. R1, R2 — P2, команды отвечают неверно или отвергают собственный флаг восстановления.
2. R3, R4 — P2, наблюдаемость для оператора и агента.
3. R5–R9 — грамматика и help, одной серией.
4. R10, R11 — новые возможности backup и watch.
5. R12–R15 — гигиена, отдельными коммитами.
