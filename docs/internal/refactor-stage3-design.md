# Этап 3: спецификация команды и единый конвейер — проектное решение

Дата: 2026-10-01. Основание: [план рефакторинга](refactor-plan-2026-10-01.md), разделы 1–3, этап 3, инварианты
I4–I6; код `main` на `13680b1`. Для исполнителей rf3-spec, rf3-pipeline, rf3-effects,
rf3-mig-{lifecycle,management,operate,orchestration,sets}, rf3-property. Отступления от плана помечены словом
«отступление». Пути — от `tools/framework/`, если не сказано иное.

## 0. Решения коротко

Команда = **тело** в модуле реализации (аргументы, действия, эффект, фазы) + **проза** в файле группы; запись
`{ summary, group, details, ...BODY }` материализуется в обычный `AppCommand`. Один разборщик (`tokenize` + `bind`),
`parseDeclaredArgs` — обёртка над ним. Эффект `read`/`change`/`destroy` на теле, действии и флаге заменяет 28
предикатов. `executeCommand` — один конвейер консоли и MCP. Поверхности этапа 3 читают производное `arguments` (байт в
байт нынешнее) и профиль эффекта; справка по действиям, автодополнение и документация — этап 5.

## 1. Модель объявления

### 1.1. Аргументы, значения, результат разбора

```ts
// core/command/spec.ts
export type Effect = "read" | "change" | "destroy";          // read < change < destroy
export type Needs = "deployment" | "target";
interface ArgumentBase<N extends string> {   // description — полный текст справки; summary — ≤ 60 символов для схемы MCP,
  readonly name: N; readonly description: string; readonly summary?: string;   // обязателен, если description > 60
}
export interface FlagSpec<N extends string = string> extends ArgumentBase<N> {
  readonly kind: "flag"; readonly effect?: Effect /* 1.3 */; readonly setByConfirm?: true /* вместо forceOnConfirmation */;
}
export interface ValueSpec<K extends "option" | "positional", N extends string = string, T = unknown> extends ArgumentBase<N> {
  readonly kind: K; readonly valueName?: string /* у option обязателен */; readonly required?: boolean;
  readonly choices?: readonly string[];   // взаимоисключающе с parse
  readonly parse?: ValueParser<T>;        // нет ни parse, ни choices — непустая строка
}
export interface VariadicSpec<N extends string = string> extends ArgumentBase<N> {
  readonly kind: "variadic"; readonly required?: boolean;
  readonly verbatim?: true;   // добавление при переносах (1.5, п. 3): хвост буквальный; только cli/exec/host
}
export type ArgumentSpec = FlagSpec | ValueSpec<"option"> | ValueSpec<"positional"> | VariadicSpec;

type ValueOf<A> = A extends { kind: "flag" } ? boolean          // false, если флага нет
  : A extends { kind: "variadic" } ? readonly string[]          // [], если нет
  : A extends { parse: ValueParser<infer T> } ? T
  : A extends { choices: readonly (infer C)[] } ? C : string;
type Absent<A> = A extends { kind: "flag" | "variadic" } | { required: true } ? never : undefined;
export type Values<Args extends readonly ArgumentSpec[]> = { readonly [A in Args[number] as A["name"]]: ValueOf<A> | Absent<A> };
export interface ParsedCall<V> {      // action — набранное слово или defaultAction; given — флаги и опции в порядке набора
  readonly values: V; readonly action?: string; readonly given: readonly string[];
}

// core/values/value.ts. Без parameter properties и enum: их не снимает --experimental-strip-types.
export class ValueError extends UserError { readonly clause: string }   // текст после метки аргумента
export interface ValueParser<T> {     // expected: "a number of lines"; example/invalidExample — для проверки-свойства (6.2)
  readonly expected: string; readonly example: string; readonly invalidExample: string; parse(raw: string): T;   // бросает ValueError
}
```

* `refuse` (добавление, сделанное при переносах; operate): точные токены argv (до голого `--`), которые тело или
  действие отклоняет с объявленной причиной до токенизации — `expose tailscale --funnel`. Это не аргумент: в
  справке, схеме MCP и производном `arguments` его нет, отказ — `ArgumentError` на стадии `parse`.
* `verbatim: true` у `VariadicSpec` (добавление, сделанное при переносах; management/sets): буквальный хвост
  (1.5, п. 3) объявляют только `cli`, `exec`, `host`; остальные variadic (`set diff A B --json`) продолжают
  распознавать флаги и опции.
* Публичный `CommandArgument` (`core/app.ts`, экспорт `./app`) получает только `summary?: string`. `ArgumentSpec`
  структурно с ним совместим: производное `arguments` идёт в нынешние рендереры без изменений; `actions` в
  `ArgumentSpec` не пишут, его выводит представление (1.2). Variadic — одна, последняя, сквозная (1.5, п. 3).
* Константы — `as const satisfies ArgumentSpec` (массив — `as const satisfies readonly ArgumentSpec[]`): аннотация
  `: CommandArgument` стирает литералы `name`/`kind`, и значение типизируется как `string`.
* `bind` превращает `ValueError` в `ArgumentError`: `--tail takes a number of lines, not "abc"` (`clause` по
  умолчанию — `takes <expected>, not "<raw>"`; у позиционного метка `<name>`). Парсеры поверх существующих грамматик
  сохраняют нынешние тексты (`--since …`, `--interval must look like …`, `--local-port must be a port number between
  1 and 65535, got: …`) — проза в проверках не меняется.
