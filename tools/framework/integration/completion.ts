// Shell completion, generated from the live command declarations rather than hand-maintained:
// command names, each command's own flags, and — for a multi-action command's `action`
// positional (CommandArgument.choices) — its flags placed under the right action
// (CommandArgument.actions), the same field help-render.ts and the MCP schema already read.
//
// Every shell calls `<invoked name> list --json --no-status` lazily, from inside the completer,
// only once a shell asks for `--app`'s value — never baked into the generated text, and via
// whichever of `clawforge`/`./clawforge` was typed. Output never carries a machine path.

import { parseDeclaredArgs, NO_ACTION } from "../core/arguments.ts";
import { reportError } from "../core/io/log.ts";
import { cli } from "../core/io/invocation.ts";
import { emitRaw } from "../core/io/output.ts";
import { openclawCommands } from "../commands/interface/index.ts";
import type { CommandArgument } from "../core/app.ts";
import type { GateCommand } from "./gate.ts";

export type CompletionShell = "bash" | "zsh" | "pwsh";

export const COMPLETION_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "pwsh"];

export const COMPLETION_ARGUMENTS: CommandArgument[] = [
  { name: "shell", description: "bash, zsh or pwsh", kind: "positional", required: true, choices: COMPLETION_SHELLS },
];

/** One command's completion surface: its own flags, and — only for a command whose
 *  declaration has a first `action` positional with `choices` (backup, recipe, watch,
 *  expose, sets) — that action's own value list plus which flags apply under each one. */
export interface CommandCompletionSpec {
  readonly name: string;
  /** Every flag/option this command declares with no `actions` scoping — its own flags when
   *  it has no action positional, or the ones every action shares (core/app.ts's documented
   *  meaning of an absent `actions` field). Trusts the same declaration --help/MCP schema
   *  read, not a private per-action parser. Always ends with `--help`. */
  readonly flags: readonly string[];
  readonly action?: {
    readonly values: readonly string[];
    readonly flags: Readonly<Record<string, readonly string[]>>;
    /** Flags offered when no (or an unknown) action word was typed — for a command with an
     *  implicit default action (backup's bare create), that action's own flags, not just
     *  --help. */
    readonly fallback: readonly string[];
  };
  /** A non-action positional's `choices` (completion's shell, host's context) — offered at
   *  the word right after the command, before any flag is typed. */
  readonly positionalValues?: readonly string[];
  /** Options declared with `choices` (--profile, --kind, --client), keyed by `--name` —
   *  offered at the option's value position instead of the command's flags. */
  readonly optionValues?: Readonly<Record<string, readonly string[]>>;
}

function flagName(argument: CommandArgument): string {
  return `--${argument.name}`;
}

