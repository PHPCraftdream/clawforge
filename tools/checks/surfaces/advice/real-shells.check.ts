// The frame law over REAL shells (stage 7 S1.6, design §7.2): the tokenization model in
// kit/shells.ts is proven by pasting the renderer's actual lines into the shell itself.
// A temp directory OUTSIDE the checkout — its path carries a space, the O2 case — holds
// stub programs (the committed-shim spellings plus node_modules/.bin wrappers) that print
// JSON {stub, cwd, argv}. One line per spelling form: the model's tokenization decides the
// expected words, the real shell must run exactly that stub with exactly that argv in
// exactly that directory. A missing shell capability is a visible skip (I11), never a
// silent pass. Surfaces group, not exclusive, no checkout writes. The fixtures and
// frames are Windows-shaped (PATHEXT stubs, cmd/pwsh), so the file declares the host it
// needs and is skipped — visibly — elsewhere.
// check:requires windows-host

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { installLineParts, renderAdviceParts } from "#framework/core/io/invocation/render.ts";
import { command, shellLine, type Advice } from "#framework/core/io/invocation/advice.ts";
import { pasteShells, SHIM_PROGRAM, type Frame, type Host, type HostPlatform, type Launch, type Places } from "#framework/core/io/invocation/frame.ts";
import { parsePaste, programArgv, type Shell } from "#checks/kit/shells.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { installFrame, setInvocation } from "#framework/core/io/invocation/index.ts";
import { handoverOf } from "#framework/core/io/invocation/frame.ts";
import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { pwshCommand } from "#checks/kit/capabilities/capabilities.ts";
import { runProcess, type ProcessResult } from "#checks/kit/spawn.ts";

const TIMEOUT_MS = 60_000;

// Known gaps, in the same decrease-only baseline mechanism the frame law uses
// (baseline.json, "realShellKnownGaps"): a case recorded here is reported as a counted
// KNOWN GAP instead of a failure — an owner decision is owed, not silently skipped. A
// gap that stops occurring must be removed from the baseline; an unrecorded failure
// fails this check.
interface KnownGaps {
  readonly comment: string;
  readonly gaps: Record<string, string>;
  readonly total: number;
}
const gapsPath = pathResolve(monorepoRoot, "tools", "checks", "architecture", "baseline.json");
const knownGaps = (JSON.parse(await readFile(gapsPath, "utf8")) as { realShellKnownGaps: KnownGaps }).realShellKnownGaps;
const seenGaps = new Set<string>();
// The stable reason for the renderer's quoted-program spelling: pwsh reads a quoted word
// as a string and cmd reads a single-quoted word literally, so one quoting cannot serve
// both (the pwsh wording is the law key's; the cmd wording names cmd's own reading).
const GAP_PWSH = "the renderer quotes the program word; pwsh reads a quoted word as a string — invoking it needs the call operator & (owner decision: per-shell rows or a documented entry)";
const GAP_CMD = "the renderer quotes the program word; cmd reads a single-quoted word literally — invoking it needs double quotes (owner decision: per-shell rows or a documented entry)";

const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const fwd = (path: string): string => path.split(BS).join("/");

// --- the stub tree (outside the checkout; the root path carries a space) ----------------------

