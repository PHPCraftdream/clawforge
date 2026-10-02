# Этап 5: поверхности из спецификации и проверки по структуре — проектное решение

Дата: 2026-10-02. Основание: [план рефакторинга](refactor-plan-2026-10-01.md), разделы 1–3, этап 5, «Сквозное: проверки
по структуре (класс F)», инварианты I4 и I9; [решение этапа 3](refactor-stage3-design.md) (`CommandSpec`,
`argumentsView`, `specOf`); [решение этапа 4](refactor-stage4-design.md) (`Advice`, рендерер, токены прозы); код `main`
на `b650a56`. Для исполнителей rf5-completion, rf5-mcp, rf5-docs, rf5-prose. Все четыре стартуют после слияния #253
(rf4-sweep-cmds2). Отступления от плана помечены словом «отступление». Пути — от `tools/framework/`, если не сказано
иное. Замеры — приложение А.

## 0. Решения коротко

Все имена, которые разрешает диспетчер, — записи одного реестра `CommandRegistry` (`integration/gate.ts`): команды
развёртывания, команды шлюза (`check`, `new-app`, `remove-app`, `list`, `version`, `completion`, `init`) и две команды
диспетчера — `control-mcp` и `help` — с объявлениями (summary, details, аргументы). `renderHelp`, сообщение о неизвестной
команде, подвал справки, автодополнение, таблица документации и проверки P4 читают реестр; `knownCommandNames`,
`controlMcpHelp`, `builtinHelpLines` и фиксированные записи автодополнения удаляются. Списки команд шлюза собирает один
модуль `entry/registry.ts`.

Автодополнение — вариант (б), выбран замером: на Windows p95 запуска при загрузке объявлений — 0,82–2,19 с у входа
чекаута (TS) и 1,11 с у установленного входа (JS) против порога 0,5 с; даже нижняя граница (один `core/command`, без
единой команды) у чекаута — p95 0,53–0,74 с. Решение — данные `CompletionData`, построенные из реестра на TypeScript;
bash/zsh и pwsh получают таблицу и неизменный интерпретатор; эталонный интерпретатор — `completionCandidates`;
равенство трёх доказывает дифференциальная проверка с настоящими bash и PowerShell по сценариям, порождённым из данных.
Генерируемых по командам веток (`bashCaseArm`, ветви pwsh, особый случай `help`) не остаётся; вычислитель подмножества
PowerShell в проверках удаляется. Скрытой команды `__complete` нет.

MCP: описание аргумента — `summary ?? description` дословно плюс хвост действий; части по действиям берутся из
спецификации (`argumentScopes`), а не разбором строки. `shortenDescription`, `stripParentheticals`,
`SHARED_SCHEMA_DESCRIPTIONS`, `splitActionScoped` удаляются; хвост `(value: <…>)` больше не добавляется. Бюджет: замер
32 506 → 32 184 байт из 32 768.

Документация: таблица `docs/guide/commands.md` между маркерами — вывод `npm run docs:commands` из реестра; проверка
сравнивает сгенерированное с закоммиченным побайтно. Длинные ячейки «Purpose» уходят: полный текст — `help <command>`.

Проверки (F): `prosePins` 854 → не больше 427. Остаются тексты внешних инструментов и проверки рендереров; остальное
переводится в коды, argv советов, поля JSON, классы ошибок с именем аргумента, дубли эталонов удаляются, а текст
сообщения продукта становится именованным экспортом модуля-владельца, который проверка импортирует (отступление,
раздел 5.3). Замер: 36 самых плотных файлов, 462 пина → ожидаемый итог ≈ 390.

Порядок: rf5-completion (коммит реестра первым) → rf5-mcp ∥ rf5-docs (после коммита реестра) → rf5-prose последней.

## 1. Реестр команд (5.4)

### 1.1. Типы и раскладка

```ts
// integration/gate.ts — данные и рендер справки, без побочных эффектов при импорте
export type CommandOrigin = "deployment" | "gate" | "dispatcher";
export interface RegistryEntry {
  readonly name: string;
  readonly origin: CommandOrigin;
  readonly summary: string;
  readonly details?: string;
  readonly arguments?: readonly CommandArgument[];
  readonly command?: AppCommand;    // только "deployment": спецификация, эффект, группа
  readonly gate?: GateCommand;      // только "gate"
}
export interface CommandRegistry {
  readonly entries: readonly RegistryEntry[];   // deployment (порядок объявления), gate (порядок шлюза), control-mcp, help
  readonly names: readonly string[];            // имена entries в том же порядке
  find(name: string): RegistryEntry | undefined;
}
export const DISPATCHER_COMMANDS = ["control-mcp", "help"] as const;
export const HELP_COMMAND_DESCRIPTION = "Command name; omit to list every command";
export function commandRegistry(source: {
  readonly deployment: Readonly<Record<string, AppCommand>>;
  readonly gate: readonly GateCommand[];
  readonly appName: string;
}): CommandRegistry;
export function dispatcherHelpLines(registry: CommandRegistry): string[];
export function renderHelp(target: string | undefined, app: AppDefinition, registry: CommandRegistry, gateHelp: readonly string[]): boolean;

// entry/registry.ts (новый; entry/ 6 → 7 записей) — один список на вход, вместо сборки по месту
export function checkoutGate(): GateCommand[];   // check, new-app, remove-app, list, version, completion(appFlag true)
export function installedGate(appRoot: string, placement?: InitPlacement): GateCommand[];   // init, version(appRoot), completion(appFlag false)
export function surfaceRegistry(): CommandRegistry;   // openclawCommands + checkoutGate() + init из installedGate("<app-root>"), appName "clawforge"
```

`InitPlacement` — нынешний второй параметр `makeInitGateCommand` (`{ localTypesOnly?, ancestor? }`), экспортируется под
этим именем. Записи диспетчера строит `commandRegistry` из `DISPATCHER_COMMANDS`:

| Имя | summary | details | arguments |
| --- | --- | --- | --- |
| `control-mcp` | `` `expose ${appName}'s commands as MCP tools, for agents` `` | `CONTROL_MCP_DETAILS` | `[]` |
| `help` | `same as: <command> --help` | — | `[{ name: "command", kind: "positional", description: HELP_COMMAND_DESCRIPTION, choices: names }]` |

* `choices` у `help` — все имена реестра: автодополнение, P4 (`help-prose`, `advice-matrix`) и таблица документации
  читают его как любую позиционную с выбором. Своя справка `help` недостижима (`help`, `help --help`, `help help` —
  экран usage, как сейчас), инструментом MCP реестровая запись не становится (1.3), поэтому длинный список нигде не
  печатается.
* Порядок `names` = порядок `knownCommandNames` сейчас, кроме хвоста: `control-mcp`, затем `help` (порядок подвала).
  На `closestCommand` это не влияет: ничья между `help` и `control-mcp` невозможна (разница длин 7 больше суммы порогов).
* `dispatcherHelpLines` — `helpEntryLine(name + " <имя>" для каждой позиционной, summary)`: «`control-mcp`» и
  «`help <command>`» — побайтно нынешние `builtinHelpLines`.

### 1.2. Что меняется в местах вызова

