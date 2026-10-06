# Этап 7, срез S2: один binder и подготовленный план — проект (S2.1)

Дата: 2026-10-06. Основание: [план этапа 7](refactor-plan-stage7-2026-10-06.md) (S2, I13, §6),
[отчёт о сходимости](review-convergence-after-refactor-2026-10-06.md) (§4 семейства 2–3, §5.2, §5.3, §5.5, §6 S2),
[план рефакторинга](refactor-plan-2026-10-01.md) (I4–I6, §6 совместимость), проекты этапов 3 и 5, [backlog-p3](backlog-p3.md).
Срез кода: `main` = `0cdea4d` (прочитан рабочий каталог основного checkout; worktree проектировщика стоит на
`d36e76c`, на 47 коммитов позади, и для анализа не использовался). Статус: проект, реализация — после согласования.

Решения владельца по §12 (Q1–Q9) и новым вопросам N1–N3 — [refactor-stage7-decisions.md](refactor-stage7-decisions.md).
Заменённые рекомендации помечены на месте «заменено решением <ID>», решённый текст стоит рядом; обоснование сохранено.

## 0. Решения коротко

| № | Решение |
| --- | --- |
| D1 | Одна функция `selectAction` и одна форма `BoundCall` в `core/command/call.ts`; argv, MCP, справка и автодополнение получают выбор действия и срез только от неё |
| D2 | MCP связывается **по именам** (`bindNamed`) внутри конвейера, без `toArgv`; `validate`/`toArgv` остаются только для legacy `AppCommand` |
| D3 | У каждого value-аргумента спецификации объявлен вид `value: ValueKind`; `parse`/`choices` у `ValueSpec` заменяются видом, представление (`CommandArgument`) их по-прежнему показывает |
| D4 | Вид может иметь локальное разрешение (`resolve`), которое конвейер выполняет сам в стадии `prepare`; `run` получает `Prepared<P>` из брендированных значений и не может построить `ArgumentError` |
| D5 | `Needs = "nothing" \| "local" \| "deployment" \| "target"`, объявляется и на действии; `local`/`nothing` не строят `Context` |
| D6 | Команды шлюза переводятся на тела спецификации (`needs: "nothing"`), материализуются в прежний тип `GateCommand` как фасад; второй путь validate/help/effect удаляется |
| D7 | `Execution` несёт достигнутую стадию; MCP `changed` выводится из неё: отказ до `run` — `false` |
| D8 | Строгий и мягкий токенизатор — одна таблица переходов; оракул автодополнения — `scanCall` binder'а |

## 1. Что именно должно стать невозможным

| Дефект (раунды 18–19, отчёт §5) | Причина в коде (`0cdea4d`) | Механизм |
| --- | --- | --- |
| MCP: неизвестное действие → отказ «applies to … not `list`» | `call.ts:245–247`, `302–304`: `validate` и `toArgv` сами выбирают действие и падают на `defaultAction` | D1+D2: действие выбирает только `selectAction`; неизвестное — `UnknownActionError` с консольным текстом |
| MCP: позиционный попал в слот чужого действия | `toArgv` кодирует по позиции, `validate` латает сдвиг (`call.ts:256–281`) | D2: значение кладётся в слот по имени, позиции в MCP нет |
| Шлюз: `choices`/required другой формулировкой, эффект только в MCP, `help X` без пометки эффекта | `GateCommand` — второй тип; `refuseAgainstDeclaration`, `gateConfirmationRefusal`, `captureGateRun`; `renderHelp` для записи шлюза зовёт `renderCommandHelp` без `effectNote` (`gate.ts:505–507`; статически: `help remove-app` внутри развёртывания и MCP `help` теряют строку эффекта, `remove-app --help` — нет) | D6 |
| Аргументные факты о локальном отказываются в `run` после `Context`: basename источника `recipe import`, нет артефакта у `set try`/`set diff`, нет рецепта (`runLocked`→`loadRecipe`, `provision-agent`), `operations ../x`, образ с `-` | `run` получает сырую строку (`actions.ts:197–201`, `set-try.ts:185`, `set-diff.ts:346`, `recipe/index.ts:280`, `provision-agent/index.ts:77`) | D3+D4 |
| Sweep I5 не доходит до `run` | `property.check.ts:86–92` без развёртывания; `stage === "context"` засчитывается | §10: fixture S0.2 + учёт стадий |
| `recipe import/new` строят `Context` | `ActionSpec` закреплён на `target` (`spec.ts:125`) | D5 |
| MCP `changed: true` у destroy-вызова, остановленного в prepare/context | `changedFact` смотрит на эффект (`call.ts:20–27`) | D7 |
| Мягкий/строгий токенизатор расходятся (опция «глотает» объявленный флаг, повтор) | `scan(..., lenient)` с отдельными ветками (`parse.ts:296–329`) | D8 |

Найдено дополнительно: выбор действия повторён ещё в `execute.ts:88–111` (`jsonTokenGiven`) и в
`completion/table.ts:182` (`after.has(cmd + between[0])`). Метрика «выбор действия/среза вне `core/command`»
на деле 3 (`validate`, `toArgv`, `completionCandidates`), плюс копия внутри `core/command`.

## 2. Нормализованная форма вызова

Новый модуль `core/command/call.ts` (без runtime-импортов, экспортируется из `core/command/index.ts`):

```ts
export type CallInput =
  | { readonly kind: "argv"; readonly argv: readonly string[] }
  | { readonly kind: "named"; readonly args: Readonly<Record<string, unknown>>; readonly confirmed: boolean };

export type Provenance =
  | { readonly from: "argv"; readonly index: number; readonly form: "word" | "flag" | "inline" | "next" | "after-dashdash" | "tail" }
  | { readonly from: "named"; readonly property: string }
  | { readonly from: "confirm" } | { readonly from: "absent" };   // setByConfirm; false / [] / undefined
export interface SelectedAction { readonly name: string | undefined; readonly how: "single" | "typed" | "named" | "default" }
/** Декларация выбранной единицы — никогда слитое представление. */
export interface CallSlice {
  readonly arguments: readonly ArgumentSpec[];
  readonly positionals: readonly ValueSpec<"positional">[];      // порядок объявления
  readonly variadic?: VariadicSpec; readonly verbatim: boolean;
  readonly refuse?: Readonly<Record<string, string>>; readonly rules?: readonly ArgumentRule[];
  readonly needs: Needs;
  readonly siblings: readonly CommandArgument[];                  // scopeByAction — для applies-to
}
export interface BoundArgument {
  readonly argument: ArgumentSpec; readonly raw: string | true | readonly string[];
  readonly value: unknown;                                        // kind.parse, не resolve
  readonly provenance: Provenance;
}
export interface BoundCall<V = Record<string, unknown>> extends ParsedCall<V> {
  readonly command: string; readonly selected: SelectedAction; readonly slice: CallSlice;
  readonly bound: readonly BoundArgument[];                       // порядок ввода
  readonly optionsEnded: boolean;
}

export function selectAction(shape: CallShape, input: CallInput, command: string):
  { readonly selected: SelectedAction; readonly slice: CallSlice; readonly rest: CallInput };
export function bindCall(shape: CallShape, input: CallInput, command: string): BoundCall;   // строго, бросает ArgumentError
export function scanCall(shape: CallShape, argv: readonly string[]): ScannedCall;          // мягко, для автодополнения
```