* Общие парсеры — фабрики в `core/values/value.ts` с необязательным `expected`, чтобы сохранить нынешний текст:
  `countValue("a number of lines")` (целое ≥ 0), `portValue()` (1–65535), `regexValue()` (пустой шаблон допустим, как
  сейчас), `nameValue(kind)` (`safeName`), `nonEmptyValue()` (умолчание). Предметные — у владельца
  грамматики: `sinceValue` в `core/values/durations.ts`, `scheduleIntervalValue({ bareMinutes })` в
  `commands/operate/schedule.ts` (грамматика, проверка cron, ближайшие допустимые), `imageRefValue` в
  `runtime/docker/image-ref.ts`. Их пишет rf3-spec; парсер одной группы (`apply --expect`) — её перенос.

### 1.2. Тело, действия, запись группы

```ts
type On<N extends Needs> = N extends "deployment" ? DeploymentScope : Context;
interface Phases<V, P, N extends Needs> {
  readonly prepare?: (call: ParsedCall<V>, local: LocalScope) => P | Promise<P>;   // нет — план = call.values
  readonly run: (on: On<N>, plan: P) => Promise<void>;
}
export interface SingleBody<A extends readonly ArgumentSpec[], P, N extends Needs> extends Phases<Values<A>, P, N> {
  readonly effect: Effect; readonly needs?: N /* умолчание "target" */; readonly arguments: A;
  readonly refuse?: Readonly<Record<string, string>>;   // добавление при переносах (1.5, п. 5)
  readonly preparesEnvironment?: N extends "target" ? true : never;
}
export interface ActionSpec<A extends readonly ArgumentSpec[], P> extends Phases<Values<A>, P, "target"> {
  readonly summary: string /* ≤ 60, выводится с этапа 5 */; readonly effect?: Effect /* нет — эффект тела */; readonly arguments?: A;
  readonly refuse?: Readonly<Record<string, string>>;   // добавление при переносах (1.5, п. 5)
}
export interface MultiBody {
  readonly effect: Effect; readonly action: { readonly description: string; readonly summary?: string };   // позиционный action
  readonly actions: Readonly<Record<string, Action>>;   // порядок объявления = порядок choices
  readonly defaultAction?: string;                      // без него слово действия обязательно
}
export function commandBody<const A extends readonly ArgumentSpec[], P = Values<A>, N extends Needs = "target">(body: SingleBody<A, P, N>): CommandBody;
export function defineAction<const A extends readonly ArgumentSpec[], P = Values<A>>(action: ActionSpec<A, P>): Action;
export function multiActionBody(body: MultiBody): CommandBody;
export interface CommandEntry extends CommandBody, Pick<AppCommand, "details" | "structured" | "consoleOnly" | "exportsSecrets"> { readonly summary: string; readonly group: CommandGroup }
export function materializeCommands(entries: Readonly<Record<string, AppCommand | CommandEntry>>): Record<string, AppCommand>;
export function specOf(command: AppCommand): CommandEntry | undefined;
export function runOnContext(body: CommandBody, ctx: Context, args: readonly string[]): Promise<void>;
```

* `CommandBody` и `Action` — стёртые типы с меткой-символом `COMMAND_SPEC`; многодейственные — только `target`;
  умолчание — поле тела `defaultAction`, а не признак на `ActionSpec` (отступление: двух умолчаний не бывает по типу).
* `materializeCommands` (один вызов на объект группы) строит лицо `AppCommand`: проза, признаки, `preparesEnvironment`,
  `arguments = argumentsView(body)`, `run = (ctx, args) => runOnContext(body, ctx, args)`, `destructive`/`readOnly`
  из профиля (1.3) для внешних читателей; предикатов и `forceOnConfirmation` нет. Структурные ошибки (повтор имени,
  variadic не последний, `defaultAction` вне `actions`, `effect`/`setByConfirm` не на флаге, `parse` с `choices`,
  `preparesEnvironment` без `target`) бросаются при загрузке модуля.
* `specOf` отдаёт запись, только если `command.run` создан материализацией: `{ ...openclawCommands.backup, summary }`
  сохраняет спецификацию (spread копирует символьный ключ), подмена `run` уводит команду на путь устаревшей (3).
* `argumentsView` (`core/command/view.ts`): одно действие — `arguments` как объявлены. Многодейственная — позиционный
  `action` (текст тела, `choices` — имена действий по порядку, `required` без `defaultAction`); позиционные действий,
  слитые по имени (первое объявление, без `actions`, `required` — если обязателен во всех действиях); флаги и опции
  нынешним `scopeByAction` в порядке «действие по умолчанию, затем порядок объявления» (`required` — если во всех
  действиях). Имя, описанное в действиях по-разному, получает `summary`, составленный как `description` («s1 (a, b);
  s2 (c)»), только если он объявлен во всех частях.

### 1.3. Эффект

