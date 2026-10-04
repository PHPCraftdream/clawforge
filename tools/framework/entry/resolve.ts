// One decision for "where am I, which deployment, which framework copy runs it, how do I
// name myself" (refactor plan stage 2, invariant I3). Pure: the file system arrives as a
// probe, nothing here spawns, exits or imports app.ts — the entries (tools/clawforge.ts,
// entry/bin.ts via entry/delegate.ts) execute the returned decision. Every refusal's
// wording is pinned by the entry matrix under tools/checks/golden/.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { isWithin } from "../core/paths.ts";
import { safeName } from "../core/values/names.ts";
import type { InvocationApp } from "../core/io/invocation/index.ts";
import { manual } from "../core/io/invocation/advice.ts";
import { command, shellLine, type Advice } from "../core/io/invocation/advice.ts";
import { renderAdvice, shimInvocation } from "../core/io/invocation/render.ts";
import { UserError } from "../core/io/log.ts";
import { normalizeVersionAlias } from "../integration/version.ts";
import {
  checkoutSubfolderReport,
  isDeploymentHelpRequest,
  misplacedAppFlag,
  missingDeploymentReport,
  soleDeploymentFallback,
  splitLeadingAppFlag,
} from "../integration/gate.ts";

/** The file system as the resolver may see it — real at the entries, fake in the matrix check. */
export interface FsProbe {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  /** Entry names of a directory, [] when it cannot be read. */
  readdir(path: string): readonly string[];
  /** A file's text, undefined when absent. */
  readFile(path: string): string | undefined;
  /** The path as the file system spells it, or the input when it cannot be resolved. */
  realpath(path: string): string;
}

/** Fixed parts of the entry refusals, exported so checks assert the same text the product
 *  prints instead of restating it. */
export const ALREADY_HOLDS_APP = "already holds app.ts";
export const NOTHING_TO_INSTALL_NOTE = "nothing to install";
export const IN_BASH_NOTE = "in bash";
export const NOT_INITIALISED_NOTE = "has not been initialised as an OpenClaw deployment yet";
export const FROM_CHECKOUT_ROOT = "run the gate from its root";
export const CANNOT_LOAD = "cannot load";
export function takeoverNote(directory: string): string {
  return `new-app ${directory} takes over this empty directory, or remove it`;
}

export const nodeFs: FsProbe = {
  exists: (path) => existsSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  // .native: on Windows only it returns the case the file system spells (APPS/<name>).
  realpath: (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return path;
    }
  },
};

// --- the monorepo (checkout) gate ---------------------------------------------------------------

export interface CheckoutEntryInput {
  /** The checkout root this gate serves (apps/ sits directly under it). */
  readonly root: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly ocApp: string | undefined;
  /** A hand-over (bin.shim → gate, or the legacy variable) named this process. */
  readonly handedOver: boolean;
  readonly fs: FsProbe;
  readonly gateCommands: readonly string[];
  readonly deploymentCommands: readonly string[];
  /** Deployment commands that read their argv verbatim — their `--app` is their own. */
  readonly variadicCommands: readonly string[];
}

export type CheckoutEntryDecision =
  | { readonly kind: "refuse"; readonly refusals: readonly UserError[] }
  /** Rendered by the gate: "--app must come before the command". */
  | { readonly kind: "refuse-misplaced-app-flag" }
  | { readonly kind: "refuse-unknown-command"; readonly name: string; readonly candidates: readonly string[] }
  | { readonly kind: "gate-command"; readonly name: string; readonly args: readonly string[] }
  | { readonly kind: "help-without-deployment"; readonly description: string; readonly argv: readonly string[] }
  | {
      readonly kind: "run";
      readonly deploymentDir: string;
      readonly appName: string;
      readonly argv: readonly string[];
      /** The deployment fact for hints; undefined only when no app fact applies. */
      readonly app: InvocationApp | undefined;
      /** Set when the lone deployment under apps/ was picked without being named. */
      readonly soleNote?: string;
    };

/** Visible apps/<name> directories holding app.ts, sorted — the same rule scanApps applies. */
function availableNames(root: string, fs: FsProbe): string[] {
  const names: string[] = [];
  for (const entry of fs.readdir(resolve(root, "apps"))) {
    if (entry.startsWith(".")) continue;
    if (!fs.isDirectory(resolve(root, "apps", entry))) continue;
    try {
      safeName("deployment", entry);
    } catch {
      continue;
    }
    if (fs.exists(resolve(root, "apps", entry, "app.ts"))) names.push(entry);
  }
  return names.sort();
}

