# Этап 4: советы как данные — проектное решение

Дата: 2026-10-01. Основание: [план рефакторинга](refactor-plan-2026-10-01.md), разделы 1–3, этап 4, инварианты I1–I2;
[решение этапа 3](refactor-stage3-design.md) (`CommandSpec`, один разборщик, `executeCommand`, `argumentsView`); код
`main` на `dc80216`. Для исполнителей rf4-advice, rf4-codes, rf4-sweep-core, rf4-sweep-cmds1, rf4-sweep-cmds2.
Отступления от плана помечены словом «отступление». Пути — от `tools/framework/`, если не сказано иное. Замеры —
приложение А.

## 0. Решения коротко

Совет — значение `Advice` (`clawforge` | `shell` | `manual`). Текст из него строит один рендерер
`core/io/invocation/render.ts` — единственное место правила `--app` и единственный читатель `Invocation.program`;
литерал `./clawforge` остаётся в одной константе `SHIM_PROGRAM` и в трёх генераторах, закреплённых построчно. Команда в
выводе — совет в слоте (`UserError(message, { advice })`, `Problem.next`) или строка `commandLine(argv)` того же
рендерера внутри сообщения (отступление: команды в сообщениях остаются, но не литералом). Проза справки ссылается на
команду токеном `{clawforge …}`, на свой флаг — `{--flag}`; токены сверяются со спецификацией. `PROBLEM_CODES[*].next` —
`Advice`; в JSON добавляется `next`, в конверте MCP — `nextSteps` (форма вызова инструмента, обратная `toArgv`); строки
`nextAction`/`nextActions` остаются строками консоли. `localizeHints`, `infoRaw`, `reportErrorVerbatim`, `cli`,
`invocationPrefix` удаляются; до последнего переноса `localizeHints` — переходный слой, для вывода рендерера
идемпотентный. Вывод в вызове по умолчанию (корень чекаута) не меняется байт в байт, кроме перечисленного в 5.2;
меняется вывод других вызовов — там, где он сейчас неверен.

## 1. Модель

### 1.1. Типы и раскладка

```ts
// core/io/invocation/advice.ts — данные: без вывода, без рендерера, без импорта команд
export type Shell = "posix" | "cmd" | "pwsh";
export interface CommandAdvice {             // команда clawforge
  readonly kind: "clawforge";
  readonly argv: readonly string[];          // слово команды и её аргументы — без программы и без --app
  readonly app?: string;                     // развёртывание названо явно ("<name>" допустим); правило --app молчит
  readonly note?: string;                    // проза без токенов; другая команда в ней — голым именем в `…`
}
export interface ShellAdvice { readonly kind: "shell"; readonly shell: Shell; readonly text: string; readonly note?: string }
export interface ManualAdvice { readonly kind: "manual"; readonly text: string }
export type Advice = CommandAdvice | ShellAdvice | ManualAdvice;
export function command(argv: string | readonly string[], options?: { app?: string; note?: string }): CommandAdvice;
export function shellLine(shell: Shell, text: string, options?: { note?: string }): ShellAdvice;
export function manual(text: string): ManualAdvice;
```

* `command("logs --tail 100")` режется по одиночным пробелам и бросает на кавычке; элемент с пробелом — только массивом.
  Пустой элемент и `argv[0] === "--app"` бросают при построении: развёртывание — поле `app`.
* Заполнитель — элемент `<…>` (с необязательным `…`): рендерится голым, в проверке P4 заменяется примером.
* Значения — простые объекты: `JSON.stringify` и есть контракт поля `next` (`{"kind":"clawforge","argv":["lock"]}`).
  `shell` — строка для другого shell, хоста или планировщика (cron, `schtasks` для cmd.exe, команда на сервере после
  `deploy`); `manual` — действие человека без команды (`reconnect the MCP client (in Claude Code: /mcp)`).

`core/io/` заполнен (7 записей), поэтому всё — в каталоге `core/io/invocation/` (сейчас 1 файл; станет 4):

| Файл | Содержимое | Строк |
| --- | --- | --- |
| `index.ts` | `Invocation`, формат v1 (как сейчас); `localizeHints` — до флипа (rf4-sweep-cmds2) | ~130 |
| `advice.ts` | 1.1 | ~90 |
| `render.ts` | `SHIM_PROGRAM`, `renderAdvice`, `commandLine`, `shimInvocation`, `useGateCommands` | ~180 |
| `prose.ts` | токены справки: разбор и подстановка (раздел 2) | ~120 |

Циклов нет: `advice.ts` ничего не импортирует; `render.ts` — `advice.ts`, `index.ts`, `core/io/shell.ts`; `log.ts` —
`render.ts`; `core/command/errors.ts` по-прежнему импортирует только `UserError`.

### 1.2. Рендерер

```ts
// core/io/invocation/render.ts
export const SHIM_PROGRAM = "./clawforge";   // как набирают закоммиченный шим: корень чекаута и каталог init
export function shimInvocation(app?: string): Invocation;   // явный вызов для текста вне терминала: файлы, cron, сервер
export function useGateCommands(names: readonly string[]): void;   // вход регистрирует имена своих команд шлюза
export function renderAdvice(advice: Advice, on: Invocation = invocation()): string;
export function commandLine(argv: string | readonly string[], options?: { app?: string }): string;   // renderAdvice(command(…))
```

