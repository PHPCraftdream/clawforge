# Ревью ClawForge, раунд 12 — после реализации раунда 11

Дата: 2026-09-28. База: `main` @ 5e85856 (33 коммита впереди `origin`, не запушены; в рабочем
дереве — подъём `@types/node` до 24.13.6). Предыдущее ревью:
`docs/internal/review-2026-09-28-round-11.md` — его S1–S13 закрыты коммитами bf461d3…5e85856
(S14: `recover-env --adopt-runtime` в таблице, `OC_DEBUG` описан, `@types/node` → 24).

Метод: чтение кода тех участков, которые раунды 10–11 не трогали (разбор `.env`, перечисление
рецептов, `init`/`new-app`, транспорт-утилиты, `lock`), сверка `docs/` и README с кодом (все
`./clawforge <команда>` и `--флаги` из документации существуют), воспроизведение через скрипты
на временных каталогах (без развёртывания в `apps/`, на target ничего не создавалось),
статистика по проверкам (`tools/checks`). Вывод, сделанный рассуждением, а не воспроизведением,
помечен «по коду».

Шкала: P1 — ломает основное обещание; P2 — неверное поведение в реальном сценарии; P3 —
шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| T1 | P2 | перечисление рецептов | каталог `recipes/` перечисляется в 9 местах с разной обработкой ошибок; 5 из них превращают нечитаемый каталог в «рецептов нет»; воспроизведено |
| T2 | P2 | `core/env.ts` `parseEnv` | разбор `.env` не понимает синтаксис dotenv: `KEY=v # комментарий` даёт значение `v # комментарий`, `export KEY=v` — ключ `export KEY`; воспроизведено |
| T3 | P3 | код | четыре копии shell-квотирования и ещё пять пар дубликатов утилит |
| T4 | P3 | `init` / `new-app` | `init.ts` и `scaffold.ts` — параллельные копии; исправление S10 (`state/`, `sets/`) сделано только в одной |
| T5 | P3 | `tools/checks` | 128 из 145 файлов несут собственную копию обвязки с тремя разными семантиками сравнения; один процесс на все проверки |
| T6 | P3 | CLI | нет `--version` / `version` |
| T7 | P3 | полнота | нет планового backup; `watch install` на Windows/WSL печатает «настройте Task Scheduler вручную» |
| T8 | P3 | `restore` | нет предпросмотра (`--dry-run`): что будет заменено, что в архиве |
| T9 | P3 | bootstrap | нет проверки предпосылок до `bootstrap` (docker, `sudo` для `/srv`, порт); `new-app` о `sudo` молчит |
| T10 | P3 | блокировка | порог «устарела» 30 минут без обновления отметки; `recipe install` держит блокировку на всю сборку; `configure-provider` без `--break-lock` |
| T11 | P3 | структура | `runtime/instance-lock.ts` зависит от `security/instance-mutation-guard.ts`; два механизма с общим словом «guard/lock» |
| T12 | P3 | `control-mcp` | после S7 `tools/list` всё ещё ≈40 КБ: остаток — схемы аргументов |

## 2. Ошибки

### T1 (P2). Нечитаемый `recipes/` — это «рецептов нет»

Воспроизведено: `useDeployment(<каталог>)`, где `recipes` — файл (ENOTDIR; так же
работает EACCES/EIO на Linux):

```
listRecipes:            []
listBrokenRecipes:      []
listAgentBundleRecipes: []
recipeExpectations:     THROWS  …\recipes could not be read: ENOTDIR …
```

Список рецептов реализован независимо в `service/recipe.ts` (`listRecipes`, `listBrokenRecipes`,
`listAgentBundleRecipes`), `commands/management/lock.ts` (`recipeNames`),
`commands/sets/set-manifest.ts` (`recipeNames`), `commands/orchestration/accept.ts`
(`recipesWithAcceptance`), `commands/orchestration/inspect/declared.ts`
(`recipeExpectations`), `commands/management/recipe/index.ts` (`runningRecipeStacks`),
`commands/management/deploy/refusals.ts`. Пять из девяти — `catch { return []; }` (`listRecipes`,
`listBrokenRecipes`, `listAgentBundleRecipes`, `lock.ts`, `accept.ts`); остальные четыре
(`declared.ts`, `set-manifest.ts`, `runningRecipeStacks`, `refusals.ts`) отделяют ENOENT от
остального. У `set-manifest.ts`
комментарий прямо называет причину: «calling that an empty inventory would publish a read
failure as the removal of every recipe».