function sameFile(fs: FsProbe, a: string, b: string): boolean {
  return fs.realpath(a) === fs.realpath(b);
}

/** The deployment fact hints need: recorded for every selected deployment; a hand-over whose
 *  cwd is inside the deployment re-selects it by the cwd, so the prefix rule prints nothing. */
function appFact(name: string, selectedBy: InvocationApp["selectedBy"], handedOver: boolean, deploymentDir: string, cwd: string): InvocationApp {
  return { name, selectedBy: handedOver && isWithin(deploymentDir, cwd) ? "cwd" : selectedBy };
}

export function resolveCheckoutEntry(input: CheckoutEntryInput): CheckoutEntryDecision {
  const { root, cwd, argv, ocApp, handedOver, fs, gateCommands, deploymentCommands, variadicCommands } = input;

  // --app wins over the environment, the environment over the default.
  let name = ocApp ?? "openclaw";
  let selectedBy: InvocationApp["selectedBy"] = ocApp !== undefined ? "env" : "default";
  const appFlag = splitLeadingAppFlag([...argv]);
  if (appFlag.missingValue) return { kind: "refuse", refusals: [new UserError("--app needs a deployment name")] };
  if (appFlag.value !== undefined) {
    name = appFlag.value;
    selectedBy = "flag";
  }
  const rest = [...appFlag.rest];

  // --app after the command is refused, except where the command reads argv verbatim.
  if (misplacedAppFlag(rest[0], rest.slice(1), [...gateCommands, ...variadicCommands]) !== undefined) {
    return { kind: "refuse-misplaced-app-flag" };
  }

  // The gate's own commands run before any deployment is resolved.
  if (gateCommands.includes(rest[0])) return { kind: "gate-command", name: rest[0], args: rest.slice(1) };

  // Checked before it becomes a path: the name also becomes the compose project.
  try {
    safeName("deployment", name);
  } catch (error) {
    return { kind: "refuse", refusals: [new UserError((error as Error).message)] };
  }

  const baseCommandNames = [...deploymentCommands, ...gateCommands, "help", "control-mcp"];

  const deploymentDir = resolve(root, "apps", name);
  if (!fs.exists(resolve(deploymentDir, "app.ts"))) {
    // Other deployments may exist under another name: name them instead of claiming none.
    const available = availableNames(root, fs);
    const sole = soleDeploymentFallback(ocApp !== undefined || appFlag.value !== undefined, available);
    if (sole !== undefined) {
      return { kind: "run", deploymentDir: resolve(root, "apps", sole), appName: sole, argv: rest, app: appFact(sole, "sole", handedOver, resolve(root, "apps", sole), cwd), soleNote: sole };
    }
    if (rest.length === 0 || rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h" || isDeploymentHelpRequest(rest, deploymentCommands)) {
      const pick = available.length === 0
        ? "this checkout has no deployments yet"
        : `no deployment "${name}" — available: ${available.join(", ")} (pick one with --app <name> or OC_APP)`;
      return { kind: "help-without-deployment", description: pick, argv: rest };
    }
    if (!baseCommandNames.includes(rest[0])) {
      return { kind: "refuse-unknown-command", name: rest[0], candidates: baseCommandNames };
    }
    return {
      kind: "refuse",
      refusals: [missingDeploymentReport(ocApp !== undefined || appFlag.value !== undefined, name, deploymentDir, available, fs.exists(deploymentDir))],
    };
  }

  return { kind: "run", deploymentDir, appName: name, argv: rest, app: appFact(name, selectedBy, handedOver, deploymentDir, cwd) };
}

// --- the installed command: which framework copy runs --------------------------------------------

const PACKAGE = "@clawforge/framework";

/** The checkout's own gate, purely: `root` holds tools/clawforge.ts next to the framework sources. */
export function checkoutGateIn(root: string, fs: FsProbe): string | undefined {
  const gate = resolve(root, "tools", "clawforge.ts");
  const manifest = fs.readFile(resolve(root, "tools", "framework", "package.json"));
  if (manifest === undefined) return undefined;
  try {
    return (JSON.parse(manifest) as { name?: unknown }).name === PACKAGE && fs.exists(gate) ? gate : undefined;
  } catch {
    return undefined;
  }
}

