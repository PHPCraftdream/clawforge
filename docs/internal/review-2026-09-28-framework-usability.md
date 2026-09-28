# Ревью ClawForge — удобство, полнота инструментов, ошибки, качество кода

Дата: 2026-09-28. База: `main` @ 5efabd6 (код идентичен 3351344, CI зелёный на Linux и Windows).

Метод: статическое чтение кода новых модулей (`upgrade`, `incident`, `watch`, `expose`,
`security-audit`, `backup --native`, `lock`, `openclawCliBatch`) и точек входа CLI, прогон
`./clawforge` без развёртывания (help, опечатки, неизвестные аргументы), сверка деклараций
аргументов с парсерами скриптом по всему `tools/framework`, сверка README/CHANGELOG/.env.example
с кодом. Живой инстанс не поднимался; каждое утверждение ниже опирается на конкретные строки,
механизм описан. Где вывод сделан рассуждением, а не воспроизведением, это сказано.

Шкала: **P1** — ломает основное обещание команды или теряет данные/улики; **P2** — неверное
поведение в реальном, но не основном сценарии; **P3** — шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| B1 | P1 | `upgrade` | после `bootstrap` команда без `--image` всегда «nothing to upgrade»; имя канала (тег) из `.env` потеряно |
| B2 | P1 | `incident` | логи собираются после пересоздания контейнера — улики за время инцидента уничтожаются самой командой |
| B3 | P1 | `watch check` | недоступный хост/Docker — исключение до алерта; самый важный отказ не сигнализируется |
| B4 | P2 | `watch check` | `PROVIDER_MISSING` (ложноположительный по дизайну) даёт вечное `degraded` и ненулевой exit |
| B5 | P2 | `watch install` | `--interval` 60…1440 порождает `*/N` в поле минут — фактически раз в час |
| B6 | P2 | `incident` contain | `tailscale serve reset` сносит все serve-маршруты хоста; сбой contain обрывает ротацию токена |
| B7 | P2 | `backup --native` | при сбое полный архив с секретами остаётся в живом `config/` и попадает в следующие backup/migrate |
| B8 | P2 | `deploy` | `--adopt` принимается и советуется, но не задекларирован: нет в `--help` и MCP-схеме |
| B9 | P3 | security gate | на SSH-хосте без ufw — ложный «could not determine whether UFW is active» |
| B10 | P3 | `openclawCliBatch` | `mktemp -d` не удаляется; вывод без завершающего `\n` ломает разбор маркеров |
| B11 | P3 | CLI | опечатка в команде без развёртывания → «deployment not found»; нет «did you mean» |
| B12 | P3 | CLI | `--app` вырезается из любой позиции argv, включая аргументы `exec`/`cli` |
| B13 | P3 | `backup.ts` | осиротевший JSDoc над `NEVER_COPY_LIVE` |

Документация: `incident` отсутствует в README; `security-suppressions.json` и `OC_WATCH_WEBHOOK`
не описаны для пользователя; CHANGELOG «Unreleased: nothing»; README обещает `upgrade` без
флагов (см. B1); задача #13 закрыта, хотя мониторинг dead-letter каналов не реализован.

## 2. Ошибки и баги

### B1 (P1). `upgrade` без `--image` ничего не делает после первого `bootstrap`

- `tools/framework/diagnostics/image-digest.ts:17` — `resolveImageDigest` возвращает
  `repo@sha256:…`, **срезая тег**.
- `tools/framework/commands/lifecycle/bootstrap.ts:112-116` — bootstrap пишет эту ссылку в
  `OPENCLAW_IMAGE` (`pinImageReference`).
- `tools/framework/commands/lifecycle/lifecycle.ts:338,346,358` — `upgrade` берёт
  `ctx.settings.image`, видит `@sha256:` и использует его как цель; цель равна текущему
  дайджесту → «already running … nothing to upgrade».

