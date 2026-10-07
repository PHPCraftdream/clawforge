// The frame law's measurement core (stage 7 S1.2a, invariant I12, design §7.1 items 3-4,
// decision O6; the case loop moved here so the architecture check can re-measure it):
// render through the producer's FRAME → the kit's shell-model tokenization → the REAL
// resolver on a fake file system must return the same command and the same deployment the
// advice declares. The expectation never reads the render path back (I11): argv and
// deployment come from the (placeholder-filled) advice row and the producer's own
// hand-over facts.
//
// Pure: no check()/finish() calls, no baseline read. The law check
// (surfaces/frame-law.check.ts) prints the violations and compares them to the
// DECREASING-ONLY baseline in tools/checks/architecture/baseline.json
// ("frameLawViolations"); the architecture check re-measures the same loop.

import { dirname, resolve as pathResolve } from "node:path";
import { renderFrameAdvice } from "#framework/core/io/invocation/render.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { forShell, frameFromInvocation, handoverOf, IN_BASH_NOTE, resolvesByCwd, SHIM_PROGRAM } from "#framework/core/io/invocation/frame.ts";
import {
  findCheckoutRootIn,
  frameworkOwner,
  resolveCheckoutEntry,
  resolveInstalledEntry,
  type FsProbe,
} from "#framework/entry/resolve.ts";
import { FRAME_PRODUCERS, SELECTION_CASES } from "#checks/golden/frames.ts";
import { ADVICE_ROWS, GATE_COMMAND_NAMES } from "#checks/golden/advice.ts";
import { parsePaste, type Shell } from "#checks/kit/shells.ts";
import { basename } from "node:path";
import { stageTally } from "#checks/kit/deployment-fixture.ts";

// --- the fake layout (the law's own tree; paths spelled like golden/matrix.ts's) ------------

const ROOT = "/clawforge-checkout";
const APP_LOCAL = "/home/u/app-local";
const LOCAL_ENTRY = `${APP_LOCAL}/node_modules/@clawforge/framework/entry/bin.js`;
const SELF = "/usr/local/lib/node_modules/@clawforge/framework/dist/entry/bin.js";
const BIN_SUFFIX = "/node_modules/.bin/clawforge";
const DEPLOYMENT_COMMANDS: readonly string[] = ["status", "bootstrap"];
const EXPANDING_SHELLS: readonly Shell[] = ["posix", "cmd", "pwsh"];

/** Minimal in-memory file system, the same probe shape the resolver takes (matrix.ts's rule:
 *  normalise drive/separator spelling, because node's resolve spells fake paths with this
 *  host's drive). */
const FILES: Record<string, string> = {
  [`${ROOT}/clawforge`]: "#!/bin/sh\n",
  [`${ROOT}/tools/clawforge.ts`]: "// gate\n",
  [`${ROOT}/tools/framework/package.json`]: JSON.stringify({ name: "@clawforge/framework" }),
  [`${ROOT}/apps/openclaw/app.ts`]: "export default {};\n",
  [`${ROOT}/apps/demo/app.ts`]: "export default {};\n",
  // The case-4 target deployment exists on the law's layout, like demo and openclaw: rows
  // filled to app "x" name ROOT/apps/x, and the real resolver must accept it.
  [`${ROOT}/apps/x/app.ts`]: "export default {};\n",
  [`${APP_LOCAL}/app.ts`]: "export default {};\n",
  [`${APP_LOCAL}/config/desired-state.json`]: "{}\n",
  [LOCAL_ENTRY]: "// local package entry\n",
};
const DIRS: readonly string[] = [
  `${ROOT}/apps`, `${ROOT}/apps/openclaw`, `${ROOT}/apps/demo`, `${ROOT}/apps/x`, `${ROOT}/docs`,
  `${ROOT}/tools`, `${ROOT}/tools/framework`, `${APP_LOCAL}/config`,
  `${APP_LOCAL}/node_modules`, `${APP_LOCAL}/node_modules/.bin`,
  `${APP_LOCAL}/node_modules/@clawforge`, `${APP_LOCAL}/node_modules/@clawforge/framework`,
  `${APP_LOCAL}/node_modules/@clawforge/framework/entry`,
];
/** Host-independent refusal TEXT: paths inside a recorded reason normalize exactly like
 *  the layout's paths (drive letter and separators stripped), so a baseline reason written
 *  on one host compares equal on every host. */