| Часть | Правило |
| --- | --- |
| программа | `on.program` как набрана; её выбрал вход по режиму (этап 2) |
| `--app` | ровно одно `--app <имя>` сразу после программы, если у совета есть `app`; иначе — если `argv[0]` не команда шлюза, `on.app` есть, `selectedBy ∈ {flag, env, sole}` и имя не `openclaw`; во всех прочих случаях ни одного |
| аргументы | программа-путь (`./clawforge`, `../../clawforge` — шимы на bash): POSIX, `shellQuote` только где нужно; голая `clawforge` (её набирают и в cmd, и в pwsh): двойные кавычки только где нужно, одинарных нет; заполнители — голыми |
| `note` | `<команда>  (<note>)` — два пробела, как в `PROBLEM_CODES` сейчас |
| `shell` | `text` без изменений (+ `  (<note>)`) |
| `manual` | `text` |

* Программа — поле, а не функция режима (отступление от «program — по режиму»): закоммиченные шимы пишут `"program":
  "./clawforge","mode":"installed"`, и правило по режиму отдало бы им `clawforge`, которого за шимом может не быть. Режим
  выбирает вход (`entry/root.ts defaultInvocation`, `tools/clawforge.ts`), как сейчас; второго правила нет.
* Команды шлюза (`check`, `new-app`, `remove-app`, `list`, `version`, `completion`; у установленного входа `init`) `--app`
  не получают (сейчас `refusals.txt`: `./clawforge --app demo new-app <name>`). Имена регистрирует вход из своего массива
  `GateCommand` — производная, не ручной список; матрица 4.2 регистрирует те же массивы.
* Рендер жадный — при построении строки, `Problem`, `UserError`: вызов один на процесс, вход выставляет его до любой
  команды. На уровне модуля рендерер не вызывается — строка застыла бы в вызове по умолчанию; статический текст — токены
  (раздел 2), коды — данные. Запрет для файлов групп и `service/inspection.ts` проверяется (2.3).
* `audience` остаётся полем формата v1 и рендером текста не читается (уточнение плана, 7.3): текст для MCP — тот же,
  что для консоли этого вызова; форма вызова инструмента — отдельное поле `nextSteps`, его строит слой MCP (1.4).

Переход. До флипа `log`/`info`/`warn`/`emit` пропускают текст через `localizeHints`. Вывод рендерера для неё — неподвижная
точка, кроме двух случаев: (а) строка `shell` с `./clawforge` без `--app` — её до флипа печатает `infoRaw`; (б) команда
шлюза внутри текста при вызове с `--app` — вернётся лишнее `--app`, как сейчас (не регресс, уходит на флипе). Советы
в слоте `UserError` печатаются мимо `localizeHints` сразу, поэтому отказы входа исправляются уже в rf4-sweep-core.

### 1.3. Ошибки

```ts
// core/io/log.ts
export interface UserErrorOptions { readonly advice?: readonly Advice[]; readonly cause?: unknown }
export class UserError extends Error { readonly advice: readonly Advice[]; constructor(message: string, options?: UserErrorOptions) }
export function die(message: string, ...advice: Advice[]): never;
export function formatError(error: unknown): string;   // сообщение + "\n    → <совет>" на каждый совет; маскировано
export function reportError(error: unknown): void;     // "error: " + formatError(error)
```

* Подклассы (`ArgumentError`, `ValueError`, `CommandFailedError`, `ConfirmationRequiredError`) не меняются: второй параметр
  необязателен; `die(message)` — как сейчас.
* Строка совета `    → <renderAdvice>` — формат, который `status` и `backup list` уже печатают вручную
  (``die(`${code}  ${detail}\n    → ${nextAction}`)``); они переходят на слот без изменения вывода.
* MCP: `captureRun`, `captureGateRun` и ловушка `handleAppToolCall` берут `formatError(error)` вместо
  `localizeHints(error.message)` (−3 вызова); отказ разбора — `<tool>: ${formatError(…)}`.
* Решения входа (`entry/resolve.ts`) несут `refusals: readonly UserError[]` вместо строк; вид `refuse-verbatim` уходит —
  дословность переходит в `ShellAdvice`. Init в чекауте: сообщение и советы `[command(["new-app", "<name>"]),
  shellLine("posix", renderAdvice(command(["new-app", "<name>"]), shimInvocation()), { note: "in bash" })]`.

### 1.4. Коды проблем, документы, конверт MCP

```ts
// service/inspection.ts
interface CodeMeaning { readonly severity: Severity; readonly summary: string; readonly next: Advice }   // было nextAction: string
export interface Problem {
  readonly code: ProblemCode; readonly severity: Severity; readonly detail: string;
  readonly nextAction: string;   // renderAdvice(next) при построении
  readonly next: Advice;
}
export function problem(code: ProblemCode, detail: string, next?: Advice): Problem;
export function nextActions(problems: readonly Problem[]): string[];   // как сейчас
export function nextAdvice(problems: readonly Problem[]): Advice[];   // тот же порядок и ключ дедупликации
// integration/mcp/call.ts
export interface ToolStep { readonly tool: string; readonly arguments: Readonly<Record<string, unknown>> }
export function toolArguments(command: Declared, argv: readonly string[]): Record<string, unknown> | undefined;
export function toolSteps(next: readonly Advice[], lookup: (name: string) => Declared | undefined): ToolStep[];
```

* `PROBLEM_CODES` (47): 45 — `command(…)`, `TARGET_UNREACHABLE` и `MCP_RESTART_REQUIRED` — `manual(…)`; хвост в скобках —
  `note`. Две заметки называли вторую команду литералом (`GATEWAY_PUBLICLY_BOUND`: «…and ./clawforge up to recreate…»,
  `UFW_DOCKER_BYPASS`: «…use ./clawforge expose») — теперь голым именем в `…`: заметка — данные JSON, токенов в ней нет.