Следствия (по коду):

- `recipe list` печатает «no recipes yet — add one under recipes/<name>/» для каталога,
  который существует и не читается;
- `lock` записывает `deployment.lock.json` с `recipes (none)` — фиксация состава молча теряет
  все рецепты, а `lock --check` сравнивает с тем же способом перечисления;
- `accept` отвечает «no recipe declares acceptance checks»;
- при этом `inspect`/`plan` (`recipeExpectations`) на том же каталоге падают — три команды
  описывают одно развёртывание тремя разными способами.

Исправление: одна функция `listRecipeDirectories()` (ENOENT → `[]`, любая другая ошибка —
`die` с путём и errno, как в `set-manifest.ts`), все девять мест используют её; проверка на
файле вместо каталога для каждого потребителя.

### T2 (P2). `.env` читается не по правилам dotenv

Воспроизведено на `parseEnv`:

```
A=10 # keep ten          →  A = "10 # keep ten"
export C=exported        →  ключ "export C"
E=${A}suffix             →  "${A}suffix" (без подстановки)
```

Разбор (`core/env.ts:87–107`) режет по первому `=`, снимает одну пару кавычек, комментарием
считает только строку, начинающуюся с `#`. Значения затем без изменений попадают в compose
через собственный env-файл фреймворка, так что расхождения с Docker Compose нет — но `.env`
выглядит как dotenv, шаблон `.env.example` ведётся как dotenv, и оператор пишет привычное:

- `OPENCLAW_GATEWAY_PORT=18789  # мой порт` → порт `"18789  # мой порт"`: URL сервиса и
  публикация порта ломаются без указания причины;
- `OC_BACKUP_KEEP=10 # хранить десять` → предупреждение из S11 (до него — тихо `10` через
  `parseInt`);
- `export OC_DATA_DIR=…` → переменная не найдена, применяется значение по умолчанию.

Ни одно из правил не описано в документации: комментарий у `serializeEnvLine` говорит
«parseEnv trims each line, splits on the first `=`», но пользователю это не сказано.

Исправление (выбрать одно): (а) поддержать dotenv — `export ` в начале и ` #…` после
незакавыченного значения; (б) оставить простой формат, но `parseEnv` возвращает предупреждения
(значение с ` #`, ключ с пробелом), и `doctor` называет строку. Документировать формат в
`docs/guide/`.

## 3. Полнота и удобство

### T6 (P3). Нет `--version`

`./clawforge --version`, `-v`, `version` → `unknown command`. Версия видна только в `inspect`
(`framework 0.1.0`) и в `set build`. Для поддержки и багрепортов первый вопрос — «какая
версия»; ответ должен быть без развёртывания: `--version` в шлюзе и в `bin.ts`.

### T7 (P3). Плановый backup остаётся ручным

`watch install` ставит cron только на `watch check`; ни `backup`, ни `pull` расписания не
имеют, в таблице «I want to…» README строки про регулярные копии нет. Ротация
(`OC_BACKUP_KEEP`) при этом рассчитана на запуск по расписанию («a pull run on a schedule»,
`.env.example`), то есть расписание подразумевается, но инструмента для него нет.
На Windows/WSL (основная среда разработки) `watch install` вместо действия печатает «wire it
into Task Scheduler by hand».

Исправление: `backup install [--interval …] [--apply]` по образцу `watch install` (та же
печать/применение crontab, тот же отказ на непригодных целях) и готовая строка `schtasks
/create …` для Windows вместо «by hand».

### T8 (P3). У `restore` нет предпросмотра

`restore` показывает подтверждение и требует `--force` для пропуска; какой архив выбран,
сколько занимает, что будет перенесено в `<data>.replaced-<stamp>`, есть ли в архиве
идентичность — заранее не узнать, кроме как запустив. Раунд 10 добавил `backup list` и
имя выбранного архива в вывод, но сухой прогон (валидация архива без остановки сервиса)
остаётся: архив уже проверяется до остановки, нужно лишь остановиться после проверки и
напечатать план.