Вызов: `base = action?.effect ?? body.effect`; поставлен флаг действия с `effect: "read"` (`--dry-run`, `--check`) —
`read`; иначе максимум `base` и `effect` поставленных флагов (`--apply`, `--yes`). `read` — только наблюдает;
`change` — меняет без подтверждения (архив, декларация, запуск); `destroy` — заменяет или удаляет состояние либо
исполняет произвольную команду. Профиль (статический): `destructive` — у какого-то действия база `destroy` или есть
флаг `destroy`; `alwaysDestroys` — у каждого действия база `destroy` и нет флага `read`; `byAction` — есть `actions`.
Устаревшая команда: `destructive` — её поле, `alwaysDestroys` — `destructive` без `readOnlyWhen` и
`requiresConfirmationWhen`, `byAction` — у аргумента есть `actions`; вызов `read` ⇔ `readOnly` или
`readOnlyWhen(argv)`, `destroy` ⇔ `destructive` и (`requiresConfirmationWhen(argv)` ?? не `read`), иначе `change`;
`changed` — `changedWhen?.(argv)`. Это ровно нынешняя логика `server.ts`, `schema.ts`, `help-render.ts`. Функции —
`core/command/effect.ts`: `callFacts`, `callFactsFor(command, argv)` (для проверок), `effectProfile(command)`.

| Что выводится | Правило |
| --- | --- |
| подтверждение MCP | `destroy` без `confirm: true` → отказ на стадии `confirm` |
| `changed` в конверте | `read` → false; иначе булево `changed` документа, иначе true; у устаревшей сначала `changedWhen` |
| `confirm` во входной схеме | есть при `destructive`; обязателен и «Must be true: destroys state» при `alwaysDestroys`, иначе «Confirm a destructive action» |
| пометки списка и описания инструмента | `alwaysDestroys` → ` !`, ` (destructive)`; `destructive` → ` *`, ` (destructive for some actions)` |
| примечание `--help` | `alwaysDestroys` → «…replaces or destroys state.»; `byAction` → «…depending on the action given.»; иначе «…depending on the flags given.» |
| подготовка окружения | `preparesEnvironment` и эффект не `read` |

Перевод механический, точные значения закрепляет таблица паритета (5.4): `readOnly: true` → `read`; `destructive` без
предикатов (`cli`, `exec`, `host`) → `destroy`; без пометок → `change` (rf3-spec заранее ставит `readOnly: true`
командам `status`, `logs`, `verify`, `mcp-creds` — невидимо: они не `destructive` и не `structured`). Эффект получают
только флаги, которые читают нынешние предикаты: `--dry-run`, `--check` → `read`; `--yes`, `--apply`, `--init-store`,
`--dump` → `destroy`; `secrets --template` → `change`; у команды destroy база `read`. Предикат по `argv[0]` — эффект
действия: backup create `change`, list `read`, prune-replaced/install/uninstall `read` (`--apply` → `destroy`); recipe
list/status/logs `read`, остальные `destroy`; expose, watch — `read` (`--apply` → `destroy`); set
validate/diff/receipts `read`, build `change`, try/forget `destroy`. `restore` и `push` объявляют `{ ...FORCE_ARGUMENT,
setByConfirm: true }`.

### 1.4. Фазы и области

```ts
export interface LocalScope {               // ни Context, ни Transport, ни Runtime — по типу
  deployment(): { readonly name: string; readonly dir: string };   // runtime/deployment.ts
  env(): Promise<Env | undefined>;          // .env как записан (parseEnv), без проверки и умолчаний
  readText(path: string): Promise<string | undefined>; exists(path: string): Promise<boolean>;
}
export interface DeploymentScope extends LocalScope {
  readonly service: string;                 // app.service.name ?? "app"
  transport(): Promise<Transport>;          // из OC_TARGET_LOCATION/OC_WSL_DISTRO/OC_SSH_HOST в .env, без Settings
}
```

* `prepare` может: чистый код, парсеры `core/values`, `LocalScope`, локальное чтение без `Context` (`loadRecipe`,
  `listRecipeDirectories`, `secretStoreFile`, `safeName`). Не может: получать или строить `Context`/`Transport`/
  `Runtime`, брать блокировку, писать файлы, запускать процессы, ходить в сеть. Отказ — `ArgumentError(message,
  argument)` или `UserError`. Держится типом, проверкой-свойством и ревью.
* `needs: "target"` (умолчание) — `run(ctx: Context, plan)`; `needs: "deployment"` — `run(scope: DeploymentScope,
  plan)` без `Context` и подготовки окружения, в этапе 3 только `recover-env`. `"nothing"` не вводится
  (отступление): ни одной команде приложения он не нужен; придёт с командами шлюза в реестр этапа 5.
* `preparesEnvironment: true` — поле тела; `ensureEnvironment()` — только если эффект вызова не `read`.

### 1.5. Правила разборщика

1. Действие: `argv[0]` — имя действия → оно; нет слова или оно начинается с `-` → `defaultAction` со всем argv, без
   него `UnknownActionError("<cmd> needs an action: a, b, …")`; другое слово → `UnknownActionError("unknown action: x
   (expected a, b, …)")` с «did you mean».
2. Токены — нынешний `parseDeclaredArgs`: `--opt value`, `--opt=value` (буквально), отказы на `--flag=…`, повтор
   опции и отсутствие значения с прежними текстами; голый `--` заканчивает опции. Неизвестный `--x`, объявленный
   другим действием, → ``--x applies to `a`, not `b` ``; иначе «did you mean». `given` — все вхождения по порядку.
