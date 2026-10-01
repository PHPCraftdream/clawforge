// The one renderer for advice: a clawforge command, a shell line or a manual step becomes
// the exact text a user pastes. The `--app` rule and argument quoting live here and only
// here; advice.ts is data.

import { shellQuote } from "../shell.ts";
import { invocation, type Invocation } from "./index.ts";
import { command, type Advice } from "./advice.ts";

export const SHIM_PROGRAM = "./clawforge";

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

/** A word POSIX and cmd leave as is without quoting. `/` is excluded, so a path is a
 *  program spelling (rendered bare) rather than an argument. */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,.-]+$/;

function renderArgument(word: string, program: string): string {
  if (/^<.*>$/.test(word)) return word;                // a placeholder <…> stays bare
  if (SAFE_WORD.test(word)) return word;
  if (program.includes("/")) return shellQuote(word); // a path spelling: POSIX rules
  return `"${word.replaceAll('"', '\\"')}"`;           // bare clawforge (cmd, pwsh): double quotes only
}

export function renderAdvice(advice: Advice, on: Invocation = invocation()): string {
  if (advice.kind === "shell") {
    return advice.note === undefined ? advice.text : `${advice.text}  (${advice.note})`;
  }
  if (advice.kind === "manual") {
    return advice.text;
  }
  const parts = [on.program];
  if (advice.app !== undefined) {
    parts.push("--app", advice.app);
  } else if (
    !isGateCommand(advice.argv[0]) &&
    on.app !== undefined &&
    on.app.name !== "openclaw" &&
    (on.app.selectedBy === "flag" || on.app.selectedBy === "env" || on.app.selectedBy === "sole")
  ) {
    parts.push("--app", on.app.name);
  }
  for (const argument of advice.argv) parts.push(renderArgument(argument, on.program));
  const line = parts.join(" ");
  return advice.note === undefined ? line : `${line}  (${advice.note})`;
}

export function commandLine(argv: string | readonly string[], options?: { readonly app?: string }): string {
  return renderAdvice(command(argv, options));
}