| Место | Было | Стало |
| --- | --- | --- |
| `renderHelp` | особые ветки `control-mcp`; `knownCommandNames` | usage при `undefined`/`--help`/`-h`/`help`; иначе `registry.find`: `deployment` → `renderFullCommandHelp`, прочее → `renderCommandHelp(name, entry)`; нет — `reportUnknownCommand(target, registry.names)` |
| `knownCommandNames` | функция с литералами `"help"`, `"control-mcp"` | удаляется; читатели берут `registry.names` |
| `controlMcpHelp` | своя функция | удаляется; `renderCommandHelp("control-mcp", entry)` — тот же вывод (аргументов нет, строки `Usage:` нет) |
| `renderUsage(app, gateHelp)` (`core/io/help-render.ts`) | добавляет `builtinHelpLines(app.name)` | `renderUsage(app, footer: readonly string[])`; вызывающий передаёт `[...gateHelp, ...dispatcherHelpLines(registry)]`; `builtinHelpLines` удаляется (core/io не импортирует integration) |
| `runApp` (`entry/cli.ts`) | особые ветки `help`, `control-mcp`; `knownCommandNames` | строит реестр; ветки `help` и `control-mcp` остаются — это исполнение, не поверхность (`control-mcp --help`/`-h` → `renderCommandHelp` записи); неизвестная команда — `registry.names` |
| `helpWithoutDeployment` | литерал `"help"`, проверка `first === "control-mcp"` | кандидаты `[...deploymentCommands, ...offered, ...DISPATCHER_COMMANDS]`; `control-mcp` проходит через общее `candidates.includes(first)` |
| `serveMcp` (`integration/mcp/server.ts`) | `renderHelp(target, app, gateCommands, gateHelp)` | строит реестр и вызывает новую сигнатуру |
| `tools/clawforge.ts`, `entry/bin.ts` | собирают массив шлюза по месту (`[...checkoutGateCommands, versionGateCommand]` + `push(completion)`) | `checkoutGate()`, `installedGate(appRoot, { localTypesOnly, ancestor })`; `useGateCommands` — из того же массива |
| проверки и эталоны (`architecture.check.ts` `commandNames`, `help-prose.check.ts`, `advice-matrix.check.ts`, `golden/advice.ts`, `invocation-hints.check.ts` `GATE_NAMES`) | ручные списки, `controlMcp`-заглушка, ветки `help`/`control-mcp` в P4 | `surfaceRegistry()`; P4 одинаков для всех записей: спецификация → `parseCall`, прочее → `tokenize(arguments)` + `choices` позиционных |
| `docs-commands.check.ts` | объявленная сторона — разбор bash-скрипта регулярками | объявленная сторона — `surfaceRegistry()` (в этом же коммите; документированная сторона — до rf5-docs) |

Автодополнение в коммите реестра не трогается: его фиксированные записи уходят вместе со всем генератором (2.5).

### 1.3. Чего реестр не делает

* Инструмент MCP `help` остаётся своим объявлением `HELP_TOOL` в `server.ts` (уточнение плана): у инструмента опция
  `command`, у консольной команды — позиционная, описание аргумента одно — `HELP_COMMAND_DESCRIPTION`. Описание
  инструмента остаётся своим текстом, иначе меняется либо подвал консоли, либо `tools/list`.
* `normalizeVersionAlias` (`--version`, `-v`) — грамматика входа, не поверхность; не трогается.
* `MCP_EXEMPTIONS` — без изменений: реестр не решает, что становится инструментом.

## 2. Автодополнение (5.1)

### 2.1. Решение: вариант (б)

Критерий плана: (а), если p95 задержки на Windows при загрузке одних объявлений не больше 0,5 с; иначе (б).

| Вход | Сейчас (объявления тянут 164 из 186 модулей) | Нижняя граница (`core/command` + `core/app`, 38 модулей) |
| --- | --- | --- |
| чекаут, TS (`--experimental-strip-types`), расчёт кандидатов в процессе | p95 0,82–2,19 с; min 0,59–0,68 с | p95 0,53–0,74 с; min 0,20–0,21 с |
| чекаут через шим `./clawforge` (Git Bash) | p95 3,0 с (`completion bash`) | + запуск bash (p50 0,05 с) |
| установленный, JS, `bin.js completion bash` | p95 1,11 с; min 0,27 с | — |
| установленный, JS, расчёт кандидатов в процессе | p95 0,45–0,61 с | p95 0,14–0,16 с |

Вывод: (а) не проходит ни на одном реальном входе. Порог достижим только для идеализированного JS-случая и только после
переноса `run` всех 41 команды за ленивую границу (сейчас объявления импортируют реализации: тело команды объявлено в
модуле реализации) — это перестройка этапа 3, вне этапа 5; вход чекаута не проходит и на нижней границе (стоимость
снятия типов и самого `core/command`). Машина замера была нагружена параллельными сессиями — p95 завышены, но минимумы
(огибающая без нагрузки) у чекаута тоже выше 0,5 с. Кэш компиляции Node (`NODE_COMPILE_CACHE`) даёт p50 0,59 с /
p95 0,89 с — недостаточно.

### 2.2. Данные и эталонный интерпретатор

`integration/completion.ts` (464 строки) заменяется каталогом `integration/completion/` (в `integration/` по-прежнему 7
записей; в каталоге 4 файла):

| Файл | Содержимое | Строк |
| --- | --- | --- |
| `index.ts` | `CompletionShell`, `COMPLETION_SHELLS`, `COMPLETION_COMMAND_NAME`, `COMPLETION_ARGUMENTS`, `renderCompletion`, `makeCompletionGateCommand` | ~80 |
| `table.ts` | `CompletionData`, `completionData`, `completionCandidates` | ~170 |
| `bash.ts` | `BASH_COMPLETER` (неизменный текст), `renderBash(data, zsh)` | ~130 |
| `pwsh.ts` | `PWSH_COMPLETER` (неизменный текст), `renderPwsh(data)` | ~110 |

```ts
// integration/completion/table.ts
export interface OptionValues { readonly command: string; readonly scope: string; readonly option: string; readonly values: readonly string[] }
export interface CompletionData {
  readonly appFlag: boolean;
  readonly top: readonly string[];                          // имена реестра по алфавиту (+ "--app" при appFlag)
  readonly first: ReadonlyMap<string, readonly string[]>;   // команда → кандидаты сразу после неё
  readonly after: ReadonlyMap<string, readonly string[]>;   // "<команда> <действие>" и "<команда> *"
  readonly values: readonly OptionValues[];                 // ключ в скриптах — command + scope + option, как сейчас
}
export function completionData(registry: CommandRegistry, appFlag: boolean): CompletionData;
export function completionCandidates(data: CompletionData, words: readonly string[], cword: number,
  appNames: () => readonly string[]): readonly string[];
// integration/completion/index.ts
export function renderCompletion(shell: CompletionShell, data: CompletionData): string;
export function makeCompletionGateCommand(siblings: readonly GateCommand[], appFlag: boolean): GateCommand;
// run: completionData(commandRegistry({ deployment: openclawCommands, gate: siblings, appName: "clawforge" }), appFlag)
```

Построение — нынешнее правило `specFor`, без особых записей:
* флаги команды — флаги и опции без `actions` + `--help`, по алфавиту без повторов;
* команда с позиционной `action` и `choices`: `first` — слова действий по алфавиту + запасной список; `after["<к> <д>"]` —
  флаги команды ∪ флаги, ограниченные действием `д`; `after["<к> *"]` — запасной список (при необязательном действии —
  флаги ∪ флаги действия по умолчанию `NO_ACTION`, иначе флаги команды);
* команда с другой позиционной с `choices` (`completion`, `host`, `help`): `first` — значения + флаги; `after["<к> *"]` —
  флаги;
* прочие: `first` и `after["<к> *"]` — флаги;
* `values`: опция с `choices` — `scope: ""`, у многодейственной команды ещё по записи на каждое действие (`actions` опции
  или все действия), как сейчас.

`completionCandidates` (эталон; скрипты повторяют его буквально):

```text
scan = words[0 .. cword-1]; cur = words[cword] ?? ""; prev = последний элемент scan
i = 0; при appFlag: пока scan[i] == "--app": i += 2
если i >= |scan|:  при appFlag и prev == "--app" → appNames();  иначе → top
cmd = scan[i]; between = scan[i+1 ..]
если first не знает cmd → []
scope = (|between| > 0 и between[0] != prev) ? between[0] : ""
если prev начинается с "--" и есть values[cmd + scope + prev] → эти значения
если |between| == 0 → first[cmd]
→ after[cmd + " " + between[0]] ?? after[cmd + " *"]
```

Фильтр по `cur` — дело shell (`compgen -W … -- "$cur"`, `-like "$word*"`); эталон возвращает список без фильтра.
Единственное изменение поведения: после `help <имя>` предлагается `--help`, а не снова имена (сейчас особая ветка
`help` отдаёт имена на любой позиции).