3. Variadic с `verbatim: true` (`cli`, `exec`, `host`; у прочих variadic флаги распознаются по всему argv,
   добавление, сделанное при переносах): первый токен, который не объявленный флаг или опция и не занимает свободный
   позиционный слот, либо всё после `--`, начинает variadic; дальше всё буквально (`host target --root ls -la`).
4. `bind`: данные значения в порядке набора (пустое без `parse` → `--x needs a value`; `choices` → `--x takes one of
   a, b, not "y"`; `parse`), затем недостающие обязательные (`set forget needs --kind <kind>`).
5. (Добавление, сделанное при переносах.) `refuse`: до токенизации argv (до голого `--`) сверяется с точными
   токенами из `refuse` тела или выбранного действия; совпадение — `ArgumentError` с объявленной причиной.

## 2. `executeCommand`

```ts
// core/command/execute.ts — не реэкспортируется из core/command/index.ts (тянет runtime и integration)
export interface CommandIo {
  readonly surface: "terminal" | "mcp"; readonly confirmed?: boolean;   // MCP: confirm: true
  readonly transport?: Transport;    // проверки: вместо транспорта createContext/DeploymentScope
}
export type Stage = "parse" | "confirm" | "prepare" | "environment" | "context" | "run";
export interface CallFacts { readonly effect: Effect; readonly changed?: boolean }   // changed — только changedWhen
export interface Execution { readonly stage: Stage; readonly error?: unknown; readonly facts?: CallFacts }
export function executeCommand(app: AppDefinition, name: string, argv: readonly string[], io: CommandIo): Promise<Execution>;
```

Предусловие: `app.commands[name]` есть, `--help` обработан в `runApp`. Стадии:

1. **parse** — `tokenize` → `bind` → `ParsedCall`; устаревшая команда — argv как есть.
2. **confirm** — `facts = callFacts(…)`; `mcp`, `destroy`, нет `confirmed` → `ConfirmationRequiredError`.
3. **prepare** — `useApplicationRecipesDir(app.recipesDir)`, `clearRecipesDir()` (переезжают из `runApp` и
   `captureRun`), затем `plan = prepare ? await prepare(call, localScope()) : call.values`.
4. **environment** — `target`, `preparesEnvironment`, не `read` → `ensureEnvironment()`; устаревшая —
   `legacyPreparesEnvironment(command, argv)` (нынешний `preparesEnvironmentFor`).
5. **context** — `target`: `createContext({ mounts, service, settings, secrets, afterBackup, beforeRestore, transport:
   io.transport })`; `deployment`: `deploymentScope(app, io)`.
6. **run** — `run(ctx или scope, plan)`; устаревшая — `command.run(ctx, argv)`.
7. Ошибка любой стадии возвращается, не бросается. `terminal`: контракт `--json` — документ `{"error":{"message":…}}`
   (маскированный, через `emit`), если выбранное действие объявляет флаг `json`, `--json` есть среди токенов до `--`,
   ошибка не `UnknownArgumentError` и с начала вызова не выросли `machineWritesCount()` и `stdoutBytesWritten()`;
   `reportJsonFailure` из `main()` удаляется. `mcp`: конверт строит `captureRun` из `Execution.facts` и вывода.

`runApp` после `requestsHelp` зовёт `executeCommand(…, { surface: "terminal" })`: нет ошибки → 0;
`UnknownArgumentError` → `reportUnknownArgument` и 1; иначе бросает `execution.error`, и `main()` сообщает, как сейчас
(контракт «бросает при неаргументной ошибке» нужен проверкам app-hooks). `captureRun` — `withOutputSink(…, () =>
executeCommand(app, name, argv, { surface: "mcp", confirmed: args.confirm === true }), …)`. `handleAppToolCall`:
`validate` (у спецификации — только форма: неизвестное свойство, boolean/string/string[]; `choices`, обязательность и
значения — тот же разборщик после `toArgv`; у устаревшей — как сейчас) → `toArgv` (флаги `setByConfirm` при
подтверждении) → `captureRun`; отказ на `parse`/`confirm` отвечает как нынешний отказ `validate` (`isError`, текст
`<tool>: <message>` или фраза подтверждения, без `structuredContent`); иначе как сейчас, с `toolEnvelope(command,
output, machineOutput, operationId, execution.facts)`. `readOnly`/`requiresConfirmation` и ветка `recoverEnv` уходят
из `server.ts`. `recover-env` — тело с `needs: "deployment"`: `run` — нынешний `recoverEnvBeforeContext` поверх
`DeploymentScope`, отказ «нет `.env`» — в `prepare`; функция `recoverEnv(ctx, args)` остаётся для шага `apply`;
сравнения `command.run === recoverEnv` удаляются. `bootstrap` держится на `preparesEnvironment` и эффекте.

Ошибки (`core/command/errors.ts`; `closestCommand`, `dieUnknownAction` переезжают туда, реэкспорт из `gate.ts` цел):
`ArgumentError extends UserError` с полем `argument?` — `bind` и `prepare`; `UnknownArgumentError extends
ArgumentError` — `tokenize` и флаг другого действия, получает указатель на `--help` и не получает документ `--json`;
`UnknownActionError extends UnknownArgumentError` — действие неизвестно или отсутствует; `ConfirmationRequiredError
extends UserError` — «`<name>` replaces or destroys state — pass confirm: true»; `ValueError` (`core/values`) наружу не
выходит — `bind` превращает его в `ArgumentError`.