/** The ClawForge checkout at or above `start` (the same test as the hand-over gate). */
export function findCheckoutRootIn(start: string, fs: FsProbe): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (checkoutGateIn(dir, fs) !== undefined) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** True when `appRoot/app.ts` loads the framework from a checkout's sources rather than the package. */
const CHECKOUT_IMPORT = /(?:from|import)\s*\(?\s*["'](?:\.\.?\/)+(?:[^"']*\/)?tools\/framework\//;

export function importsCheckoutSourcesIn(appRoot: string, fs: FsProbe): boolean {
  const source = fs.readFile(resolve(appRoot, "app.ts"));
  return source !== undefined && CHECKOUT_IMPORT.test(source);
}

/** The nearest deployment at or above `start`. The start itself counts with app.ts alone;
 *  an ancestor also needs config/desired-state.json (init and new-app both write it). */
export function findAppRootIn(start: string, fs: FsProbe): string | undefined {
  let dir = resolve(start);
  if (fs.exists(resolve(dir, "app.ts"))) return dir;
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
    if (fs.exists(resolve(dir, "app.ts")) && fs.exists(resolve(dir, "config", "desired-state.json"))) return dir;
  }
}

/** `--app <name>` for the gate, once: a leading one in `argv` is kept when it names the same
 *  deployment and refused when it names another (the cwd already selects this one). */
export type HandoverArgv = { readonly argv: readonly string[] } | { readonly refuse: "missing-app-value" } | { readonly refuse: "app-conflict"; readonly typed: string; readonly app: string };

export function handoverArgv(name: string, argv: readonly string[]): HandoverArgv {
  const { value, missingValue, rest } = splitLeadingAppFlag([...argv]);
  if (missingValue) return { refuse: "missing-app-value" };
  if (value === undefined) return { argv: ["--app", name, ...rest] };
  if (value !== name) return { refuse: "app-conflict", typed: value, app: name };
  return { argv: ["--app", name, ...rest] };
}

export interface HandoverInput {
  /** This package's own entry (the file to stop running when another copy takes over). */
  readonly self: string;
  readonly appRoot: string;
  /** Untouched argv for a local install (same entry point). */
  readonly launchArgv: readonly string[];
  /** Argv without --project-root, for a checkout gate. */
  readonly argv: readonly string[];
  readonly handedOver: boolean;
  readonly platform: NodeJS.Platform;
  readonly fs: FsProbe;
  /** The app's own local package entry, resolved from its package.json, or undefined. */
  readonly localEntry: string | undefined;
}

export type HandoverDecision =
  | { readonly kind: "run-here" }
  | { readonly kind: "spawn"; readonly entry: string; readonly args: readonly string[]; readonly delegated: boolean }
  | { readonly kind: "refuse-app-value"; readonly reason: "missing-app-value" }
  | { readonly kind: "refuse-app-value"; readonly reason: "app-conflict"; readonly typed: string; readonly app: string };

/** Whose framework runs `appRoot` when `clawforge` is the system-wide command: the local
 *  package, that checkout's own gate, the checkout gate of the apps/<name> it sits in —
 *  or this package. Two framework copies in one process would split module state, so it
 *  is always exactly one. */
export function frameworkOwner(input: HandoverInput): HandoverDecision {
  const { self, appRoot, launchArgv, argv, handedOver, platform, fs, localEntry } = input;
  if (handedOver) return { kind: "run-here" };

  if (localEntry !== undefined && fs.exists(localEntry) && !sameFile(fs, localEntry, self)) {
    return { kind: "spawn", entry: localEntry, args: launchArgv, delegated: true };
  }
  const inCheckout = checkoutGateIn(appRoot, fs);
  if (inCheckout !== undefined) return { kind: "spawn", entry: inCheckout, args: argv, delegated: false };
  // The cwd keeps the case it was typed in; the file system may not (Windows: APPS/<name>).
  // The app's name stays the typed spelling: the canonical basename may be cased differently.
  const canonical = platform === "win32" ? fs.realpath(appRoot) : appRoot;
  const parent = dirname(canonical);
  const parentName = basename(parent);
  const isApps = platform === "win32" ? parentName.toLowerCase() === "apps" : parentName === "apps";
  if (isApps && fs.exists(resolve(appRoot, "app.ts"))) {
    const appGate = checkoutGateIn(dirname(parent), fs);
    if (appGate !== undefined) {
      const withApp = handoverArgv(basename(appRoot), argv);
      if ("refuse" in withApp) {
        return withApp.refuse === "missing-app-value" ? { kind: "refuse-app-value", reason: "missing-app-value" } : { kind: "refuse-app-value", reason: "app-conflict", typed: withApp.typed, app: withApp.app };
      }
      return { kind: "spawn", entry: appGate, args: withApp.argv, delegated: false };
    }
  }
  return { kind: "run-here" };
}

export interface StrayInput {
  readonly self: string;
  readonly appRoot: string;
  readonly fs: FsProbe;
}

/** A stray checkout-style app.ts: no hand-over happened, yet app.ts imports a checkout's
 *  framework sources that are not this package's own — loading it would run a second copy.
 *  An installed-style app.ts (the package specifier) is fine. */
export function strayCheckoutApp(input: StrayInput): { readonly checkout: string } | undefined {
  const { self, appRoot, fs } = input;
  if (!fs.exists(resolve(appRoot, "app.ts")) || !importsCheckoutSourcesIn(appRoot, fs)) return undefined;
  const checkout = findCheckoutRootIn(appRoot, fs);
  if (checkout === undefined) return undefined;
  return isWithin(fs.realpath(checkout), fs.realpath(self)) ? undefined : { checkout };
}

// --- the installed entry: placement decisions ----------------------------------------------------

export interface InstalledEntryInput {
  readonly cwd: string;
  /** process.argv.slice(2) as it arrived — `--project-root` is decided before anything else. */
  readonly rawArgv: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly fs: FsProbe;
}

export type InstalledEntryDecision =
  /** reportError refusals: the --project-root refusal, init nesting inside a deployment,
   *  and init inside a ClawForge checkout (its bash spelling rides as shell advice). */
  | { readonly kind: "refuse"; readonly refusals: readonly UserError[] }
  /** info + exit 0: `init --local` whose deployment already imports the checkout's sources. */
  | { readonly kind: "checkout-types-note"; readonly line: string }
  | {
      readonly kind: "run";
      readonly appRoot: string;
      /** argv with the version aliases normalised and --project-root consumed. */
      readonly argv: readonly string[];
      /** The re-exec argv: as typed, or with the found app root passed explicitly. */
      readonly launchArgv: readonly string[];
      readonly initializing: boolean;
      /** `init --local` in an already initialised directory: prints the editor-types line only. */
      readonly localTypesOnly: boolean;
      /** The deployment found at or above the cwd, when the cwd is not itself one. */
      readonly ancestor: string | undefined;
      /** The ClawForge checkout at or above the cwd, when the directory is in one. */
      readonly checkout: string | undefined;
    };

function sameDirectory(platform: NodeJS.Platform, a: string, b: string): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The installed entry's placement decisions (plan stage 2, item 2 — what bin.ts used to
 *  decide inline): `--project-root <abs>`, where init may write, which directory is the
 *  app root, and the argv a re-exec needs. Pure: same fs-probe discipline as the gate. */