* Уточнения места вызова — тоже `Advice`: новые `provisionRemedy(recipe)` и `forgetRemedy(kind, name)` в `set/advice.ts`
  рядом с `imagePinAdvice` (их строит `inspect/live.ts`, читает `plan.ts`, рисует матрица); `imagePinAdvice` отдаёт
  `{ detail, next }` — главная команда, альтернативы в `note`; `recipeIncomplete`, `recipeMissingDir`,
  `recipeInvalidDefinition` — `command("set validate" | "set build", { note })`; `security/audit.ts` —
  `manual(finding.remediation)` или `command("cli security audit --json")`; `extensions.ts` — команды переустановки как
  `CommandAdvice`; `unreachableProblem` — `manual(error.nextAction)`. Классы ошибок транспорта не меняются.
* `plan.ts` читает `entry.next.argv` вместо разбора строки (`startsWith("./clawforge provision-agent ")`, `FORGET_PATTERN`):
  после рендера при построении строка в вызове с `--app` начиналась бы иначе — переход в том же коммите, что и рендер.
* Документы с `nextActions` получают `next: nextAdvice(…)`, выровненный по индексу с `nextActions`: `inspect --json`,
  `doctor --json`, `lock --check --json`, `apply`, `set validate --json`. Строковое `next` у `bootstrap --check` — другой
  документ, не трогается.
* `toolArguments` — обратная `toArgv`: `tokenize(command.arguments, argv)` по производному `arguments` (слово действия
  ложится в позиционный `action`); флаг → `true`, опция и позиционный → строка, variadic → массив. Закон:
  `toArgv(c, toolArguments(c, a))` разбирается в те же значения, что `a`.
* `nextSteps` строит `toolEnvelope` из `payload.next` через `lookup` по `mcpCommands(app)` и командам шлюза (собирает
  `serveMcp`): `clawforge`-советы с инструментом и без чужого `app`; `shell`, `manual` и несопоставимые не
  угадываются и пропускаются, поэтому `nextSteps` не выровнен с `nextActions`; `confirm` в шаг не кладётся. В
  `STRUCTURED_OUTPUT_SCHEMA` — `nextSteps: { type: "array" }` в `properties` и `required` (`tools/list` 32024 → 32516 байт
  из 32768); `STRUCTURED_ENVELOPE_HELP` называет `nextSteps`.

## 2. Проза справки

### 2.1. Токены

| Токен | Значение | Рендер |
| --- | --- | --- |
| `{clawforge}` | программа | `on.program`, без `--app` |
| `{clawforge <argv…>}` | команда: слова через один пробел; `--app <имя>` первыми словами → поле `app`; `<…>` — заполнитель | `commandLine(argv, { app })` |
| `{--name}` | флаг этой команды | `--name` |

Конец токена — первая `}`; `{` без `clawforge`/`--` — текст (JSON в прозе). Скобки охватывают всю команду (отступление от
примера плана `{clawforge} help pull`): длина команды должна быть однозначной — по ней проверка берёт `argv`.

### 2.2. Подстановка

`renderProse(text, on = invocation())` (`prose.ts`) заменяет токены, остальное не трогает. Вызывает только
`help-render.ts`: `renderCommandHelp` для `details` — оба входа, `help <cmd>`, `<cmd> --help`, MCP-инструмент `help`.
Справка всегда в форме консоли (равенство с `mcp-mirror`). Строки `Usage:` и подвал `renderUsage` —
`commandLine([name])`, `commandLine(["<command>"])` вместо литерала и `localizeHints`. Токены — только в `details`:
`summary` и описания аргументов уходят в `tools/list` и схему как есть, команда в них — голым именем (`exec`: «…same
sidecar as `cli`»). `details` команд развёртывания (`app.ts`) рендерятся так же; литерал `./clawforge` в них после флипа
печатается как написан.

### 2.3. Проверка

`tools/checks/surfaces/help-prose.check.ts` — по всем объявлениям с `details`: `openclawCommands`, `checkoutGateCommands`,
`makeVersionGateCommand`, `makeCompletionGateCommand`, `makeInitGateCommand` (объявление `init` переезжает из `bin.ts` в
`integration/deployment/init.ts`, как у version/completion, — иначе его не прочесть без побочных эффектов), `control-mcp`:
* токен разбирается; `{clawforge …}` проходит P4 (4.2); `{--name}` объявлен этой командой (любым действием) —
  переименованный флаг ломает проверку, а не справку;
* в файлах групп и в `service/inspection.ts` нет `commandLine(` и `renderAdvice(`.

Храповик `proseFlags` (`architecture.check.ts`): `--name`, объявленный этой командой, вне токена и вне кода в `…`, первое
слово которого — не команда фреймворка и не начинается с `--`/`{` (такой код — строка чужого инструмента: `openclaw
channels status --json`, `tailscale status --json`). Старт 119: lifecycle 38, management 36, orchestration 17, operate 13,
sets 8, checkout-gate 5, version 2. Цель 0.

### 2.4. Документация

`docs/guide/*.md` на этапе 4 не генерируются и не правятся, кроме полей конверта (`docs/guide/operations.md`,
`docs/architecture.md` — `nextSteps`, rf4-codes) и раздела о советах в `docs/architecture.md` (rf4-sweep-cmds2). Примеры
руководства — для bash и остаются; таблица `commands.md` из спецификации — этап 5.

