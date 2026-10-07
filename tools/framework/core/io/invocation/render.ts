// The one renderer for advice: a clawforge command, a shell line or a manual step becomes
// the exact text a user pastes. The `--app` rule and argument quoting live here and only
// here; advice.ts is data. The program is spelled by the frame (frame.ts): the installed
// launch spells as handed, a checkout-root row spells from the root — by the KIND of
// launch, never by "contains /".

import { shellQuote } from "../shell.ts";
import { currentFrame, frameFacts, invocation, type Invocation } from "./index.ts";
import {
  frameFromInvocation,
  handoverOf,
  IN_BASH_NOTE,
  launchOf,
  pasteShells,
  resolvesByCwd,
  spell,
  SHIM_PROGRAM,
  toCheckoutRoot,
  WINDOWS_BIN_PROGRAM,
  type Frame,
  type Host,
  rootedLaunch,
} from "./frame.ts";
import { command, type Advice } from "./advice.ts";

export { SHIM_PROGRAM };
export { WINDOWS_BIN_PROGRAM };

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

/** One word's quoting for a frame whose shells are POSIX-only. */
function posixArgument(word: string): string {
  if (/^<.*>$/.test(word)) return word;                // a placeholder <…> stays bare
  if (SAFE_WORD.test(word)) return word;
  return shellQuote(word);                             // a path spelling: POSIX rules
}

/** One word's quoting for a frame that also pastes into cmd.exe and PowerShell: double
 *  quotes are the only spelling all three parse. POSIX shells still expand `$` and
 *  backticks inside them, so a word carrying one is single-quoted instead: it pastes
 *  safely into POSIX shells and PowerShell (cmd.exe keeps single quotes literally, an
 *  accepted limit for a value that cannot be spelled safely there). Never throws: this
 *  runs while an error is reported. */
function shellArgument(word: string): string {
  if (/^<.*>$/.test(word)) return word;
  if (SAFE_WORD.test(word)) return word;
  if (POSIX_ACTIVE.test(word)) return shellQuote(word);
  return `"${word.replaceAll('"', '\\"')}"`;
}

/** Boundary shim for pre-frame callers only (the advice-matrix pins hold it; it dies in
 *  S1.3/S1.4): the shells come from the program's launch kind plus this process's host
 *  facts, and the word quotes by those shells — no decision by the program's spelling. */
export function renderArgument(word: string, program: string): string {
  const launch = launchOf({ program, mode: program === "clawforge" ? "installed" : "checkout", audience: "terminal" });
  const host: Host = { kind: "operator", platform: process.platform === "win32" ? "win32" : "posix" };
  const shells = pasteShells(launch, host, false);
  return shells.length === 1 && shells[0] === "posix" ? posixArgument(word) : shellArgument(word);
}

/** An argv echoed for a reader to re-assemble — the failure headlines of exec, host and cli:
 *  each element by the argument rule under a path spelling (POSIX quoting), so plain words
 *  stay bare and an element carrying a space, a quote or a newline stays one element. */
export function renderArguments(argv: readonly string[]): string {
  return argv.map((word) => renderArgument(word, SHIM_PROGRAM)).join(" ");
}

/** Programs that find their deployment from the cwd (entry/resolve.ts aliases the same
 *  list, which needs it for the cwd re-selection): the system-wide command, a deployment's
 *  own shim and npm's bin wrapper. A path spelling (the MCP launcher) never reads the cwd. */
export const CWD_RESOLVING_PROGRAMS: readonly string[] = ["clawforge", SHIM_PROGRAM, WINDOWS_BIN_PROGRAM];
/** The note a paste-conflict row carries (rf6-fix33) — exported so the matrix check strips
 *  exactly what the renderer adds. */
export const CWD_CONFLICT_NOTE = "from the checkout root";

/** SAFE_WORD plus backslash: the invocation's own program is spelled for the user's shell
 *  already (npm's bin wrapper carries `\`), so it renders bare like any safe word. */