## 3. Совместимость: адаптер устаревших команд

* `AppCommand`, `AppDefinition`, `defineApp`, `mcpCommands` не меняются; `CommandArgument` получает `summary?`. Для
  команд развёртывания поля сохраняют смысл: `run(ctx, args)`, `arguments` (справка и MCP; argv конвейер не
  разбирает), `destructive`/`readOnly`, три предиката (их путь устаревшей вычисляет ровно как сейчас),
  `forceOnConfirmation`, `preparesEnvironment`, `structured`, `consoleOnly`, `exportsSecrets`.
* `openclawCommands.<cmd>.run(ctx, args)` идёт через `runOnContext` (разбор → `prepare` → `run` на переданном
  контексте, без подготовки окружения, подтверждения и контракта `--json` — как прямой вызов сейчас);
  `commands: { ...openclawCommands, seed }` работает без правок. Для `needs: "deployment"` `transport()` — это
  `ctx.transport`, `service` — `serviceOf(ctx)` (новый доступ к записи, которую `core/context.ts` уже хранит).
* Подмена `run` у команды фреймворка уводит её на путь устаревшей (профиль из `destructive` без предикатов строже —
  безопасная сторона). Не экспортируются в этапе 3: `commandBody`, `defineAction`, `multiActionBody`, типы
  спецификации (раздел 8); `FRAMEWORK_EXPORT_SOURCES` и `exports` пакета не меняются, новые файлы попадают в `dist`.

## 4. Поверхности: этап 3 и этап 5

| Поверхность | Этап 3 | Этап 5 |
| --- | --- | --- |
| разбор консоли; MCP `validate`/`toArgv` | один разборщик; MCP — форма + тот же разборщик, `setByConfirm` | обратная форма `toArgv` для `Advice` (этап 4) |
| MCP подтверждение, `changed`, `confirm` и пометки схемы | из эффекта и профиля | — |
| MCP описания аргументов | `summary`, если объявлен, иначе нынешняя эвристика | `shortenDescription`, `SHARED_SCHEMA_DESCRIPTIONS`, `splitActionScoped` удаляются |
| `--help`, `help <cmd>`; автодополнение | производное `arguments`, пометки из профиля; `NO_ACTION` | разделы по действиям из `ActionSpec`; одно решение автодополнения |
| `docs/guide/commands.md`; `help`, `control-mcp`, `completion`, `version`, команды шлюза | без изменений; `parseDeclaredArgs` | генерация; реестр, `needs: "nothing"` |

## 5. Рецепт переноса команды

### 5.1. Шаги

1. Аргументы → `ArgumentSpec`: `parse`, `required`, `effect` флагов, `setByConfirm`. `summary` для описаний длиннее 60
   — текст аргумента из эталона `mcp-tools-list.json` без хвостов ` (value: <…>)` и ` (<действия>)`; кончается на «…»
   — полная фраза (пять случаев: `upgrade --image`, `rollback --previous-set`, `apply-config --dump`,
   `recipe <new-name>`, `expose --apply`).
2. Эффект — по переводу из 1.3; таблица паритета остаётся зелёной без правок.
3. Отказы по одним аргументам и локальным файлам (перекрёстные правила флагов, имена рецептов, локальные хранилища) —
   в `prepare`; результат — план. `run(ctx, plan)` — прежнее тело без разбора; `guarded(ctx, what, args, …)` →
   `guardedWith(ctx, what, takeoverOf(values), …)`.
4. Тело экспортируется из модуля реализации. Функция с изменившейся сигнатурой (и старая `cmd(ctx, args)`) правится у
   импортёров своей группы; импортёр вне группы — старая сигнатура остаётся обёрткой над `runOnContext(BODY, ctx,
   args)`. Помощники других групп (`takeTail`, `createBackup`, `preflightSecrets`, `loadSecrets`,
   `runningRecipeStacks`, `recoverEnv`) сигнатур не меняют.
5. Запись группы: убрать `run`, `arguments`, `destructive`, `readOnly`, предикаты, `forceOnConfirmation`,
   `preparesEnvironment`; добавить `...BODY`; проза остаётся. Меняются только внутренние строки записи.
6. Действия — в порядке нынешних `choices`; у `recipe` — в порядке `RECIPE_ACTION_GRAMMAR` (совпадает порядок флагов,
   меняется только порядок `choices`). Проверки группы, вызывавшие функцию действия с argv, переходят на
   `openclawCommands.<cmd>.run(ctx, argv)`.

### 5.2. Пример: `logs` (одно действие)

```ts
// commands/lifecycle/instance/logs.ts
const LOGS_ARGUMENTS = [
  { name: "tail", kind: "option", valueName: "n", parse: countValue("a number of lines"), description: "Lines to return when reading rather than following" },
  { name: "since", kind: "option", valueName: "duration|timestamp", parse: sinceValue, summary: "Only lines at or after this duration/timestamp",
    description: "Only lines at or after this duration/timestamp (10m, 2h, 1h30m, or RFC3339/ISO)" },
  { name: "grep", kind: "option", valueName: "pattern", parse: regexValue(), description: "Only lines matching this regular expression" },
] as const satisfies readonly ArgumentSpec[];

export const LOGS = commandBody({
  effect: "read", arguments: LOGS_ARGUMENTS,
  async run(ctx, { tail, since, grep }) {     // number | undefined, string | undefined, RegExp | undefined
    await requireBootstrapped(ctx);           // дальше прежнее тело; readLogs получает String(tail)
  },
});
// groups/openclawCommands.lifecycle.ts: logs: { summary: "…", group: "start-stop", details: "…", ...LOGS },
```