### 2.3. Скрипты

bash (zsh — тот же текст после `#compdef clawforge ./clawforge`, `autoload -Uz bashcompinit`, `bashcompinit`):

```text
# clawforge bash completion — generated from the command declarations.
# Install: source <(<commandLine(["completion", "bash"])>)
_clawforge_app=1                                  # 0 у установленного входа
_clawforge_lookup() {                             # данные: case по "top", "first <к>", "after <к> <слово>", "values <ключ>"
  case "$1" in
    "top") _clawforge_reply="…" ;;
    …
    *) return 1 ;;
  esac
}
<BASH_COMPLETER>                                  # _clawforge_complete(): алгоритм 2.2; ни одной подстановки из данных
complete -F _clawforge_complete clawforge
complete -F _clawforge_complete ./clawforge
```

pwsh:

```text
$clawforgeApp = $true
$clawforgeTop = @(…); $clawforgeFirst = @{…}; $clawforgeAfter = @{…}; $clawforgeValues = @{…}
$clawforgeCompleter = { <PWSH_COMPLETER> }
Register-ArgumentCompleter -Native -CommandName clawforge, ./clawforge -ScriptBlock $clawforgeCompleter
```

* Интерпретаторы — константы-строки без интерполяции (в TS — обычные строки, не шаблоны с `${…}`). Значения `--app` —
  ленивый вызов, как сейчас: bash — `"${COMP_WORDS[0]}" list --json --no-status 2>/dev/null | grep -o … | grep -v
  '^[.]'`, pwsh — `& $tokens[0] list --json --no-status`, скрытые каталоги отсекаются.
* Совместимость: bash 3.2 (`/bin/bash` macOS) — без `declare -A`, `mapfile`, `${x,,}`; Windows PowerShell 5.1 — без
  `??`, `?.`, тернарного оператора. Все глобальные имена — с префиксом `_clawforge_` / `$clawforge`.
* Детерминизм: ключи и значения отсортированы; два рендера одних данных побайтно равны.
* `./clawforge` в скриптах — три исключения храповика (`bash.ts`: строка регистрации и строка `#compdef`; `pwsh.ts`:
  `Register-ArgumentCompleter`) вместо нынешних четырёх.

### 2.4. Проверки

`tools/checks/foundation/core/command/completion/completion-behaviour.check.ts` переписывается; `pwsh-completer.ts`
(440 строк, вычислитель подмножества PowerShell; план называет его `foundation/core/arguments/pwsh-completer.ts`)
удаляется, на его место — `scenarios.ts` (порождение сценариев):

1. **Данные** (структура вместо текста скрипта): `backup install` несёт `--interval`, `list` — нет; `--keep` только под
   `prune-replaced`; запасной список `backup` содержит флаги создания; `set forget --kind` — значения `kind`, `set try` —
   нет; `help` в `first` — все имена; без `appFlag` в `top` нет `--app`. Сюда переезжают утверждения из
   `gate-commands.check.ts` (секция completion) и `spec/view.check.ts` (блок R31-07).
2. **Эталон**: нынешние именованные сценарии через `completionCandidates`.
3. **Дифференциал**: сценарии из данных — `[""]`; префикс имени; `[к, ""]` для каждой команды; `[к, д, ""]` для
   каждого ключа `after`; `[к, "zz", ""]` для `*`; `[к, (scope), опция, ""]` для каждого `values`; `--app x` перед
   командой; `["--app", ""]`; `["status", "--app", ""]`; неизвестная команда; плюс вариант с непустым `cur`. Ожидание —
   `completionCandidates`, отфильтрованный по `cur`, без повторов, по алфавиту.
   * `requires("bash", …)`: один процесс bash на все сценарии (`source`, затем `COMP_WORDS`/`COMP_CWORD` и
     `_clawforge_complete` в цикле); на darwin — ещё `/bin/bash`, если есть; `bash -n` разбирает скрипт.
   * `requires("pwsh", …)`: один процесс PowerShell (`pwsh`, на Windows без него — `powershell.exe`): dot-source скрипта,
     затем `TabExpansion2 -inputScript "clawforge …" -cursorColumn <len>` на каждый сценарий; один сценарий — с
     `./clawforge`. Заглушка `clawforge` на `PATH` (`clawforge.cmd` на Windows, sh-скрипт иначе) отвечает
     `[{"name":"app-one"},{"name":"app-two"}]` и `[{"name":".hidden"}]` в хвосте — проверка отсечения.
   * Ключи хеш-таблиц PowerShell нечувствительны к регистру — сценарии только в нижнем регистре.
4. **Неизменность интерпретатора**: рендер двух разных `CompletionData` различается только блоком данных (bash и pwsh);
   тело zsh побайтно равно телу bash.

Возможности: в `tools/checks/kit/capabilities/capabilities.ts` добавляются `bash` (`bash -c "exit 0"`) и `pwsh`
(`pwsh -NoProfile -NonInteractive -Command exit 0`, на win32 при неудаче — `powershell.exe` с теми же ключами);
функция выбора бинаря экспортируется и ею же пользуется проверка. CI (`.github/workflows/ci.yml`): Linux —
`OC_CHECK_REQUIRE` += `bash,pwsh`; macOS — += `bash,pwsh`; Windows (no WSL) — `OC_CHECK_REQUIRE: bash,pwsh`. Это и есть
проверка плана «pwsh есть на hosted-раннерах»: первый коммит с требованием красный, если нет. Таблица джобов и список
меток в CONTRIBUTING.md («Host capability labels») правятся тем же коммитом.

### 2.5. Удаляется и остаётся

| Символ | Судьба |
| --- | --- |
| `buildCompletionModel`, `CommandCompletionSpec`, `specFor`, `bashCaseArm`, `bashFunctionBody`, `LIST_NAMES_JSON` | → `completionData` + `BASH_COMPLETER` |
| фиксированные записи `help`/`control-mcp`, ветки `help)` в bash и `$cmd -eq 'help'` в pwsh, `if (cmd === "help")` в TS | удаляются: `help` — позиционная с `choices` (1.1) |
| `renderPwsh` с ветвлением по командам | → таблицы + `PWSH_COMPLETER` |
| `tools/checks/…/completion/pwsh-completer.ts` (`runPwshCompleter`, `parsePwshTables`) | удаляется; настоящий PowerShell |
| `completionCandidates` | остаётся эталоном с новой сигнатурой (2.2) |
| `emitRaw` для скрипта, `COMPLETION_ARGUMENTS`, текст справки `completion`, отказ на неизвестный shell | без изменений |

### 2.6. Обновление установленных скриптов

Новый скрипт самодостаточен, как старый, и регистрирует ту же функцию `_clawforge_complete` под теми же именами:
* `source <(clawforge completion bash)` в профиле и `clawforge completion pwsh | Out-String | Invoke-Expression`
  обновляются при следующем запуске shell сами;
* сохранённый в файл (`> "${fpath[1]}/_clawforge"`) продолжает работать на старых данных до повторной генерации — как
  сейчас при любом изменении команд. CHANGELOG называет команду перегенерации; миграции нет.

### 2.7. Скрытая команда и «один реестр»

При (б) скрытой `__complete` нет, реестр не получает записей вне справки, MCP и документации. Если (а) когда-нибудь
станет нужен (после ленивого `run`), `__complete` вводится записью реестра с объявленным признаком видимости, который
читают все поверхности, — а не пропуском по имени в каждой из них.

## 3. MCP (5.2)

### 3.1. Правило описания

```ts
// integration/mcp/schema.ts
export function schemaArgumentDescription(argument: CommandArgument, scopes?: readonly ArgumentScope[]): string | undefined;
// isTrivial(argument)  → undefined (остаётся: не обрезка, а пропуск описания, повторяющего имя)
// scopes              → scopes.map(s => `${s.summary ?? s.description} (${s.actions.join(", ")})`).join("; ")
// иначе               → `${argument.summary ?? argument.description}` + (argument.actions ? ` (${argument.actions.join(", ")})` : "")
```