`ParsedCall` (`values`, `action`, `given`) остаётся надтипом: `call.action === selected.name`, `given` — флаги и опции
в порядке ввода (для `callFacts` и `--json`), поэтому `effect.ts` и тела не меняются. `parseCall(shape, argv, command)`
остаётся обёрткой `bindCall(shape, { kind: "argv", argv }, command)`.

`selectAction` — единственная реализация правила: argv — первое слово без `-` и известное → `typed`; неизвестное →
`UnknownActionError` (`unknown action: X (expected …)` + did-you-mean); нет слова или слово с `-` → `default`, без
default → `<cmd> needs an action: …`. Named — `args.action` строка и известна → `named`; строка неизвестна → тот же
`UnknownActionError` с тем же текстом; отсутствует или `""` → `default`/отказ, как в argv. Потребители:
`bindCall`, `scanCall`, `jsonTokenGiven` (становится `scanCall(...).given.includes("json")`), справка (выбор
действия для `--help`-запроса и для `effectNote`, §7), автодополнение (§9), `toolArguments` (обратное
преобразование `Advice` → шаг MCP: `bindCall(argv)` → свойства из `bound`).

## 3. Связывание MCP по именам

`executeCommand(app, name, input: CallInput, io)` — вход меняется с `argv` на `CallInput` (консоль передаёт
`{kind:"argv"}`); MCP передаёт `{kind:"named", args, confirmed}`. `handleAppToolCall` больше не зовёт `validate` и
`toArgv` для тела спецификации: отказ стадии `parse` — тот же ответ `isError` с текстом ошибки, что и сейчас.

`bindNamed` (внутри `bindCall`) — порядок отказов, общий с argv; первый отказ останавливает связывание на обеих
поверхностях:

| Шаг | Что | Консоль | MCP | Текст |
| --- | --- | --- | --- | --- |
| 1 | `refuse`-токены | да | нет (свойства, которых нет в декларации, — шаг 3) | причина декларации |
| 2 | Выбор действия (неизвестное, нет обязательного) | да | да | общий, байт в байт |
| 3 | Неизвестный аргумент; аргумент другого действия | да | да | applies-to — общий, с меткой декларации (`--key`, `<key>`); unknown — эхо того, что прислали (`--x` / `x`) |
| 4 | JSON-тип (boolean / string / string[]) | — | да | только MCP, имя свойства (как сейчас) |
| 5 | Флаг с `=value`, опция без значения, повтор опции, `--` | да | невыразимо | только консоль |
| 6 | Значения: вид (`parse`/`choices`/пусто) | порядок ввода | порядок объявления среза | общий, байт в байт |
| 7 | Пропуск позиционного (дан поздний при отсутствующем раннем) | невыразимо | да | `requiredArgumentRefusal(ранний)` — голос binder'а |
| 8 | `count` variadic, обязательные (порядок объявления), правила | да | да | общий, байт в байт |