const ROOT = await mkdtemp(join(tmpdir(), "clawforge s16 stubs "));
const DOCS = join(ROOT, "docs");
const DEMO = join(ROOT, "apps", "demo");
const CONFIG = join(DEMO, "config");
const BIN = join(ROOT, "node_modules", ".bin");
const MARKER_NAME = "calc-ran.txt";
const MARKER = join(ROOT, MARKER_NAME);
const PRINTER = join(ROOT, "printer.cjs");
const NODE = JSON.stringify(process.execPath);
const shStub = (id: string): string => ["#!/bin/sh", NL, "exec ", NODE, " ", JSON.stringify(PRINTER), " ", JSON.stringify(id), ' "$@"'].join("");
const cmdStub = (id: string): string => ["@", NODE, ' "' + PRINTER + '" "', id, '" %*'].join("");
const psStub = (id: string): string => ["& ", NODE, " ", JSON.stringify(PRINTER), " ", JSON.stringify(id), " @args"].join("");
const STUBS: readonly (readonly [string, string])[] = [
  ["printer.cjs", `process.stdout.write(JSON.stringify({ stub: process.argv[2], cwd: process.cwd(), argv: process.argv.slice(3) }));`],
  ["clawforge", shStub(fwd(join(ROOT, "clawforge")))],
  ["clawforge.cmd", cmdStub("%~f0")],
  // A second command a quoting bug would let cmd run: first on PATH, it only leaves a marker.
  ["calc.cmd", `@echo ran> "%~dp0${MARKER_NAME}"`],
  ["clawforge.ps1", psStub("$PSCommandPath")],
  ["apps/demo/clawforge", shStub(fwd(join(DEMO, "clawforge")))],
  ["node_modules/.bin/clawforge", shStub(fwd(join(BIN, "clawforge")))],
  ["node_modules/.bin/clawforge.cmd", cmdStub("%~f0")],
  ["node_modules/.bin/clawforge.ps1", psStub("$PSCommandPath")],
];
for (const dir of [ROOT, DOCS, DEMO, CONFIG, BIN]) await mkdir(dir, { recursive: true });
for (const [path, body] of STUBS) {
  await writeFile(join(ROOT, path), body, "utf8");
  // chmod every stub (the .bin wrapper included): on a POSIX host the sh stubs need the
  // bit; on Windows the call is a best-effort no-op for the shebang forms.
  await chmod(join(ROOT, path), 0o755).catch(() => { /* Windows: ACLs, not mode bits */ });
}
const printerId = (path: string): string => {
  try { return realpathSync.native(path).toLowerCase(); } catch { return resolve(path).toLowerCase(); }
};

// --- the frame the model spells from -----------------------------------------------------------
// This host is Windows, so the bash cases carry Git Bash facts (win32 + msys): the shims'
// spellings are then the forward-slash forms bash actually runs.

function frameOf(launch: Launch, msys: boolean, cwd: string, places: Places = {}): Frame {
  const hostPlatform: HostPlatform = "win32";
  const host: Host = { kind: "operator", platform: hostPlatform };
  return { launch, host, shells: pasteShells(launch, host, msys), cwd: { kind: "dir", path: cwd }, places, app: { state: "none" }, audience: "terminal" };
}

interface RealCase {
  readonly name: string;
  readonly shell: "bash" | "pwsh" | "cmd";
  readonly advice: Advice;
  readonly frame: Frame;
  /** Where the line pastes, under the stub root. */
  readonly paste: string;
  /** The argv the program must receive, stated independently of the model's tokenization. */
  readonly intendedArgv?: readonly string[];
}