`summary` у `--since` — текст эталона `tools/list`. Проверки `--tail`/`--since`/`--grep` уходят из `run` в парсеры;
эталоны не меняются; `legacyCommands` −1, `unsummarizedDescriptions` −1.

### 5.3. Пример: `backup` (многодейственная)

```ts
// commands/lifecycle/backup/index.ts. BACKUP_APPLY_ARGUMENT: effect "destroy"; --keep: countValue("a non-negative integer");
// --interval: scheduleIntervalValue({ bareMinutes: false }); --dry-run у create: effect "read".
export const BACKUP = multiActionBody({
  effect: "change",
  action: { description: "Omit to create a backup; an action word lists or manages backups instead", summary: "Omit to create a backup" },
  defaultAction: "create",
  actions: {                // порядок нынешних choices; create как умолчание первым при слиянии флагов
    list: defineAction({ summary: "List archives and replaced copies", effect: "read", arguments: BACKUP_LIST_ARGUMENTS, run: backupList }),
    "prune-replaced": defineAction({ summary: "Delete copies restore left aside", effect: "read", arguments: PRUNE_PARSE_ARGUMENTS, run: backupPruneReplaced }),
    install: defineAction({ summary: "Schedule a plain backup", effect: "read", arguments: BACKUP_INSTALL_ARGUMENTS, run: backupInstall }),
    uninstall: defineAction({ summary: "Remove the backup schedule", effect: "read", arguments: BACKUP_UNINSTALL_ARGUMENTS, run: backupUninstall }),
    create: defineAction({ summary: "Create an archive", arguments: BACKUP_ARGUMENTS,
      prepare: ({ values, given }) => createPlan(values, given),
      run: (ctx, plan) => (plan.dryRun ? previewBackup(ctx, plan.options) : createBackup(ctx, plan.options).then(() => {})) }),
  },
});

/** --share/--migrate/--with-secrets и --profile задают одно поле, побеждает последний набранный;
 *  PROFILE_BY_FLAG — нынешний PROFILE_SHORTHAND_FLAGS с ключами без `--`. */
function createPlan(values: Values<typeof BACKUP_ARGUMENTS>, given: readonly string[]) {
  const last = given.filter((name) => name === "profile" || PROFILE_BY_FLAG.has(name)).at(-1);
  const profile = last === undefined ? undefined : last === "profile" ? values.profile : PROFILE_BY_FLAG.get(last);
  if (values.native && (profile ?? "full") !== "full") throw new ArgumentError("--native only supports the full profile — …", "native");
  return { options: { hot: values.hot, native: values.native, profile }, dryRun: values["dry-run"] };
}
```

Действия получают `(ctx, values)`; удаляются `backup(ctx, args)`, `backupActionIsReadOnly`, `BACKUP_ALL_ARGUMENTS`,
`BACKUP_ACTION_ARGUMENTS` и разборщики в `list.ts`, `prune-replaced.ts`, `install.ts`; `previewBackup` — нынешняя
ветка `--dry-run`; запись — `backup: { summary, group, details, ...BACKUP }`. Отказ `--native` с не-full профилем
теперь раньше `requireBootstrapped` и блокировки (I5). Эталоны не меняются. Храповики: три предиката по −1,
`legacyCommands` −1, `unsummarizedDescriptions` −7.

### 5.4. Проверки

* Без правок ожиданий остаются зелёными: таблица паритета (`spec/effect.check.ts` — по каждой из 41 команды
  представительные argv и эффект, записанные rf3-spec по нынешним предикатам), эталоны (кроме 5.6), поведенческие
  проверки группы, `npm run gate`. На каждый отказ уровня `prepare` — случай через `executeCommand` с записывающим
  транспортом (ошибка, ноль контактов). Проза на изменившихся сообщениях становится структурой (`error.argument`).
* Общие проверки, читающие предикаты, `is*DryRun`, `*ActionIsReadOnly` или `*_ACTION_ARGUMENTS`
  (`integration/mcp-safety-policy`, `integration/mcp/dispatch/mcp-server`, `foundation/cli/help-groups`,
  `foundation/core/arguments/*`), rf3-spec заранее переводит на `callFactsFor`, `effectProfile`,
  `openclawCommands[cmd].arguments` и `.run(ctx, argv)`; случаи «объявлено = принимает» по таблицам действий уходят в
  проверки групп. Переносы общие проверки не правят: падение там — изменение поведения сверх 5.6.

### 5.5. Храповики (`tools/checks/architecture/baseline.json`)

| Метрика | Старт | pipeline | effects | lifecycle | management | operate | orchestration | sets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `rawArgvPredicates.readOnlyWhen` | 17 | −1 | — | −6 | −4 | −3 | −2 | −1 |
| `rawArgvPredicates.changedWhen` | 6 | — | — | −2 | −1 | −2 | — | −1 |
| `rawArgvPredicates.requiresConfirmationWhen` | 5 | — | — | −1 | −1 | −2 | — | −1 |
| `legacyCommands` (новая, вводит effects) | 41 | −1 | — | −13 | −15 | −3 | −8 | −1 |
| `unsummarizedDescriptions` (было `longArgumentDescriptions.total`) | 61 | −1 | −24 | −12 | −10 | −5 | −6 | −3 |
| `declaredArguments` | 183 | = | = | = | = | = | = | = |