## 3. Удаление и совместимость

| Символ | Судьба | Кто |
| --- | --- | --- |
| `CHECKOUT_PREFIX` | → `SHIM_PROGRAM` | rf4-advice |
| `cli(rest)` (6 вызовов), `invocationPrefix()` (1 + `golden/matrix.ts`) | → `commandLine(argv)`; до переноса — обёртки над рендерером | обёртки rf4-advice, удаление rf4-sweep-core |
| `reportErrorVerbatim` (3 вызова, все в `entry/bin.ts`) | → `reportError` с `ShellAdvice` | rf4-sweep-core |
| вид решения `refuse-verbatim` | → `refuse` с `UserError[]` | rf4-sweep-core |
| `FORGET_PATTERN`, разбор `nextAction` в `plan.ts` | → `problem.next.argv` | rf4-codes |
| `localizeHints` (5 вызовов, 3 после rf4-advice) | удаляется вместе с вызовами в `write`, `emit`, `formatError` | rf4-sweep-cmds2, флип |
| `infoRaw` (7 вызовов) | вызовы → `info` в том же коммите | rf4-sweep-cmds2, флип |
| `emitRaw` (12 вызовов: вывод контейнера 8, токен и секреты 3, скрипт автодополнения 1) | остаётся; после флипа `emit` и `emitRaw` различаются назначением: документ фреймворка / чужие байты | — |

Публичные экспорты `@clawforge/framework` (`FRAMEWORK_EXPORT_SOURCES` и `exports` пакета не меняются):

| Экспорт | Что видно |
| --- | --- |
| `./app` (`core/app.ts`) | типы без изменений; документация `AppCommand.details` называет токены; литерал `./clawforge` в `details` развёртывания больше не переписывается (CHANGELOG, флип) |
| `./commands` | `openclawCommands[*].details` хранят токены в сыром виде (рендерит справка); `run(ctx, args)`, `arguments` — без изменений |
| `./mounts`, `./private-config` | не затронуты |

Ни один удаляемый символ не экспортируется. Данные: имена кодов, поля `nextAction` и `nextActions` (строки консоли этого
вызова, в том числе в конверте MCP) — без изменений; новые поля — `problems[].next`, `next` документов, `nextSteps`.
`CLAWFORGE_INVOCATION` v1, тексты шима и лаунчера — побайтно прежние, список хешей лаунчеров не трогается.

## 4. Приёмка

### 4.1. Храповики

`dotClawforgeLiterals`: область — `tools/framework/**/*.ts` и `tools/clawforge.ts` (вход чекаута, сейчас вне счёта: 7
вхождений, среди них отказ `--app must come before the command: ./clawforge --app <name> <command> …`). Исключение —
таблица `exempt` в `baseline.json`: файл → причина и точные строки (обрезанные) с кратностью. Вхождение исключено, только
если его строка есть в таблице, иначе считается в `files`; расхождение строк или кратностей — провал в обе стороны,
поэтому исключение не расширяется молча и не гниёт.

| Файл | Строки | Причина |
| --- | --- | --- |
| `core/io/invocation/render.ts` | `export const SHIM_PROGRAM = "./clawforge";` ×1 | рендерер |
| `integration/deployment/init.ts` | 4 строки текста `SHIM`: два комментария шима, `CLAWFORGE_INVOCATION`, `CLAWFORGE_INVOKED_AS` | шим называет себя |
| `integration/mcp/project.ts` | 2 строки `MONOREPO_LAUNCHER`: `program: "../../clawforge"`, `CLAWFORGE_INVOKED_AS` | генератор входного файла, как шим; канонический текст под хешем |
| `integration/completion.ts` | `complete -F … ./clawforge` ×2, `#compdef clawforge ./clawforge` ×1, `Register-ArgumentCompleter … ./clawforge` ×1 | регистрация имён в автодополнении |

| Метрика | Старт | advice | codes | core | cmds1 | cmds2 |
| --- | --- | --- | --- | --- | --- | --- |
| `dotClawforgeLiterals.total` | 448 + 7 | 445 | 365 | 285 | 166 | 11 (только `exempt`) |
| `localizeOptOuts.localizeHints` | 5 | 3 | = | = | = | 0 |
| `localizeOptOuts.infoRaw` | 7 | = | = | = | = | 0 |
| `localizeOptOuts.reportErrorVerbatim` | 3 | = | = | 0 | = | = |
| `proseFlags` (новая) | 119 | 119 | = | 112 | 38 | 0 |

Числа — замер правилом 2.3 и приложения А; точные значения записывает задача, вводящая метрику (храповик — равенство).

### 4.2. Матрица советов

`tools/checks/golden/advice.ts` (новый; в `golden/` станет 5 записей) рендерит `expected/advice-matrix.txt` в процессе,
без хоста. Свойства утверждает `tools/checks/surfaces/advice-matrix.check.ts` до сравнения со снимком — неверный рендер
нельзя «благословить» обновлением эталона.

Строки — каждый `Advice`, который продукт строит из данных; каждая задача добавляет свою группу:
1. `PROBLEM_CODES[*].next` — 47 (rf4-codes);
2. уточнения с фикстурными входами: `imagePinAdvice` (нет замка, замок без digest, замок другого образа),
   `recipeIncomplete`, `recipeMissingDir`, `recipeInvalidDefinition`, `provisionRemedy`, `forgetRemedy`, переустановка
   плагина и навыка, ремедиации аудита (rf4-codes);