### T9 (P3). Нет проверки предпосылок до `bootstrap`

`doctor` на новом развёртывании отвечает единственным `NOT_BOOTSTRAPPED`; есть ли docker и
compose v2, можно ли создать `/srv/<имя>` без пароля `sudo`, свободен ли порт — выясняется
внутри `bootstrap`, то есть посреди мутирующей команды. `new-app` завершается «check .env —
data directory, port, image» и о том, что каталог данных по умолчанию лежит в `/srv` и требует
`sudo install -d`, не говорит (README упоминает это только в таблице неполадок).

Исправление: `bootstrap --check` (только чтение: docker/compose, `test -w` на родителя каталога
данных с готовой строкой `sudo install -d …`, порт, диск) и та же строка в выводе `new-app`.

### T10 (P3). Блокировка: порог и сообщение

`STALE_AFTER_MS = 30 мин` (`runtime/instance-lock.ts:39`), отметка `takenAt` не обновляется
пока держатель жив. `recipe install` по документации «holds the lock across the whole build»,
а сборка на сервере может идти дольше; сообщение отказа для такой живой операции говорит
«longer than any operation should take, so it may be left over from a run that died» и
предлагает `--break-lock`. Заодно `configure-provider` — единственная блокирующая команда без
`--break-lock` (`breakLockSupported: false`), отказ отсылает к другой команде.

Исправление: держатель обновляет `heartbeatAt`, «устарела» считается от него; текст — «не
обновлялась N минут»; `--break-lock` для `configure-provider` или явное описание в `--help`.

## 4. Код и структура

### T3 (P3). Дубли утилит

- Квотирование для POSIX-shell — четыре независимые реализации: `commands/lifecycle/state.ts:64`
  (`shellQuote`), `runtime/transport/quoting.ts:11` (`shellQuote`),
  `service/openclaw-cli.ts` (`quoteArg`, комментарий «kept local rather than shared»),
  `SshTransport.quote` (`runtime/transport/ssh.ts:42`); `security/privacy/deploy-boundary.ts`
  добавляет пятую обёртку `quoted`. Сегодня они совпадают побайтно; это код, от которого
  зависит безопасность передачи аргументов, и правка одной копии не дойдёт до остальных.
- `regexEscape` (`lifecycle.ts:42`, `core/io/log.ts:49`), `removeEmptyDirectory`
  (`runtime/instance-lock.ts:139`, `security/instance-mutation-guard.ts:265`), `physicalPath`
  (`lifecycle/restore.ts:201`, `runtime/datadir.ts:193`), `timestamp`
  (`backup/index.ts:114`, `set/artifacts/receipt.ts:119` — разные функции с одним именем),
  `recipeNames` (T1).

Исправление: `core/shell.ts` с `shellQuote`, остальные пары — в общие модули (`core/`), по
одной правке на каждую; проверка «в `tools/framework` ровно одно определение `shellQuote`».

### T4 (P3). `init.ts` и `scaffold.ts`

`integration/init.ts` (установленный режим) и `integration/scaffold.ts` (монорепозиторий)
содержат по копии `deploymentEnv`, `GITIGNORE_APPEND`, `updateGitignore`. Уже разошлись:

- S10 добавил `state/` и `sets/` в `.gitignore` только у `scaffold.ts`; `init.ts` их не
  добавляет — машинно-локальные `state/watch.json` и `sets/*.tar.gz` в установленном режиме
  попадают в коммит;
- идемпотентность `updateGitignore` в `init.ts` — эвристика
  `includes("@clawforge/framework") && includes("secrets/")`: репозиторий, у которого блок уже
  есть, новые записи не получит никогда;
- `scaffold.ts` выбирает порт с учётом занятых (`usedPorts()`), `init.ts` — случайный без проверки.

Исправление: общий модуль шаблона `.env` и блока `.gitignore` (параметр «есть ли
`node_modules/`»); добавление недостающих строк по одной, а не по маркеру блока.