`legacyCommands` — записи `openclawCommands` с пустым `specOf`. `unsummarizedDescriptions` — аргументы производного
`arguments` с описанием длиннее 60 и без `summary`; −24 у rf3-effects — `summary` у общих
`BREAK_FOREIGN_LOCK_ARGUMENT` (21 команда) и `PROFILE_ARGUMENT` (3). `declaredArguments` не меняет ни одна задача:
другое число — ошибка представления. `dotClawforgeLiterals` и `prosePins` только убывают; исключение — перенос записей
в группу operate (rf3-spec переписывает числа двух файлов групп). После rf3-property в первых пяти строках 0.

### 5.6. Допустимые изменения

Эталоны (`help-*.txt`, `mcp-tools-list.json`) меняются только так, и каждое перечисляется в сообщении коммита:
(1) пять «…»-описаний из 5.1 заменены полными; (2) у `set` действие обязательно в `Usage` и в `required` схемы
(время выполнения уже требует); (3) порядок `choices` у `recipe`; (4) порядок `tools/list` после выделения группы
operate (6.1, rf3-spec). Поведение (CHANGELOG — 6.3): ошибка аргумента и отказ `prepare` раньше любого
контакта, блокировки и записи `.env` на всех хостах, в том числе раньше `LOCAL_TARGET_UNSUPPORTED`; пустое значение
опции без `parse` отвергается одинаково; тексты неизвестного или отсутствующего действия и флага другого действия
едины для пяти многодейственных команд; `recipe --json` = `recipe list --json`; ошибки `choices` и обязательности в
MCP приходят текстом разборщика.

## 6. Раскладка и разделение работы

### 6.1. Файлы (не больше 7 записей в каталоге с исходниками, 700 строк в файле)

```
core/command/                 вместо core/arguments.ts — в core/ по-прежнему 7 записей
  index.ts    барьер: spec, parse, view, effect, errors (без execute)
  spec.ts     типы 1.1–1.4, commandBody/defineAction/multiActionBody, materializeCommands, specOf, runOnContext, localScope
  parse.ts    tokenize, bind, parseCall; parseDeclaredArgs, ActionScope, NO_ACTION (обёртки до этапа 5)
  view.ts     argumentsView, scopeByAction, splitActionScoped (до этапа 5)
  effect.ts   callFacts, callFactsFor, effectProfile, legacyPreparesEnvironment
  errors.ts   ArgumentError…, ConfirmationRequiredError, closestCommand, dieUnknownAction
  execute.ts  executeCommand, CommandIo, Execution, deploymentScope, контракт --json
core/values/value.ts                  ValueError, ValueParser, общие парсеры (в values/ 3 записи)
integration/mcp/call.ts               validate, toArgv, structuredResult, toolEnvelope, mask* из schema.ts (4 записи)
commands/interface/groups/openclawCommands.operate.ts   expose, watch, incident, recover-env (6 записей)
tools/checks/foundation/core/command/ вместо …/arguments/: spec/ — parse.check.ts (из arguments.check.ts),
  view.check.ts (из action-arguments.check.ts), effect.check.ts; pipeline/ — execute.check.ts (из
  failure-order.check.ts), property.check.ts; completion/ — completion-behaviour.check.ts, pwsh-completer.ts
tools/checks/values/value.check.ts
```

`commands/interface/index.ts` сливает `{ ...lifecycle, ...orchestration, ...operate, ...management, ...sets }`: так
порядок справки внутри разделов сохраняется, меняется только порядок `tools/list`. Файл группы оборачивает свой
объект в `materializeCommands({ … })` — правка первой и последней строки, один раз, rf3-spec.

### 6.2. Задачи и владение

Порядок: rf3-spec один → rf3-pipeline ∥ rf3-effects → пять переносов ∥ → rf3-property. Файл правит только владелец;
чужой — через оркестратора.

