// The entry decision matrix (refactor plan stage 2, item 4): every layout × argv × env ×
// platform, resolved by the pure entry resolver (entry/resolve.ts) on a fake file system —
// no processes. Not a table-driven re-assertion of the code's own shape: the prefixes are
// rendered through the real invocationPrefix(), the refusals through the same pure report
// builders the entries render, and the file is a golden diff like the other surfaces.

import { basename, dirname } from "node:path";
import { invocationPrefix, setInvocation, type Invocation } from "#framework/core/io/invocation/index.ts";
import {
  resolveCheckoutEntry,
  frameworkOwner,
  strayCheckoutApp,
  type FsProbe,
} from "#framework/entry/resolve.ts";

/** The fake checkout root. Path-shaped so node's resolve/relative see a normal tree; the
 *  renderer strips whatever drive prefix this host's path module puts in front of it. */
const ROOT = "/clawforge-checkout";
const APP = "/home/u/app";
const APP_LOCAL = "/home/u/app-local";
const EMPTY = "/home/u/empty";
const STRAY = `${ROOT}/stray-sub`;
const SELF = "/usr/local/lib/node_modules/@clawforge/framework/dist/entry/bin.js";
const LOCAL_ENTRY = `${APP_LOCAL}/node_modules/@clawforge/framework/entry/bin.js`;

/** A tiny in-memory file system: exact paths plus a canonical-spelling map (Windows case).
 *  Lookups are normalised, because node's resolve spells fake paths with this host's drive
 *  and separators. */
function fakeFs(files: Record<string, string>, dirs: readonly string[], real: Record<string, string> = {}): FsProbe {
  const norm = (path: string): string => path.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
  const canonical = (path: string): string => real[norm(path)] ?? norm(path);
  return {
    exists: (path) => canonical(path) in files || dirs.includes(canonical(path)),
    isDirectory: (path) => dirs.includes(canonical(path)),
    readdir: (path) => {
      const dir = canonical(path);
      const names = new Set<string>();
      for (const file of Object.keys(files)) if (dirname(file) === dir) names.add(basename(file));
      for (const entry of dirs) if (dirname(entry) === dir) names.add(basename(entry));
      return [...names];
    },
    readFile: (path) => files[canonical(path)],
    realpath: (path) => real[path] ?? path,
  };
}

const manifest = JSON.stringify({ name: "@clawforge/framework" });
const strayAppTs = 'import { defineApp } from "../../tools/framework/core/app.ts";\nexport default defineApp({});\n';

/** Files/dirs shared by every layout, laid out once: the checkout with two deployments, the
 *  stray checkout-style app.ts outside apps/, the installed app, its local-package twin,
 *  and an empty directory. */
const BASE_FILES: Record<string, string> = {
  [`${ROOT}/tools/clawforge.ts`]: "// gate\n",
  [`${ROOT}/tools/framework/package.json`]: manifest,
  [`${ROOT}/apps/openclaw/app.ts`]: "export default {};\n",
  [`${ROOT}/apps/demo/app.ts`]: "export default {};\n",
  [`${STRAY}/app.ts`]: strayAppTs,
  [`${APP}/app.ts`]: "export default {};\n",
  [`${APP}/config/desired-state.json`]: "{}\n",
  [`${APP_LOCAL}/app.ts`]: "export default {};\n",
  [`${APP_LOCAL}/config/desired-state.json`]: "{}\n",
  [LOCAL_ENTRY]: "// local package entry\n",
};
const BASE_DIRS = [`${ROOT}/apps`, `${ROOT}/apps/openclaw`, `${ROOT}/apps/demo`, `${ROOT}/docs`, `${ROOT}/tools`, `${ROOT}/tools/framework`, dirname(STRAY), STRAY, `${APP}/config`, `${APP}/recipes`, `${APP}/recipes/sub`, `${APP_LOCAL}/config`, EMPTY];
/** Windows case: the same deployment typed as APPS/<name>. */
const WIN_REAL: Record<string, string> = {
  [`${ROOT}/APPS/openclaw`]: `${ROOT}/apps/openclaw`,
  [`${ROOT}/APPS/openclaw/app.ts`]: `${ROOT}/apps/openclaw/app.ts`,
};

interface CaseLayout {
  readonly id: string;
  /** cwd for the gate decision; undefined — the gate is not the process for this layout. */
  readonly gate?: { readonly cwd: string; readonly handedOver: boolean };
  readonly handover: { readonly appRoot: string; readonly localEntry?: string };
}

const LAYOUTS: readonly CaseLayout[] = [
  { id: "checkout-root", gate: { cwd: ROOT, handedOver: false }, handover: { appRoot: ROOT } },
  { id: "apps-openclaw", gate: { cwd: `${ROOT}/apps/openclaw`, handedOver: true }, handover: { appRoot: `${ROOT}/apps/openclaw` } },
  // APPS/<name> typed case: the hand-over's canonicalisation is decided here; whether the
  // handed-over gate process then sees its own cwd as inside is the host path module's case
  // rule, not resolver logic — covered end to end by system-install on Windows.
  { id: "apps-upper", handover: { appRoot: `${ROOT}/APPS/openclaw` } },
  { id: "checkout-subfolder", handover: { appRoot: `${ROOT}/docs` } },
  { id: "installed-app", handover: { appRoot: APP } },
  { id: "installed-app-local", handover: { appRoot: APP_LOCAL, localEntry: LOCAL_ENTRY } },
  { id: "stray-checkout-app", handover: { appRoot: STRAY } },
  { id: "empty-directory", handover: { appRoot: EMPTY } },
  { id: "nested-app", handover: { appRoot: `${APP}/recipes/sub` } },
];