3. отказы входа: советы решений `resolveCheckoutEntry`, `resolveInstalledEntry`, `missingAppDecision`, `frameworkOwner` на
   раскладках `golden/matrix.ts`, плюс `missingDeploymentReport`, `checkoutSubfolderReport`, указатели
   `reportUnknownCommand`/`reportUnknownArgument` (rf4-sweep-core);
4. строки другого shell: cron (`posixTargetInvocation` локально и по ssh), `schtasks`, строка транспорта, удалённые
   строки `deploy` (синтетика — rf4-advice; настоящие — cmds1 для `deploy`, cmds2 для cron и `schtasks`);
5. каждый `{clawforge …}` из `details` — собирается сам по мере переноса прозы.

Столбцы — `Invocation`: чекаут по умолчанию (`openclaw`/`default`); `--app openclaw` (`flag`); `--app demo` (`flag`);
`OC_APP=demo` (`env`); единственное `demo` (`sole`); передача из `apps/demo` (`cwd`); шлюз до выбора развёртывания (без
`app`); глобальная `clawforge`; глобальная, переданная шлюзу чекаута с `--app demo`; шим `init` (`./clawforge`,
`installed`); локальный пакет; лаунчер MCP чекаута (`../../clawforge`, `demo`/`flag`) — и строка формы инструмента
(`ToolStep` или «—»). Имена шлюза регистрируются из массивов того входа, к которому относится столбец.

* **P1, `--app`:** между программой и словом команды ровно одно `--app <имя>` или ни одного — по правилу 1.2; у команды
  шлюза — никогда; при явном `app` — всегда оно.
* **P2, `./` для cmd и pwsh:** при голой программе (`clawforge`) совет `clawforge` не содержит `./clawforge` и одинарных
  кавычек; `shell` для `cmd`/`pwsh` не начинается с `./`; у пользователя голой программы `./clawforge` бывает только в
  `shell`-совете `posix` с заметкой.
* **P3, `shell` байт в байт:** `renderAdvice(a, v) === a.text` (+ заметка) во всех столбцах; после флипа — то же через
  настоящие `info`/`reportError` в перехваченный вывод: слой вывода ничего не переписывает.
* **P4, спецификация:** `argv` с заполнителями, заменёнными примерами (`ValueParser.example`, `choices[0]`, `x`), проходит
  `parseCall` спецификации команды, `tokenize` её `arguments` (устаревшая, шлюз), у `help` — имя известной команды, у
  `control-mcp` — пусто. Неизвестная команда или флаг — провал.
* **P5, форма инструмента:** для совета с инструментом `toArgv(c, toolArguments(c, argv))` разбирается в те же значения.

### 4.3. Прочее

Эталоны этапа 0 в вызове по умолчанию — байт в байт, кроме 5.2; поэтому 79 проверок вида `includes("./clawforge …")`
остаются верными, правятся только пины намеренных изменений 5.2 («(in bash also …)» в `system-install.check.ts`, полный
текст совета пина образа в `set-validate.check.ts`). Сдача каждой задачи — с зелёным `npm run gate`; diff эталонов
читается против 5.2.

## 5. Задачи

### 5.1. Порядок

rf4-advice → rf4-codes → rf4-sweep-core → rf4-sweep-cmds1 → rf4-sweep-cmds2, строго последовательно — план подтверждаю:
1. переходный слой один: `localizeHints` нельзя удалить, пока жив хоть один литерал, — флип ждёт все три переноса;
2. каждая задача правит одни общие файлы: `baseline.json`, растущий `advice-matrix.txt`, CHANGELOG, эталоны;
3. владение пересекается по построению: rf4-codes правит ремедиации в `commands/**`, флип — вызовы `infoRaw` в чужих
   каталогах; последовательно это не конфликты, параллельно — гарантированные;
4. переносы механические и проверяются эталонами байт в байт; узкое место — чтение diff, а не набор правок.

Параллель тратится на этап 5: после слияния rf4-sweep-core он может идти рядом с cmds1/cmds2 (их файлы — `commands/**`
и файлы групп; этапа 5 — `completion.ts`, `mcp/schema.ts`, `help-render.ts`, `gate.ts`, документация). Пересечение одно —
флип (`log.ts`, `output.ts`, `core/io/invocation/index.ts`): этап 5 их не правит, иначе — через оркестратора.

Уточнение раскроя списка задач: механизм токенов (`prose.ts`, `help-prose.check.ts`, `proseFlags`) — в rf4-advice, иначе
cmds1 не переведёт прозу своих групп; cmds2 закрывает 4.5 (свои группы, `proseFlags` = 0) и 4.6. Каталоги вне списка:
`runtime/`, `security/privacy/`, `tools/clawforge.ts` — rf4-sweep-core; `set/**`, `security/audit.ts` и места построения
ремедиаций в `commands/**` — rf4-codes. Объём — 7–9 коммитов (план: 5–7; флип — отдельный коммит).

### 5.2. Владение, числа, изменения

Файл правит только владелец; чужой — через оркестратора (кроме перечисленного у задачи).

**rf4-advice** — 1.1–1.3 и механизм раздела 2; 2 коммита (модель, рендерер, ошибки; токены и проверки).
* Владеет: `core/io/invocation/*`, `core/io/log.ts`, документация `core/io/output.ts`, `core/io/help-render.ts`, три места
  ошибки в `integration/mcp/server.ts`, вызовы `useGateCommands` в `tools/clawforge.ts` и `entry/bin.ts`,
  `architecture.check.ts` и `baseline.json` (область, `exempt`, `proseFlags`), `golden/advice.ts`,
  `surfaces/{advice-matrix,help-prose}.check.ts`; `integration/apps/invocation-hints.check.ts` переписывается в проверку
  рендерера (случаи формата v1 остаются); правило о подсказках в CONTRIBUTING.md.