| Задача | Владеет | Результат |
| --- | --- | --- |
| rf3-spec (3 коммита: перенос без изменений поведения; модель; материализация) | `core/command/*` кроме `execute.ts`; удаление `core/arguments.ts` и импорты 59 модулей; `core/app.ts` (`summary`); `core/values/*`; `core/context.ts` (`serviceOf`); `runtime/lock/instance-lock.ts` (`LockTakeover`, `guardedWith`, `guarded` поверх него); парсеры в `image-ref.ts` и `schedule.ts`; `shared-arguments.ts` (`LOCK_TAKEOVER_ARGUMENTS`, `takeoverOf`); `groups/*`, `commands/interface/index.ts`; разделение `schema.ts`/`call.ts` и импорты `server.ts`; каталог проверок 6.1, `spec/*`, `values/value.check.ts`, общие проверки 5.4; пути в `docs/architecture.md` | модель, разборщик, представление, эффект, таблица паритета; `view.check.ts` сверяет `argumentsView` со `scopeByAction` на синтетических срезах; эталоны — только (4) из 5.6 |
| rf3-pipeline | `core/command/execute.ts`, `entry/cli.ts`, `integration/mcp/server.ts` и `call.ts`, `commands/operate/recover-env/*` и её запись в группе, `pipeline/execute.check.ts`, проверки recover-env, environment-preparation и MCP dispatch; случай `incident --dry-run` → `security/incident/incident.check.ts` | конвейер; `runApp` и `captureRun` на нём; recover-env на `needs: "deployment"`; случаи failure-order через `executeCommand` с утверждениями о структуре (`error.argument`, контакты), а не о прозе |
| rf3-effects | `core/io/help-render.ts`, `integration/mcp/schema.ts`, `summary` в `shared-arguments.ts`, код `tools/checks/architecture/*`, проверки справки и схемы | поверхности из профиля, `summary` в MCP, метрики 5.5; эталоны без изменений |
| rf3-mig-lifecycle | `groups/openclawCommands.lifecycle.ts`, `commands/lifecycle/**` и их проверки | 13 команд |
| rf3-mig-management | `groups/openclawCommands.management.ts`, `commands/interface/{status,cli,exec,cli-helper}.ts`, `host/`, `commands/management/**` и их проверки | 15 команд |
| rf3-mig-operate | `groups/openclawCommands.operate.ts` кроме recover-env, `commands/operate/{expose,watch,incident}/**` и их проверки | 3 команды |
| rf3-mig-orchestration | `groups/openclawCommands.orchestration.ts`, `commands/orchestration/**` и их проверки | 8 команд |
| rf3-mig-sets | `groups/openclawCommands.sets.ts`, `commands/sets/**`, `tools/checks/sets/**` | 1 команда, 6 действий |
| rf3-property | `pipeline/property.check.ts`; удаление неиспользуемых экспортов (`ActionScope`, `scopeByAction` вне view); финальные числа; сводная запись CHANGELOG; раздел о спецификации в `docs/architecture.md`; статус этапа в плане | проверка-свойство; этап закрыт |

Проверка-свойство: для каждой команды и действия, для каждого аргумента с `choices` или `parse` — argv из слова
действия, примеров предшествующих позиционных (`choices[0]`, `example`, `x`) и `invalidExample` (для `choices` —
значение вне списка); для опций без `parse` — пустое значение. Прогон через `executeCommand` с записывающим
транспортом на `terminal` и на `mcp` (через `toArgv`). Ожидается: стадия `parse`, `ArgumentError` с `argument` = имя
(у `main()` это код 1), ноль контактов, документ `{"error":…}` только у действия с флагом `json` (тогда в argv
добавлен `--json`). Развёртывание не нужно: до разбора конвейер ничего не читает.

### 6.3. Общие файлы

* `baseline.json`: каждая задача снижает свои числа; конфликт при слиянии — перезамер (`check architecture` печатает
  фактическое значение). Эталоны `tools/checks/golden/expected/*` после каждого слияния пересобираются
  `npm run golden:update`, diff читается против 5.6.
* CHANGELOG: каждая задача пишет строку о своих видимых изменениях в том же коммите; конфликт при слиянии — обе
  стороны. rf3-property сводит записи этапа в одну.

## 7. Риски и не-цели

* Вывод типов (`const`-параметры, переименование ключей): rf3-spec закрепляет `Values<…>` проверкой типов на `logs` и
  `backup`; запасной путь — явный тип плана в `prepare`, без `any` в коде команд.
* Скрытая семантика нынешних разборщиков («последний побеждает» у `--profile`, сквозной `host`, число позиционных
  `recipe`, буквальное `--opt=value`, `takeTail`) покрыта 1.5 и `given`; страховка — поведенческие проверки групп.
* Эффекты перенесены как есть (`watch check` — `read`, хотя пишет локальное состояние; `recipe import`/`new` —
  `destroy`, хотя локальны); пересмотр — ревью этапа 6. Граница `prepare` — тип и проверка-свойство, без запрета
  импорта транспорта. Барьер `core/command/index.ts` без `execute.ts`, тела не импортируют файлы групп (нет циклов;
  это же нужно этапу 5 для быстрого автодополнения).

Не цели этапа 3: поверхности этапа 5 (справка по действиям, автодополнение, генерация документации, удаление эвристики
и `splitActionScoped`); `Advice` и литералы `./clawforge` (этап 4); реестр `help`/`control-mcp`/`completion`/`version`
и команды шлюза как спецификации; `needs` на действии; декларативные ограничения между аргументами (правила — код в
`prepare`); объявленные умолчания; публичный экспорт спецификации; пересмотр эффектов; новые команды и флаги;
переписывание транспорта и блокировок (кроме аддитивного `guardedWith`); изменение JSON-вывода команд.

## 8. Решено до старта

1. `needs: "nothing"` откладывается до этапа 5 (отступление от плана) — принято.
2. Группа operate — отдельный файл; порядок `tools/list` меняется (не справки) — принято: порядок списка
   инструментов не контракт, владение по файлу нужно параллельным переносам.
3. `commandBody`/`defineAction` в этапе 3 внутренние; публикация в `@clawforge/framework/app` — решение владельца
   при выпуске.
4. Изменения поведения 5.6 приняты как есть, включая единый отказ пустому значению опции и обязательное действие у
   `set`.
5. CHANGELOG — в коммите каждой задачи (6.3), а не одной записью в конце: `main` между слияниями не живёт без
   записи о видимых изменениях.