function specFor(name: string, declared: readonly CommandArgument[] | undefined): CommandCompletionSpec {
  const args = declared ?? [];
  const actionArgument = args.find(
    (argument): argument is CommandArgument & { choices: readonly string[] } =>
      argument.kind === "positional" && argument.name === "action" && argument.choices !== undefined,
  );
  const flagArgs = args.filter((argument) => argument.kind === "flag" || argument.kind === "option");
  const globalFlags = [...new Set([...flagArgs.filter((argument) => argument.actions === undefined).map(flagName), "--help"])].sort();
  // Choice values are keyed "cmd--flag", or "cmdACTION--flag" once the command declares an
  // action positional: the action word already typed scopes the lookup, so `set try` (no
  // --kind) never sees forget's values while `set forget --kind` does (R33-10).
  const choiceFlags: Record<string, readonly string[]> = {};
  const addChoice = (key: string, values: readonly string[]) => {
    choiceFlags[key] = values;
  };
  for (const argument of flagArgs) {
    if (!(argument.kind === "option" && argument.choices !== undefined)) continue;
    const bare = `${name}${flagName(argument)}`;
    if (actionArgument === undefined) {
      addChoice(bare, argument.choices);
      continue;
    }
    if (argument.actions === undefined) addChoice(bare, argument.choices);
    for (const value of argument.actions ?? actionArgument.choices) addChoice(`${name}${value}${flagName(argument)}`, argument.choices);
  }
  const optionValues = Object.keys(choiceFlags).length === 0 ? undefined : choiceFlags;

  if (actionArgument === undefined) {
    const positional = args.find(
      (argument): argument is CommandArgument & { choices: readonly string[] } =>
        argument.kind === "positional" && argument.choices !== undefined,
    );
    return { name, flags: globalFlags, positionalValues: positional?.choices, optionValues };
  }

  const perAction: Record<string, readonly string[]> = {};
  for (const value of actionArgument.choices) {
    const scoped = flagArgs.filter((argument) => argument.actions?.includes(value) === true).map(flagName);
    perAction[value] = [...new Set([...globalFlags, ...scoped])].sort();
  }
  // An OPTIONAL action positional means the command has an implicit default action —
  // backup's bare create (NO_ACTION). Its flags are the fallback for the no-action and
  // unknown-action cases, where the shell cannot know which action is meant.
  const fallback = actionArgument.required === true
    ? globalFlags
    : [...new Set([...globalFlags, ...(perAction[NO_ACTION] ?? globalFlags)])].sort();
  return { name, flags: globalFlags, action: { values: [...actionArgument.choices].sort(), flags: perAction, fallback }, optionValues };
}

/** Every name the console dispatcher can resolve, from the same declarations --help/the MCP
 *  tool list are built from — `help`/`control-mcp` are dispatcher-level (entry/cli.ts), so
 *  they get a fixed flags-only entry here, same as knownCommandNames adds them by hand. */
export function buildCompletionModel(gateCommands: readonly GateCommand[]): readonly CommandCompletionSpec[] {
  const gateSpecs = gateCommands.map((command) => specFor(command.name, command.arguments));
  const appSpecs = Object.entries(openclawCommands).map(([name, command]) => specFor(name, command.arguments));
  const fixed: CommandCompletionSpec[] = [
    { name: "help", flags: ["--help"] },
    { name: "control-mcp", flags: ["--help"] },
  ];
  return [...gateSpecs, ...fixed, ...appSpecs].sort((a, b) => a.name.localeCompare(b.name));
}

// Hidden directories (.r28) are not deployments.
const LIST_NAMES_JSON =
  "$(\"${COMP_WORDS[0]}\" list --json --no-status 2>/dev/null | grep -o '\"name\":\"[^\"]*\"' | cut -d'\"' -f4 | grep -v '^[.]')";

/** The candidate list for one completion request — the one decision both emitted scripts
 *  (bash/zsh and pwsh) implement. `rest` is every token after the program name INCLUDING
 *  the word being completed; `wordToComplete` is that partial word ('' after a trailing
 *  space). The checks drive this function through the same scenarios the scripts must
 *  answer, so a script and the model it was rendered from cannot quietly diverge.
 *  `appNames` stands in for the lazy `list --json` call the scripts make for --app. */