Без обрезки, без снятия скобок и вводного «With x: », без хвоста `(value: <…>)` (решение по бюджету, 3.4). Длина
основы ≤ 60 держит храповик `unsummarizedDescriptions` (3.3) и утверждение в `mcp-mirror.check.ts`.

### 3.2. Части по действиям — из спецификации

```ts
// core/command/view.ts
export interface ArgumentScope { readonly actions: readonly string[]; readonly description: string; readonly summary?: string }
/** Per-action texts of one flag/option of a multi-action command when its actions describe it differently; undefined otherwise. */
export function argumentScopes(command: { readonly run?: unknown }, name: string): readonly ArgumentScope[] | undefined;
```

`argumentScopes` читает `specOf(command)` → `specData` → `actions[*].arguments`; `argumentsView` строит составные
`description`/`summary` через тот же внутренний помощник (составной текст в производном `arguments` остаётся —
его читают внешние потребители и справка). Читатели: `inputSchema` (передаёт `argumentScopes(command, a.name)`) и
`renderCommandHelp` в `core/io/help-render.ts` (условие «хвост действий не дописывается» — `scopes !== undefined` вместо
`splitActionScoped(...) !== undefined`). У команд шлюза спецификации нет — `undefined`, как сейчас.

### 3.3. Удаляется; что объявляется

Удаляются: `shortenDescription`, `stripParentheticals`, `SHORT_DESCRIPTION_LIMIT`, `SHARED_SCHEMA_DESCRIPTIONS`,
`sharedSchemaDescription` (`integration/mcp/schema.ts`), `splitActionScoped` (`core/command/view.ts` и экспорт из
`core/command/index.ts`). `HELP_TOOL` берёт описание аргумента из `HELP_COMMAND_DESCRIPTION`.

Чтобы текст `tools/list` остался нынешним (кроме 3.4), `summary` объявляется там, где нынешний текст получался
эвристикой; значение — нынешний текст без хвостов:

| Где объявлен аргумент | Аргумент → `summary` |
| --- | --- |
| `commands/interface/groups/shared-arguments.ts` | `break-lock` → `Take over a held instance lock`; `break-foreign-lock` → `Host id of an orphaned lock to take over` |
| `destroy` | `data` → `Remove the data directory`; `backups` → `Remove the backup directory`; `snapshots` → `Remove the snapshot directory` |
| `backup` (create), `pull` | `hot` → `Do not stop the service` |
| `restore`, `push` | `fresh-identity` → `Drop identity and paired devices` |
| `accept` | `recipe` → `Recipe to check` |
| `operations` | `limit` → `How many recent operations to list` |
| `incident` | `tail` → `Lines of log to collect` |
| `host` | `args` → `Command and arguments to run` |
| `secrets` | `force` → `Replace an existing store` |
| `recipe` | `with-hooks` → `add commented prepare.ts/verify.ts stubs`; `tail` → `lines to return per service`; `force-disabled` → `build a recipe marked disabled`; `dry-run` → `show what would happen`; `volumes` → `delete its volumes too` |
| `deploy` | `path` → `Remote install directory` |
| `mcp-setup` | `client` → `Client configuration to update` |
| `set` | `from` → `original artifact`; `to` → `replacement artifact`; `set-id` → `filter by immutable set id`; `receipt` → `show this receipt; requires --set-id`; `with-model` → `include acceptance checks that call the model` |
| `entry/checkout-gate.ts` (`check`) | `filter` → `Only run checks whose relative path contains this text`; `jobs` → `Concurrent check-file processes`; `require` → `Capabilities that must fail a check instead of skipping it` (новый текст: нынешний обрезан с «…») |
| `integration/version.ts` | `json` → `Emit {name, version, source, path} instead of text` |
| `integration/deployment/init.ts` | `local` → `Print the npm command for editor types` |

Аргумент в теле многодейственной команды получает `summary` в своём срезе действия (`defineAction`); `argumentsView`
сложит составной `summary`, как сейчас. `version` и `init` не инструменты — их `summary` нужен храповику, область
которого расширяется на `surfaceRegistry()` (сейчас только `openclawCommands`). `declaredArguments` (183) сохраняет
область `openclawCommands`.

### 3.4. Бюджет

Замер на эталоне `mcp-tools-list.json` (компактный JSON, как в `mcp-mirror.check.ts`; приложение А.3):

| Вариант | Байт | Δ |
| --- | --- | --- |
| сейчас | 32 506 | — |
| `summary ?? description` дословно, без новых `summary` | 34 279 | +1 773 (превышение) |
| новые `summary` = нынешний текст; хвосты действий и значений | 33 145 | +639 (превышение) |
| новые `summary`; хвост действий, без хвоста значений — **решение** | 32 184 | −322 |
| новые `summary`; без обоих хвостов | 31 560 | −946 |

Хвост действий остаётся: он несёт смысл (флаг принимается только этими действиями — R29-04), у `break-lock` и
`break-foreign-lock` он теперь появляется для `backup`, `expose`, `watch`, `recipe`, `set` (сейчас его съедала таблица
`SHARED_SCHEMA_DESCRIPTIONS`). Хвост значения (`(value: <n>)`) дублирует имя опции и тип `string`; полный текст —
`help`. Запас после этапа — около 580 байт (`mcp-mirror` сейчас печатает на 10 байт больше эталона: другое имя
развёртывания).

## 4. Документация (5.3)

* `tools/dev/docs-commands.ts` (новый; `tools/dev/` 5 → 6 записей): чистые `renderCommandTables(): string` и
  `spliceGenerated(markdown, block): string`; запуск файлом (`process.argv[1]` совпадает с этим файлом) переписывает
  блок в `docs/guide/commands.md`. `package.json`: `"docs:commands": "node --experimental-strip-types
  tools/dev/docs-commands.ts"`.
* Маркеры: `<!-- commands:begin (generated by npm run docs:commands from the command declarations; do not edit) -->` и
  `<!-- commands:end -->`, ровно по одному.
* Содержимое блока — `surfaceRegistry()`: по разделу `### <GROUP_HEADINGS[g]>` на группу в `GROUP_ORDER` (команды
  развёртывания в порядке объявления), затем `### Framework` — команды шлюза (порядок `checkoutGate()`, затем `init`) и
  `control-mcp`, `help`. Таблица `| Command | Arguments | Summary |`:
  * `` `имя` ``;
  * `` `argumentsSignature(arguments)` `` (`core/io/help-render.ts`), пусто — `—`; `|` экранируется `\|`;
  * `summary` + `destructiveMarker` у команд развёртывания; у команд шлюза — «(checkout only)», если имени нет в
    `installedGate`, «(installed only)», если нет в `checkoutGate()`; у `control-mcp` — `appName` `<app>`.
* `docs-commands.check.ts`: в файле ровно одна пара маркеров; блок между ними (переводы строк нормализованы к LF)
  побайтно равен `renderCommandTables()`; при расхождении — сообщение с командой `npm run docs:commands`. Разбор строк
  таблицы и `UNDOCUMENTED_COMMANDS` удаляются (`declaredFromCompletion` уходит раньше, в C1).
* Повествование правится руками: длинные ячейки «Purpose» исчезают вместе с таблицей (полный текст — `help <command>`,
  о чём говорит вступление страницы); ссылки из ячеек на другие страницы (`backup` → data-and-backups.md, `watch` и
  `incident` → monitoring-and-access.md, `init` → deploy-and-mcp.md) переезжают в ручной список «Where the details
  are» под блоком. Предложения, перечисляющие флаги одной команды, заменяются ссылкой на её `--help`; описания модели
  (грамматика `--opt=value`, привилегии `host`) остаются. Заголовок `## Shell completion` сохраняется (на него ссылается
  README.md); его текст правит rf5-completion (2.6).
* CONTRIBUTING.md: строка о том, что таблица команд генерируется, и команда обновления.

## 5. Проверки по структуре (F, rf5-prose)