### T5 (P3). Проверки: обвязка и изоляция

- 128 из 145 файлов определяют собственную `function check(name, actual, expected)`, 126 —
  собственный `let failed = 0`; общей обвязки нет ни одной (`#checks/…` не импортируется).
- Определений сравнения три вида: `===` (41), `JSON.stringify(a) === JSON.stringify(b)`
  (84, в том числе через `const same = …`). JSON-сравнение слепо к `undefined` против
  отсутствующего поля, к `NaN`/`null`, к `Set`/`Map` (`{}` против `{}`) и зависит от порядка
  ключей; в 165 строках вызовов ожидается именно `undefined`.
- Все проверки исполняются в одном процессе через `import()` (`tools/checks/run.ts`), а 70 из
  145 вызывают `useDeployment()` (глобальный синглтон), 5 меняют `process.env`, 4 вызывают
  `process.exit()`.
- Восемь файлов длиной 675–698 строк упираются в лимит 700: каждое добавление превращается в
  вынос части в новый файл (так были созданы `backup/retention.check.ts` и др.).

Исправление: `tools/checks/harness.ts` (`check`, `checkEqual` на `node:assert` deepStrictEqual,
итоговый `finish()`), миграция файлов по каталогам отдельными коммитами; runner запускает
файлы дочерними процессами (или воркерами) с общей очисткой.

### T11 (P3). «guard» и «lock»

`runtime/instance-lock.ts` импортирует `machineName`, `ownProcessStartedAt`,
`withMutationGuard` из `security/instance-mutation-guard.ts`; файл в `security/` содержит
определение идентичности хоста, проверку живости процесса и подчистку временных env-файлов
compose — то есть общую инфраструктуру блокировок. Зависимость идёт из `runtime/` в
`security/`, имя не говорит о содержимом, а в архитектурной документации «lock» и «mutation
guard» описываются как разные вещи.

Исправление: `runtime/process-identity.ts` (машина, pid, время старта, живость),
подчистка env-файлов — рядом с compose; `instance-mutation-guard.ts` остаётся только тем, что
его имя обещает.

### T12 (P3). `tools/list` после S7

40 121 байт против 88 010 до S7; цель 24 КБ не достигнута, бюджет проверки — 46 КБ. Остаток —
`inputSchema` с описаниями каждого аргумента (по 100–300 символов на аргумент у `watch`,
`recipe`, `backup`, `set`). Агент платит ≈10 тыс. токенов за схемы, из которых большинство
описаний повторяют имя аргумента.

Исправление: описания аргументов до одной короткой фразы, подробности — в `help`; бюджет
понизить до 30 КБ.

## 5. Что хорошо

- Документация сверена с кодом: все команды из `docs/guide`, README и `CONTRIBUTING.md` есть в
  `./clawforge help`; все упомянутые `--флаги` существуют в декларациях (четыре «лишних» —
  флаги чужих инструментов или отрицательные примеры).
- Раунд 11 доведён до конца: 13 находок закрыты 18 коммитами, полный прогон дал один
  реальный отказ (типизация опубликованного пакета из S8), он исправлен на месте.
- Классы ошибок раунда 11 не возвращаются: `requireBootstrapped` покрыт проверкой на каждую
  команду, `TARGET_UNREACHABLE` — на doctor/plan/status/backup list, вывод не портится на
  границе чанка (регрессия на `€` и `ж`).
- Замаскированный вывод: `maskSecrets` применяется к ошибкам, MCP-ответам, `incident`-файлам
  и результатам `list`; JSON-экранированные формы секрета тоже маскируются.
- Отказы `deploy`, `restore`, `prune-replaced` проверяют цель перед действием и называют
  причину и выход.

## 6. Порядок работ

1. T1, T2 — P2, ошибки чтения конфигурации и рецептов.
2. T3, T4 — дубли и расхождения копий (одной серией: общие модули).
3. T6–T9 — полнота инструментов: `--version`, плановый backup, `restore --dry-run`,
   `bootstrap --check`.
4. T10, T11, T12 — блокировка, структура, размер MCP.
5. T5 — обвязка проверок, отдельной серией коммитов по каталогам.
