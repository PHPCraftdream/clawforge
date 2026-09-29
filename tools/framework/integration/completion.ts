// Shell completion, generated from the live command declarations rather than hand-maintained:
// command names, each command's own flags, and — for a multi-action command's `action`
// positional (CommandArgument.choices) — its flags placed under the right action
// (CommandArgument.actions), the same field help-render.ts and the MCP schema already read.
//
// bash/zsh call `./clawforge list --json` lazily, from inside the shell function, only once
// a shell asks for `--app`'s value — never baked into the generated text. Output never
// carries a machine path: only the invoked name, `clawforge` or `./clawforge`.

import { parseDeclaredArgs } from "../core/arguments.ts";
import { reportError } from "../core/io/log.ts";
import { emit } from "../core/io/output.ts";
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
interface CommandCompletionSpec {
  readonly name: string;
  /** Every flag/option this command declares with no `actions` scoping — its own flags when
   *  it has no action positional, or the ones every action shares (core/app.ts's documented
   *  meaning of an absent `actions` field). Trusts the same declaration --help/MCP schema
   *  read, not a private per-action parser. Always ends with `--help`. */
  readonly flags: readonly string[];
  readonly action?: {
    readonly values: readonly string[];
    readonly flags: Readonly<Record<string, readonly string[]>>;
  };
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

  if (actionArgument === undefined) return { name, flags: globalFlags };

  const perAction: Record<string, readonly string[]> = {};
  for (const value of actionArgument.choices) {
    const scoped = flagArgs.filter((argument) => argument.actions?.includes(value) === true).map(flagName);
    perAction[value] = [...new Set([...globalFlags, ...scoped])].sort();
  }
  return { name, flags: globalFlags, action: { values: [...actionArgument.choices].sort(), flags: perAction } };
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

const LIST_NAMES_JSON = "$(./clawforge list --json 2>/dev/null | grep -o '\"name\":\"[^\"]*\"' | cut -d'\"' -f4)";

/** One `case "$cmd" in …` arm: a plain compgen for a single-action command, or a nested
 *  dispatch on the action word (still typing it vs. already past it) for one with an
 *  `action` positional — the exact shape backup/recipe/watch/expose/sets declare theirs. */
function bashCaseArm(spec: CommandCompletionSpec): string {
  const reply = (flags: readonly string[]): string => `COMPREPLY=( $(compgen -W "${flags.join(" ")}" -- "$cur") )`;
  if (spec.action === undefined) {
    return `    ${spec.name}) ${reply(spec.flags)} ;;\n`;
  }
  const action = spec.action;
  const arms = action.values.map((value) => `        ${value}) ${reply(action.flags[value] ?? spec.flags)} ;;`).join("\n");
  return (
    `    ${spec.name})\n` +
    `      if [[ $cword -eq $((idx + 1)) ]]; then\n` +
    `        ${reply([...action.values, "--help"])}\n` +
    `      else\n` +
    `        case "\${words[$((idx + 1))]}" in\n${arms}\n          *) ${reply(["--help"])} ;;\n        esac\n` +
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
    '  if [[ -z "$cmd" ]]; then\n' +
    appBlock +
    `    COMPREPLY=( $(compgen -W "${topLevel}" -- "$cur") )\n` +
    "    return\n" +
    "  fi\n" +
    '  case "$cmd" in\n' +
    arms +
    "    *) COMPREPLY=() ;;\n" +
    "  esac\n" +
    "}\n"
  );
}

function renderBash(commands: readonly CommandCompletionSpec[], appFlag: boolean): string {
  return (
    "# clawforge bash completion — generated from the live command declarations.\n" +
    "# Install: source <(./clawforge completion bash)\n" +
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
    "# grammar. Install: ./clawforge completion zsh > \"${fpath[1]}/_clawforge\" (new shell), or\n" +
    "# source <(./clawforge completion zsh) in the current one.\n" +
    "autoload -Uz bashcompinit\n" +
    "bashcompinit\n" +
    `${bashFunctionBody(commands, appFlag)}` +
    "complete -F _clawforge_complete clawforge\n" +
    "complete -F _clawforge_complete ./clawforge\n"
  );
}

/** PowerShell data: one line of names, and a `Hashtable` per command (Flags, and — only for
 *  an action command — an Actions table keyed by action name). Sorted, so the emitted text is
 *  the same on every run for the same declarations (no timestamps, no Map iteration order). */
function renderPwsh(commands: readonly CommandCompletionSpec[], appFlag: boolean): string {
  const names = commands.map((command) => `"${command.name}"`).join(", ");
  const flagTable = commands
    .map((command) => `  "${command.name}" = @(${command.flags.map((flag) => `"${flag}"`).join(", ")})`)
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
  const appLine = appFlag ? " + @('--app')" : "";
  const appSkip = appFlag ? "    if ($rest[$i] -eq '--app') { $i++; continue }\n" : "";

  return `# clawforge PowerShell completion — generated from the live command declarations.
# Install: ./clawforge completion pwsh | Out-String | Invoke-Expression
$clawforgeCommands = @(${names})
$clawforgeFlags = @{
${flagTable}
}
$clawforgeActions = @{
${actionsTable === "" ? "" : actionsTable}
}
Register-ArgumentCompleter -Native -CommandName clawforge, ./clawforge -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
  $rest = if ($tokens.Count -gt 1) { $tokens[1..($tokens.Count - 1)] } else { @() }
  $cmd = $null
  $idx = -1
  for ($i = 0; $i -lt $rest.Count; $i++) {
${appSkip}    $cmd = $rest[$i]
    $idx = $i
    break
  }
  $candidates = @()
  if (-not $cmd -or $idx -eq ($rest.Count - 1)) {
    $candidates = $clawforgeCommands${appLine}
  } elseif ($clawforgeActions.ContainsKey($cmd) -and $idx -eq ($rest.Count - 2)) {
    $candidates = $clawforgeActions[$cmd].Keys
  } elseif ($clawforgeActions.ContainsKey($cmd)) {
    $action = $rest[$idx + 1]
    $candidates = if ($clawforgeActions[$cmd].ContainsKey($action)) { $clawforgeActions[$cmd][$action] } else { $clawforgeFlags[$cmd] }
  } else {
    $candidates = $clawforgeFlags[$cmd]
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
      (appFlag ? "--app's own value completion calls `./clawforge list --json` lazily, only once a shell actually asks for it — never baked into the script.\n" : "") +
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
      emit(renderCompletion(shell as CompletionShell, model, appFlag));
      return 0;
    },
  };
}