### 5.1. Метрика и цель

`prosePins` (`architecture.check.ts`): строки проверок вне `architecture/` и `golden/`, где есть
`includes("… …")` с пробелом в литерале. База — 854 (записана на этапе 0; на `b650a56` столько же, 145 файлов). Цель
плана — не больше половины: **≤ 427** к концу rf5-prose. Метрика не меняется: другое правило счёта сделало бы базу
несравнимой.

Новый сторож `proseMatchers` (rf5-prose, первый коммит): строки тех же файлов с прозой в других формах —
`startsWith`/`endsWith`/`indexOf` литерала с пробелом, `.match(/… …/)`, `/…\s…/.test(`, `===`/`!==` с литералом с
пробелом. Сейчас 96 (приложение А.4); равенство с базой, рост — провал: перевод не может уйти в другой оператор.

### 5.2. Что законно остаётся

* **Тексты внешних инструментов** — вывод или ошибка чужой программы (docker, compose, ssh, tailscale, OpenClaw CLI,
  ОС: «Permission denied», «No services to build») и строки для чужой программы, которые продукт строит (cron,
  `schtasks`, `sudo install -d …`, `tailscale serve …`).
* **Проверки рендереров** — файлы, предмет которых — рендер текста: `foundation/cli/cli-help.check.ts`,
  `foundation/cli/help-groups.check.ts`, `integration/apps/invocation-hints.check.ts`, `surfaces/*`,
  `kit/harness.check.ts`, `kit/spawn.ts`, `foundation/packaging/docs-commands.check.ts`,
  `foundation/hygiene/readme-quickstart.check.ts`.

Замер (эвристика, приложение А.4): внешние ≈ 95, рендереры 68 — около 160 строк; всё прочее — проза продукта.

### 5.3. Формы перевода

| Форма | Когда | Как утверждать |
| --- | --- | --- |
| S1 совет | пин `./clawforge …`/`clawforge …` в отказе, проблеме, документе | `error.advice[*]`, `problem.next`, поле `next`/`nextSteps` JSON: `kind` и `argv` массивом |
| S2 аргумент | «unknown argument», «takes …», «must look like …» | класс (`ArgumentError`/`UnknownArgumentError`/`UnknownActionError`) и `error.argument`; в процессе — пойманная ошибка, через процесс — код выхода 1 плюс S2 через `executeCommand` в процессе, если случай это позволяет |
| S3 код | имя кода проблемы | `problems.map((p) => p.code)` |
| S4 JSON | факт, который команда отдаёт в `--json` | поле документа (случай переводится на `--json`, только если команда его объявляет) |
| G дубль | текст справки, usage, скрипта автодополнения того же вызова, что снят в `expected/*` | пин удаляется; эталон уже держит текст |
| M сообщение (отступление) | текст сообщения продукта без структуры | экспорт модуля-владельца, проверка его импортирует (ниже) |

**M — сообщение как именованное значение.** Фиксированный текст — `export const <NAME> = "…";`, текст со значениями —
`export function <name>Message(…): string`; объявляется в модуле, который его печатает, и **этим же символом**
печатается (место вывода переходит на него в том же коммите); проверка пишет `includes(LOCK_BUSY)` или
`includes(cannotSearchMessage(dir))`. Если пин проверяет часть длинного сообщения, экспортируется та часть, из которой
продукт собирает текст. Вывод побайтно прежний. Экспорты внутренние: `FRAMEWORK_EXPORT_SOURCES` и `exports` пакета не
меняются.

Почему не коды: у 265 `die(…)` и у строк `info`/`warn` кодов нет; ввести их — изменение публичного API ошибок вне
этапа. Почему не эталоны сообщений: вывод сквозных проверок содержит временные пути и различается на четырёх хостах CI.
Именованное сообщение снимает корень 1.2.7 плана — правка текста в одном месте больше не ломает проверки в других.

### 5.4. Запреты

* Не переносить прозу в другой оператор (`startsWith`, регулярка, `===`) — сторож `proseMatchers`.
* Не объявлять в проверке строковую константу с текстом продукта — только импорт из `#framework/…`.
* Не удалять пин без замены в том же случае (S1–S4, M) или эталона, который держит тот же вывод (G).
* Не менять формулировки продукта: эталоны побайтно прежние; любой diff — ошибка перевода.
* Хост-зависимый случай — только `requires(cap)`; новые ветки по платформе в проверках не добавляются.

### 5.5. Список и порядок

Правило: файлы в порядке убывания числа пинов вне 5.2; в каждом взятом файле переводятся **все** такие пины; остановка,
когда `prosePins` ≤ 397 (запас 30 до 427) по завершении текущего файла. Список пересчитывается на входе задачи (после
rf5-completion/rf5-mcp). Замер на `b650a56` — 36 файлов, 462 пина (S 86, G+M 376; в M — около 269 различных текстов),
итог ≈ 392 (приложение А.4). Коммиты по областям, каждый со своим числом в `baseline.json`: (1) `foundation/` и
`integration/`; (2) `runtime/`; (3) `security/`, `sets/`, `release/`; (4) при необходимости — добор.

## 6. Задачи

### 6.1. Порядок и зависимости

```text
#253 (rf4-sweep-cmds2) ─→ rf5-completion C1 (реестр) ─┬─→ rf5-completion C2 (возможности, CI) → C3 (таблица, скрипты)
                                                      ├─→ rf5-mcp
                                                      └─→ rf5-docs
                         все три слиты ─→ rf5-prose
```

* Всё после #253: rf5-mcp и rf5-prose правят `commands/**` и файлы групп (владение #253), rf5-completion — `entry/` и
  `integration/`, которые #253 не трогает; файлы флипа (`core/io/log.ts`, `core/io/output.ts`,
  `core/io/invocation/index.ts`) этапу 5 не нужны вовсе.
* C1 первым: от реестра зависят сигнатура `renderHelp` (её вызывает `server.ts`, который правит и rf5-mcp), объявленная
  сторона `docs-commands.check.ts` (без неё C3 ломает проверку новым форматом скрипта) и область храповика rf5-mcp.
* rf5-mcp ∥ rf5-docs ∥ C2–C3 после C1. Пересечения: `spec/view.check.ts` (C3 — блок автодополнения, rf5-mcp — блок
  схемы и `splitActionScoped`), `docs/guide/commands.md` (C3 — раздел «Shell completion», rf5-docs — таблица и
  повествование), `core/io/help-render.ts` (C1 — `renderUsage`, rf5-mcp — `renderCommandHelp`), `baseline.json`,
  CHANGELOG. Порядок слияния: C2–C3 → rf5-mcp → rf5-docs; второй сливающийся перебазируется и перезамеряет.
* rf5-prose — последней и одна: правит десятки файлов `commands/**`, `runtime/**`, `service/**` и проверки всех
  областей; параллельно — гарантированные конфликты.

### 6.2. Владение, коммиты, изменения

**rf5-completion** — 1, 2.1–2.7; 3 коммита.
* C1 (реестр, поведение побайтно прежнее): `integration/gate.ts`, `entry/registry.ts` (новый), `entry/cli.ts`,
  `core/io/help-render.ts` (`renderUsage`, `builtinHelpLines`), вызов `renderHelp` в `integration/mcp/server.ts`,
  `tools/clawforge.ts`, `entry/bin.ts`, экспорт `InitPlacement` в `integration/deployment/init.ts`; проверки:
  `architecture.check.ts` (`commandNames` из реестра; новый сторож `retiredSymbols`), `help-prose.check.ts`,
  `advice-matrix.check.ts`, `golden/advice.ts`, `golden/matrix.ts` (списки шлюзов из `entry/registry.ts`),
  `invocation-hints.check.ts`, `docs-commands.check.ts` (объявленная сторона), `cli-help.check.ts`/`gate-*.check.ts` —
  только если меняется вызов API. CHANGELOG: нет.