export function completionCandidates(
  specs: readonly CommandCompletionSpec[],
  rest: readonly string[],
  wordToComplete: string,
  appFlag: boolean,
  appNames?: readonly string[] | (() => readonly string[]),
): readonly string[] {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const names = specs.map((spec) => spec.name);
  // Only the words BEFORE the cursor pick the command — the partial word itself is not a
  // typed command (R32-02: `clawforge sta<Tab>` used to see the command "sta").
  const scan = wordToComplete !== "" ? (rest.length > 1 ? rest.slice(0, -1) : []) : rest;
  const prev = wordToComplete !== "" ? (rest.length >= 2 ? rest[rest.length - 2] : undefined) : (rest.length >= 1 ? rest[rest.length - 1] : undefined);
  let cmd: string | undefined;
  let idx = -1;
  let skip = false;
  for (let i = 0; i < scan.length; i++) {
    if (skip) {
      skip = false;
      continue;
    }
    if (appFlag && scan[i] === "--app") {
      skip = true;
      continue;
    }
    cmd = scan[i];
    idx = i;
    break;
  }
  if (appFlag && prev === "--app" && cmd === undefined) {
    // --app's own value: only while no command word has been typed yet — past a command
    // (--app is positional, it must come before the command) the command's flags return.
    return typeof appNames === "function" ? appNames() : (appNames ?? []);
  }
  if (cmd === undefined) return appFlag ? [...names, "--app"] : names;
  const spec = byName.get(cmd);
  if (spec === undefined) return [];
  const between = scan.slice(idx + 1);
  // The word after the command scopes option-value keys; when the option itself is the last
  // scanned word (empty wordToComplete) it sits in `between` too and is not a scope.
  const scope = between.length > 0 && between[0] !== prev ? between[0] : "";
  if (prev !== undefined && prev.startsWith("--") && spec.optionValues?.[`${cmd}${scope}${prev}`] !== undefined) {
    return spec.optionValues[`${cmd}${scope}${prev}`];
  }
  // `help` takes a command name — the most natural place to look one up.
  if (cmd === "help") return [...names, "--help"];
  if (spec.action !== undefined) {
    // Empty between-space means the word being completed IS the action word (typed in full
    // or in part) — the action words are offered, plus an implicit default action's flags.
    if (between.length === 0) return [...spec.action.values, ...spec.action.fallback];
    return spec.action.flags[between[0]] ?? spec.action.fallback;
  }
  if (spec.positionalValues !== undefined && between.length === 0) return [...spec.positionalValues, ...spec.flags];
  return spec.flags;
}

/** One `case "$cmd" in …` arm: a plain compgen for a single-action command, a
 *  positional-choices command offered at its first position, or a nested dispatch on the
 *  action word (still typing it vs. already past it) for one with an `action` positional —
 *  the exact shape backup/recipe/watch/expose/sets declare theirs. */
function bashCaseArm(spec: CommandCompletionSpec): string {
  const reply = (flags: readonly string[]): string => `COMPREPLY=( $(compgen -W "${flags.join(" ")}" -- "$cur") )`;
  if (spec.action === undefined) {
    if (spec.positionalValues !== undefined) {
      const first = [...new Set([...spec.positionalValues, ...spec.flags])];
      return (
        `    ${spec.name})\n` +
        `      if [[ $cword -eq $((idx + 1)) ]]; then\n        ${reply(first)}\n      else\n        ${reply(spec.flags)}\n      fi\n      ;;\n`
      );
    }
    return `    ${spec.name}) ${reply(spec.flags)} ;;\n`;
  }
  const action = spec.action;
  const arms = action.values.map((value) => `        ${value}) ${reply(action.flags[value] ?? spec.flags)} ;;`).join("\n");
  // First position (nothing typed after the command yet): the action words plus — for an
  // implicit default action like backup's bare create — that action's own flags (R31-07),
  // since `backup --h` must complete --hot, not only --help.
  const firstPosition = [...new Set([...action.values, ...action.fallback])];
  return (
    `    ${spec.name})\n` +
    `      if [[ $cword -eq $((idx + 1)) ]]; then\n` +
    `        ${reply(firstPosition)}\n` +
    `      else\n` +
    `        case "\${words[$((idx + 1))]}" in\n${arms}\n          *) ${reply(action.fallback)} ;;\n        esac\n` +
    `      fi\n      ;;\n`
  );
}

/** The `_clawforge_complete` function body, shared verbatim by bash (sourced directly) and
 *  zsh (loaded through `bashcompinit`, which shims COMP_WORDS/COMP_CWORD for exactly this
 *  old-style `complete -F` shape) — one completion grammar, not two that could drift. */