const ARGVS: readonly (readonly string[])[] = [
  [],
  ["help"],
  ["status"],
  ["status", "--help"],
  ["--app", "x", "status"],
  ["--app=x", "status"],
  ["--app"],
  ["status", "--app", "x"],
];

const ENVS: readonly (readonly [string, string | undefined])[] = [
  ["none", undefined],
  ["OC_APP=x", "x"],
];

const PLATFORMS: readonly NodeJS.Platform[] = ["linux", "win32", "darwin"];

const GATE_COMMANDS = ["check", "list", "new-app", "remove-app", "version", "completion"];
const DEPLOYMENT_COMMANDS = ["status", "bootstrap"];
const VARIADIC_COMMANDS = ["exec"];

/** Host-independent path text: this machine's path module may prefix a drive and prefer
 *  backslashes; the fake world spells everything with forward slashes from /. */
function fakePath(text: string): string {
  return text.replaceAll("\\", "/").replace(/[A-Za-z]:\//g, "");
}

function gateDecisionLine(input: Parameters<typeof resolveCheckoutEntry>[0]): string {
  const decision = resolveCheckoutEntry(input);
  switch (decision.kind) {
    case "refuse":
      return `refuse: ${decision.lines.map(fakePath).join(" | ")}`;
    case "refuse-misplaced-app-flag":
      return "refuse-misplaced-app-flag";
    case "refuse-unknown-command":
      return `refuse-unknown-command ${decision.name}`;
    case "gate-command":
      return `gate-command ${decision.name} ${JSON.stringify(decision.args)}`;
    case "help-without-deployment":
      return `help-without-deployment: ${decision.description}`;
    case "run": {
      // The prefix through the real renderer, not a restatement of the rule.
      const invocation: Invocation = { program: "./clawforge", mode: "checkout", audience: "terminal", ...(decision.app === undefined ? {} : { app: decision.app }) };
      setInvocation(invocation);
      return `run app=${decision.appName} fact=${decision.app === undefined ? "-" : decision.app.name}/${decision.app?.selectedBy} argv=${JSON.stringify(decision.argv)} prefix=${invocationPrefix()}${decision.soleNote === undefined ? "" : ` sole=${decision.soleNote}`}`;
    }
  }
}

function handoverDecisionLine(input: Parameters<typeof frameworkOwner>[0]): string {
  const decision = frameworkOwner(input);
  switch (decision.kind) {
    case "run-here":
      return "run-here";
    case "spawn":
      return `spawn ${decision.entry === LOCAL_ENTRY ? "local-package" : "checkout-gate"} delegated=${decision.delegated} argv=${JSON.stringify(decision.args).replace(ROOT, "<root>")}`;
    case "refuse-app-value":
      return decision.reason === "missing-app-value" ? "refuse-app-value: missing" : `refuse-app-value: conflict --app ${decision.typed}`;
  }
}

/** The whole matrix as deterministic text; golden.check.ts compares it with expected/entry-matrix.txt. */
export function renderEntryMatrix(): string {
  const lines: string[] = [
    "// Entry decisions (plan stage 2, invariant I3): resolveCheckoutEntry (gate) where the gate",
    "// is the process, frameworkOwner (installed command hand-over) everywhere, plus the stray",
    "// app.ts predicate. Fake fs, no processes. Paths are fake-root relative.",
    "",
  ];
  for (const platform of PLATFORMS) {
    for (const layout of LAYOUTS) {
      const fs = fakeFs(BASE_FILES, BASE_DIRS, platform === "win32" ? WIN_REAL : {});
      for (const [envLabel, ocApp] of ENVS) {
        for (const argv of ARGVS) {
          const label = `platform=${platform} layout=${layout.id} argv=${argv.length === 0 ? "<none>" : JSON.stringify(argv)} env=${envLabel}`;
          lines.push(`== ${label}`);
          if (layout.gate !== undefined) {
            lines.push(`gate: ${gateDecisionLine({
              root: ROOT,
              cwd: layout.gate.cwd,
              argv,
              ocApp,
              handedOver: layout.gate.handedOver,
              fs,
              gateCommands: GATE_COMMANDS,
              deploymentCommands: DEPLOYMENT_COMMANDS,
              variadicCommands: VARIADIC_COMMANDS,
            })}`);
          }
          lines.push(`handover: ${handoverDecisionLine({
            self: SELF,
            appRoot: layout.handover.appRoot,
            launchArgv: argv,
            argv,
            handedOver: false,
            platform,
            fs,
            localEntry: layout.handover.localEntry,
          })}`);
          const stray = strayCheckoutApp({ self: SELF, appRoot: layout.handover.appRoot, fs });
          lines.push(`stray: ${stray === undefined ? "none" : `checkout=${fakePath(stray.checkout)}`}`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