* C2: `kit/capabilities/capabilities.ts` (+`bash`, `pwsh`), `capabilities.check.ts`, `ci.yml`, CONTRIBUTING.md; в
  нынешней `completion-behaviour.check.ts` bash-часть уходит под `requires("bash")` вместо ручного пропуска. CHANGELOG:
  нет.
* C3: `integration/completion/` вместо `completion.ts`, импорты (`tools/clawforge.ts`, `entry/bin.ts`,
  `entry/registry.ts`, `golden/{advice,matrix,render}.ts`, `architecture.check.ts`, `help-prose.check.ts`),
  `completion-behaviour.check.ts` + `scenarios.ts`, удаление `pwsh-completer.ts`, секции автодополнения в
  `gate-commands.check.ts` и `spec/view.check.ts`, исключения `dotClawforgeLiterals.exempt`, эталон
  `completion-scripts.txt`, раздел «Shell completion» в `docs/guide/commands.md`, README.md — только если меняется
  строка установки (не меняется). CHANGELOG: «Shell completion scripts are now a fixed interpreter plus a table
  generated from the command declarations, identical in behaviour for bash, zsh and PowerShell; after `help <command>`
  only `--help` is offered. A script saved to a file (`> "${fpath[1]}/_clawforge"`) needs to be generated again; the
  `source <(…)` and `| Invoke-Expression` forms update themselves.»

**rf5-mcp** — 3; 1 коммит.
* Владеет: `integration/mcp/schema.ts`, `HELP_TOOL` в `integration/mcp/server.ts`, `core/command/view.ts` и
  `core/command/index.ts` (экспорт), `renderCommandHelp` в `core/io/help-render.ts`; объявления `summary` по таблице
  3.3 (`commands/interface/groups/shared-arguments.ts`, модули тел `destroy`, `backup`, `pull`, `restore`, `push`,
  `accept`, `operations`, `incident`, `host`, `secrets`, `recipe`, `deploy`, `mcp-setup`, `set`;
  `entry/checkout-gate.ts`, `integration/version.ts`, `integration/deployment/init.ts`); проверки
  `spec/view.check.ts` (блок схемы), `mcp-mirror.check.ts`, `architecture.check.ts` (область
  `unsummarizedDescriptions`, имена в `retiredSymbols`); эталон `mcp-tools-list.json`.
* CHANGELOG: «MCP tool schemas describe each argument with its declared summary — no heuristic shortening; the
  `(value: <…>)` suffix is gone; `break-lock`/`break-foreign-lock` name the actions they apply to on backup, expose,
  watch, recipe and set.»

**rf5-docs** — 4; 1 коммит.
* Владеет: `tools/dev/docs-commands.ts`, `package.json` (скрипт), `docs/guide/commands.md` (блок и повествование, кроме
  раздела «Shell completion»), `docs-commands.check.ts` (целиком), CONTRIBUTING.md (строка). CHANGELOG: нет (продукт не
  меняется).

**rf5-prose** — 5; 3–4 коммита.
* Владеет: файлы проверок из списка 5.5 и модули продукта, чьи сообщения экспортируются (M); `architecture.check.ts`
  (сторож `proseMatchers`) и `baseline.json`; статус этапа 5 в плане; сводная запись CHANGELOG этапа (только сведение
  записей rf5-completion и rf5-mcp; своих видимых изменений нет).

### 6.3. Общие файлы

* `baseline.json`: каждая задача записывает свои числа; при слиянии второй перезамеряет (`node
  --experimental-strip-types tools/clawforge.ts check architecture` печатает факт) — числа не складываются руками.
* Эталоны: после слияния — `npm run golden:update`, один коммит на поверхность, diff читается против раздела 8.
* CHANGELOG: строка в коммите задачи; при конфликте — объединение; rf5-prose сводит этап в одну запись.

## 7. Храповики