const shim = (root: string): Launch => ({ kind: "checkout-shim", root });
const deploy = (root: string): Launch => ({ kind: "deployment-shim", root });
const npmBin = (root: string): Launch => ({ kind: "npm-bin", root });
const atRoot: Places = { checkoutRoot: ROOT };
const bashVerbatim = (): Launch => ({ kind: "verbatim", program: fwd(join(ROOT, "clawforge")), mode: "checkout" });
const spacedVerbatim = (): Launch => ({ kind: "verbatim", program: join(ROOT, "clawforge"), mode: "checkout" });
const case4 = (msys: boolean): RealCase["frame"] => ({
  ...frameOf({ kind: "system" }, msys, DEMO, atRoot),
  app: { state: "selected", name: "demo", by: "cwd" },
});
const CASES: readonly RealCase[] = [
  { name: "system: bare command, bash, at the root", shell: "bash", advice: command(["status"]), frame: frameOf({ kind: "system" }, true, ROOT), paste: ROOT },
  { name: "system: bare command, bash, from docs", shell: "bash", advice: command(["status"]), frame: frameOf({ kind: "system" }, true, DOCS), paste: DOCS },
  { name: "system: bare command, cmd", shell: "cmd", advice: command(["status"]), frame: frameOf({ kind: "system" }, false, ROOT), paste: ROOT },
  { name: "system: bare command, pwsh", shell: "pwsh", advice: command(["status"]), frame: frameOf({ kind: "system" }, false, ROOT), paste: ROOT },
  { name: "system: explicit --app, cmd", shell: "cmd", advice: command(["status"], { app: "demo" }), frame: frameOf({ kind: "system" }, false, ROOT), paste: ROOT },
  { name: "system: two-words argument quoting, bash", shell: "bash", advice: command(["status", "--reason", "two words"]), frame: frameOf({ kind: "system" }, true, ROOT), paste: ROOT },
  { name: "system: two-words argument quoting, cmd", shell: "cmd", advice: command(["status", "--reason", "two words"]), frame: frameOf({ kind: "system" }, false, ROOT), paste: ROOT },
  { name: "system: two-words argument quoting, pwsh", shell: "pwsh", advice: command(["status", "--reason", "two words"]), frame: frameOf({ kind: "system" }, false, ROOT), paste: ROOT },
  { name: "checkout shim: at the root, bash", shell: "bash", advice: command(["status"]), frame: frameOf(shim(ROOT), true, ROOT, atRoot), paste: ROOT },
  { name: "checkout shim: from docs, bash", shell: "bash", advice: command(["status"]), frame: frameOf(shim(ROOT), true, DOCS, atRoot), paste: DOCS },
  { name: "checkout shim: from apps/demo, bash", shell: "bash", advice: command(["status"]), frame: frameOf(shim(ROOT), true, DEMO, atRoot), paste: DEMO },
  { name: "checkout shim: from apps/demo, bash, --app", shell: "bash", advice: command(["status"], { app: "demo" }), frame: frameOf(shim(ROOT), true, DEMO, atRoot), paste: DEMO },
  { name: "deployment shim: at its root, bash", shell: "bash", advice: command(["status"]), frame: frameOf(deploy(DEMO), true, DEMO), paste: DEMO },
  { name: "deployment shim: from config, bash", shell: "bash", advice: command(["status"]), frame: frameOf(deploy(DEMO), true, CONFIG), paste: CONFIG },
  { name: "npm bin: POSIX spelling (Git Bash), at the root", shell: "bash", advice: command(["status"]), frame: frameOf(npmBin(ROOT), true, ROOT), paste: ROOT },
  { name: "npm bin: POSIX spelling from docs", shell: "bash", advice: command(["status"]), frame: frameOf(npmBin(ROOT), true, DOCS), paste: DOCS },
  { name: "npm bin: Windows spelling, cmd", shell: "cmd", advice: command(["status"]), frame: frameOf(npmBin(ROOT), false, ROOT), paste: ROOT },
  { name: "npm bin: Windows spelling, pwsh", shell: "pwsh", advice: command(["status"]), frame: frameOf(npmBin(ROOT), false, ROOT), paste: ROOT },
  { name: "npm bin: Windows spelling from config, cmd", shell: "cmd", advice: command(["status"]), frame: frameOf(npmBin(ROOT), false, CONFIG), paste: CONFIG },
  { name: "verbatim: spaced program, bash", shell: "bash", advice: command(["status"]), frame: frameOf(bashVerbatim(), true, ROOT), paste: ROOT },
  { name: "verbatim: spaced program, pwsh", shell: "pwsh", advice: command(["status"]), frame: frameOf(spacedVerbatim(), false, ROOT), paste: ROOT },
  { name: "verbatim: spaced program, cmd", shell: "cmd", advice: command(["status"]), frame: frameOf(spacedVerbatim(), false, ROOT), paste: ROOT },
  { name: "O1: the (in bash) fallback pasted in bash", shell: "bash", advice: command(["completion", "pwsh"], { at: "checkout-root" }), frame: frameOf(npmBin(ROOT), false, ROOT, atRoot), paste: ROOT },
  { name: "O2: case-4 --project-root over the spaced root, bash", shell: "bash", advice: command(["bootstrap"], { app: "x" }), frame: case4(true), paste: DEMO },
  { name: "O2: case-4 --project-root over the spaced root, cmd", shell: "cmd", advice: command(["bootstrap"], { app: "x" }), frame: case4(false), paste: DEMO },
  { name: "cd-prefixed target line, bash", shell: "bash",
    advice: shellLine("posix", `cd ../.. && ${SHIM_PROGRAM} backup`),
    frame: frameOf(shim(ROOT), true, DEMO, atRoot), paste: DEMO },
  { name: "npm bin: shell-named POSIX advice pasted in bash", shell: "bash",
    // from a subdirectory: the POSIX-named line must spell the sh wrapper, not cmd's
    // backslash spelling (the two only differ away from the launch root)
    advice: command(["completion", "bash"], { shell: "posix" }),
    frame: frameOf(npmBin(ROOT), false, DOCS), paste: DOCS },
  { name: "shell-named advice spells for pwsh alone", shell: "pwsh",
    advice: command(["completion", "pwsh"], { shell: "pwsh" }),
    frame: frameOf({ kind: "system" }, false, ROOT), paste: ROOT },
];