Variadic в named-форме кладётся в свой слот напрямую: сдвига через `--` больше нет, поэтому особый случай
«variadic дан, обязательный позиционный пропущен» (`call.ts:269–281`, раздел sweep'а 226–261) превращается в
обычный шаг 8. `confirm: true` выставляет `setByConfirm`-флаги только выбранного среза (provenance `confirm`).

Сохраняемые намеренные ограничения MCP (перечисляются в `call.ts` и в CHANGELOG дословно): `""` у опции или
позиционного = «не дано» (клиенты шлют пустые поля, backlog R9-B); `false` у флага = не дано; пустая строка внутри
variadic — отказ; JSON не выражает повтор опции, `--`, inline-форму и `refuse`-токены; дубликаты ключей схлопывает
`JSON.parse`. Отменяемое: MCP-only отказ «`<name>` cannot begin with -» (`positionalDashMessage`) — в S2.3 он остаётся
правилом binder'а только для позиционных без вида, в S2.4 заменяется правилом вида `text` для обеих поверхностей (§4).
Изменение для MCP: отказ один (первый), а не список через `; `. Это цена одинакового порядка; список лишь
повторял бы порядок, который клиент всё равно проходит по одному.

Legacy `AppCommand` (публичный `run(ctx, args)`): `validate` legacy-ветки (`choices`, required) + `toArgv` остаются в
`integration/mcp/legacy.ts` — единственное место, где named превращается в argv.

## 4. Виды значений аргумента

### 4.1. Тип и место объявления

```ts
// core/values/kind.ts
export type KindName = "choice" | "count" | "port" | "pattern" | "duration" | "since"
  | "name" | "id" | "checksum" | "absolutePath" | "localFile" | "localDirectory" | "recipeRef" | "image" | "text"
  | "hostId" | "sshDestination" | "commandName";   // решения: §3 «Вид для host id», Q4, N1

export interface InvalidSample { readonly raw: string; readonly stage: "parse" | "prepare"; readonly why: string }

export interface ValueKind<T, R = T> extends ValueParser<T> {     // ValueParser: expected, example, invalidExample, parse
  readonly kind: KindName;
  readonly choices?: readonly string[];                            // только choice
  readonly invalid: readonly InvalidSample[];                      // генератор недопустимого
  readonly valid?: (fixture: KindFixture) => string;               // контроль, обязанный дойти до run (default: example)
  readonly resolve?: (value: T, local: LocalScope) => Promise<R>;  // локальный факт, стадия prepare (S2.5)
}
```

`ValueSpec<K, N, T>` теряет `parse` и `choices` и получает обязательное `value: ValueKind<…>`; `VariadicSpec` —
`value` тоже (элементный вид). Структурная проверка `checkArguments` отказывает value-аргументу без `value`
(`kind-missing`) — это и есть метрика «аргументы без вида = 0»: свободный текст объявлен явно как `text(reason)`.
`argumentsView` проецирует вид в публичную форму `CommandArgument`: `choices` (для `choice`) и `parse` (сам вид — он
`ValueParser`), поэтому справка, схема MCP (`enum`), автодополнение и `CommandArgument` развёртываний не меняются
байтово. У legacy-команд `CommandArgument.parse/choices` остаются как есть (публичный API).

Конструкторы (`core/values/kinds.ts`, обёртки над существующими парсерами `value.ts`/`durations.ts`/`names.ts`/
`image-ref.ts`):

| Вид | Грамматика (parse) | `resolve` (prepare) | Недопустимые (`invalid`) |
| --- | --- | --- | --- |
| `choice(values)` | член списка, текст `choicesRefusal` | — | `outside-the-list`, `""` |
| `count`, `positive`, `port`, `pattern`, `interval`, `since` | нынешние парсеры | — | нынешний `invalidExample`, `""` |
| `name(kind, "create" \| "read")` | `safeName(kind)`; режимы в S2.4 ведут себя одинаково, S3.1 разводит политику | — | `Bad_Name`, `../x`, `-x`, `""` (+`CON` только для create после S3.1) |
| `id(kind)` | не пусто, без ведущего `-`, без `/` `\`, не `.`/`..`, без управляющих; `provider` — нынешний regex `provider.ts:56`. Для host id не применяется (вид `hostId` ниже) | — | `../x`, `-x`, `a/b`, `""` |
| ~~`checksum(form)`~~ | ~~`hex64` (set-id) или `declaration` (формат печати `plan`, см. вопрос Q6)~~ — заменено решением Q6 | — | `zz`, `""` |
| `checksum("hex64")` | `/^[0-9a-f]{64}$/` для `apply --expect` и `set receipts --set-id`: `declarationChecksum` — `sha256(...).digest("hex")` (`service/checksums.ts:15`, `management/lock.ts:173`), `apply` сравнивает строго (`apply.ts:431`). Пример `9f86d081` (`apply.ts:43`) — префикс, который никогда не совпадёт; заменяется полной строкой `9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08` | — | `zz`, `9f86d081`, `""` |
| `hostId` | не пусто, без управляющих символов, остальное разрешено (`:` и пользовательский `HOSTNAME` допустимы). **Не** `id("host")`: записанный формат — `<COMPUTERNAME \| HOSTNAME \| hostname()>:<platform \| linux-<pid ns>>` (`runtime/lock/process-identity.ts:20–32`; пример `DESKTOP-1:win32`, `srv:linux-4026531836`), у записей до `7e6e0fd` суффикса может не быть; сравнение строгое (`security/instance-mutation-guard.ts:175`). Отказ записанному id сделал бы чужую блокировку неснимаемой (I14) | — | `""`, `a\u0007b` |
| `sshDestination` | не пусто, без ведущего `-`, без пробелов и управляющих (Q4): `deploy` передаёт `<target>` в `ssh`/`rsync` позиционно без `--` (`deploy/server.ts:43–60`, `deploy/sync.ts:105–133`) | — | `-oProxyCommand=x`, `a b`, `""` |
| `commandName` | имя есть в реестре команд (parse, did-you-mean); в схему MCP **не** проецируется как `enum` (N1) | — | `no-such-command`, `""` |
| `absolutePath("posix-remote")` | нынешний `validatedRemoteRoot` | — | `relative/x`, `""` |
| `localFile("artifact")` | не пусто | существует, обычный файл → `LocalArtifact` | `""` (parse); путь к отсутствующему, каталог (prepare) |
| `localDirectory("recipe-source")` | не пусто | каталог с `recipe.json` → `LocalRecipeSource` | отсутствующий, без `recipe.json` (prepare) |
| `recipeRef()` | `name("recipe","read")` | `recipes/<n>/recipe.json` есть в текущем источнике → `RecipeRef` | `Bad_Name` (parse), `absent-recipe` (prepare) |
| `image()` | `imageRefValue` + отказ ведущему `-` | — | `-x`, `""` |
| `text(reason, { leadingDash: "refuse" \| "allow" })` | не пусто; `refuse` по умолчанию | — | `""`, `-x` при `refuse` |

`R` — брендированные типы (`LocalArtifact = { readonly path: string; readonly [ARTIFACT]: true }` и т. п.),
конструируемые только своим `resolve`. Проверка свойства берёт случаи из `invalid` (стадия ожидаемого отказа задана
в образце) и контроль из `valid`/`example` — раздел `invalidOf`/`ARGUMENT_REFUSAL_SHAPE`/`"Bad_Name"`
(`property.check.ts:74–84, 157–187`) удаляется: эвристика по форме текста больше не нужна.

### 4.2. Миграция: подсчёт по коду

Перечень получен импортом `openclawCommands` (только чтение) на `0cdea4d`: 86 мест value-аргументов в телах
развёртывания, из них с `parse`/`choices` — 36, без — 50.

| Вид | Мест | Где | Сейчас |
| --- | --- | --- | --- |
| ~~`id("host")`~~ (`--break-foreign-lock`) — заменено решением §3 «Вид для host id» | 28 | одно объявление `BREAK_FOREIGN_LOCK_ARGUMENT` | свободно |
| `hostId` (`--break-foreign-lock`) | 28 | то же объявление | свободно |
| `choice` | 6 | backup create/pull/verify `--profile`, host `<context>`, mcp-setup `--client`, set forget `--kind` | choices |
| `count`/`positive` | 6 | logs/incident/recipe diagnose/recipe logs `--tail`, backup `--keep`, operations `--limit` | parse |
| `interval`/`since`/`pattern`/`port` | 5 | backup/watch install `--interval`, logs `--since`/`--grep`, expose ssh `--local-port` | parse |
| `image` | 1 | upgrade `--image` | parse (без отказа `-`) |
| `checksum` | 2 | apply `--expect`, set receipts `--set-id` | parse |
| `id` (operation, receipt, provider) | 4 | rollback `--operation`, operations `<id>`, set receipts `--receipt`, configure-provider `--provider` | parse ×2; `operations <id>` и `--provider` свободны (provider — regex в prepare) |
| `name(...)` | 8 | create: recipe import `<new-name>`, recipe new `<name>`, set build `--name`; read: set validate `--name`, secrets `--store`, destroy `--confirm-name`, set forget `--name` (`name("owned-object","read")`, Q7: имена в ledger записаны после `safeName`, `provision-agent/declaration.ts:43–45`), configure-provider `--env` (`name("env-var")`) | parse ×5; 3 свободны |
| `recipeRef` | 9 | accept `<recipe>`, recipe verify/onboard/diagnose/install/remove/status/logs `<name>`, provision-agent `<recipe>` | `nameValue("recipe")`, существование — в `run` |
| `localFile("artifact")` | 8 | plan/apply/accept/set validate/set try `--set`, set diff `--from`/`--to`/`<artifacts…>` | свободно; 4 из 8 проверяют существование в prepare вручную |
| `localDirectory` | 1 | recipe import `<name>` (источник) | свободно |
| `absolutePath` | 1 | deploy `--path` | свободно, проверка в prepare и повторно в run |
| `text` | 7 | restore/push/verify `<archive>` (путь на цели), ~~deploy `<target>`~~ (заменено решением Q4 → `sshDestination`), cli/exec/host `<args…>` (`allow`, verbatim) | свободно |
| `sshDestination` | 1 | deploy `<target>` (вычитается из `text`: `text` — 6) | свободно; доходит до `ssh`/`rsync` как опция при ведущем `-` |

Шлюз (§7): `check <filter…>` → `text(allow)`, `--jobs` → `count`, `--require` → `text` (список возможностей —
вопрос Q7), `new-app <name>` → `name("deployment","create")`, `remove-app <name>` → `name("deployment","read")`,
`completion <shell>` → `choice`; 6 мест, 2 с видом сейчас. ~~Диспетчерский `help <command>` — `choice` из реестра.~~
Заменено решением N1: диспетчерский `help <command>` — вид `commandName` (проверка по реестру в parse с
did-you-mean), без `enum` в схеме MCP: проекция `choice` добавила бы `enum` всех команд в инструмент `help`
(`mcp-tools-list.json`, запись `help`, сейчас `command: { type: "string" }`) — рост бюджета `tools/list`, который
ratchet не поднимает, и enum, зависящий от развёртывания. `check --require` — `text` (решение Q7): список
возможностей живёт в `tools/checks/kit/capabilities/`, неизвестная отказывает до запуска проверок
(`kit/capabilities/gate.ts:33`), без контакта с целью.

## 5. Подготовленный план

### 5.1. Тип и граница фаз

```ts
export type Prepared<P> = P & { readonly [PREPARED]: true };      // строит только конвейер
interface PrepareCall<V> extends BoundCall<V> {
  refuse(argument: keyof V & string, clause: string): never;     // отказ в голосе binder'а
  derive<T>(argument: keyof V & string, kind: ValueKind<T, unknown>, raw: string): T;  // производное через вид
}
interface Phases<V, P, N extends Needs> {
  readonly prepare?: (call: PrepareCall<V>, local: LocalScope) => P | Promise<P>;
  readonly run: (on: On<N>, plan: Prepared<P>) => Promise<void | ExitCode>;
}
```

Стадия `prepare` конвейера: (1) для каждого связанного значения с `resolve` — `await kind.resolve(value, local)`;
отказ — `ArgumentError` с меткой аргумента; (2) `Values<A>` в `PrepareCall` уже содержит разрешённые типы `R`;
(3) `prepare` тела или тождественный план. `run` получает только `Prepared<P>`.

Что обеспечено типом, а что — проверкой (калибровка):

* **Тип:** `run` не видит `BoundCall`, сырой ввод и неразрешённые значения; функции бизнес-слоя принимают
  `LocalArtifact`, `RecipeRef`, `LocalRecipeSource`, `RecipeName` (бренд вида `name`) — строку без каста не передать.
  Конструктор `ArgumentError` получает приватный токен модуля `core/command` (класс экспортируется для
  `instanceof`); построить отказ аргумента можно только binder'ом или `call.refuse/derive` в prepare.
* **Не тип:** TypeScript не запрещает `throw new Error("invalid recipe name …")` в `run`. Поэтому: конвейер
  превращает `ArgumentError`, вылетевший из `run` (например из вложенного `runOnContext`), в `LateArgumentError`
  (ошибка-инвариант, текст сохраняется); ratchet `kindCastsOutsideValues` (каст `as RecipeName`/`as LocalArtifact`
  вне `core/values`) = 0; ratchet `grammarCallsInRun` (вызовы `safeName(`, `nameValue(`, `imageRefValue.parse(` в
  `commands/**` вне объявлений и prepare) с базой, уходящей в 0 к S2.5; sweep с fixture (§10).

### 5.2. Что вычисляет prepare по командам (S2.5)

| Команда | Prepare / resolve | Что получает run |
| --- | --- | --- |
| recipe import | resolve источника (каталог, `recipe.json`); `derive("name", name("recipe","create"), basename(source))` если нет `new-name`; отказ «уже существует» | `{ source: LocalRecipeSource, name: RecipeName }` |
| recipe new | `name("recipe","create")`; отказ «уже существует» | `{ name: RecipeName, withHooks }` |
| recipe verify/onboard/diagnose/install/remove/status/logs | `recipeRef` (замена `loadRecipe` из `runLocked`) | `RecipeRef` (+ прочие значения) |
| provision-agent | `recipeRef` + `loadRecipeAgentBundle` (локально) | `{ recipe: RecipeRef, bundle }` |
| accept | `localFile` для `--set`; `recipeRef` для `<recipe>` без `--set`; с `--set` — членство в манифесте остаётся в run как содержательный отказ (Q5). Решение Q5: в run, но все отказы по выбранным рецептам (членство, наличие `acceptance.json`) — сразу после распаковки, **до первого обращения к `ctx`**: `acceptFromSource` получает предварительный проход `loadChecks` по всем рецептам до `observeRuntime`/`gatherInspection` (сейчас они идут первыми, `accept.ts:545–548`, а отказ `loadChecks` — позже, `:412–413`) | `AcceptPlan` с брендами |
| set try / set diff / set validate / plan / apply `--set` | `localFile("artifact")` (заменяет `refuseMissingArtifact` в 4 prepare и добавляет его try/diff); распаковка и integrity — в run (`ArtifactIntegrityError` — факт содержимого) | `LocalArtifact` |
| apply `--expect` | `checksum("hex64")` (S2.4, Q6) | строка-бренд `Checksum` |
| operations `<id>`, rollback `--operation` | `id("operation")`; существование записи — факт цели, остаётся в run | `OperationId` |
| set forget | `choice` + `name("owned-object","read")` (Q7); существование объекта — факт цели | `{ kind, name }` |
| deploy | `absolutePath`; `remoteRecipesPath`, `frameworkSourceRoot`, `deploymentName` — локальные, переезжают из `resolveDeployArguments` | `DeployPlan` без повторного `validatedRemoteRoot` |
| configure-provider, destroy | виды `id("provider")`, `name("env-var")`; совпадение `--confirm-name` — `call.refuse` | как сейчас |

Не переезжает: всё, что требует цели (запись операции, существование объекта, бутстрап) — это не аргументный
факт. `prepare` выполняется внутри текущего источника набора: `apply` вызывает `provisionAgent(ctx, [recipe])` под
`withSetSource`, и `runOnContext` выполняет resolve там же, поэтому `recipeRef` видит рецепт артефакта.

### 5.3. Адаптер legacy `run(ctx, args)`

`runOnContext(body, ctx, args)` идёт тем же путём: `bindCall` → resolve → prepare → run. Фасад
`materializeCommands` (`AppCommand.run`) и функции-обёртки (`recipe(ctx,args)`, `accept`, `operations`,
`provisionAgent`, `secrets`, `recoverEnv`, `applyConfig`, `up`, `restart`) не меняют сигнатуры. Публичный
`AppCommand.run(ctx,args)` развёртываний — legacy-ветка `executeCommand` без изменений (backlog: парсинг внутри
`run`), MCP для них — `legacy.ts` (§3).

## 6. Needs по действию

`Needs = "nothing" | "local" | "deployment" | "target"`; `On<"nothing"> = NothingScope` (без развёртывания),
`On<"local"> = LocalScope`, `deployment` и `target` — как сейчас. `ActionSpec.needs?: Needs` (default `"target"`),
`SingleBody.needs` — как есть. Конвейер берёт `slice.needs` выбранной единицы: `nothing`/`local` пропускают
`environment` и `context`; `useApplicationRecipesDir` — для всех, кроме `nothing`. `preparesEnvironment` — только
`target` (как сейчас).

Объявления: `recipe import`, `recipe new` → `local`; `mcp-setup` → `local` — кандидат (backlog: падает на
`LOCAL_TARGET_UNSUPPORTED`, хотя пишет только локальные файлы; требует проверки тела, Q8); `recover-env` остаётся
`deployment`. Решение Q8: `mcp-setup` → `local` (`runMcpSetup` не читает `ctx` — только `deploymentDir()` и
`setupProjectMcp`, `commands/management/credentials/mcp.ts:113–121`); `lock --check` остаётся `target`: он читает
цель — `ctx.runtime.imageReference()` и инвентарь плагинов/навыков через `openclawCliBatch`
(`commands/management/lock.ts:143–161`, `runLock` → `currentComposition(ctx, { includeExtensions: true })`, `:335`).
Строка 28 backlog P3 ошибочно относит `lock --check` к локальным командам; она переписывается в S2.6a. Возражение backlog'а «неверное `needs` молча запустит команду цели локально» снимается типом: у
`LocalScope` нет `transport`/`runtime`, тело с `needs: "local"`, трогающее цель, не компилируется.

I5 сохраняется: аргументные отказы — `parse`/`prepare`, до любой стадии с контактом; для `local` контакта нет вовсе.
I4/I6: needs объявлен один раз и читается одним конвейером. ~~Эффекты `recipe import/new` (`destroy` от тела) не
меняются этим шагом (Q1).~~ — заменено решением Q1: `recipe import`/`recipe new` объявляют `change` в S2.6a вместе с
`needs: "local"` (оба отказывают, если рецепт уже есть, `recipe/actions.ts:205`, `:287`, — только добавляют файлы);
`mcp-tools-list.json` не меняется, исчезает только требование `confirm` этих двух действий.

## 7. Команды шлюза

Варианты: (A) перевести 7 команд (`check`, `new-app`, `remove-app`, `list`, `version`, `completion`, `init`) на тела
`commandBody({ needs: "nothing", … })` и исполнять общим конвейером; (B) оставить `GateCommand` и только связывать его
аргументы `bindCall` по `{ arguments }`.

Стоимость B: binder работает по `CallShape`, так что связывание дёшево, но остаются второй путь run
(`captureGateRun`, без `Execution`, без стадий и `changed`), ветка `effectProfile` по `command.effect`, отдельная
справка (`gateCommandHelp` + `renderHelp` без пометки эффекта), `gateConfirmationRefusal`, невозможность
`setByConfirm` и `effect` у флага (`CommandArgument` их не несёт — backlog: `remove-app` с `confirm: true` только
dry-run) и правил (backlog: `GateCommand` без `rules`). Это ровно класс «второй тип команды», который дал находки R17–R18.

Стоимость A: 7 объявлений; `runGateCommand` и `handleGateToolCall` вызывают `executeBody` (`executeCommand` без
`app` для `needs: "nothing"`); `run` возвращает `ExitCode`. Тип `GateCommand` остаётся фасадом
(`materializeGate(entry)`, `run(args) → executeBody`), поэтому `tools/clawforge.ts`, `entry/{bin,registry}.ts`,
completion и реестр не меняют вызовов (`entry/*` редактирует S1.3). Публичного контракта у `GateCommand` нет: пакет
экспортирует только `./app`, `./mounts`, `./commands`, `./private-config`. Сохраняются: имена инструментов MCP шлюза и
`inputSchema` (кроме объявленного ниже), коды выхода, текст справки, запуск `control-mcp`/launcher'ов.

**Решение: A.** Видимые изменения: `remove-app` объявляет `yes` как `setByConfirm` с `effect: "destroy"`, базовый
эффект тела — `read` (dry-run), профиль «destructive for some flags»: схема MCP теряет обязательность `confirm`
(становится необязательным), список помечает `*` вместо `!`, `--help` — строка «depending on the flags given»;
`confirm: true` удаляет (backlog-пункт закрывается). `help <gate-command>` везде с пометкой эффекта (одна функция
`renderFullCommandHelp` для любого тела). Отказ аргумента шлюза — стадия `parse` с `--json`-документом у `list --json`/
`version --json` (сейчас документа нет; Q3). Удаляются: `refuseAgainstDeclaration`, `gateConfirmationRefusal`,
`captureGateRun`, ветка `command.effect` в `effectProfile`, `GateCommand.effect` как поле ввода (остаётся в фасаде).
Следствия приняты решением Q3 (документ ошибки `--json`, удаление по одному `confirm: true`), шаг S2.6b.

## 8. Факты результата по стадиям

`Execution` получает `reachedRun: boolean`, `environmentWrote?: boolean` (ensureEnvironment создал `.env`/токен) и
`exitCode?`; `stage`, `error`, `facts` — как сейчас (`facts` — намерение вызова, не факт изменения).
`changedFact(command, fields, facts, execution)`: `stage ∈ {parse, confirm, prepare}` → `false`; `environment`/
`context` → `environmentWrote === true`; `run` — как сейчас (`changedWhen`, `read` → `false`, булево документа,
иначе `true`: прерванный run мог изменить состояние частично). `ensureEnvironment` возвращает
`{ token, wrote }` (`integration/provision.ts`, одна правка вызова в `execute.ts`). Конверт строится и при отказе
до `run` у structured-команды (как сейчас); меняется только `changed`. Отказ `parse`/`confirm` — по-прежнему
голый `isError` без конверта. Legacy-ветка: те же правила по стадии.

## 9. Автодополнение

Таблица переходов `step(state, token, slice) → Transition` в `parse.ts`; виды переходов: `flag`, `option-inline`,
`option-pending`, `option-value`, `positional`, `variadic`, `options-end`, `tail-start` и отказы
`unknown`, `flag-with-value`, `option-missing-value`, `option-repeated`, `no-slot`, `refused-token`. Строгий режим
(`bindCall`) бросает на отказе; мягкий (`scanCall`) записывает отказ и продолжает с **тем состоянием, в котором
строгий был бы без этого токена**: неизвестный и `flag=value` пропускаются; опция перед объявленным длинным флагом
остаётся без значения, флаг связывается как флаг (сейчас мягкий отдаёт его опции как значение — расхождение со
строгим); повтор опции переписывает значение. Отличается только реакция на отказ, не решение о состоянии.

`ScannedCall = { selected, slice, entries, given, optionsEnded, pending?, tail, refusals }`. `completionCandidates`
читает `scanCall` по `RegistryEntry.shape: CallShape` (диспетчерские записи — `{ arguments }`): действие — `selected`
(неизвестное → fallback `*`, но решает `selectAction`), значения опции — по `pending` в срезе действия. bash/pwsh
остаются фиксированными интерпретаторами таблицы (дизайн этапа 5); `valueOptions` по команде точен при структурном
условии «имя не бывает опцией в одном действии и флагом в другом» — оно становится проверкой. Дифференциальная
проверка получает второй уровень: `completionCandidates` против оракула из `scanCall` без таблицы, на тех же строках.

## 10. Проверки

**Fixture (из S0.2, `tools/checks/kit/`).** S2 использует `deploymentFixture()`: временный root, валидные `app.ts`/
`.env`, `recipes/demo/recipe.json` (+ `agent/config.json`, `acceptance.json`), собранный артефакт `demo.tar`,
записывающий транспорт, который отвечает правдоподобно (не бросает). `KindFixture` даёт виду пути и имена для
`valid`/`invalid` (`artifact: fixture.artifact`, `recipeRef: "demo"`, missing: `fixture.path("absent.tar")`).
`CommandIo.observe?: (stage: Stage) => void` — крючок конвейера перед каждой стадией; sweep бросает
`ReachedRun`-сентинел в `observe("run")`, поэтому реальные тела не исполняются, а достижимость доказана.

**Учёт стадий.** Каждый случай записывает `{ unit, argument, sample, expected, reached }`. Правила: допустимый
контроль единицы обязан дойти до `run` (иначе провал с причиной — ошибка настройки не «held»); образец `invalid`
обязан остановиться на объявленной стадии (`parse`/`prepare`) с `ArgumentError`, `argument` = имя, ноль контактов и
ноль блокировок; консоль и MCP — один текст (случаи шагов 2, 3 (applies-to), 6–8 §3). Итог печатает долю
допустимых, достигших `run` (метрика плана: 0 → 100 %), по единицам и видам.

**Проверки.** `property.check.ts` — на `invalid`/`valid` видов, MCP через `{kind:"named"}`; раздел «positional scope»
заменяется равенством `bindCall(argv)` и `bindCall(named)` по `BoundCall` (тот же `selected`, значения, первый отказ).
Новые: `binder.check.ts` (таблица §3 построчно); `needs.check.ts` (`recipe import/new` при транспорте, бросающем на
любом вызове, доходят до `run`); `mcp-changed.check.ts` (отказ на каждой стадии до `run` у destroy-команды →
`changed:false`); help-паритет (`help X`, `X --help`, MCP `help` — один текст для каждой записи реестра, со строкой
эффекта). Меняются `gate-commands.check.ts` (`executeBody`, `remove-app` + confirm) и `completion-behaviour.check.ts`.

**Отрицательные контроли (реестр S0.3).**

| ID | Правка в изолированной копии | Обязана упасть |
| --- | --- | --- |
| NC-S2-action | `bindNamed` при неизвестном `args.action` берёт `defaultAction` | `binder.check.ts`, `property.check.ts` (unknown action, MCP) |
| NC-S2-slot | named-binder раскладывает позиционные по слитому `argumentsView` | `property.check.ts` (равенство argv/named) |
| NC-S2-late-artifact | у `localFile("artifact")` убран `resolve` | `property.check.ts` (missing artifact на `prepare`) |
| NC-S2-derived-name | `recipe import` prepare не вызывает `derive` | `property.check.ts` (`Bad_Name/` источник) |
| NC-S2-needs | `recipe import` объявлен `target` | `needs.check.ts` |
| NC-S2-changed | `changedFact` игнорирует стадию | `mcp-changed.check.ts` |
| NC-S2-late-error | тело бросает `ArgumentError` из `run` через `runOnContext` | `property.check.ts` (`LateArgumentError` = 0) |
| NC-S2-lenient | мягкий режим снова отдаёт объявленный флаг опции | `completion-behaviour.check.ts` |
| NC-S2-gate-note | `renderHelp` для записи шлюза без `effectNote` | help-паритет |
| NC-S2-accept-order | в `acceptFromSource` вернуть `observeRuntime`/`gatherInspection` перед предварительным проходом `loadChecks` (Q5) | sweep: локальный отказ (`accept --set X <recipe>` без рецепта или без `acceptance.json`) обязан предшествовать любому контакту с целью — sweep видит контакт до отказа |

**Ratchet'ы.** Новые: `actionSelectionOutsideCore` (чтения `defaultAction`/`actions[...]`-выбора вне
`core/command/call.ts`) 3 → 0 к S2.8; `untypedValueArguments` 50 (+4 шлюза) → 0 к S2.4 (структурно, через
`specData`, не лексически); `argvRebuilders` (`toArgv` вызывается только из `mcp/legacy.ts`) = 1;
`argumentErrorOutsideCore` (`new ArgumentError` вне `core/command`) 4 → 0 к S2.5; `kindCastsOutsideValues` = 0;
`grammarCallsInRun` — база при S2.4, 0 к S2.5. Удаляемые символы (в список retired): `positionalDashMessage`,
`gateConfirmationRefusal`, `refuseAgainstDeclaration`, `captureGateRun`, `jsonTokenGiven`, `validate`/`toArgv` для
тел спецификации. Не поднимаются: `legacyCommands` (0), `rawArgvPredicates` (0), бюджет `tools/list`.

## 11. Шаги

Каждый шаг — один коммит с зелёным `npm run gate`, изменения поведения — diff эталонов и строка CHANGELOG.

**S2.2 Форма вызова.** Файлы: `core/command/call.ts` (новый), `parse.ts` (таблица переходов, `parseCall` — обёртка),
`execute.ts` (`bindCall`, `jsonTokenGiven` → `scanCall`), `effect.ts` (`callFactsFor` через `bindCall`),
`view.ts`, `index.ts`, `integration/gate.ts` (`refuseAgainstDeclaration` → `bindCall({arguments})`, временно),
`integration/mcp/call.ts` (`toolArguments` через `bindCall`); проверки `binder.check.ts`, правки
`parse.check.ts`/`view.check.ts`. Поведение: без изменений, эталоны побайтно. CHANGELOG: нет (внутреннее).

**S2.3 MCP по именам.** Файлы: `call.ts` (`bindNamed`), `execute.ts` (`CallInput`), `entry/cli.ts` (передаёт
`{kind:"argv"}`), `integration/mcp/server.ts` (app/gate/help через binder), `integration/mcp/call.ts` → `legacy.ts`
(`validate`/`toArgv` legacy), `property.check.ts` (MCP-случаи через named). Diff: MCP unknown action — текст консоли
вместо applies-to; MCP applies-to у позиционного — `<name> applies to …`; MCP — один отказ вместо списка.
CHANGELOG: «MCP tool calls bind arguments by name with the console's own binder: an unknown action is refused as
such, a positional never lands in another action's slot, and the first refusal is reported in the console's words».

**S2.4 Виды.** Файлы: `core/values/{kind,kinds}.ts` (новые), `spec.ts` (`value`, `kind-missing`), `parse.ts`
(`convert` через вид), `view.ts` (проекция); объявления всех 86 + 6 мест §4.2 (≈25 файлов `commands/**`,
`entry/checkout-gate.ts`, `integration/{version,completion/index,deployment/init}.ts`); `property.check.ts`. Diff: `operations ../x`, `operations -x` — отказ
на `parse`; `upgrade --image -x` — отказ вида; `restore/push/verify -- -x`, `deploy -- -x` — отказ на консоли тоже
(было только MCP); `configure-provider --provider/--env` — текст в голосе вида (`--provider …`), стадия `parse`
вместо `prepare`; `set forget --name Bad/x` — отказ `name(read)` (Q7). CHANGELOG: перечень по командам.
По решениям: `--break-foreign-lock` — `hostId` (любой записанный id принимается, отказ только пустому и с
управляющими); `deploy <target>` — `sshDestination`, отдельная строка CHANGELOG «`deploy` refuses a target that starts
with `-` (it reached ssh as an option)» (Q4); `apply --expect`/`set receipts --set-id` — `checksum("hex64")`, пример
`apply.ts:43` — полная 64-символьная строка, golden `help-*.txt`, если пример печатается (Q6); `set forget --name` —
`name("owned-object","read")`, `check --require` — `text` (Q7); `help <command>` — `commandName` без `enum`,
`mcp-tools-list.json` не меняется (N1).

**S2.5 Подготовленный план.** Файлы: `core/command/{spec,errors,execute}.ts` (`Prepared`, `PrepareCall`, токен
`ArgumentError`, resolve, `LateArgumentError`, `runOnContext`); команды §5.2 и `lifecycle/backup/index.ts`
(`--native` в direct-call пути); `set/artifacts/install.ts` (сигнатуры на `LocalArtifact`). Diff: нет артефакта у `set try/diff` — отказ на `prepare` до чтения `.env`/секретов;
нет рецепта у `recipe <action>`/`provision-agent`/`accept` — `ArgumentError` на `prepare` (текст прежний, теперь с
`--json`-документом и без контакта при недоступной цели); `recipe import Bad_Name/` — отказ до `Context`.
CHANGELOG: «Local facts of arguments — a missing artifact or recipe, an import source's derived name — are refused
before the deployment's target is read». По решению Q5: `accept.ts` — предварительный проход `loadChecks` по всем
выбранным рецептам до `observeRuntime`/`gatherInspection`; контроль NC-S2-accept-order (§10). После S3.2
пересмотреть: модель portable content может дать манифест как локальный факт prepare.

**S2.6a Needs по действию.** Файлы: `spec.ts`, `execute.ts`, `recipe/index.ts`, (`mcp-setup` — по Q8),
`needs.check.ts`. Diff: `recipe import/new` работают при недоступной/неподдерживаемой цели и битом `.env`.
CHANGELOG: да. По решениям: `mcp-setup` → `needs: "local"` (`commands/management/credentials/mcp.ts`), `lock --check`
остаётся `target` (Q8); `recipe import`/`recipe new` → эффект `change` (Q1). Строка 28 backlog P3 переписывается:
закрыта для `mcp-setup`, `lock --check` из неё убирается как целевая команда. CHANGELOG: «`mcp-setup` works when the
target location is unsupported or unreachable»; «MCP no longer asks for confirm on `recipe import`/`recipe new`,
which only add files».

**S2.6b Шлюз на теле спецификации.** Файлы: `entry/checkout-gate.ts`, `integration/{gate,version}.ts`,
`integration/completion/index.ts`, `integration/deployment/init.ts`, `core/command/{spec,effect,execute}.ts`
(`executeBody`, `ExitCode`, `nothing`), `core/io/help-render.ts`, `integration/mcp/server.ts`; проверки
`gate-commands`, `gate-dispatch`, `property.check.ts` (раздел шлюза — общие случаи). Diff §7 (`remove-app`, пометки,
`help X`, `--json`-документ). CHANGELOG: да. (Добавляет девятый коммит S2 к оценке плана — Q9.)
По решению Q3: golden `mcp-tools-list.json` (`remove-app.required`), `help-checkout.txt` (`!` → `*`, строка
эффекта), `refusals.txt` (документ `--json`). В этом коммите из backlog P3 удаляются строки 19 (gate `remove-app` с
одним `confirm: true` только dry-run'ит) и 22 (`GateCommand` без `rules`).

**S2.7 Факты по стадиям.** Файлы: `execute.ts`, `integration/provision.ts`, `integration/mcp/{call,server}.ts`,
`mcp-changed.check.ts`. Diff: MCP `changed:false` у отказа до `run`. CHANGELOG: да.

**S2.8 Автодополнение.** Файлы: `parse.ts` (мягкий режим на общих переходах), `completion/table.ts`
(`scanCall`, `shape` в записи реестра), `integration/gate.ts` (`RegistryEntry.shape`), проверки completion.
Diff: кандидаты после `cmd --opt --flag ` — флаги команды (было: то же по иной причине; расхождения в строках
эталона не ожидаю, проверить на эталоне скриптов). CHANGELOG: только если эталон скриптов изменится.

Порядок последовательный (все шаги трогают `execute.ts`). Пересечение с S1: `entry/cli.ts` (S2.3, одна строка) и
`help-render.ts` (S2.6b) — согласовать порядок слияния с S1.3/S1.4.

## 12. Риски, отвергнутые альтернативы, вопросы

**Риски.** (1) Ужесточение чтения: `id`/`name(read)` на уже записанных значениях (host id, объекты владения) —
I14 запрещает; грамматики `read` минимальны (без `/`, `..`, ведущего `-`), совместимость проверяется в S2.4 на
значениях, которые пишет сам фреймворк (`newOperationId`, ledger); для host id риск снят видом `hostId` (решение
§3 «Вид для host id»). (2) MCP отдаёт ошибки по одной. (3) `observe` —
тестовый шов конвейера, как `CommandIo.transport`. (4) Схема `remove-app` теряет обязательный `confirm`, удаление
по-прежнему требует `yes` или `confirm`. (5) S2.4 широк (≈25 файлов), механичен; S2.5 может пересечься с S3.3–S3.4
по `set/artifacts/*`.

**Отвергнуто.** Второй MCP-парсер или «исправленный» `toArgv` (кодирование по позиции остаётся источником сдвигов);
ленивый транспорт вместо `needs` (backlog: path bridge требует вида транспорта синхронно); общий Result-слой для
ошибок (не цель плана); распаковка артефакта в prepare для всех команд (требует контракта освобождения staging и
SSH-моста `set try`; оставлено вопросом Q5); вариант B для шлюза (§7); новый генератор автодополнения через callback
(запрещено планом без нового замера).

**Вопросы владельцу.**
Q1. `recipe import`/`new` наследуют `destroy` от тела и требуют `confirm` в MCP; объявить им `change`? Схема не
меняется (у тела остаются destroy-действия), меняется требование `confirm` для двух действий.
→ Решение Q1: `change`, в S2.6a.
Q2. Принять «один первый отказ» в MCP вместо списка? → Решение Q2: принять (S2.3, «MCP reports the first refusal only»).
Q3. Принять следствия D6: `{"error":…}`-документ у `list --json`/`version --json` при отказе и удаление по
`remove-app` с одним `confirm: true` в MCP (закрывает пункт backlog)? → Решение Q3: принять оба; S2.6b, строки 19 и
22 backlog удаляются там же.
Q4. Принять отказ ведущему `-` у `restore/push/verify <archive>` и `deploy <target>` на консоли (`-- -x`)?
→ Решение Q4: принять; `<archive>` — `text("path on the target", { leadingDash: "refuse" })`, `deploy <target>` —
вид `sshDestination` (исправление безопасности: внедрение опции ssh).
Q5. `accept --set X <recipe>`: членство рецепта в артефакте — в run как содержательный отказ (проект) или
распаковка в prepare с освобождаемым планом? → Решение Q5: в run, но до первого обращения к `ctx`; NC-S2-accept-order.
Q6. Формат чексуммы `plan` для `--expect` (сейчас любая непустая строка) — какой регекс считать каноническим?
→ Решение Q6: `/^[0-9a-f]{64}$/`, вид `checksum("hex64")`; формат `declaration` не нужен; пример `apply.ts:43` полный.
Q7. Вид `set forget --name` (`name(read)` или `id`) и `check --require` (`text` или список `choice` из возможностей)?
→ Решение Q7: `name("owned-object","read")`; `check --require` — `text`.
Q8. `mcp-setup` (и `lock --check`) — `needs: "local"` в S2.6a? → Решение Q8: `mcp-setup` → `local`; `lock --check`
остаётся `target` (строка 28 backlog была неверна).
Q9. S2.6 в два коммита (needs и шлюз) — девять коммитов среза вместо восьми. → Решение Q9: принять (S2.6a + S2.6b).

**Решения по новым вопросам** ([decisions](refactor-stage7-decisions.md) §5).
N1. Диспетчерский `help <command>` — вид `commandName`: проверка по реестру в parse с did-you-mean, без проекции в
`enum` схемы MCP (§4.2). N2. README:53 уточняется в S1.4 проекта frame: вход checkout — Git Bash, PowerShell — для
установленного пакета. N3. Пустой `OC_APP` в окружении MCP-клиента даёт в launcher'е тот же отказ, что на консоли
(launcher проходит тот же вход; проект frame §5, S1.3).

**Не проверено.** Ни одна проверка, gate или CLI/MCP-сценарий не запускались; прочитан рабочий каталог основного
checkout (без `git status` — незакоммиченные правки там не исключены). Подсчёт аргументов — read-only импорт
`openclawCommands`. Отсутствие строки эффекта у `help remove-app` внутри развёртывания и в MCP `help` — вывод из кода
`renderHelp`, не воспроизведён. Не проверены: формат host id в `--break-foreign-lock`, где лежит `<archive>`
у `push` (цель или локально), поведение `mcp-setup` без транспорта, точный список эталонов, затрагиваемых S2.3/S2.6b,
и совпадение эталона скриптов автодополнения после S2.8. После решений проверены статически (decisions §3):
формат host id (`runtime/lock/process-identity.ts:20–32` → вид `hostId`), `push <archive>` лежит на цели
(`lifecycle/state.ts:565–581`), `mcp-setup` не читает `ctx` (Q8).