* Числа — столбец advice 4.1 (core/io: 11 → 1 в `exempt`). Эталоны: новый `advice-matrix.txt` на синтетике (команда,
  команда шлюза, явный `app`, заполнитель, заметка, три `shell`, `manual`); остальные — байт в байт. CHANGELOG: нет.
* Доказательство: проверка рендерера (`--app` по каждому `selectedBy`, регистрация шлюза, кавычки по форме программы,
  заметка, `shell`, `manual`, `UserError`/`die`/`reportError`/`formatError`, маска строк совета), P1–P5 на синтетике,
  `help-prose` (пока пусто), храповики, `layout`.

**rf4-codes** — 1.4; 1–2 коммита.
* Владеет: `service/inspection.ts`, `set/**`, `security/audit.ts`; ремедиации в `commands/orchestration/inspect/live.ts` и
  `commands/management/extensions.ts`; читатели `recipeWork`/`orphanActions` и два комментария в `plan.ts`; поле `next` в
  `inspect/gather.ts` (×2), `management/lock.ts`, `orchestration/apply.ts`, `sets/set.ts`; `integration/mcp/{call,schema,
  server}.ts` (`toolArguments`, `toolSteps`, `nextSteps`, `lookup`); `STRUCTURED_ENVELOPE_HELP`; `golden/render.ts`
  (`problem-codes.txt` через `renderAdvice`); группы 1–2 `advice.ts`; поля конверта в двух документах (2.4).
* Числа: −80 (inspection 47, `set/` 15, audit 2, live 8, extensions 4, plan 4). Эталоны: `problem-codes.txt` (две
  заметки), `mcp-tools-list.json` (`nextSteps` у 12 инструментов), `help-checkout.txt` (строка конверта в `--help` 12
  структурных команд), `advice-matrix.txt`.
* CHANGELOG: проблемы и документы с `nextActions` несут структурное `next`; конверт MCP — `nextSteps` (`{tool, arguments}`)
  рядом с прежним `nextActions`; заметки `GATEWAY_PUBLICLY_BOUND`/`UFW_DOCKER_BYPASS` и советы пина образа в `set
  validate`/`set build` называют главную команду первой, остальные — именем в заметке.
* Доказательство: P4/P5 на всех кодах и уточнениях; `plan` под `--app demo` находит рецепт и сироту (новый случай);
  `nextSteps` конверта `lock --check` и `inspect` (`mcp-server.check.ts`); бюджет `tools/list`; проверки JSON (`lock`,
  `folder`, `recipes`, `set-validate` — её пин полного текста совета пина образа, строка 101, правится).

**rf4-sweep-core** — 4.6 вне `commands/`; 1–2 коммита.
* Владеет: `entry/**`, `tools/clawforge.ts`, `integration/**` кроме `mcp/{call,schema}.ts` (`gate.ts`, `completion.ts`,
  `list.ts`, `deployment/*` с переездом объявления `init`, комментарии и `MCP_EXEMPTIONS` в `mcp/server.ts`),
  `service/{operations,openclaw-cli}.ts`, `core/{app,env}.ts`, `runtime/**`, `security/privacy/deploy-boundary.ts`;
  `golden/{render,matrix}.ts`, группа 3 `advice.ts`; проверки входа и шлюза.
* Числа: −80 (73 в `tools/framework` + 7 в `tools/clawforge.ts`; остаются 10 `exempt`), `reportErrorVerbatim` 0,
  `proseFlags` −7 (объявление `init` входит в счёт уже с токенами). Эталоны: `refusals.txt` (столбец `--app demo` —
  `new-app` без `--app`; отказы входа — сообщение и строки `→` вместо `error:` на каждой строке), `entry-matrix.txt`
  (формат строк `refuse`), `advice-matrix.txt`; справка и скрипты автодополнения — байт в байт.
* CHANGELOG: совет с командой шлюза (`new-app`, `list`, `check` …) не несёт `--app`; отказы входа печатают совет строкой
  `→`, вариант для bash помечен `(in bash)`.
* Доказательство: P1 на командах шлюза, P2 на глобальной программе; `system-install` сквозной (у глобальной команды
  `./clawforge` — только в помеченной строке bash); `gate-*`, `cli-help`, `init*`, `remove-app`, `list`.

**rf4-sweep-cmds1** — 1 коммит.
* Владеет: `commands/lifecycle/**`, `commands/management/**` (кроме сделанного rf4-codes),
  `groups/openclawCommands.{lifecycle,management}.ts` и их проверки.
* Числа: −119, `proseFlags` −74; `infoRaw` в `backup/install.ts` и `deploy/{index,sync}.ts` остаются, внутри — текст
  рендерера. Эталоны: `help-checkout.txt` и `mcp-tools-list.json` — только `summary` команды `exec`; `advice-matrix.txt`.
* CHANGELOG: `exec` в списке команд и в описании инструмента называет `cli` без программы.
* Доказательство: проверки групп без правок ожиданий, `help-prose`, храповики, эталоны.