const SAFE_PROGRAM = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

/** The program as typed: quoted by the argument rule when it carries a space or a shell word.
 *  Kept for pre-frame callers (prose.ts, the matrix check); no slash decision lives here. */
export function renderProgram(on: Invocation): string {
  return SAFE_PROGRAM.test(on.program) ? on.program : renderArgument(on.program, on.program);
}

/** The renderer proper: the FRAME is the input. Every decision — the checkout-root spelling
 *  (toCheckoutRoot, the frame's own places), the fallback shell, the quoting rule (the
 *  frame's shells) — reads the frame value, never the invocation's string spelling. */
export function renderFrameAdvice(
  advice: Advice,
  frame: Frame,
  // deploymentFree: a pointer to a command whose own usage never targets a deployment (the dispatcher's two).
  options?: { readonly deploymentFree?: boolean },
  // The spelling the caller typed, exactly as handed: a hand-over's checkout spelling (the
  // MCP launcher's two-levels-up program) is echoed as typed, but a Frame built from it
  // carries only the launch kind — the root spelling, not the hand-over — so the v1 wrapper
  // passes it through here (S1.3's Launch-carrying resolver removes the gap).
  asTyped?: string,
): string {
  if (advice.kind === "shell") {
    return advice.note === undefined ? advice.text : `${advice.text}  (${advice.note})`;
  }
  if (advice.kind === "manual") {
    return advice.text;
  }
  const on = handoverOf(frame);
  const handed = asTyped ?? on.program;
  const host = frame.host.kind === "operator" ? frame.host.platform : "posix";
  // A checkout-root advice spells the program from the checkout root — the frame the
  // place-naming sentences direct to — not from the directory this run refused in. The
  // same frame for a row that names a deployment the cwd's own selection does not, under
  // a cwd-resolving program: pasted where this run stands it is refused as an app
  // conflict (rf6-fix33), and the conflict refusal's own remedy is the checkout root —
  // so the row is spelled from there, with the note saying where it pastes.
  const cwdConflict = advice.app !== undefined
    && frame.app.state === "selected" && frame.app.by === "cwd" && frame.app.name !== advice.app
    && resolvesByCwd(frame.launch, on.program);
  const rooted = advice.at === "checkout-root" || cwdConflict;
  let note = advice.note ?? (cwdConflict ? CWD_CONFLICT_NOTE : undefined);
  let program = handed;
  if (rooted) {
    // The re-rooted frame spells in the frame's primary shell, or — a bash shim under
    // [cmd, pwsh] — in none: there the POSIX spelling stands in (Git Bash, the documented
    // checkout path on Windows; decision O1). The note naming that shell is the S1.4
    // renderer's: this check set reads the note suffix as command words (design S1.6).
    // Without a known checkout root the transition is a no-op, so the spelling falls
    // back to the launch's own re-rooting (the pre-frame behavior, kept byte-identical).
    const reRooted = toCheckoutRoot(frame);
    const root = reRooted.places.checkoutRoot;
    const launch = root === undefined ? rootedLaunch(frame.launch) : reRooted.launch;
    // The spelling is relative to where the frame stands: the frame's places decide the
    // program (a wrong recorded root spells a wrong line), and the transition's paste
    // directory is the checkout root itself. Without a known root the transition is a
    // no-op and the launch's own re-rooting stands (the pre-frame behavior, kept
    // byte-identical).
    const from = frame.cwd.kind === "dir" ? frame.cwd.path : undefined;
    const primary = spell(launch, frame.shells[0], host, from);
    program = primary ?? spell(launch, "posix", host, from) ?? handed;
    // The fallback case (O1, S1.2a): the frame's own shells have no spelling for the
    // re-rooted launch — npm's bin wrapper on win32 re-roots to the bash-only shim under
    // [cmd, pwsh] — so the POSIX spelling stands in (Git Bash, the documented checkout
    // path) and the note names that shell. A frame whose shells are [posix] spells the
    // shim itself and carries no note.
    if (primary === undefined) {
      note = note === undefined ? IN_BASH_NOTE : `${note}, ${IN_BASH_NOTE}`;
    }
  } else {
    // O4: a hint printed from a subdirectory of its launch root spells the entry relative
    // to the frame's paste directory, one climb per level; at the root the root spelling
    // stands byte-identical. Only a frame that knows BOTH its launch root and its paste
    // directory re-spells — a launch read back from a hand-over (root "") or a frame
    // without a paste directory keeps the handed spelling (the pre-frame behavior).
    const from = frame.cwd.kind === "dir" ? frame.cwd.path : undefined;
    const launchRoot = frame.launch.kind === "checkout-shim" || frame.launch.kind === "deployment-shim" || frame.launch.kind === "npm-bin" ? frame.launch.root : undefined;
    if (launchRoot !== undefined && launchRoot !== "" && from !== undefined) {
      program = spell(frame.launch, frame.shells[0], host, from)
        ?? spell(frame.launch, "posix", host, from)
        ?? handed;
    }
  }
  // An install line spells its program for the shell that pastes it, not for wherever
  // this run stood: forward slashes survive bash, zsh and every PowerShell alike.
  if (advice.install === true) program = program.replaceAll("\\", "/");
  // Arguments quote by the frame's shells, not by the program's spelling: a frame that
  // also pastes into cmd.exe and PowerShell takes the double-quote rule, a POSIX-only
  // frame the POSIX one.
  const posixOnly = frame.shells.length === 1 && frame.shells[0] === "posix";
  const quote = (word: string): string => (posixOnly ? posixArgument(word) : shellArgument(word));
  // The program quotes by the same rule as an argument (review R9-A R9-4): a hand-set
  // CLAWFORGE_INVOCATION whose program carries a space must still render a pasteable line.
  const parts = [SAFE_PROGRAM.test(program) ? program : quote(program)];
  if (advice.app !== undefined) {
    parts.push("--app", quote(advice.app));
  } else if (
    !isGateCommand(advice.argv[0]) &&
    options?.deploymentFree !== true &&
    on.app !== undefined &&
    (on.app.selectedBy === "flag" || on.app.selectedBy === "env" || on.app.selectedBy === "sole")
  ) {
    // A flagged `openclaw` is named too: it is the default only while OC_APP is unset,
    // and the pasting shell may export it.
    parts.push("--app", quote(on.app.name));
  }
  for (const argument of advice.argv) parts.push(quote(argument));
  const line = parts.join(" ");
  return note === undefined ? line : `${line}  (${note})`;
}