export function resolveInstalledEntry(input: InstalledEntryInput): InstalledEntryDecision {
  const { cwd, rawArgv, platform, fs } = input;

  const scheduled = rawArgv[0] === "--project-root";
  if (scheduled && (rawArgv[1] === undefined || !isAbsolute(rawArgv[1]))) {
    return { kind: "refuse", refusals: [new UserError("--project-root requires an absolute directory")] };
  }
  const argv = normalizeVersionAlias(scheduled ? rawArgv.slice(2) : [...rawArgv]);
  // The entries pass an already-resolved cwd; resolving again keeps the comparisons below
  // spelling-independent (the matrix's fake paths are relative to a fake root).
  const here = resolve(cwd);

  // Without --project-root the deployment is the nearest app.ts at or above the cwd. `init` is
  // the exception: it always initialises the cwd itself, and refuses under an existing deployment.
  const initializing = argv[0] === "init" && !argv.includes("--help") && !argv.includes("-h");
  const ancestor = scheduled ? undefined : findAppRootIn(cwd, fs);
  // `init --local` writes nothing, so from a subfolder it only prints the editor-types line.
  const localTypesOnly = initializing && argv.includes("--local") && ancestor !== undefined;
  if (initializing && !scheduled && ancestor !== undefined && ancestor !== here && !localTypesOnly) {
    return { kind: "refuse", refusals: [new UserError(`${ancestor} ${ALREADY_HOLDS_APP} — this directory is inside that deployment; init here would nest a second one`)] };
  }
  // A checkout deployment reads the framework from the checkout's sources: nothing to install.
  if (localTypesOnly && ancestor !== undefined && importsCheckoutSourcesIn(ancestor, fs)) {
    return { kind: "checkout-types-note", line: `editor types: this deployment imports the framework from its ClawForge checkout, so they already resolve there — ${NOTHING_TO_INSTALL_NOTE} (npm ci in the checkout root is enough)` };
  }
  const checkout = scheduled ? undefined : findCheckoutRootIn(cwd, fs);
  if (initializing && ancestor === undefined && checkout !== undefined) {
    // new-app only takes over an empty apps/<name> directly under the checkout — and only a
    // name new-app would accept; hidden or invalid names get the plain advice instead.
    const reusable =
      fs.readdir(cwd).length === 0 &&
      // Both sides resolved, so the comparison does not depend on how the caller spelled cwd.
      sameDirectory(platform, dirname(here), resolve(checkout, "apps")) &&
      isValidDeploymentName(basename(here));
    // The main advice is this invocation's spelling; the bash variant is shell advice, so
    // nothing rewrites it to the program that was typed.
    const advice: Advice[] = [
      command(["new-app", "<name>"]),
      shellLine("posix", renderAdvice(command(["new-app", "<name>"]), shimInvocation()), { note: IN_BASH_NOTE }),
    ];
    if (reusable) {
      advice.push(manual(takeoverNote(basename(cwd))));
    }
    return {
      kind: "refuse",
      refusals: [
        new UserError(
          `${checkout} is a ClawForge checkout — init writes an installed-style deployment (its own committed ` +
            `clawforge entrypoint, package.json and MCP launcher), not a checkout deployment; a checkout one ` +
            `is new-app under apps/. From the checkout root, run the gate from its root:`,
          { advice },
        ),
      ],
    };
  }
  const appRoot = scheduled ? resolve(rawArgv[1]) : initializing ? here : (ancestor ?? here);
  // A hand-over target may predate the walk, so the found root is passed explicitly.
  const launchArgv = scheduled || appRoot === here ? [...rawArgv] : ["--project-root", appRoot, ...rawArgv];
  return { kind: "run", appRoot, argv, launchArgv, initializing, localTypesOnly, ancestor, checkout };
}

