# Ревью ClawForge №2 — после доработок по первому ревью

Дата: 2026-09-28. База: `main` @ 81d8a10 (CI зелёный на Linux и Windows; локально 133/133 check-файла).
Предыдущее ревью: `docs/internal/review-2026-09-28-framework-usability.md` — его B1–B13, C1, C4,
C5, §6.1, §6.2 закрыты коммитами 3879690…81d8a10.

Метод: прогон CLI на временном развёртывании (`new-app review-probe`, без bootstrap, удалено
после), чтение нового кода (`argv/parse-args.ts`, `integration/scaffold.ts` list,
`commands/lifecycle/lifecycle.ts` logs/upgrade, `watch/health.ts`, `incident/`), сверка README с
поведением, подсчёт лимитов раскладки. Вывод, сделанный рассуждением, помечен.

Шкала: P1 — ломает основное обещание; P2 — неверное поведение в реальном сценарии; P3 —
шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| N1 | P2 | CLI | `status --app x`, `up --app x`, `restart --app x` молча игнорируют `--app` после команды — команда уходит в другое развёртывание |
| N2 | P2 | `down` | необъявленные аргументы уходят в `docker compose down` как есть (`--rmi all`, `-v`) — у деструктивной команды |
| N3 | P3 | CLI | `help <опечатка>` без развёртывания печатает ошибку, но выходит с кодом 0 |
| N4 | P3 | argv | нет формы `--opt=value` (хотя `--app=` есть); повторный позиционный аргумент молча заменяет предыдущий (`deploy h1 h2` → h2) |
| N5 | P3 | `list` | `target: auto` — не разрешается в фактический транспорт (wsl:…/local/ssh:…) |
| N6 | P3 | CLI | «using the only deployment: X» на каждом вызове — шум (в stderr, JSON не ломает) |
| N7 | P3 | `watch` | каждый цикл запускает отдельный CLI-контейнер для `channels status` сверх пакета inspect |
| N8 | P3 | README | «backup … kept on this machine» — архивы лежат на target (для SSH — на сервере) |
| S1 | P2 | структура | 28 из ~35 каталогов исходников ровно на лимите 7 записей; структура следует лимиту, а не домену |
| S2 | P2 | структура | `runtime/runtime-docker.ts` ровно 700/700, `transport.ts` 699, `smoke.ts`/`archive.ts` 696 |
| S3 | P3 | структура | новые проверки разложены по свободным каталогам, а не по смыслу (`integration/recipe/deployment-list.check.ts`) |
| S4 | P3 | структура | `sleep()` в `core/output.ts`, `list` в `integration/scaffold.ts` — потому что целевые каталоги заполнены |

## 2. Ошибки

### N1 (P2). `--app` после команды молча игнорируется

После перехода на «`--app` только до команды» (e6fa722) команды, которые не разбирают свои
аргументы, принимают `--app x` как мусор без ошибки. Воспроизведено:
`./clawforge status --app x` при единственном развёртывании `review-probe` вывел статус
`review-probe`, не сказав ни слова про `--app`. Так же ведут себя `up`, `restart`, `cli-start`,
`cli-stop` (`commands/lifecycle/lifecycle.ts:115,146`, `commands/interface/status.ts:13`,
`commands/interface/cli-helper.ts:11,23` — аргументы не проверяются). Раньше `--app` в любой
позиции работал, поэтому привычный вызов теперь без предупреждения действует на другое
развёртывание — для `up`/`restart` это мутация не того инстанса.

Исправление: гейт отказывает, если после имени не-passthrough команды встречается `--app`/
`--app=`, с подсказкой «put --app before the command»; плюс эти команды разбирают свои аргументы
через `parseDeclaredArgs` (у них есть декларации — только лок-флаги), чтобы любой лишний
аргумент был ошибкой.

### N2 (P2). `down` пропускает необъявленные аргументы в Compose