**rf4-sweep-cmds2** — 4.5 и 4.6 до конца; 2 коммита (перенос; флип).
* Владеет: `commands/{orchestration,operate,sets}/**` (кроме сделанного rf4-codes), `commands/interface/**` кроме двух
  файлов групп cmds1; флип — `localizeHints` (`invocation/index.ts`, `log.ts`, `output.ts`), `infoRaw` и его 7 вызовов
  (`backup/install.ts`, `deploy/index.ts`, `deploy/sync.ts` ×2, `schedule.ts` ×2, `watch/install.ts`); итоговые случаи
  проверки рендерера; раздел о советах в `docs/architecture.md`; статус этапа в плане; сводная запись CHANGELOG.
* Числа: 166 → 11, `localizeOptOuts` 0/0/0, `proseFlags` 0. Эталоны: байт в байт, кроме `advice-matrix.txt`; любой иной
  diff — пропущенное место.
* CHANGELOG: слой вывода ничего не переписывает — строки cron и schtasks, команды для сервера и документы JSON выходят
  как построены; тестовое оповещение `watch test` называет команду этого развёртывания; в `details` своих команд —
  `{clawforge …}`, литерал печатается как написан.
* Доказательство: P3 через настоящий вывод под каждым столбцом; `gate`.

### 5.3. Рецепт переноса

| Было | Стало |
| --- | --- |
| комментарий `./clawforge up` | `clawforge up` или `` `up` `` |
| текст сообщения `"… ./clawforge up"` (`die`, `info`, `log`, `warn`, заметки, `detail`, `reason`) | `` `… ${commandLine("up")}` `` — байт в байт по умолчанию |
| ремедиация в ошибке, уже существующая как данные | `die(message, advice)` |
| `details`: `` `./clawforge inspect` reports ``, `--check …` | `` `{clawforge inspect}` reports ``, `{--check} …` |
| `summary`, описание аргумента | голое имя команды |
| строка ремедиации проблемы | `command(…)` / `manual(…)` |
| `PlanAction.command`, поле `nextAction` результата `restore` | `commandLine(…)` |
| строка для другого shell или хоста | до флипа `infoRaw(… renderAdvice(shellLine(…)))`; программа в ней — `SHIM_PROGRAM` или `renderAdvice(command(…), shimInvocation(app))` |
| исполняемая программа (cron, команда на сервере) | `SHIM_PROGRAM`; регулярка — `regexEscape(SHIM_PROGRAM)` |
| текст генерируемого файла (`app.ts` new-app и init) | `renderAdvice(command("status"), shimInvocation(name))` |
| разбор строки ремедиации | `problem.next.argv` |
| `cli(rest)`, `invocationPrefix()` | `commandLine(argv)`, `commandLine([])` |

### 5.4. Общие файлы

* `baseline.json`: каждая задача снижает свои числа; конфликт при слиянии — перезамер (`check architecture` печатает факт).
* `advice-matrix.txt` и прочие эталоны после слияния пересобираются `npm run golden:update`, diff читается против 5.2.
* CHANGELOG — строка о видимых изменениях в коммите задачи; cmds2 сводит записи этапа в одну.

## 6. Риски и не-цели

* **Застывший рендер.** `commandLine` на уровне модуля застынет в вызове по умолчанию. Запрет для файлов групп и
  `service/inspection.ts` проверяется (2.3); остальное — ревью и P1 для строк, попавших в матрицу.
* **Переход.** До флипа команда шлюза в тексте под `--app` печатается с лишним `--app` (как сейчас), строки `shell` — только
  через `infoRaw`. `info(renderAdvice(shellLine(…)))` до флипа — ошибка ревью.
* **Сохранённый текст.** Журнал `apply` (`detail`) пишется отрендеренным; записи с литералом, сделанные до этапа 4,
  после флипа печатаются как записаны.
* **Бюджет `tools/list`.** После `nextSteps` запас 252 байта; этап 5 (описания из `summary`) должен уложиться; запасной ход —
  `nextSteps` вне `required` (+144).
* **Жадный рендер в проверках.** Проверка, меняющая вызов между рендерами, строит `Problem`/`UserError` после
  `setInvocation`; рендерящая команды шлюза под вызовом с `app` — регистрирует их имена (`useGateCommands`).
* **Чужие флаги.** Флаг чужого инструмента с именем своего вне кода в `…` посчитается своим — пишется внутри кода.

Не цели этапа 4: поверхности этапа 5 (одно решение автодополнения, генерация `commands.md`, описания MCP из `summary`,
реестр `help`/`control-mcp`/`completion`/`version`, справка по действиям); ревью этапа 6; генерация или правка
`docs/guide`; формат `CLAWFORGE_INVOCATION`, тексты шима и лаунчера; советы ошибки в конверте MCP (`UserError.advice` →
`nextSteps`); форма инструмента в тексте вывода; `confirm` в шагах; токены в `summary`, описаниях и заметках; кавычки
`remotePath` в строках `deploy` (печатаются как сейчас); пересмотр формулировок; новые команды и флаги.

## 7. Решено до старта

1. **Команды в сообщениях — через `commandLine`, не только в слоте** (отступление от «в тексте сообщения команды
   clawforge не пишутся»). I1 держится: команда попадает в вывод из `Advice` через один рендерер, литерал запрещён
   храповиком. Взамен вызов по умолчанию остаётся байт в байт, и перенос ~330 вхождений в строках механический и
   проверяется эталонами и 79 существующими проверками; слот — там, где совет уже данные (коды, отказы входа, `→`-строки).
   Буквальный вариант плана — перекладка около 150 сообщений в строки `→`, правка этих проверок и большой diff эталонов
   без выигрыша для I1.