const normalizeMessage = (text: string): string => text.replaceAll("\\", "/").replace(/([A-Za-z]):\//g, "/");
const fakePath = (path: string): string => {
  const slashed = path.replaceAll("\\", "/");
  const stripped = slashed.replace(/^[A-Za-z]:\//, "");
  return stripped.startsWith("/") ? stripped : ["", stripped].join("/");
};
const fs: FsProbe = {
  exists: (path) => FILES[fakePath(path)] !== undefined || DIRS.includes(fakePath(path)),
  isDirectory: (path) => DIRS.includes(fakePath(path)),
  readdir: (path) => {
    const dir = fakePath(path);
    const names = new Set<string>();
    for (const file of Object.keys(FILES)) if (dirname(file) === dir) names.add(basename(file));
    for (const entry of DIRS) if (dirname(entry) === dir) names.add(basename(entry));
    return [...names];
  },
  readFile: (path) => FILES[fakePath(path)],
  realpath: (path) => path,
};

// --- the rows under law -----------------------------------------------------------------------

/** A word the two quoting rules spell differently, so the tokenization round-trip (the law's
 *  own form: the pasted words must reassemble the advice argv) pins the shells branch. */
const QUOTE_ROW = {
  label: "law: quoting round-trip",
  advice: command(["status", "--reason", ["two", "words"].join(" ")]),
};

/** Placeholder fill (P4, rule P): a `<…>` word is an example the reader substitutes — the
 *  law fills it with a plain word BEFORE rendering, tokenizing and resolving, so the
 *  expected argv is the FILLED argv and the shell model never has to model a bare `<`. */
const fillWord = (word: string): string => (/^<.*>$/.test(word) ? "x" : word);

interface Entry {
  readonly kind: "system" | "gate" | "installed";
}
type ProgramResolution = Entry | { readonly problem: string };

/** The pasted program resolves to an entry point on the fake layout: the checkout shim →
 *  the checkout gate; a clawforge bin wrapper → the installed entry; the bare system-wide
 *  command → the installed entry. Anything else is spelling drift. */
function resolveProgram(program: string, pasteDir: string, launch: string, shell: Shell): ProgramResolution {
  if (program === "clawforge") return { kind: "installed" };
  if (launch === "verbatim") {
    return { problem: "the hand-set verbatim program names no clawforge entry the model can resolve (the launchOf adapter, S1.3)" };
  }
  const at = fakePath(pathResolve(pasteDir, program.replaceAll("\\", "/")));
  if (at === `${ROOT}/clawforge`) return { kind: "gate" };
  if (program === SHIM_PROGRAM && pasteDir !== ROOT) {
    return { problem: `the shim hint spells ${SHIM_PROGRAM} from the checkout root, not from the paste directory ${pasteDir} — relative spellings land in S1.2b (O4/D10)` };
  }
  // The tokenizer folds backslash escapes, so a pasted npm bin spelling arrives as one
  // unbroken word: recognize the folded shape to keep naming its mechanism (D1/O1).
  if (shell === "posix" && /^node_modules\.*(bin|\\bin)?clawforge$/.test(program)) {
    return { problem: "npm's Windows bin spelling pasted in a POSIX shell — the backslashes are escapes there (D1/O1)" };
  }
  if (program.includes("\\") && shell === "posix") {
    return { problem: "npm's Windows bin spelling pasted in a POSIX shell — the backslashes are escapes there (D1/O1)" };
  }
  if (at.endsWith(BIN_SUFFIX)) {
    const appRoot = at.slice(0, at.length - BIN_SUFFIX.length);
    return fs.exists(`${appRoot}/node_modules/@clawforge/framework/entry/bin.js`)
      ? { kind: "installed" }
      : { problem: `${at} has no clawforge package entry on the layout` };
  }
  return { problem: `${at} is not a clawforge entry point on the layout` };
}

const sameWords = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const NOTE_OPEN = [" ", " ", "("].join("");

/** The renderer appends paste notes as trailing "  (…)" groups; the law reads the command
 *  words only, and reports the note text (the "in bash" fallback names its shell). */
function stripNote(line: string): { readonly command: string; readonly note?: string } {
  let text = line;
  const notes: string[] = [];
  for (;;) {
    if (!text.endsWith(")")) break;
    const open = text.lastIndexOf(NOTE_OPEN);
    if (open < 0) break;
    notes.unshift(text.slice(open + NOTE_OPEN.length, -1));
    text = text.slice(0, open);
  }
  return { command: text, note: notes.length === 0 ? undefined : notes.join(", ") };
}

export interface FrameLawMeasurement {
  /** Violation key → reason. Keys are `<producer> | <row> | <shell>` and
   *  `selection <label> | <producer>`. */
  readonly violations: Map<string, string>;
  /** (producer, row, shell) cases that reached a resolver decision. */
  readonly reached: number;
  /** (producer, row, shell) cases attempted. */
  readonly attempted: number;
  /** Cases that stopped BEFORE a decision for a SETUP reason (unknown producer/row,
   *  unresolvable paste directory, model crash): the law check fails on these —
   *  violations recorded in the baseline are fine, silent setup stops are not. */
  readonly setupFailures: readonly string[];
  /** Pipeline-stage case accounting: before final run versus resolved final run. */
  readonly stageCounts: ReadonlyArray<{ readonly stage: string; readonly count: number }>;
  readonly finalRuns: number;
}

/** The full law measurement: every clawforge-kind row of ADVICE_ROWS (plus the synthetic
 *  quoting round-trip row) × every producer × the producer's shells (install/prose/quoting
 *  rows paste in all three shells), then the SELECTION_CASES drive through the gate
 *  resolver (design §5, decision O3). */
export function runFrameLaw(tally = stageTally()): FrameLawMeasurement {
  const violations = new Map<string, string>();
  const setupFailures: string[] = [];
  let reached = 0;
  let attempted = 0;
  let finalRuns = 0;
  const record = (key: string, reason: string): void => {
    if (!violations.has(key)) violations.set(key, reason);
  };

  const rows: { readonly label: string; readonly advice: (typeof ADVICE_ROWS)[number]["advice"] }[] = [
    ...ADVICE_ROWS,
    QUOTE_ROW,
  ].filter((rowEntry) => rowEntry.advice.kind === "clawforge");
  /** Help-prose token rows without a shell of their own and the synthetic quoting row paste
   *  in every shell, not only the producer's own set (the renderer spells them shell-free).
   *  A row WITH a shell (S1.4's CommandAdvice.shell — the install lines) spells for that
   *  shell alone: the renderer re-transitions to advice.shell whatever frame pastes it, so
   *  pasting it elsewhere would re-measure the same line against a shell it does not name. */
  const PROSE_PREFIX = ["help", "prose:"].join(" ");
  const expandsShells = (label: string, advice: { readonly shell?: string }): boolean =>
    advice.shell === undefined && (label.startsWith(PROSE_PREFIX) || label === QUOTE_ROW.label);

  for (const producer of FRAME_PRODUCERS) {
    const frameCwd = producer.frame.cwd.kind === "dir" ? producer.frame.cwd.path : ROOT;
    const hostPlatform = producer.frame.host.kind === "operator" ? producer.frame.host.platform : "posix";
    const platform = hostPlatform === "win32" ? "win32" : "linux";
    const handed = producer.invocation.app;
    const handedApp = handed !== undefined && handed.selectedBy !== "default" && handed.selectedBy !== "cwd" ? handed.name : undefined;
    for (const rowEntry of rows) {
      const advice = rowEntry.advice;
      if (advice.kind !== "clawforge") continue;
      // The FILLED advice is the law's expectation: placeholders become "x" before the
      // render, before the tokenization and before the resolver call (rule P4).
      const filled = {
        ...advice,
        argv: advice.argv.map(fillWord),
        app: advice.app === undefined ? undefined : fillWord(advice.app),
      };
      const pasteDir = frameCwd;
      // The paste directory mirrors the renderer's rooted branch (design §2.3 rule 1, §3):
      // a row that spells from the checkout root — `at: "checkout-root"` — is rendered
      // against the RE-ROOTED frame, so the line pastes where the sentence names: the
      // re-rooted frame's cwd, i.e. the frame's checkout root. A frame without a known
      // checkout root is a genuine setup stop. A cwd-conflict row (decision O2, case 4) is
      // NOT re-rooted: its line runs where the reader stands (O2), the producer's own cwd
      // (apps/demo), and points at the other deployment with --project-root. Every other
      // row pastes where the frame stands.
      const on = handoverOf(producer.frame);
      const cwdConflict = filled.app !== undefined
        && producer.frame.app.state === "selected" && producer.frame.app.by === "cwd" && producer.frame.app.name !== filled.app
        && resolvesByCwd(producer.frame.launch, on.program);
      const atRooted = filled.at === "checkout-root";
      const rootedPasteDir = atRooted ? producer.frame.places.checkoutRoot : undefined;
      // O2: the case-4 line runs where the reader stands — the paste directory is the
      // producer's cwd; only an `at` row re-roots.
      const pasteBase = rootedPasteDir ?? pasteDir;
      if (atRooted && rootedPasteDir === undefined) {
        setupFailures.push(`${producer.label} | ${rowEntry.label}: the checkout-root row renders against a re-rooted frame, but the producer frame has no checkout root place`);
        continue;
      }
      const shells = new Set<Shell>(filled.shell !== undefined ? [filled.shell] : producer.frame.shells);
      if (expandsShells(rowEntry.label, filled)) for (const shell of EXPANDING_SHELLS) shells.add(shell);
      for (const shell of shells) {
        const key = `${producer.label} | ${rowEntry.label} | ${shell}`;
        attempted += 1;
        let stage: import("#framework/core/command/execute.ts").Stage = "parse";
        try {
          // The law tests the line PRODUCTION emits from the original multi-shell frame;
          // only a row that names its own shell (advice.shell) re-renders for that shell.
          const line = renderFrameAdvice(filled, filled.shell !== undefined ? forShell(producer.frame, shell) : producer.frame);
          const { command: clean, note } = stripNote(line);
          // The bash-shim fallback (O1): the line itself names the shell it pastes in — a
          // non-posix paste of it is the known npm-bin re-root violation (D1).
          const noteWords = note === undefined ? [] : note.split(",").map((part) => part.trim());
          if (shell !== "posix" && noteWords.includes(IN_BASH_NOTE)) {
            record(key, "npm-bin re-root spelled the bash-only shim for a non-posix paste — the fallback note names Git Bash (D1/O1)");
            continue;
          }
          const pasted = parsePaste(clean, shell);
          // The paste directory: the rendered `cd <path> &&` prefix, resolved against the
          // producer's frame cwd (the prefix is spelled relative to where the frame stands);
          // otherwise the frame's own directory — the spelling the renderer produced is
          // relative to exactly that directory (the S1.2b relative-spelling rule), so the
          // program resolves against it, whatever place mark the row carries.
          let resolvedPasteDir = pasteBase;
          if (pasted.cd !== undefined) {
            const resolved = fakePath(pathResolve(pasteBase, pasted.cd));
            if (resolved === "" || resolved === "/") {
              setupFailures.push(`${key}: the pasted cd does not resolve on the fake layout (${pasted.cd})`);
              continue;
            }
            resolvedPasteDir = resolved;
          }
          const words = pasted.words;
          const program = words[0] ?? "";
          const tokenArgv = words.slice(1);
          // The pasted words must reassemble the FILLED advice argv (a leading --app pair is
          // the selector the renderer and the resolver share; the command follows it). The
          // S1.4 case-4 selector (--project-root, decision O2) implies the deployment the
          // same way, so its pair is stripped too — and the path it names is verified
          // against the fake layout: <ROOT>/apps/<filled.app>, or the row names the wrong
          // deployment directory.
          const selector = tokenArgv[0] === "--app" || tokenArgv[0] === "--project-root" ? tokenArgv[0] : undefined;
          const withoutSelector = selector !== undefined ? tokenArgv.slice(2) : tokenArgv;
          if (selector === "--project-root") {
            const wantRoot = `${ROOT}/apps/${filled.app}`;
            if (tokenArgv[1] !== wantRoot) {
              record(key, `--project-root drift: the row names ${tokenArgv[1] ?? "no path"} where the law expects ${wantRoot}`);
              continue;
            }
          }
          if (!sameWords(withoutSelector, filled.argv)) {
            record(key, `quoting/spelling drift: the shell model tokenized ${JSON.stringify(tokenArgv)} where the advice declares ${JSON.stringify(filled.argv)}`);
            continue;
          }
          const where = resolveProgram(program, resolvedPasteDir, producer.frame.launch.kind, shell);
          stage = "environment";
          if ("problem" in where) {
            record(key, `the pasted program does not resolve — ${where.problem}`);
            continue;
          }
          const expected = filled.app ?? handedApp;
          if (where.kind === "gate") {
            const decision = resolveCheckoutEntry({
              root: ROOT, cwd: resolvedPasteDir, argv: tokenArgv,
              ocApp: producer.env?.OC_APP,
              handedOver: producer.env !== undefined, launch: producer.frame.launch, handedProgram: producer.invocation.program,
              fs, gateCommands: GATE_COMMAND_NAMES, deploymentCommands: DEPLOYMENT_COMMANDS, variadicCommands: [],
            });
            reached += 1;
            stage = decision.kind === "run" || decision.kind === "gate-command" ? "run" : "context";
            if (decision.kind === "run") {
              if (!sameWords(decision.argv, filled.argv)) {
                record(key, `command drift: the gate ran ${JSON.stringify(decision.argv)} where the advice declares ${JSON.stringify(filled.argv)}`);
                continue;
              }
              const want = expected ?? (!atRooted && !cwdConflict && producer.frame.app.state === "selected" && producer.frame.app.by === "cwd" ? producer.frame.app.name : undefined) ?? "openclaw";
              if (decision.appName !== want) {
                record(key, `deployment drift: the gate ran ${decision.appName} where the law expects ${want}`);
              }
            } else if (decision.kind === "gate-command") {
              if (!sameWords([decision.name, ...decision.args], filled.argv)) {
                record(key, `command drift: the gate answered ${decision.kind} ${JSON.stringify([decision.name, ...decision.args])} where the advice declares ${JSON.stringify(filled.argv)}`);
                continue;
              }
              if (expected !== undefined && decision.app?.name !== expected) {
                record(key, `deployment drift: the gate command carries ${decision.app?.name ?? "no deployment"} where the law expects ${expected}`);
              }
            } else {
              record(key, `the resolver did not run the advice: ${decision.kind}`);
            }
          } else {
            const decision = resolveInstalledEntry({ cwd: resolvedPasteDir, rawArgv: tokenArgv, platform, fs, frame: frameFromInvocation(producer.invocation, { host: producer.frame.host.kind === "operator" ? producer.frame.host.platform : "posix", msys: false }) });
            reached += 1;
            stage = "context";
            if (decision.kind !== "run") {
              // A refusal is the law's FINDING, not a setup stop: the pasted line is the
              // renderer's output, so the resolver refusing it names a real drift.
              record(key, `the resolver refused the pasted line: ${decision.kind}${decision.kind === "refuse" ? ` — ${normalizeMessage((decision.refusals[0] as Error | undefined)?.message ?? "no message")}` : ""}`);
              continue;
            }
            if (!sameWords(decision.argv[0] === "--app" ? decision.argv.slice(2) : decision.argv, filled.argv)) {
              record(key, `command drift: the entry ran ${JSON.stringify(decision.argv)} where the advice declares ${JSON.stringify(filled.argv)}`);
              continue;
            }
            stage = "prepare";
            const owner = frameworkOwner({
              self: SELF, appRoot: decision.appRoot, launchArgv: decision.launchArgv, argv: decision.argv,
              handedOver: producer.env !== undefined, platform, fs,
              localEntry: decision.appRoot === APP_LOCAL ? LOCAL_ENTRY : undefined,
            });
            if (owner.kind === "refuse-app-value") {
              record(key, `the hand-over refused the advice: ${owner.reason}`);
              continue;
            }
            if (owner.kind === "spawn" && owner.delegated === false) {
              // Spawn inherits the original cwd; resolve against it, with handed-over facts.
              const checkout = findCheckoutRootIn(dirname(owner.entry), fs) ?? dirname(dirname(decision.appRoot));
              const final = resolveCheckoutEntry({
                root: checkout, cwd: resolvedPasteDir, argv: owner.args,
                ocApp: producer.env?.OC_APP,
                handedOver: true, launch: producer.frame.launch, handedProgram: owner.entry,
                fs, gateCommands: GATE_COMMAND_NAMES, deploymentCommands: DEPLOYMENT_COMMANDS, variadicCommands: [],
              });
              if (final.kind === "run") {
                stage = "run";
              finalRuns++;
              if (!sameWords(final.argv[0] === "--app" ? final.argv.slice(2) : final.argv, filled.argv)) {
                  record(key, `command drift: the spawned gate ran ${JSON.stringify(final.argv)} where the advice declares ${JSON.stringify(filled.argv)}`);
                  continue;
                }
                const want = expected ?? (!atRooted && !cwdConflict && producer.frame.app.state === "selected" && producer.frame.app.by === "cwd" ? producer.frame.app.name : undefined) ?? "openclaw";
                if (final.appName !== want) {
                  record(key, `deployment drift: the spawned gate ran ${final.appName} where the law expects ${want}`);
                }
              } else if (final.kind === "gate-command") {
                if (!sameWords([final.name, ...final.args], filled.argv)) {
                  record(key, `command drift: the spawned gate answered ${final.kind} ${JSON.stringify([final.name, ...final.args])} where the advice declares ${JSON.stringify(filled.argv)}`);
                  continue;
                }
                if (expected !== undefined && final.app?.name !== expected) {
                  record(key, `deployment drift: the spawned gate command carries ${final.app?.name ?? "no deployment"} where the law expects ${expected}`);
                }
              } else {
                record(key, `the hand-over gate did not run the advice: ${final.kind}`);
              }
            }
            if (owner.kind === "spawn" && owner.delegated === true) {
              const finalEntry = resolveInstalledEntry({ cwd: resolvedPasteDir, rawArgv: owner.args, platform, fs, frame: frameFromInvocation(producer.invocation, { host: producer.frame.host.kind === "operator" ? producer.frame.host.platform : "posix", msys: false }) });
              if (finalEntry.kind !== "run") {
              stage = "context";
              record(key, `the delegated final entry did not run the advice: ${finalEntry.kind}`);
                continue;
              }
              // spawnSync inherits cwd; the delegated checkout gate is the final framework
              // owner (its own gate path is not delegated a second time).
              stage = "run";
              finalRuns++;
              if (!sameWords(finalEntry.argv[0] === "--app" ? finalEntry.argv.slice(2) : finalEntry.argv, filled.argv)) {
                record(key, `delegated final entry argv drift: ${JSON.stringify(finalEntry.argv)} does not match advice ${JSON.stringify(filled.argv)}`);
              }
              if (owner.entry === LOCAL_ENTRY && finalEntry.appRoot !== APP_LOCAL) {
                record(key, `delegated final entry app root drift: ${finalEntry.appRoot} does not match local app ${APP_LOCAL}`);
              }
            }
          }
        } catch (error) {
          setupFailures.push(`${key}: model crash — ${(error as Error).message}`);
        } finally {
          tally.case(key, stage);
        }
      }
    }
  }

  // --- the selection sweep (design §5) through the gate resolver ----------------------------
  for (const selection of SELECTION_CASES) {
    const producer = FRAME_PRODUCERS.find((entry) => entry.label === selection.producer);
    const key = `selection ${selection.label} | ${selection.producer}`;
    attempted += 1;
    let stage: import("#framework/core/command/execute.ts").Stage = "parse";
    if (producer === undefined) {
      setupFailures.push(`${key}: unknown producer`);
      tally.case(key, stage);
      continue;
    }
    const cwd = producer.frame.cwd.kind === "dir" ? producer.frame.cwd.path : ROOT;
    try {
      const decision = resolveCheckoutEntry({
        root: ROOT, cwd, argv: selection.argv,
        ocApp: selection.ocApp,
        handedOver: producer.env !== undefined, launch: producer.frame.launch, handedProgram: producer.invocation.program,
        fs, gateCommands: GATE_COMMAND_NAMES, deploymentCommands: DEPLOYMENT_COMMANDS, variadicCommands: [],
      });
      reached += 1;
      if (selection.ocApp !== undefined && selection.ocApp.trim() === "") {
        // O3: an empty OC_APP on a deployment command is a refusal BY NAME; treating it as
        // unset (the current resolver's reading) is the recorded S1.3 behavior gap.
        const refused = decision.kind === "refuse" && decision.refusals.some((error) => error.message.includes("OC_APP"));
        if (!refused) {
          record(key, `empty OC_APP ran as ${decision.kind} where O3 expects a refusal naming OC_APP — the resolver's empty reading is S1.3 behavior`);
        }
        continue;
      }
      const flagApp = selection.argv[0] === "--app" ? selection.argv[1] : undefined;
      const want = flagApp ?? (selection.ocApp !== undefined && selection.ocApp.trim() !== "" ? selection.ocApp : undefined) ?? selection.soleApp ?? selection.cwdApp ?? "openclaw";
      if (decision.kind === "run") {
        if (decision.appName !== want) {
          record(key, `deployment drift: the ${selection.label} selection ran ${decision.appName} where the law expects ${want} (the selection sweep is not yet resolver-visible — S1.3/O3)`);
        }
      } else {
        record(key, `the ${selection.label} selection did not run: ${decision.kind} (S1.3/O3)`);
      }
    } catch (error) {
      setupFailures.push(`${key}: model crash — ${(error as Error).message}`);
    } finally {
      tally.case(key, stage);
    }
  }

  return { violations, reached, attempted, setupFailures, stageCounts: tally.counts(), finalRuns };
}