`commands/lifecycle/lifecycle.ts:164-166`: `ctx.runtime.stop(stripLockFlags(args))` →
`docker compose --profile cli down <args>` (`runtime/runtime-docker.ts` stop). Декларация `down`
(`openclawCommands.lifecycle.ts:61-66`) объявляет только лок-флаги, а details обещают «never
touches data». При этом `./clawforge down --rmi all` удалит образы, `-v` — именованные тома
(данные в bind mounts, но это уже не «ничего, кроме контейнеров»). MCP такой вызов отвергнет
(`validate()`), CLI — пропустит: два входа с разной семантикой. Новая проверка деклараций
(arguments.check) этого не ловит — `down` не использует `parseDeclaredArgs`. (Опасность — вывод
по коду; вживую `--rmi` не запускался.)

Исправление: `down` разбирает аргументы по декларации; если passthrough в Compose нужен —
объявить его явно (`variadic` после `--`) и описать.

### N3 (P3). `help <опечатка>` — код выхода 0

`./clawforge help lsit` без развёртывания печатает `unknown command: lsit` / `did you mean:
list` и выходит с 0. Причина: ветка help в `tools/clawforge.ts` (развёртывания нет) вызывает
`main(genericApp, …)` и затем безусловно `process.exit(0)`, хотя `runApp` уже выставил
`process.exitCode = 1`. Исправление: `process.exit(process.exitCode ?? 0)`.

### N4 (P3). Грамматика генерического парсера

`tools/framework/argv/parse-args.ts`:
- `--tail=5` → «unknown argument: --tail=5», хотя гейт понимает `--app=name` — непоследовательно;
- лишний позиционный аргумент молча заменяет предыдущий (строки 64-70; сохранено ради прежнего
  поведения) — для `deploy h1 h2` это деплой на `h2` без предупреждения, у деструктивной команды;
- опция без значения становится `""` и каждая команда обязана сама это отличить — часть команд
  не отличает (`deploy --path` → пустой путь уходит в `validatedRemoteRoot`, который, судя по
  коду, откажет, но сообщение будет про путь, а не про пропущенное значение — по коду, не
  воспроизводилось).

Исправление: поддержать `--opt=value`; лишний позиционный — ошибка (изменение поведения,
согласовать); пустое значение опции — единая ошибка «--x needs a value» в парсере.

### N5–N8 (P3)

- **N5** `scaffold.ts` configSummary: `target` = сырое `OC_TARGET_LOCATION` (`auto`). При
  `checkStatus` контекст уже построен — можно показать `ctx.transport.description`.
- **N6** `tools/clawforge.ts`: `info("using the only deployment: …")` на каждом вызове. Показывать
  один раз, когда развёртывание создаётся, или только при `--verbose`.
- **N7** `watch/health.ts` channelFindings: отдельный `openclawCliJson(["channels","status","--json"])`
  — лишний контейнер (без `cli-start`) на каждый цикл cron. Добавить команду в пакет
  `openclawCliBatch` из `observeLive`.
- **N8** README таблица «I want to…»: «kept on this machine» для backup неверно — `backupDir` на
  target. Там же `watch install` подан как универсальный, хотя на Windows/WSL он только печатает
  команду.

## 3. Структура — запахи

### S1 (P2). Раскладка упирается в лимит 7 записей почти везде

`layout.check.ts` ограничивает каталоги 7 записями. Сейчас ровно 7 в 28 каталогах:
`tools/framework/{core,runtime,service,security,integration,watch}`,
`tools/framework/commands/{,interface,lifecycle,management,orchestration,sets}`,
`tools/checks/{,foundation,foundation/cli,foundation/core,integration,integration/agent,
integration/mcp,runtime,runtime/connection-facts,runtime/convergence,runtime/convergence/inspect,
runtime/lifecycle,runtime/service,security/credentials,security/credentials/secrets-command,
sets/artifact}`. Корень `tools/framework/` (на который лимит не распространяется) разросся до 26
записей: `argv/`, `watch/`, `incident/`, `expose/`, `security-audit/`, `extensions/`,
`diagnostics/` появились там именно потому, что «правильные» каталоги заполнены (так прямо
написано в их шапках). Каждая новая фича теперь выбирает место по свободному слоту.