2. **`program` — поле Invocation, рендерер — его единственный читатель** (отступление): правило по режиму ломает
   закоммиченные шимы.
3. **`nextActions` — строки консоли и в MCP; форма инструмента — только `nextSteps`; `audience` не читается**: план требует
   «`nextActions` без изменений», `mcp-mirror.check.ts` — побайтного равенства инструмента `help` и `./clawforge help`.
4. **Токен охватывает команду целиком** (`{clawforge help pull}`) — иначе длина команды в тексте неоднозначна; **справка —
   всегда в форме консоли**, в том числе через MCP-инструмент `help`.
5. **Лаунчер чекаута — в исключениях, вход `tools/clawforge.ts` — в области храповика**: первый — генератор входного
   файла под хешем, второй — продуктовый код с отказом, который сейчас неверен для глобальной команды.
6. **`nextSteps` — в `required`** при замеренных 32516 из 32768 байт; превышение в rf4-codes — вывести из `required`
   (32372).
7. **Раскрой и порядок задач — 5.1**; **CHANGELOG — в коммите каждой задачи**, cmds2 сводит (как на этапе 3).

Отступление 1 принято оркестратором до старта rf4-advice; владелец может отменить его до rf4-sweep-core — тогда меняются
только строка «текст сообщения» в 5.3, списки эталонов в 5.2 и объём cmds1/cmds2.

## Приложение А. Замеры на `dc80216`

Литералы `./clawforge` в `tools/framework/**/*.ts`: 448 вхождений в 102 файлах (совпадает с `baseline.json`); вне счёта —
`tools/clawforge.ts` 7, `tools/build-framework-package.ts` 1 (комментарий сборки, область не расширяется). По каталогам:
`commands/orchestration` 63, `commands/lifecycle` 51, `commands/management` 44, `commands/operate` 43, файлы групп 53
(lifecycle 8, management 20, orchestration 19, operate 5, sets 1), `commands/interface` без групп 21, `commands/sets` 15;
`service` 52 (`inspection.ts` 47), `integration` 49, `entry` 18, `set` 15, `core` 13 (`core/io` 11), `runtime` 8,
`security` 3.

По виду (лексер по коду: комментарий или строка, вызывающая функция, ключ объекта) и задаче:

| Вид | advice | codes | core | cmds1 | cmds2 | Всего |
| --- | --- | --- | --- | --- | --- | --- |
| комментарий | 6 | 5 | 24 | 31 | 50 | 116 |
| отказ (`die`, `UserError`, `ArgumentError`, `Error`, `reportError`) | — | — | 18 | 14 | 27 | 59 |
| совет в сообщении (`info`, `log`, `warn`, заметки, `detail`) | — | 4 | 11 | 39 | 37 | 91 |
| проза справки (`details` 62, `summary` 1; `Usage`, экран без развёртывания, `CONTROL_MCP_DETAILS` 8) | 4 | — | 14 | 28 | 25 | 71 |
| `PROBLEM_CODES` | — | 47 | — | — | — | 47 |
| ремедиация на месте вызова | — | 22 | — | — | — | 22 |
| шаг `plan` | — | — | — | — | 11 | 11 |
| строка для другого shell (`infoRaw`, «in bash also») | — | — | 2 | 3 | — | 5 |
| исполняемая программа (cron, `runRemote`) | — | — | — | 1 | 4 | 5 |
| исключения: шим 4, лаунчер 2, регистрация автодополнения 4 | — | — | 10 | — | — | 10 |
| поле JSON (`restore`), текст генерируемого `app.ts`, константа программы | 1 | — | 3 | 3 | — | 7 |
| разбор строки ремедиации (`plan.ts`) | — | 2 | — | — | — | 2 |
| оповещение webhook, причина в `MCP_EXEMPTIONS` | — | — | 1 | — | 1 | 2 |
| Всего | 11 | 80 | 83 | 119 | 155 | 448 |

Прочее:
* обходы: `infoRaw` 7, `reportErrorVerbatim` 3, `localizeHints` 5 (`write`, `emit`, `server.ts` ×3), `cli` 6,
  `invocationPrefix` 1, `emitRaw` 12 вызовов — все байтовые потоки;
* проза: 41 команда, `details` 55 171 байт, литералов в `details` 52 и в `summary` 1; упоминаний своих флагов по правилу
  2.3 — 119 (вне кода 110 + 5 у шлюза чекаута + 2 у `version`, в своём коде 2), чужих — 27;
* документы с `nextActions` — 5; вызовов `die(` — 265; в проверках литерал встречается 376 раз в 100 файлах, из них 79
  строк `includes(…./clawforge…)`;
* `tools/list`: 32024 байта; с `nextSteps` в `properties` и `required` 12 структурных инструментов — 32516, без
  `required` — 32372; бюджет 32768.

Пересчёт:

```bash
# 455 = 448 в tools/framework + 7 в tools/clawforge.ts
git grep -o -F './clawforge' -- 'tools/framework/*.ts' tools/clawforge.ts ':!tools/framework/dist' | wc -l
# обходы с определениями: 8 / 6 / 4 (минус одно определение каждого — 7 / 5 / 3)
git grep -o -E 'infoRaw\(|reportErrorVerbatim\(|localizeHints\(' -- 'tools/framework/*.ts' | sed 's/^[^:]*://' | sort | uniq -c
node --experimental-strip-types tools/clawforge.ts check architecture   # факт по каждой метрике храповика
```
