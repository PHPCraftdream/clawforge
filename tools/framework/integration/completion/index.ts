// Shell completion, generated from the live command declarations rather than hand-maintained:
// command names, each command's own flags, and — for a multi-action command's `action`
// positional (CommandArgument.choices) — its flags placed under the right action
// (CommandArgument.actions), the same field help-render.ts and the MCP schema already read.
// The declarations reach a script only as a table (table.ts); bash.ts and pwsh.ts are that
// table plus a fixed interpreter each, and this module picks between the two.
//
// Every shell calls `<invoked name> list --json --no-status` lazily, from inside the completer,
// only once a shell asks for `--app`'s value — never baked into the generated text, and via
// whichever of the system-wide command or the checkout shim was typed. Output never carries a machine path.

import { parseDeclaredArgs } from "../../core/command/index.ts";
import { commandLine } from "../../core/io/invocation/render.ts";
import { emitRaw } from "../../core/io/output.ts";
import { openclawCommands } from "../../commands/interface/index.ts";
import { bashCompletionLines, renderBash } from "./bash.ts";
import { renderPwsh } from "./pwsh.ts";
import { completionData, type CompletionData } from "./table.ts";
import { commandRegistry, type GateCommand } from "../gate.ts";
import type { CommandArgument } from "../../core/app.ts";

export type CompletionShell = "bash" | "zsh" | "pwsh";

export const COMPLETION_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "pwsh"];

export const COMPLETION_COMMAND_NAME = "completion";

export const COMPLETION_ARGUMENTS: CommandArgument[] = [
  { name: "shell", description: "bash, zsh or pwsh", kind: "positional", required: true, choices: COMPLETION_SHELLS },
];

/** The zsh script is the bash script, byte for byte, behind zsh's own header: `bashcompinit`
 *  shims COMP_WORDS/COMP_CWORD for exactly this old-style `complete -F` shape, so both shells
 *  load one completion grammar rather than two that could drift. The body is sliced out of the
 *  bash render itself, which is what makes that identity hold. */
function renderZsh(data: CompletionData): string {
  const bash = renderBash(data);
  const body = bash.slice(bash.indexOf("_clawforge_lookup()"), bash.indexOf(bashCompletionLines));
  return (
    "#compdef clawforge ./clawforge\n" +
    "# clawforge zsh completion — generated from the live command declarations, via bash's\n" +
    "# completion protocol (bashcompinit), so this cannot drift from the bash script's own\n" +
    `# grammar. Install: ${commandLine(["completion", "zsh"])} > "\${fpath[1]}/_clawforge" (new shell), or\n` +
    `# source <(${commandLine(["completion", "zsh"])}) in the current one.\n` +
    "autoload -Uz bashcompinit\n" +
    "bashcompinit\n" +
    body +
    bashCompletionLines
  );
}

export function renderCompletion(shell: CompletionShell, data: CompletionData): string {
  if (shell === "bash") return renderBash(data);
  if (shell === "zsh") return renderZsh(data);
  return renderPwsh(data);
}

/** `siblings` is the SAME array the caller builds its own gate list into — this command is
 *  pushed onto it after the literal. The registry is built from it inside `run`, so it sees
 *  every entry (itself included) once the command executes. `appFlag` says whether the
 *  caller's gate has an `--app` selector (the monorepo gate does; the installed
 *  single-deployment one doesn't). */
export function makeCompletionGateCommand(siblings: readonly GateCommand[], appFlag: boolean): GateCommand {
  return {
    name: COMPLETION_COMMAND_NAME,
    summary: "Print a shell completion script (bash, zsh or pwsh) to stdout",
    details:
      "Generated from the live command declarations — names, flags, and a multi-action " +
      "command's own flags under the right action — so it cannot drift from --help.\n" +
      "Install: source <({clawforge completion bash}); " +
      '{clawforge completion zsh} > "${fpath[1]}/_clawforge"; or ' +
      "{clawforge completion pwsh} | Out-String | Invoke-Expression.\n" +
      (appFlag ? "--app's own value completion calls `<the name you typed> list --json --no-status` lazily, only once a shell actually asks for it — never baked into the script.\n" : "") +
      "No deployment is resolved, no .env is read, no lock is touched.",
    arguments: COMPLETION_ARGUMENTS,
    run: async (args) => {
      // required and choices are enforced by runGateCommand against this same declaration.
      const shell = parseDeclaredArgs(COMPLETION_ARGUMENTS, args).shell as CompletionShell;
      const model = completionData(commandRegistry({ deployment: openclawCommands, gate: siblings, appName: "clawforge" }), appFlag);
      emitRaw(renderCompletion(shell, model));
      return 0;
    },
  };
}