/** Compatibility wrapper: the remaining Invocation-passing callers (commands/**,
 *  integration/**, the checks) convert to renderFrameAdvice in S1.3/S1.4. When `on` is
 *  omitted the installed frame (currentFrame) drives rendering; an explicit Invocation
 *  derives its frame without installing. */
export function renderAdvice(
  advice: Advice,
  on?: Invocation,
  options?: { readonly deploymentFree?: boolean },
): string {
  const frame = on === undefined ? currentFrame() : frameFromInvocation(on, frameFacts());
  // The spelling as handed: the stored Invocation's own program (a hand-over's checkout
  // spelling survives the frame round-trip only through this pass-through).
  return renderFrameAdvice(advice, frame, options, on?.program ?? invocation().program);
}

export function commandLine(argv: string | readonly string[], options?: { readonly app?: string; readonly note?: string; readonly deploymentFree?: boolean; readonly at?: "checkout-root" }): string {
  return renderAdvice(command(argv, options), invocation(), { deploymentFree: options?.deploymentFree });
}

/** The install line a generated completion script spells in its header, and the --help
 *  prose sentences echo: this invocation's program and argv, the program re-spelled for
 *  the shell that pastes the line (CommandAdvice.install), not for wherever the run stood. */
export function installLine(argv: readonly string[]): string {
  return renderAdvice(command(argv, { install: true }), invocation());
}