Варианты: (а) поднять лимит до 10–12; (б) ввести уровень группировки (`commands/operate/` для
expose/watch/incident, `runtime/docker/`, `core/util/`); (в) оба. Рекомендация: (б) с умеренным
(а) — лимит полезен как сигнал, но не должен определять домен.

### S2 (P2). Файлы на пределе 700 строк

`runtime/runtime-docker.ts` — 700/700 (последний агент сжал сигнатуру в одну строку, чтобы
влезть), `runtime/transport.ts` — 699, `commands/lifecycle/smoke.ts` и `service/archive.ts` —
696. Любая правка там заставляет выпиливать куски в случайные модули
(`diagnostics/image-digest.ts`, `diagnostics/incident-snapshot.ts` — «split out to keep under the
line cap»). Решение — разбить по ответственности: `runtime-docker.ts` → compose-операции /
образ и дайджест / интроспекция контейнера / helper; `transport.ts` → по транспорту
(local/wsl/ssh); `archive.ts` → профили/исключения отдельно от упаковки.

### S3 (P3). Проверки лежат не по смыслу

`tools/checks/integration/recipe/deployment-list.check.ts` проверяет `list` (к рецептам
отношения не имеет) — положен туда, потому что это «единственный подкаталог с запасом» (из
шапки файла). Проверки `expose`/`watch`/`incident` лежат в `checks/security/`, хотя `watch` —
мониторинг. Раскладку проверок стоит зеркалить с раскладкой `tools/framework`.

### S4 (P3). Хелперы в чужих модулях

`sleep()` добавлен в `core/output.ts` (модуль про вывод), потому что `core/` на лимите; `list` —
в `integration/scaffold.ts` (модуль про создание развёртывания); `safeConnectionFacts()` — в
`expose/status.ts`, откуда его импортирует `security-audit`. Это следствие S1.

## 4. Остатки первого ревью (не закрыты)

- C2 — расписание, копия вне хоста и шифрование backup (#52, нужно решение по инструменту и
  месту хранения ключа).
- Форматы webhook (Slack/Discord/Telegram) — только generic JSON.
- Внешний heartbeat для `watch` (падение хоста целиком никто не сигнализирует).
- Планировщик `watch` на Windows/WSL — только печать команды.
- Shell completion.
- `apply-config` как отдельная команда рядом с `apply`.
- README вырос до 1567 строк; строки таблицы команд — по 600+ символов.
- `recipe`, `set diff`, `host` по-прежнему со своими парсерами (осознанно: порядкозависимая
  грамматика), но без проверки «объявлено = принимается».
- Флейк `installed-consumer.check.ts` из параллельного прогона агентов — механизм не найден,
  на последующих прогонах не воспроизвёлся.

## 5. Что хорошо

- Все P1 первого ревью закрыты и покрыты проверками; найденные по ходу флейки (ожидание по
  числу оборотов цикла, проба sudo) исправлены по механизму, а не ретраем в тесте.
- Декларации аргументов стали единым источником для help, MCP и разбора — класс ошибок B8
  закрыт проверкой по всем командам.
- Комментарии без эфемерных ID стали короче и объясняют инвариант.

## 6. Порядок работ

1. N1, N2 — P2, поведение CLI расходится с ожиданием и с MCP.
2. S1+S2+S3+S4 — одна задача реструктуризации (сначала решение по лимитам), затем разбиение
   `runtime-docker.ts`/`transport.ts`.
3. N3–N8 — мелкие правки.
4. Остатки §4 по приоритету пользователя.