| Метрика | Вход (после #253) | C1 | C2 | C3 | rf5-mcp | rf5-docs | rf5-prose |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `dotClawforgeLiterals.total` | 11 | = | = | 10 (исключения `completion/bash.ts` 2, `completion/pwsh.ts` 1) | = | = | = |
| `proseFlags` | 0 | = | = | = | = | = | = |
| `localizeOptOuts` | 0/0/0 | = | = | = | = | = | = |
| `unsummarizedDescriptions` | 0 (`openclawCommands`) | = | = | = | 0 (область — `surfaceRegistry()`, +5 `summary` вне групп) | = | = |
| `declaredArguments` | 183 | = | = | = | = | = | = |
| `prosePins` | 854 | 853 (`docs-commands`) | = | ≈ 844 (`gate-commands` 6, `view` 3) | ≈ 844 | = | ≤ 427, ожидается ≈ 390 |
| `retiredSymbols` (новый сторож, 0) | — | 0: `knownCommandNames`, `controlMcpHelp`, `builtinHelpLines`, `declaredFromCompletion` | = | 0: + `buildCompletionModel`, `CommandCompletionSpec`, `bashCaseArm`, `bashFunctionBody`, `LIST_NAMES_JSON`, `runPwshCompleter`, `parsePwshTables` | 0: + `shortenDescription`, `stripParentheticals`, `SHORT_DESCRIPTION_LIMIT`, `SHARED_SCHEMA_DESCRIPTIONS`, `sharedSchemaDescription`, `splitActionScoped` | = | = |
| `proseMatchers` (новый сторож) | — | — | — | — | — | — | факт на входе (≈ 96), равенство |

`retiredSymbols`: в `baseline.json` — `{ comment, names: [...], total: 0 }`; счёт — вхождения `\b<имя>\b` в `.ts` под
`tools/` вне `tools/checks/architecture/`. Числа «≈» — замер на `b650a56`; точное записывает задача (храповик —
равенство).

## 8. Эталоны

| Задача | Меняется | Побайтно прежние |
| --- | --- | --- |
| C1 | — | все восемь: `help-checkout.txt`, `help-installed.txt`, `mcp-tools-list.json`, `completion-scripts.txt`, `refusals.txt`, `entry-matrix.txt`, `advice-matrix.txt`, `problem-codes.txt` |
| C2 | — | все |
| C3 | `completion-scripts.txt` (все шесть секций: bash/zsh/pwsh × чекаут/установленный) | остальные семь |
| rf5-mcp | `mcp-tools-list.json`: исчезают хвосты `(value: <…>)` (включая `help.command`), хвосты действий у `break-lock`/`break-foreign-lock` пяти команд, текст `check.require` | остальные семь, в том числе `help-*.txt` (переход на `argumentScopes`) |
| rf5-docs | — (`commands.md` держит `docs-commands.check.ts`) | все |
| rf5-prose | — | все; любой diff — изменённая формулировка |

## 9. Ловушки

1. **Пины с затронутыми текстами** (полный `gate` дважды ловил пропущенные): C1 — `cli-help.check.ts` (стр. 56–124:
   «did you mean: control-mcp», «did you mean: help», usage), `gate-dispatch.check.ts`, секция help без развёртывания в
   `gate-commands.check.ts`, `system-install.check.ts` (стр. 93: список команд шлюза), `mcp-mirror.check.ts` (равенство
   инструмента `help` и `./clawforge help`); C3 — `gate-commands.check.ts` 169–260, `spec/view.check.ts` 80–110,
   `docs-commands.check.ts` (разбор bash — снять в C1); rf5-mcp — `spec/view.check.ts` (импорт `splitActionScoped`,
   стр. 115, 189, 237), `mcp-mirror.check.ts` (правило «короткая фраза ≤ 90 или составная»), `parse.check.ts` 421
   (комментарий), `mcp-server.check.ts` («call help with command=…» — описание инструмента не меняется).
2. **Порядок имён** в реестре влияет на «did you mean»; меняется только хвост `control-mcp`/`help` (1.1).
3. **`help --help`** и **`help help`** — usage, а не справка записи `help`; `control-mcp -h` принимается (у команд
   развёртывания `-h` после имени — не справка).
4. **`renderUsage`** вызывает и `invocation-hints.check.ts` (`renderUsage(app, [])`) — новая сигнатура там же.
5. **Импорты** `integration/completion.ts` → `integration/completion/index.ts` везде (около десяти мест: входы,
   `entry/registry.ts`, `golden/*`, `architecture`, `help-prose`, проверки автодополнения); правило import-style:
   в одном файле не смешивать `#src/` и `../` (в `integration/` — `../`, в новых файлах каталога — `../../`).
6. **Исключения `dotClawforgeLiterals`** — путь файла и точный текст строки (обрезанный) с кратностью; строка,
   которой больше нет, — провал.
7. **Совместимость скриптов**: bash 3.2, Windows PowerShell 5.1 (2.3); проверка гоняет то, что есть на хосте, — на
   машине разработчика под Windows это 5.1.
8. **Запуск PowerShell** на Windows — около секунды: все сценарии в один процесс; то же для bash.
9. **`$` в TS**: интерпретаторы — обычные строки; шаблонная строка с `${COMP_WORDS[0]}` молча подставит
   переменную TS.
10. **`capabilities.check.ts`** держит полный список меток; `layout.check.ts` запрещает пути `tools/checks/` в
    `ci.yml`.
11. **Храповик `unsummarizedDescriptions`** при расширении области сразу покажет 5 (`check` ×3, `version.json`,
    `init.local`) — `summary` объявляются тем же коммитом.
12. **Справка после `argumentScopes`** обязана остаться побайтной (составные описания `set --name`, `--json`): diff
    `help-*.txt` — ошибка.
13. **Документация**: переводы строк (Windows) нормализуются перед сравнением; `|` в сигнатурах экранируется;
    `docs-private-content.check.ts` — никаких машинных путей; якорь `#shell-completion` жив.
14. **rf5-prose**: модуль у предела 700 строк — экспорт рядом с местом вывода, без нового файла, если каталог уже на 7
    записях; символ, объявленный и не использованный продуктом при выводе, — ошибка ревью.
15. **Длинные команды** (`npm run gate`, `golden:update`, `check`) — только в фоне, по одной; без `&`; процессы не
    убиваются по имени образа.

## 10. Приёмка

**C1:** реестр и `entry/registry.ts`; `knownCommandNames`, `controlMcpHelp`, `builtinHelpLines` удалены
(`retiredSymbols` = 0); в `renderHelp`, `helpWithoutDeployment` и P4 нет литералов `"help"`/`"control-mcp"` вне
`DISPATCHER_COMMANDS`; все восемь эталонов побайтно прежние; `layout`, `import-style`, `architecture`; `npm run gate`
зелёный.

**C2:** метки `bash`, `pwsh`; три hosted-джоба требуют их; CI зелёный (это и доказательство наличия pwsh).

**C3:** одна таблица решения (`completionData`) и эталон `completionCandidates`; в скриптах нет ветвей по именам команд
(проверка неизменности интерпретатора); `pwsh-completer.ts` удалён; дифференциал bash и PowerShell зелёный по всем
сценариям из данных; `completion-scripts.txt` обновлён отдельным коммитом поверхности, diff прочитан;
`dotClawforgeLiterals` 10; CHANGELOG; `gate`.

**rf5-mcp:** удалённые символы — 0 (`retiredSymbols`); `tools/list` ≤ 32 768 (ожидается ≈ 32 190 в `mcp-mirror`);
каждая основа описания ≤ 60; diff `mcp-tools-list.json` — ровно перечисленное в 8; `help-*.txt` побайтно; CHANGELOG;
`gate`.

**rf5-docs:** `npm run docs:commands` идемпотентен (второй запуск — пустой diff); `docs-commands.check.ts` падает на
ручной правке блока (доказательство «падает до»: испортить строку, увидеть провал, вернуть) и не разбирает bash;
каждая запись `surfaceRegistry()` — строка таблицы; `gate`.

**rf5-prose:** `prosePins` ≤ 427; `proseMatchers` не вырос; эталоны побайтно; остаток (выборка 30 случайных пинов)
относится к 5.2; каждый экспорт M используется при выводе; статус этапа 5 в плане; `gate` дважды подряд зелёный.

## 11. Риски и не-цели

* **Задержка (а) в будущем.** Если понадобится вызов на Tab, условие — ленивый `run` у 41 команды и перезамер по методу
  приложения А.1; сейчас не цель.
* **pwsh на раннерах.** Если C2 покажет, что `pwsh` нет на macOS-раннере, метка снимается только с этого джоба
  (Linux и Windows держат дифференциал); bash 3.2 — через `/bin/bash`.
* **Объём rf5-prose** (~460 правок, ~270 текстов) — самый крупный шаг этапа; механический, по областям, под двумя
  сторожами. Срыв цели фиксируется числом, а не снижением цели.
* **Бюджет `tools/list`.** Запас ≈ 580 байт; новый инструмент или аргумент сверх него — повод вернуться к хвостам, а не
  к обрезке.

Не цели этапа 5: ленивый `run` и вызов на Tab; справка по действиям (`help backup install`); токены в `summary`;
переписывание ячеек в `details`; новые команды и флаги; коды для `UserError`; генерация других страниц `docs/guide`;
перевод пинов вне выбранных файлов сверх цели; ревью этапа 6.

## 12. Решено до старта

1. **Автодополнение — (б)** по замеру 2.1 (правило плана, не отступление).
2. **Реестр — поверхности, не исполнение**: ветки `help`/`control-mcp` в `runApp` остаются (уточнение плана); инструмент
   MCP `help` — своё объявление с общим текстом аргумента (уточнение).
3. **Хвост `(value: <…>)` в схеме MCP удаляется** — бюджет (3.4); видимое изменение в CHANGELOG.
4. **Таблица `commands.md` — только имя, сигнатура, summary**; длинные ячейки уходят, ссылки — в ручной список.
5. **Отступление: сообщение как именованный экспорт (M)** — четвёртая форма структуры рядом с кодами, argv и полями JSON;
   без неё цель ≤ 427 недостижима (структурных пинов около 118 из 854, приложение А.4).
6. **Отступление: объём** — 3 + 1 + 1 + 3–4 коммита вместо четырёх: цель класса F и проверка pwsh на CI отдельным
   коммитом.

Вопрос владельцу (один): принимается ли форма M (5.3) как «структура» для I9. Решение принято и исполнимо без ответа;
владелец может отменить его до старта rf5-prose — тогда цель F на этапе 5 не достигается (≈ 700 после S и G), и это
фиксируется в плане как перенос.

## Приложение А. Замеры на `b650a56`

### А.1. Задержка автодополнения

Хост: Windows 10 Pro 22H2, Node v24.12.0, 16 логических ЦП; во время замера машину нагружали параллельные сессии
(полные прогоны проверок в других worktree), поэтому p95 завышены, а минимум — огибающая без нагрузки. Метод:
`spawnSync` последовательно, 3 прогрева отброшены, n = 30–40, время от запуска до выхода процесса, перцентиль по
рангу. JS-вариант: модули фреймворка прогнаны через `stripTypeScriptTypes` с переписью спецификаторов, как JS-половина
`tools/build-framework-package.ts`, во временный каталог ОС; `json5` подменён заглушкой (на путь автодополнения не
влияет). «Расчёт в процессе» — скрипт, импортирующий `integration/completion.ts` и `entry/checkout-gate.ts`,
строящий модель и вызывающий `completionCandidates` (прототип `__complete`).

| Сценарий (мс: min / p50 / p95) | Выборка 1 (n=40) | Выборка 2 (n=30) | Выборка 3 (n=40) |
| --- | --- | --- | --- |
| `node -e 0` | 47 / 71 / 109 | 40 / 69 / 332 | 65 / 133 / 242 |
| `node --experimental-strip-types` пустого `.ts` | 123 / 156 / 229 | — | — |
| TS: `core/command` + `core/app` (нижняя граница) | 209 / 345 / 527 | — | 202 / 495 / 741 |
| TS: импорт `openclawCommands` | 549 / 797 / 2505 | — | — |
| TS: расчёт в процессе | 677 / 1293 / 2189 | 608 / 929 / 2000; 585 / 730 / 821 | 623 / 982 / 1893 |
| TS: расчёт в процессе + `NODE_COMPILE_CACHE` | 425 / 594 / 893 | — | — |
| TS: `tools/clawforge.ts completion bash` | 1019 / 2266 / 4288 | — | — |
| TS: `tools/clawforge.ts version` | 492 / 847 / 2307 | — | — |
| `bash ./clawforge completion bash` (Git Bash) | 1085 / 1584 / 3032 | — | — |
| `bash ./clawforge version` | — | 1453 / 2198 / 3003 | — |
| `bash -c true` | — | — | 34 / 52 / 180 |
| JS: `core/command` + `core/app` | — | 82 / 108 / 160 | 95 / 110 / 146 |
| JS: импорт `openclawCommands` | — | 280 / 368 / 726 | — |
| JS: расчёт в процессе | — | 237 / 400 / 613 | 289 / 381 / 451 |
| JS: расчёт + `NODE_COMPILE_CACHE` | — | 253 / 474 / 807 | — |
| JS: `entry/bin.js completion bash` в пустом каталоге | — | 274 / 498 / 1111 | — |

Граф модулей (хук `module.registerHooks`, загрузки под `tools/`): `commands/interface/index.ts` — 164 модуля,
1 721 059 байт исходников (из 186 файлов `.ts` фреймворка); `integration/completion.ts` — 165 модулей;
`core/command/index.ts` — 38 модулей, 254 058 байт.

### А.2. Пересчёт

```bash
# граф модулей одного входа: счётчик загрузок через module.registerHooks({ load }) вокруг await import(<модуль>)
node --experimental-strip-types <счётчик>.mjs <корень> tools/framework/commands/interface/index.ts
# задержка: spawnSync по сценариям А.1, 3 прогрева, n = 30–40, min/p50/p95 по рангу
node <замер>.mjs <корень> 40
```

### А.3. `tools/list`

Эталон `tools/checks/golden/expected/mcp-tools-list.json`: 45 инструментов, компактный JSON 32 506 байт
(`mcp-mirror.check.ts` на своём развёртывании печатал 32 516). Метод: для каждого свойства `inputSchema` нынешний текст
сверен с `schemaArgumentDescription` (расхождений нет), затем пересчитан по новому правилу, части по действиям — из
`specOf` тела; размер — `Buffer.byteLength(JSON.stringify(result))`.

| Правило | Байт |
| --- | --- |
| `summary ?? description` дословно, хвосты действий и значений, без новых `summary` | 34 279 (67 описаний меняются; крупнейшие: `break-lock` ×14 +322, `break-foreign-lock` ×16 +288, `check.require` +119) |
| новые `summary` = нынешний текст без хвостов (46 пар инструмент–аргумент, ~30 объявлений) + хвосты действий и значений | 33 145 |
| то же, хвост действий без хвоста значений | **32 184** |
| то же, без хвостов | 31 560 |

Аргументы длиннее 60 без `summary` вне `openclawCommands`: `check.filter`, `check.jobs` (через таблицу),
`check.require`, `version.json` (63), `init.local` (80).

### А.4. Пины прозы

`prosePins` по правилу `architecture.check.ts`: 854 строки в 145 файлах. Классы — эвристика по тексту литерала и
файлу (не ручная разметка):

| Класс | Строк |
| --- | --- |
| проверки рендереров (файлы 5.2) | 68 |
| внешние инструменты и ОС | 95 |
| S1 совет (`./clawforge …`) | 66 |
| S2 ошибка аргумента | 35 |
| S4 поле JSON | 12 |
| S3 код проблемы | 5 |
| текст, совпадающий с `expected/*` (кандидат G; много случайных совпадений коротких фраз) | 85 |
| прочая проза продукта (M) | 488 |

В прозе продукта до отделения текстов ОС (518 строк) — 377 различных текстов; 218 строк приходятся на тексты,
повторённые в проверках больше одного раза
(«another operation is changing this instance» ×9, «sensitive-name policy» ×7, «in progress» ×7, «could not check
whether» ×7). Прочие формы прозы (`startsWith`/`endsWith`/`indexOf`, регулярки, `===` с литералом с пробелом) — 96
строк (кандидат базы `proseMatchers`).

Список 5.5 (пины вне 5.2; S — формы S1–S4, M — G и M):

| Файл (`tools/checks/…`) | Пинов | S/M |
| --- | --- | --- |
| `release/release/system-install.check.ts` | 30 | 10/20 |
| `foundation/cli/gate-commands.check.ts` | 25 | 9/16 |
| `release/release/lock.check.ts` | 24 | 4/20 |
| `sets/lifecycle/set-validate.check.ts` | 22 | 6/16 |
| `runtime/schedule/schedule.check.ts` | 19 | 2/17 |
| `security/incident/incident.check.ts` | 19 | 3/16 |
| `security/credentials/secrets-command/local-store/local-store.check.ts` | 18 | 7/11 |
| `foundation/cli/host.check.ts` | 16 | 0/16 |
| `foundation/cli/gate-dispatch.check.ts` | 14 | 8/6 |
| `runtime/watch/install.check.ts` | 14 | 1/13 |
| `security/expose/status.check.ts` | 14 | 4/10 |
| `foundation/core/command/spec/view.check.ts` | 13 | 0/13 |
| `runtime/lifecycle/destroy/destroy.check.ts` | 13 | 0/13 |
| `runtime/lifecycle/smoke/outcomes.check.ts` | 13 | 2/11 |
| `integration/mcp/transport-listing.check.ts` | 12 | 0/12 |
| `security/expose/ssh.check.ts` | 12 | 3/9 |
| `integration/init.check.ts` | 11 | 3/8 |
| `integration/mcp/dispatch/mcp-server.check.ts` | 11 | 3/8 |
| `integration/recipe/recipe-lifecycle-hooks.check.ts` | 11 | 0/11 |
| `runtime/convergence/instance-lock/takeover.check.ts` | 11 | 0/11 |
| `security/credentials/private-file.check.ts` | 11 | 0/11 |
| `integration/agent/recipe.check.ts` | 10 | 0/10 |
| `runtime/connection-facts/recover-env-command.check.ts` | 10 | 1/9 |
| `runtime/convergence/instance-lock/advice.check.ts` | 10 | 2/8 |
| `integration/mcp/openclaw-cli.check.ts` | 9 | 0/9 |
| `runtime/connection-facts/upgrade/pin-and-digest.check.ts` | 9 | 0/9 |
| `runtime/convergence/apply-config.check.ts` | 9 | 2/7 |
| `integration/apps/remove-app.check.ts` | 8 | 0/8 |
| `runtime/connection-facts/recover-env-dispatch.check.ts` | 8 | 2/6 |
| `runtime/convergence/apply/apply-recovery.check.ts` | 8 | 4/4 |
| `runtime/convergence/backup/install.check.ts` | 8 | 4/4 |
| `runtime/convergence/inspect/folder.check.ts` | 8 | 4/4 |
| `runtime/lifecycle/restore/restore-dry-run.check.ts` | 8 | 0/8 |
| `runtime/service/deploy/checkout-policy/checkout-policy.check.ts` | 8 | 0/8 |
| `runtime/watch/status.check.ts` | 8 | 1/7 |
| `runtime/watch/webhook.check.ts` | 8 | 1/7 |
| Итого 36 файлов | 462 | 86/376 |

854 − 462 = 392. Пины `gate-commands.check.ts` (6) и `spec/view.check.ts` (3), которые снимет C3, входят в эти строки:
список пересчитывается на входе rf5-prose.

```bash
# prosePins и прочие формы: правила architecture.check.ts и 5.1, по .ts под tools/checks вне architecture/ и golden/
node --experimental-strip-types tools/clawforge.ts check architecture   # факт по каждой метрике храповика
git grep -E 'includes\((`|")[^"`]* [^"`]*(`|")\)' -- 'tools/checks/*.ts' ':!tools/checks/architecture' ':!tools/checks/golden' | wc -l
```