function bashFunctionBody(commands: readonly CommandCompletionSpec[], appFlag: boolean): string {
  const names = commands.map((command) => command.name).join(" ");
  const topLevel = appFlag ? `${names} --app` : names;
  const appBlock = appFlag
    ? `  if [[ "$prev" == "--app" ]]; then\n    COMPREPLY=( $(compgen -W "${LIST_NAMES_JSON}" -- "$cur") )\n    return\n  fi\n`
    : "";
  const arms = commands.map(bashCaseArm).join("");
  const reply = (flags: readonly string[]): string => `COMPREPLY=( $(compgen -W "${flags.join(" ")}" -- "$cur") )`;
  // Choice values for options that declare `choices` (--kind, --client, --profile): keyed
  // "cmd--flag", offered instead of the command's flags at the value position. The key
  // never collides with a bare command name — command names contain no "--".
  const choiceArms = commands
    .flatMap((command) =>
      Object.entries(command.optionValues ?? {}).map(([key, values]) => `    "${key}") ${reply(values)}\n      return\n      ;;`),
    )
    .join("\n");
  const choiceCase =
    choiceArms === ""
      ? ""
      : `  local between=() key="$cmd$prev"
` +
        `  if (( cword - idx - 1 > 0 )); then between=("\${words[@]:$((idx + 1)):$((cword - idx - 1))}"); fi
` +
        `  # The word after the command scopes the key; the option itself is not a scope.
` +
        `  if (( \${#between[@]} > 0 )) && [[ "\${between[0]}" != "$prev" ]]; then key="$cmd\${between[0]}$prev"; fi
` +
        `  case "$key" in
${choiceArms}\n  esac\n`;
  // The --app skip only makes sense where the gate has one — an installed single-deployment
  // gate (appFlag: false) must not mention --app in the generated script either.
  const appSkip = appFlag
    ? "    if [[ $skip -eq 1 ]]; then skip=0; continue; fi\n" + '    if [[ "$w" == "--app" ]]; then skip=1; continue; fi\n'
    : "";
  return (
    "_clawforge_complete() {\n" +
    '  local cur="${COMP_WORDS[COMP_CWORD]}"\n' +
    '  local prev="${COMP_WORDS[COMP_CWORD-1]}"\n' +
    '  local words=("${COMP_WORDS[@]}")\n' +
    "  local cword=$COMP_CWORD\n" +
    '  local cmd="" idx=0 skip=0\n' +
    "  for ((i = 1; i < cword; i++)); do\n" +
    '    local w="${words[i]}"\n' +
    appSkip +
    '    cmd="$w"; idx=$i; break\n' +
    "  done\n" +
    "  if [[ -z \"$cmd\" ]]; then\n" +
    appBlock +
    `    COMPREPLY=( $(compgen -W "${topLevel}" -- "$cur") )\n` +
    "    return\n" +
    "  fi\n" +
    choiceCase +
    "  case \"$cmd\" in\n" +
    "    help) COMPREPLY=( $(compgen -W \"" + names + " --help\" -- \"$cur\") ) ;;\n" +
    arms +
    "    *) COMPREPLY=() ;;\n" +
    "  esac\n" +
    "}\n"
  );
}

function renderBash(commands: readonly CommandCompletionSpec[], appFlag: boolean): string {
  return (
    "# clawforge bash completion — generated from the live command declarations.\n" +
    `# Install: source <(${cli("completion bash")})\n` +
    `${bashFunctionBody(commands, appFlag)}` +
    "complete -F _clawforge_complete clawforge\n" +
    "complete -F _clawforge_complete ./clawforge\n"
  );
}

function renderZsh(commands: readonly CommandCompletionSpec[], appFlag: boolean): string {
  return (
    "#compdef clawforge ./clawforge\n" +
    "# clawforge zsh completion — generated from the live command declarations, via bash's\n" +
    "# completion protocol (bashcompinit), so this cannot drift from the bash script's own\n" +
    `# grammar. Install: ${cli("completion zsh")} > "\${fpath[1]}/_clawforge" (new shell), or\n` +
    `# source <(${cli("completion zsh")}) in the current one.\n` +
    "autoload -Uz bashcompinit\n" +
    "bashcompinit\n" +
    `${bashFunctionBody(commands, appFlag)}` +
    "complete -F _clawforge_complete clawforge\n" +
    "complete -F _clawforge_complete ./clawforge\n"
  );
}