// --- the drive: render -> model words -> real shell -> the stub's answer -----------------------

const pathFor = (shell: "bash" | "pwsh" | "cmd"): NodeJS.ProcessEnv => {
  const list = [ROOT, process.env.PATH ?? ""].join(shell === "bash" ? ":" : ";");
  return { ...process.env, PATH: list };
};

/** The line goes to cmd verbatim: node's shell mode runs cmd /d /s /c with the text unquoted
 *  and unmangled, so cmd's own tokenizer — and a second command after an unquoted
 *  metacharacter, which a batch file would swallow — is exactly what the paste meets. */
async function runCmd(line: string, paste: string): Promise<ProcessResult> {
  return runProcess(line, [], { cwd: paste, env: pathFor("cmd"), timeoutMs: TIMEOUT_MS, shell: true });
}

async function drive(name: string, shell: "bash" | "pwsh" | "cmd", advice: Advice, frame: Frame, paste: string, intendedArgv?: readonly string[]): Promise<void> {
  const model: Shell = shell === "bash" ? "posix" : shell;
  // A shell-named advice re-transitions to its own shell before spelling (S1.4); the
  // note ("(in bash)") is the product's annotation, never paste text.
  // Production hands a shell-named advice to the renderer with the target frame it builds
  // (installLineParts builds targetFrame(currentFrame(), shell)) — never a caller-side
  // re-transition of the frame itself.
  // Only a clawforge-kind line takes the production target-frame transition, and it does
  // so through the production WRITER (installLineParts builds targetFrame(currentFrame(),
  // shell) itself): the operator frame is installed and the advice handed over, never a
  // caller-side transition. A shell row is pasted as spelled, wherever the run stands.
  const isCommand = advice.kind === "clawforge";
  const isShellNamed = isCommand && "shell" in advice && advice.shell !== undefined;
  let pasteBase = paste;
  let spelled = "";
  if (isShellNamed) {
    installFrame(frame);
    setInvocation(handoverOf(frame));
    spelled = installLineParts(advice.argv, advice.shell).line;
    // A stored line pastes at the target's own root — the writer's target-frame rule.
    pasteBase = frame.launch.kind !== "system" && frame.launch.kind !== "verbatim" && frame.launch.root !== "" ? frame.launch.root : (frame.cwd.kind === "dir" ? frame.cwd.path : paste);
  } else {
    // A quoting split names the shell each variant is spelled for (AdviceRowPart.shell).
    spelled = renderAdviceParts(advice, frame).find((part) => part.shell === undefined || part.shell === model)?.line ?? "";
  }
  const pasted = parsePaste(spelled, model);
  // What the PROGRAM receives: under cmd, the raw words through the program-side parser.
  const words = programArgv(spelled, model);
  checkTrue(`${name}: the model parses the rendered line`, words.length > 0);
  if (words.length === 0) return;
  // A `cd <path> &&` prefix moves the paste directory before the command runs.
  const pasteDir = pasted.cd === undefined ? pasteBase : resolve(pasteBase, pasted.cd);
  // The shell starts where the operator pastes; a cd inside the line does the moving.
  const spawnCwd = pasted.cd === undefined ? pasteBase : paste;
  if (shell === "pwsh" && intendedArgv !== undefined) {
    spelled = `function clawforge { ConvertTo-Json -Compress -InputObject @{ stub = '${join(ROOT, "clawforge.ps1").replaceAll("'", "''")}'; cwd = (Get-Location).Path; argv = @($args) } }; ${spelled}`;
  }
  rmSync(MARKER, { force: true });
  const run = shell === "bash"
    ? await runProcess("bash", ["-c", spelled], { cwd: spawnCwd, env: pathFor(shell), timeoutMs: TIMEOUT_MS })
    : shell === "pwsh"
      ? await runProcess(await pwshCommand() ?? "pwsh",
          // -EncodedCommand: the line reaches PowerShell's own tokenizer byte for byte —
          // node's argument quoting would mangle the line's inner quotes.
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(spelled, "utf16le").toString("base64")],
          { cwd: spawnCwd, env: pathFor(shell), timeoutMs: TIMEOUT_MS })
      : await runCmd(spelled, spawnCwd);
  checkTrue(`${name}: no second command ran`, !existsSync(MARKER));
  if (run.code !== 0) {
    // A real-shell failure is a product bug, a model bug, or an owner decision. An owner
    // decision is RECORDED, never silent: the case name must sit in
    // baseline.realShellKnownGaps with this exact mechanism, or the assertion fails.
    const gapReason = spelled.includes(String.fromCharCode(39)) ? (shell === "pwsh" ? GAP_PWSH : GAP_CMD) : undefined;
    const recorded = gapReason === undefined ? undefined : knownGaps.gaps[name];
    if (gapReason !== undefined && recorded === gapReason) {
      seenGaps.add(name);
      process.stderr.write(`  ok   KNOWN GAP ${name} — ${gapReason}
`);
      return;
    }
    checkTrue(`${name}: the real shell ran the line (${shell}) — ${(run.stderr.trim().split(NL)[0] ?? "").slice(0, 120)}`, false);
    return;
  }
  let answer: { stub?: string; cwd?: string; argv?: string[] };
  try {
    answer = JSON.parse(run.stdout.trim().split(NL).pop() ?? "");
  } catch {
    checkTrue(`${name}: the stub answered JSON (got ${JSON.stringify(run.stdout.slice(0, 80))})`, false);
    return;
  }
  const [program, ...modelArgv] = words;
  checkTrue(`${name}: the model spelled a stub program`, program !== undefined);
  if (program === undefined) return;
  // The stub the model chose is the one that ran: a bare PATH word runs one of the root's
  // stubs; a path spelling resolves, from the paste directory, to the exact stub file.
  const ran = answer.stub !== undefined ? printerId(answer.stub) : "";
  // The EXACT stub the model chose: a path spelling names one file (resolved from the
  // paste directory); a bare word is a PATH lookup, so the expected file sits at the stub
  // root — with the extension this shell resolves (bash: none; cmd and pwsh: .cmd, the
  // first PATHEXT match for cmd; pwsh resolves bare .ps1 scripts itself). The message
  // carries the stub that ran, so a resolution surprise is readable from the failure.
  const ext = shell === "bash" ? "" : shell === "pwsh" ? ".ps1" : ".cmd";
  const pathProgram = program !== undefined ? fwd(resolve(pasteDir, program.split(BS).join("/"))) : "";
  const bareWord = program !== undefined && !program.includes("/") && !program.includes(BS);
  const want = program === undefined ? "" : printerId(bareWord ? join(ROOT, program) + ext : pathProgram + ext);
  checkTrue(`${name}: the stub that ran is the one the model chose (${program ?? "none"}; ran ${ran || "nothing"})`, ran !== "" && ran === want);
  const sameDir = (a: string, b: string): boolean => {
    try { return realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase(); } catch { return false; }
  };
  checkTrue(`${name}: the stub ran in the paste directory`, answer.cwd !== undefined && sameDir(answer.cwd, pasteDir));
  if (intendedArgv !== undefined) check(`${name}: intended-argv`, answer.argv ?? [], intendedArgv);
  else check(`${name}: the shell saw the model's argv`, answer.argv ?? [], modelArgv);
}

