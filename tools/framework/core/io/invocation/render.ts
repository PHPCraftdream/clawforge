// The one renderer for advice: a clawforge command, a shell line or a manual step becomes
// the exact text a user pastes. The `--app` rule and argument quoting live here and only
// here; advice.ts is data.

import { shellQuote } from "../shell.ts";
import { invocation, type Invocation } from "./index.ts";
import { command, type Advice } from "./advice.ts";

export const SHIM_PROGRAM = "./clawforge";
/** The local-package program on Windows: npm's bin wrapper, which cmd resolves through
 *  PATHEXT and PowerShell through its own lookup. The committed shim (SHIM_PROGRAM) is
 *  bash-only (see init.ts) and runs in neither; forward slashes fail in cmd. */
export const WINDOWS_BIN_PROGRAM = "node_modules\\.bin\\clawforge";

/** Gate-command names, registered by the entry before any command runs; they run before a
 *  deployment is resolved, so they never receive an `--app` (see useGateCommands). */
const gateCommands = new Set<string>();

export function useGateCommands(names: readonly string[]): void {
  for (const name of names) gateCommands.add(name);
}

/** The explicit invocation for text that leaves the terminal — a file, cron, a remote
 *  server — where no CLAWFORGE_INVOCATION rides along; the shim spells its own `--app`. */
export function shimInvocation(app?: string): Invocation {
  if (app === undefined) return { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" };
  return { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal", app: { name: app, selectedBy: "flag" } };
}

function isGateCommand(word: string | undefined): boolean {
  return word !== undefined && gateCommands.has(word);
}

/** A word POSIX, cmd and pwsh leave as is without quoting (a path or an image reference included).
 *  `%` stays only because POSIX and PowerShell treat it literally; under the bare program
 *  cmd.exe expands `%VAR%` even inside double quotes and no quoting neutralises it, so no
 *  advice word may carry one — advice-matrix.check.ts refuses such a row, and deployment
 *  names cannot contain `%` anyway (safeName, core/values/names.ts). */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** Characters POSIX expands inside double quotes: such a word is single-quoted (see renderArgument). */
const POSIX_ACTIVE = /[`$\\]/;

/** One word's quoting, exported for refusals that print a value the user typed (the same
 *  rule as the advice line, applied outside renderAdvice). */
export function renderArgument(word: string, program: string): string {
  if (/^<.*>$/.test(word)) return word;                // a placeholder <…> stays bare
  if (SAFE_WORD.test(word)) return word;
  if (program.includes("/")) return shellQuote(word); // a path spelling: POSIX rules
  // Bare `clawforge` is typed in cmd.exe and PowerShell as often as in bash: double quotes
  // are the only spelling all three parse. POSIX shells still expand `$` and backticks
  // inside them, so a word carrying one is single-quoted instead: it pastes safely into POSIX
  // shells and PowerShell (cmd.exe keeps single quotes literally, an accepted limit for a value
  // that cannot be spelled safely there). Never throws: this runs while an error is reported.
  if (POSIX_ACTIVE.test(word)) return shellQuote(word);
  return `"${word.replaceAll('"', '\\"')}"`;
}

/** SAFE_WORD plus backslash: the invocation's own program is spelled for the user's shell
 *  already (npm's bin wrapper carries `\`), so it renders bare like any safe word. */
const SAFE_PROGRAM = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

export function renderAdvice(advice: Advice, on: Invocation = invocation()): string {
  if (advice.kind === "shell") {
    return advice.note === undefined ? advice.text : `${advice.text}  (${advice.note})`;
  }
  if (advice.kind === "manual") {
    return advice.text;
  }
  // The program quotes by the same rule as an argument (review R9-A R9-4): a hand-set
  // CLAWFORGE_INVOCATION whose program carries a space must still render a pasteable line.
  const parts = [SAFE_PROGRAM.test(on.program) ? on.program : renderArgument(on.program, on.program)];
  if (advice.app !== undefined) {
    parts.push("--app", renderArgument(advice.app, on.program));
  } else if (
    !isGateCommand(advice.argv[0]) &&
    on.app !== undefined &&
    on.app.name !== "openclaw" &&
    (on.app.selectedBy === "flag" || on.app.selectedBy === "env" || on.app.selectedBy === "sole")
  ) {
    parts.push("--app", renderArgument(on.app.name, on.program));
  }
  for (const argument of advice.argv) parts.push(renderArgument(argument, on.program));
  const line = parts.join(" ");
  return advice.note === undefined ? line : `${line}  (${advice.note})`;
}

export function commandLine(argv: string | readonly string[], options?: { readonly app?: string }): string {
  return renderAdvice(command(argv, options));
}