function isValidDeploymentName(name: string): boolean {
  try {
    safeName("deployment", name);
    return true;
  } catch {
    return false;
  }
}

/** The "no app.ts here" branches of the installed entry, as data. The executor checks
 *  app.ts, then renders this decision: a checkout-subfolder report, the deployment-less
 *  help (which always exits), or the not-initialised refusal — in that order, as today. */
export interface MissingAppInput {
  readonly appRoot: string;
  readonly argv: readonly string[];
  readonly checkout: string | undefined;
  /** The installed gate's own commands (init, version, completion). */
  readonly gateCommandNames: readonly string[];
  readonly deploymentCommands: readonly string[];
}

interface NotInitialised {
  readonly headline: string;
  readonly refusals: readonly UserError[];
}

export type MissingAppDecision =
  | { readonly kind: "subfolder-report"; readonly headline: string; readonly refusal: UserError }
  /** helpWithoutDeployment answers; `fallback` renders when it declines. */
  | { readonly kind: "help"; readonly fallback: NotInitialised }
  | ({ readonly kind: "not-initialised" } & NotInitialised);

export function missingAppDecision(input: MissingAppInput): MissingAppDecision {
  const { appRoot, argv, checkout, gateCommandNames, deploymentCommands } = input;
  const subfolder = checkout !== undefined ? checkoutSubfolderReport(argv[0] ?? "", checkout) : undefined;
  if (subfolder !== undefined) {
    return { kind: "subfolder-report", headline: `no app.ts in ${appRoot}`, refusal: subfolder };
  }
  const refusals: readonly UserError[] = checkout === undefined
    ? [new UserError(`this directory ${NOT_INITIALISED_NOTE}`, { advice: [command(["init"])] })]
    : [
        new UserError(`this is a ClawForge checkout (${checkout}) — ${FROM_CHECKOUT_ROOT}:`, {
          advice: [
            command([]),
            shellLine("posix", renderAdvice(command([]), shimInvocation()), { note: IN_BASH_NOTE }),
          ],
        }),
      ];
  const refusal: NotInitialised = {
    headline: `no app.ts in ${appRoot}`,
    refusals,
  };
  const first = argv[0];
  const offered = checkout === undefined ? gateCommandNames : gateCommandNames.filter((name) => name !== "init");
  const candidates = [...deploymentCommands, ...offered, "help"];
  // helpWithoutDeployment declines only an option, control-mcp or a name something declares;
  // every other word is a typo it reports itself, and help requests it answers.
  const isHelpRequest =
    first === undefined || first === "help" || first === "--help" || first === "-h" || isDeploymentHelpRequest(argv, deploymentCommands);
  const declined = !isHelpRequest && (first.startsWith("-") || first === "control-mcp" || candidates.includes(first));
  const handledByHelp = !declined;
  if (handledByHelp) return { kind: "help", fallback: refusal };
  return { kind: "not-initialised", ...refusal };
}