Итог: основной сценарий из README (`README.md:1077`, «`./clawforge upgrade` — to the
deployment's own OPENCLAW_IMAGE») — no-op навсегда, а имя канала (`extended-stable`) из `.env`
исчезло, так что оператор должен помнить его сам и передавать `--image`. То же делает
`upgrade --dry-run`: «проверить, есть ли обновление» невозможно.

Исправление: хранить `repo:tag@sha256:…` (Docker принимает такую форму и тянет по дайджесту),
а в `upgrade` резолвить `repo:tag` без дайджеста как канал; либо отдельная переменная канала
(`OC_IMAGE_CHANNEL`). Check: bootstrap → upgrade без флагов резолвит канал, а не пин.

### B2 (P1). `incident` уничтожает логи, которые собирается сохранить

- `tools/framework/incident/index.ts:286-290` — порядок фаз: contain → **rotate** → audit →
  **collect**.
- rotate (`:161-168`) вызывает `ctx.runtime.reconcile()` = `compose up --detach`
  (`runtime/runtime-docker.ts:278-284`) с новым `OPENCLAW_GATEWAY_TOKEN`; изменённое окружение
  → Compose пересоздаёт контейнер, старый удаляется вместе с его json-file логами.
- collect (`:260`) читает `readLogs()` = `compose logs` — это уже логи нового контейнера,
  с момента пересоздания.

Для форензики это главный артефакт; команда теряет его своими руками. Исправление: снять логи
(и `docker inspect` старого контейнера) **до** rotate — как отдельную фазу «preserve», и только
потом менять токен. Дополнительно: при исключении в rotate/audit отчёт и уже собранные улики
не пишутся вовсе (исключение пролетает мимо `render`), — collect должен выполняться в `finally`.

### B3 (P1). `watch` молчит, когда хост или Docker недоступен

- `tools/framework/commands/orchestration/inspect/gather.ts:66` — любая ошибка `ctx.runtime.isRunning()`,
  кроме `NotBootstrapped`, пробрасывается.
- `tools/framework/watch/check.ts:124` — `watchCheck` вызывает `gatherInspection` без
  перехвата; исключение завершает процесс до `runWatchCycle`: ни алерта, ни записи состояния.

Демон Docker упал, SSH-хост недоступен, wsl.exe не отвечает — именно те отказы, ради которых
заводят мониторинг, — дают только ненулевой exit в cron, чей вывод к тому же отправлен в
`/dev/null` (`watch/install.ts:65-67`). Исправление: ошибка сбора = уровень `down` с причиной
`TARGET_UNREACHABLE` и обычный путь перехода/алерта.

Связанное (by design, но стоит назвать): cron ставится на тот же хост, который наблюдается, —
падение хоста целиком не сигнализирует никто. Нужен хотя бы документированный внешний
heartbeat (dead-man's switch: алерт, если webhook не получал «ok» N минут).

### B4 (P2). `watch`: `PROVIDER_MISSING` делает инстанс вечно «degraded»

`tools/framework/watch/check.ts:21` включает `PROVIDER_MISSING` в `LIVENESS_CODES`. Сам код
находки помечен как ненадёжный (`service/inspection.ts:117-123`: провайдер из env, подписка
или CLI-backend не видны в `models.providers`), и именно поэтому он warning, а не blocking. В
`watch` же любой warning → `degraded` → `die(...)` (`check.ts:108`) — ненулевой exit каждый
цикл для работающего инстанса. Исправление: убрать код из liveness либо заменить его
реальной проверкой (агентский ping, как в `smoke`).

### B5 (P2). `watch install --interval` > 59 даёт не тот график

`watch/install.ts:152` разрешает 1…1440 минут, `cronLine` (`:65-67`) пишет `*/${minutes}` в поле
минут (диапазон 0–59). `*/90` или `*/1440` совпадают только с минутой 0 → запуск раз в час,
а не раз в 1,5 ч / сутки. Исправление: ≤ 59 — `*/N`; кратные 60 — `0 */H * * *`; иначе
отказ с объяснением.

### B6 (P2). `incident` contain: слишком широкий reset и хрупкий порядок

- `expose/tailscale.ts:81-82` — `tailscale serve reset` сбрасывает **всю** serve-конфигурацию
  узла, включая чужие сервисы; `tailscaleServeActive` (`:75`) считает активным любой маршрут.
  Шапка `incident/index.ts:5-6` утверждает обратное («never touches anything else there»).
- `incident/index.ts:127-128` — сбой reset (типично: пользователь не `tailscale set
  --operator`, нужен root) бросает исключение, и ротация токена — самое важное действие — не
  выполняется.

Исправление: снимать только маршрут на порт шлюза (`tailscale serve --https=443 off` или по
`serve status --json`), ошибки contain превращать в заметку и продолжать rotate.

Там же (UX): при публикации на `0.0.0.0` команда отказывается работать без `--keep-exposure`
(`:89-109`), хотя это ровно тот случай, когда contain нужнее всего. Логичнее предложить
действие «перепривязать на 127.0.0.1 и пересоздать» как часть contain.

### B7 (P2). `backup --native`: полный архив остаётся в живых данных при сбое

`commands/lifecycle/backup.ts:202` создаёт нативный архив в `<data>/config/.clawforge-native-*.tar.gz`,
перенос в staging происходит только в конце `createNativeArchive`. Любая ошибка между
(`listArchive`, распаковка, `copyOmittedLiveFiles`) оставляет архив в живом каталоге —
очистка трогает только `stagingDir`. `baseExcludes` (`service/archive.ts:90`) этот шаблон не
исключает, поэтому следующий обычный backup удваивается, а `migrate`-снимок (который
исключает `config/.env`) несёт вложенный полный архив **с** `.env` и credentials. Исправление:
писать нативный архив сразу вне data dir (backupDir/staging через bind-путь) или удалять его в
`finally`, плюс добавить шаблон в `baseExcludes`.

### B8 (P2). `deploy --adopt` не задекларирован

`commands/management/deploy.ts:158` принимает `--adopt`, собственный usage и сообщение отказа
его советуют, но декларация (`commands/interface/groups/openclawCommands.management.ts:401-405`)
знает только `target`, `--path`, `--no-bootstrap`. Следствия: флага нет в `./clawforge deploy
--help`, и MCP-клиент не может его передать — `validate()` отвергнет неизвестный аргумент.
Найдено сверкой «флаги в парсерах ↔ декларации» по всему `tools/framework`; остальные
расхождения — флаги самих OpenClaw/tar/docker, не наши.

### B9 (P3). Security gate: ложное «UFW не определён» на SSH

`security-audit/index.ts:223-239` считает «ufw не установлен» только при исключении из `exec`.
Локальный spawn действительно бросает ENOENT, но через SSH отсутствующая команда — это
exit 127 с `allowFailure`, без исключения; текст не совпадает ни с active, ни с inactive →
warning `UFW_DOCKER_BYPASS` «could not determine» на любом хосте без ufw при публичной
привязке. (Вывод по коду; живьём не воспроизводилось.) Исправление: `command -v ufw` до вызова.

### B10 (P3). `openclawCliBatch`: утечка каталогов и хрупкий разбор

`service/openclaw-cli.ts:183-191`: временный каталог `mktemp -d` не удаляется — в одноразовом
контейнере это безвредно, но с постоянным помощником `cli-start` каталоги копятся на каждом
inspect/doctor/watch. Маркер конца печатается сразу после `cat`; если вывод команды не
заканчивается `\n`, маркер оказывается в той же строке, регэксп `^…$` его не находит, и
результат молча становится `code: 1, stdout: ""`. Исправление: `rm -rf "$dir"` в конце и
`printf '\n'` перед маркером.

### B11 (P3). Диспетчер CLI

- `tools/clawforge.ts:129` — при отсутствии развёртывания по умолчанию любая опечатка
  (`./clawforge statsu`) отвечает «deployment "openclaw" not found», а не «unknown command»;
  проверка имени команды идёт после проверки развёртывания.
- `tools/framework/entry/cli.ts:197` — неизвестная команда печатает весь help (~55 строк)
  вместо одной строки «did you mean: status».
- Аналогично неизвестные аргументы проверяются только после загрузки развёртывания.

### B12 (P3). `--app` вырезается из любой позиции

`tools/clawforge.ts:30` — `argv.indexOf("--app")` по всему argv: `./clawforge exec -- tool
--app x` потеряет два аргумента, предназначенные контейнеру. Форма `--app=x` не
поддерживается. Разбирать глобальный флаг нужно только до имени команды.

### B13 (P3). Осиротевший комментарий

`commands/lifecycle/backup.ts:150-152` — JSDoc «Paths, relative to their own root…» относится к
`missingRelativeFiles`, но стоит над другим JSDoc и константой `NEVER_COPY_LIVE`; остаток
слияния.

## 3. Неточности документации

- **`incident` нет в README** — ни в таблице команд (`README.md` §Commands), ни отдельного
  раздела, хотя у `expose` и `watch` разделы есть.
- `config/security-suppressions.json` (формат `suppressions[]` и `acknowledgePublicBind`)
  описан только в шапке `security-audit/index.ts`; пользователь узнаёт о файле лишь из
  `nextAction` находки.
- `OC_WATCH_WEBHOOK` отсутствует в `tools/framework/.env.example`.
- `README.md:1077` — см. B1.
- `CHANGELOG.md` — «Unreleased: Nothing released yet», хотя с 0.1.0 добавлены `upgrade`,
  `backup --native`, `expose`, `watch`, `incident`, security gate, lock для плагинов/навыков,
  группировка help.
- Задача #13 называлась «мониторинг /readyz и **dead-letter каналов**»; в коде нет ни одной
  проверки каналов (`git grep -i dead.letter` пусто), `LIVENESS_CODES` — только шлюз, egress и
  провайдер. Задача закрыта как выполненная.
- Группы help: `recover-env`, `mcp-serve`, `mcp-setup`, `mcp-creds` стоят в «Security & access»,
  хотя это восстановление конфигурации и интеграции; `upgrade` — в «Save & move», хотя это
  изменение инстанса.

## 4. Удобство

1. **Имя развёртывания по умолчанию.** Без `OC_APP` выбирается `openclaw`. После `./clawforge
   new-app mybot` каждая команда требует `--app mybot` — иначе «not found — available: mybot».
   Если развёртывание одно, его стоит выбирать автоматически; `new-app` — печатать
   `export OC_APP=<name>`.
2. **Перекрывающиеся команды.** 36 команд, из них диагностических семь (`status`, `inspect`,
   `doctor`, `smoke`, `accept`, `operations`, `verify`), способов изменить конфигурацию четыре
   (`apply`, `apply-config`, `configure-provider`, `secrets --apply`), способов сохранить
   состояние три (`backup`/`restore`, `pull`/`push`, `state`). Help группирует их, но не
   говорит, *когда что*. Нужна таблица «задача → команда» в начале README и `help` и,
   вероятно, слияние `apply-config` в `apply`.
3. **Нет подсказок при опечатках и нет автодополнения** (bash/zsh/PowerShell completion) — на
   36 командах с флагами это ощутимо.
4. **Стоимость диагностики.** `doctor`/`inspect` ≈ 20 с на WSL; `watch check` каждые 5 минут
   выполняет полный `gatherInspection` с запуском CLI-контейнеров (без `cli-start` — новый
   контейнер на каждый цикл). Для liveness достаточно `/readyz` + статус контейнера;
   полная инспекция — раз в N циклов.
5. **`watch` недоступен на основной платформе.** Windows → WSL → Docker получает только
   напечатанную команду для ручной настройки Task Scheduler.
6. **Документация.** README — один файл на 1409 строк. В `docs/` ~30 внутренних отчётов
   аудитов и сессий лежат рядом с пользовательскими `architecture.md` и
   `first-hour-acceptance.md`; стоит вынести внутренние в `docs/internal/` (или архив), а
   README разделить на «быстрый старт / операции / справочник».

## 5. Полнота инструментов — чего не хватает

| Приоритет | Инструмент | Зачем |
|-----------|-----------|-------|
| высокий | Мониторинг каналов и dead-letter, свободного места на диске в `watch` | обещано задачей #13; каналы — основной способ, которым OpenClaw «делает работу» |
| высокий | Расписание резервных копий + копия вне хоста + шифрование full-архивов | сейчас backup лежит на том же хосте, в открытом tar.gz с credentials; потеря диска = потеря и данных, и копий |
| высокий | Проверка доступного обновления (`upgrade --check`) | после исправления B1; сегодня узнать о новом образе нельзя |
| средний | Внешний heartbeat для `watch` | см. B3: падение хоста целиком никто не заметит |
| средний | Обзор всех развёртываний (`./clawforge list` / `status --all`) | при нескольких `apps/*` нет сводки |
| средний | `logs --since/--grep` | сейчас только `--tail`; при разборе инцидента нужен интервал |
| средний | Форматы webhook (Slack/Discord/Telegram) | сейчас только generic JSON — нужен промежуточный адаптер |
| низкий | Task Scheduler для `watch` на Windows, либо явная инструкция в README | основная платформа разработки |
| низкий | Shell completion | см. §4 |

## 6. Качество кода и запахи

1. **Два источника правды для аргументов.** У каждой команды есть декларация `arguments`
   (help, MCP-схема, `validate`), и отдельно ~30 рукописных парсеров (`git grep "unknown
   argument"` — 36 вхождений). Флаги блокировки (`--break-lock`,
   `--break-foreign-lock <id>`) вручную пропускаются в каждом парсере. Расхождение уже
   произошло (B8). Решение: один генерический разбор по декларации, возвращающий типизированные
   опции; парсер команды остаётся только для семантических проверок.
2. **Объём и назначение комментариев.** 7 259 из 29 167 строк `tools/framework` (25 %) —
   комментарии; 182 из них ссылаются на эфемерные идентификаторы («task #32», «UX-05»,
   «P1-06 round 6», «audit 2026-09-22»). Многие шапки пересказывают историю отладки вместо
   инварианта (пример — 14-строчный JSDoc `pinFreshPull` в `bootstrap.ts`). История принадлежит
   git и отчётам; в коде — зачем и какой инвариант, коротко.
3. **Структура подстроена под линтер, а не под домен.** `runtime-docker.ts` — ровно 700/700
   строк, `transport.ts` — 699, `smoke.ts` — 692; `diagnostics/image-digest.ts` вынесен «to
   keep it under the line cap». `expose/`, `watch/`, `incident/`, `security-audit/`,
   `extensions/` лежат на верхнем уровне потому, что каталоги `commands/*` упёрлись в лимит 7
   записей (так прямо сказано в их шапках), а их проверки лежат в `checks/security/`, хотя
   `watch`/`expose` — не безопасность. Лимиты полезны, но решение — группа `commands/operate/`
   и разбиение `runtime-docker.ts` по обязанностям (compose, образ, интроспекция), а не
   выпиливание кусков в случайные каталоги.
4. **Проглатывание ошибок.** 184 `catch {}` / `.catch(() => …)`. Многие обоснованы, но паттерн
   «ошибка = нет данных» уже дал B3 (и ранее — флейк privilege probe, #37). Правило стоит
   закрепить: чтение, которое может не состояться, возвращает тип «неизвестно», а не
   `false`/`undefined`, неотличимые от ответа.
5. **Опциональные возможности runtime.** `resolveImageDigest?`, `recreateWithImage?`,
   `runningEnvironment?`, `lastExitCode?`, `reconcile?`, `runningConnectionFacts?` —
   фактически единственная реализация (`DockerRuntime`), а вызывающие обвешаны `typeof …
   === "function"` и `!` (4 non-null assertion: `recreateWithImage!` ×2 в `lifecycle.ts`, `runningEnvironment!` в `secrets.ts`, `runningConnectionFacts!` в `recover-env/index.ts`).
   Либо сделать методы обязательными, либо объект capability, проверяемый один раз.
6. **Мелкие дубли.** Генерация токена (`incident/index.ts:156` и `integration/provision.ts`)
   вместо общей функции — хотя комментарий говорит «the same way bootstrap does»; три копии
   ожидания `setTimeout` в цикле опроса; `try { runningConnectionFacts } catch` — четыре копии
   (`incident` ×2, `security-audit` ×2).

## 7. Что хорошо

- Безопасность по умолчанию последовательна: loopback-привязка, маскирование секретов, owner-only
  файлы, `funnel` запрещён, security gate с явными suppressions и причинами.
- Изменяющие команды ведут операционный журнал, берут блокировку инстанса, умеют откат; у
  `upgrade` правильная идея (backup → recreate → health → lint → rollback с восстановлением
  данных при exit 78).
- Декларативный контракт команд одновременно питает help, MCP и подтверждение
  деструктивных действий — сильная основа (её стоит довести до разбора argv, см. §6.1).
- 140 check-файлов, CI на Linux и Windows, проверка приватного контента в docs.

## 8. Рекомендуемый порядок работ

1. B1, B2, B3 — P1, каждая ломает основное обещание своей команды.
2. B4–B8 — вместе с добавлением `incident`/suppressions/webhook в README и `.env.example`.
3. Генерический разбор argv по декларации (§6.1) — закрывает класс ошибок B8.
4. Инструменты из §5 «высокий».
5. Гигиена: комментарии с эфемерными ID, дубли, структура каталогов, `docs/internal/`.