/** PowerShell data: one line of names, a `Hashtable` per command (Flags; Actions for an
 *  action command; ChoiceValues keyed "cmd--flag"; Positional for a command whose first
 *  positional declares `choices`). Sorted, so the emitted text is the same on every run for
 *  the same declarations (no timestamps, no Map iteration order). The completer body below
 *  implements the same decision completionCandidates() does — branch for branch. */
function renderPwsh(commands: readonly CommandCompletionSpec[], appFlag: boolean): string {
  const names = commands.map((command) => `"${command.name}"`).join(", ");
  const flagTable = commands
    .map((command) => `  "${command.name}" = @(${(command.action?.fallback ?? command.flags).map((flag) => `"${flag}"`).join(", ")})`)
    .join("\n");
  const actionCommands = commands.filter((command) => command.action !== undefined);
  const actionsTable = actionCommands
    .map((command) => {
      const action = command.action!;
      const perAction = action.values
        .map((value) => `    "${value}" = @(${action.flags[value]!.map((flag) => `"${flag}"`).join(", ")})`)
        .join("\n");
      return `  "${command.name}" = @{\n${perAction}\n  }`;
    })
    .join("\n");
  const choiceTable = commands
    .flatMap((command) =>
      Object.entries(command.optionValues ?? {}).map(([key, values]) => `  "${key}" = @(${values.map((value) => `"${value}"`).join(", ")})`),
    )
    .join("\n");
  const positionalTable = commands
    .filter((command) => command.positionalValues !== undefined)
    .map((command) => `  "${command.name}" = @(${command.positionalValues!.map((value) => `"${value}"`).join(", ")})`)
    .join("\n");
  const appLine = appFlag ? " + @('--app')" : "";
  const appSkip = appFlag ? "    if ($scan[$i] -eq '--app') { $skip = $true; continue }\n" : "";

  return `# clawforge PowerShell completion — generated from the live command declarations.
# Install: ${cli("completion pwsh")} | Out-String | Invoke-Expression
$clawforgeCommands = @(${names})
$clawforgeFlags = @{
${flagTable}
}
$clawforgeActions = @{
${actionsTable === "" ? "" : actionsTable}
}
$clawforgeChoiceValues = @{
${choiceTable === "" ? "" : choiceTable}
}
$clawforgePositional = @{
${positionalTable === "" ? "" : positionalTable}
}
Register-ArgumentCompleter -Native -CommandName clawforge, ./clawforge -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
  $rest = if ($tokens.Count -gt 1) { $tokens[1..($tokens.Count - 1)] } else { @() }
  # The word being completed is the last token whenever it is non-empty. Command discovery
  # must scan only the words BEFORE it (R32-02: 'clawforge sta<Tab>' used to see the
  # command "sta" and offer nothing).
  $scan = $rest
  if ($wordToComplete -ne '') {
    if ($scan.Count -gt 1) { $scan = @($rest[0..($rest.Count - 2)]) } else { $scan = @() }
  }
  $prev = $null
  if ($wordToComplete -ne '') {
    if ($rest.Count -ge 2) { $prev = $rest[$rest.Count - 2] }
  } else {
    if ($rest.Count -ge 1) { $prev = $rest[$rest.Count - 1] }
  }
  $cmd = $null
  $idx = -1
  $skip = $false
  for ($i = 0; $i -lt $scan.Count; $i++) {
    if ($skip) { $skip = $false; continue }
${appSkip}    $cmd = $scan[$i]
    $idx = $i
    break
  }
  $candidates = @()
  if (-not $cmd) {${appFlag ? `
    if ($prev -eq '--app') {
      # --app's own value — only while no command word has been typed: --app must come
      # before the command, so past one the command's flags return (R33-10).
      $names = try { & $tokens[0] list --json --no-status 2>$null | ConvertFrom-Json | ForEach-Object { $_.name } | Where-Object { $_ -notlike '.*' } } catch { @() }
      $names | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
      }
      return
    }` : ""}
    $candidates = $clawforgeCommands${appLine}
  } else {
    $between = @()
    if ($scan.Count - $idx - 1 -gt 0) { $between = @($scan[($idx + 1)..($scan.Count - 1)]) }
    # A value position keyed "cmd--flag", or "cmdACTION--flag" once the word after the
    # command scopes it — the option itself is not a scope.
    $key = "$cmd$prev"
    if ($between.Count -gt 0 -and $between[0] -ne $prev) { $key = "$cmd$($between[0])$prev" }
    if ($null -ne $prev -and $clawforgeChoiceValues.ContainsKey($key)) {
      $candidates = $clawforgeChoiceValues[$key]
    } elseif ($cmd -eq 'help') {
      # help takes a command name.
      $candidates = $clawforgeCommands + @('--help')
    } else {
      if ($clawforgeActions.ContainsKey($cmd)) {
        if ($between.Count -eq 0) {
          # The action word itself (whole or partial) is being typed; an implicit default
          # action's flags are offered too.
          $candidates = @($clawforgeActions[$cmd].Keys) + $clawforgeFlags[$cmd]
        } elseif ($clawforgeActions[$cmd].ContainsKey($between[0])) {
          $candidates = $clawforgeActions[$cmd][$between[0]]
        } else {
          $candidates = $clawforgeFlags[$cmd]
        }
      } elseif ($clawforgePositional.ContainsKey($cmd) -and $between.Count -eq 0) {
        $candidates = @($clawforgePositional[$cmd]) + $clawforgeFlags[$cmd]
      } else {
        $candidates = $clawforgeFlags[$cmd]
      }
    }
  }
  $candidates | Where-Object { $_ -like "$wordToComplete*" } | Sort-Object -Unique | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

export function renderCompletion(shell: CompletionShell, commands: readonly CommandCompletionSpec[], appFlag: boolean): string {
  if (shell === "bash") return renderBash(commands, appFlag);
  if (shell === "zsh") return renderZsh(commands, appFlag);
  return renderPwsh(commands, appFlag);
}

/** `siblingGateCommands` is the SAME array the caller builds its own gate list into — this
 *  command is pushed onto it after the literal, so the closure sees every entry (itself
 *  included) once `run` executes. `appFlag` says whether the caller's gate has an `--app`
 *  selector (the monorepo gate does; the installed single-deployment one doesn't). */
export function makeCompletionGateCommand(siblingGateCommands: readonly GateCommand[], appFlag: boolean): GateCommand {
  return {
    name: "completion",
    summary: "Print a shell completion script (bash, zsh or pwsh) to stdout",
    details:
      "Generated from the live command declarations — names, flags, and a multi-action " +
      "command's own flags under the right action — so it cannot drift from --help.\n" +
      "Install: source <(./clawforge completion bash); " +
      './clawforge completion zsh > "${fpath[1]}/_clawforge"; or ' +
      "./clawforge completion pwsh | Out-String | Invoke-Expression.\n" +
      (appFlag ? "--app's own value completion calls `<the name you typed> list --json --no-status` lazily, only once a shell actually asks for it — never baked into the script.\n" : "") +
      "No deployment is resolved, no .env is read, no lock is touched.",
    arguments: COMPLETION_ARGUMENTS,
    run: async (args) => {
      const parsed = parseDeclaredArgs(COMPLETION_ARGUMENTS, args);
      const shell = parsed.shell as string | undefined;
      if (shell === undefined || !COMPLETION_SHELLS.includes(shell as CompletionShell)) {
        reportError(`usage: ./clawforge completion <${COMPLETION_SHELLS.join("|")}>`);
        return 1;
      }
      const model = buildCompletionModel(siblingGateCommands);
      emitRaw(renderCompletion(shell as CompletionShell, model, appFlag));
      return 0;
    },
  };
}