const QUOTING_CASES: readonly RealCase[] = [
  { name: "R1-A-1: pwsh-named fallback exact argv in bash", shell: "bash",
    advice: command(["completion", "pwsh", "a$b'c", 'double"quote'], { shell: "pwsh" }),
    frame: frameOf(shim(ROOT), false, DOCS, atRoot), paste: ROOT,
    intendedArgv: ["completion", "pwsh", "a$b'c", 'double"quote'] },
  { name: "R1-A-1: dollar + apostrophe root", shell: "pwsh", advice: command(["status"], { app: "aux" }),
    frame: { ...case4(false), places: { checkoutRoot: join(ROOT, "literal $ quote'") } }, paste: ROOT,
    intendedArgv: ["--project-root", `${join(ROOT, "literal $ quote'")}/apps/aux`, "status"] },
  ...(["bash", "cmd"] as const).map((shell) => ({
    name: `R1-A-1: dollar + apostrophe root, ${shell}`, shell, advice: command(["status"], { app: "aux" }),
    frame: { ...case4(shell === "bash"), places: { checkoutRoot: join(ROOT, "literal $ quote'") } }, paste: ROOT,
    intendedArgv: ["--project-root", `${join(ROOT, "literal $ quote'")}/apps/aux`, "status"],
  })),
  ...(["bash", "cmd", "pwsh"] as const).flatMap((shell) => {
    const frame = frameOf({ kind: "system" }, shell === "bash", ROOT);
    // One row per word: the argv the program must receive is the word itself.
    const word = (name: string, value: string): RealCase => ({
      name: `R1-A-1: ${name}, ${shell}`, shell, frame, paste: ROOT,
      advice: command(["logs", "--grep", value]), intendedArgv: ["logs", "--grep", value],
    });
    return [
      word("embedded doublequote", 'double"quote'),
      word("apostrophe-only", "'"),
      word("spaces + apostrophe path", `${fwd(ROOT)}/space quote'/file`),
      // cmd toggles on every quote: the metacharacter after the embedded quote must stay quoted.
      word("quote then ampersand", 'a"&calc'),
      word("trailing backslash path", "C:\\dir\\"),
      word("spaced trailing backslash path", `${ROOT}${BS}`),
      word("backslash before quote", 'a\\"b'),
    ];
  }),
];

for (const realCase of [...CASES, ...QUOTING_CASES]) {
  await requires(realCase.shell, `real shell: ${realCase.name}`, async () => {
    await drive(realCase.name, realCase.shell, realCase.advice, realCase.frame, realCase.paste, realCase.intendedArgv);
  });
}

for (const [gapName] of Object.entries(knownGaps.gaps)) {
  if (!seenGaps.has(gapName)) checkTrue(`known gap ${gapName} no longer occurs — remove it from baseline.realShellKnownGaps`, false);
}
checkTrue(`realShellKnownGaps holds ${knownGaps.total} recorded gaps (${knownGaps.gaps ? Object.keys(knownGaps.gaps).length : 0} listed)`, knownGaps.total === Object.keys(knownGaps.gaps).length);
checkTrue("the stub root stayed outside the checkout", !ROOT.startsWith(process.cwd()));
checkTrue("the stub root path carries the O2 space", basename(ROOT).includes(String.fromCharCode(32)));
await rm(ROOT, { recursive: true, force: true }).catch(() => { /* best effort; temp root */ });
finish("real shells");
