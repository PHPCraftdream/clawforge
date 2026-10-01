// Which framework runs a deployment when `clawforge` is the system-wide command.
//
// The deployment's own framework wins, so one global install serves every app without
// changing any of them: a local @clawforge/framework dependency (the app's version pin),
// or — for apps/<name> and the root of a ClawForge checkout — that checkout's own gate.
// Only an app with neither runs on the global package itself, whose @clawforge/framework
// imports then resolve to that package. Two framework copies in one process would split
// module state (the selected deployment, registered secrets), so it is always one or the other.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { INVOCATION_ENV, invocation, serializeInvocation } from "../core/io/invocation/index.ts";
import { checkoutFrameworkSource } from "../core/env.ts";
import { reportError } from "../core/io/log.ts";
import { splitLeadingAppFlag } from "../integration/gate.ts";
import { isWithin } from "../core/paths.ts";

const PACKAGE = "@clawforge/framework";
const DELEGATED = "CLAWFORGE_DELEGATED";

/** The local package's entry point, when the app resolves one of its own. */
function localEntry(appRoot: string): string | undefined {
  try {
    const app = createRequire(resolve(appRoot, "package.json")).resolve(`${PACKAGE}/app`);
    return resolve(dirname(app), "..", "entry", "bin.js");
  } catch {
    return undefined;
  }
}

/** The checkout's own gate: `root` holds tools/clawforge.ts next to the framework sources. */
export function checkoutGate(root: string): string | undefined {
  const gate = resolve(root, "tools", "clawforge.ts");
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, "tools", "framework", "package.json"), "utf8")) as { name?: unknown };
    return manifest.name === PACKAGE && existsSync(gate) ? gate : undefined;
  } catch {
    return undefined;
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Reads and clears the hand-over flag. Called first thing in the receiving bin.ts, so the
 *  flag covers only this one hand-over and never reaches hooks or other clawforge runs it spawns. */
export function takeDelegationFlag(): boolean {
  const handedOver = process.env[DELEGATED] === "1";
  delete process.env[DELEGATED];
  return handedOver;
}

/** `flag`: only a package entry (bin.js) reads it; a checkout gate never would, so it would leak. */
function runInstead(entry: string, args: string[], flag: boolean): never {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", entry, ...args], {
    stdio: "inherit",
    env: { ...process.env, [INVOCATION_ENV]: serializeInvocation(invocation()), ...(flag ? { [DELEGATED]: "1" } : {}) },
  });
  if (result.error !== undefined) {
    process.stderr.write(`clawforge: cannot start ${entry}: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

/** Hands the whole invocation to the deployment's own framework when it has one; returns
 *  only when this package is the one to run. `launchArgv` is passed on untouched to a local
 *  install (same entry point), `argv` (without --project-root) to a checkout gate. */
export function delegateToOwnFramework(self: string, appRoot: string, launchArgv: string[], argv: string[], handedOver: boolean): void {
  if (handedOver) return;

  const local = localEntry(appRoot);
  if (local !== undefined && existsSync(local) && !sameFile(local, self)) runInstead(local, launchArgv, true);

  const inCheckout = checkoutGate(appRoot);
  if (inCheckout !== undefined) runInstead(inCheckout, argv, false);
  // The cwd keeps the case it was typed in; the file system may not (Windows: APPS/<name>).
  const canonical = canonicalCase(appRoot);
  const parent = dirname(canonical);
  const hasApp = existsSync(resolve(appRoot, "app.ts"));
  const appGate = isAppsDirectory(parent) && hasApp ? checkoutGate(dirname(parent)) : undefined;
  if (appGate !== undefined) runInstead(appGate, withApp(basename(canonical), argv), false);
}

// No hand-over, yet its app.ts imports a checkout's framework sources: this package would
// load a second copy next to its own. An installed-style app.ts (the package specifier) is fine.
// Called after the gate commands have had their turn, so `version` etc. still answer here.
export function refuseStrayCheckoutApp(self: string, appRoot: string): void {
  if (!existsSync(resolve(appRoot, "app.ts")) || !importsCheckoutSources(appRoot)) return;
  const checkout = findCheckoutRoot(appRoot);
  if (checkout !== undefined && !isWithin(realOrSelf(checkout), realOrSelf(self))) {
    reportError(`${appRoot} imports the framework sources of the ClawForge checkout ${checkout} but is not one of its apps/<name> deployments — move it into apps/<name> (new-app), or switch its imports to @clawforge/framework`);
    process.exit(1);
  }
}

// The monorepo-style declaration new-app writes: a relative import into tools/framework/.
const CHECKOUT_IMPORT = /(?:from|import)\s*\(?\s*["'](?:\.\.?\/)+(?:[^"']*\/)?tools\/framework\//;

/** True when `appRoot/app.ts` loads the framework from a checkout's sources rather than the package. */
export function importsCheckoutSources(appRoot: string): boolean {
  try {
    return CHECKOUT_IMPORT.test(readFileSync(resolve(appRoot, "app.ts"), "utf8"));
  } catch {
    return false;
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** The path as the file system spells it, where that differs from the typed one only by case. */
function canonicalCase(path: string): string {
  return process.platform === "win32" ? realOrSelf(path) : path;
}

function isAppsDirectory(dir: string): boolean {
  const name = basename(dir);
  return process.platform === "win32" ? name.toLowerCase() === "apps" : name === "apps";
}

/** The ClawForge checkout at or above `start` (the same test as the hand-over gate). */
export function findCheckoutRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (checkoutGate(dir) !== undefined) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `--app <name>` for the gate, once: a leading one in `argv` is kept when it names the same
 *  deployment and refused when it names another (the cwd already selects this one). */
function withApp(name: string, argv: string[]): string[] {
  const { value, missingValue, rest } = splitLeadingAppFlag(argv);
  if (missingValue) {
    reportError("--app needs a deployment name");
    process.exit(1);
  }
  if (value === undefined) return ["--app", name, ...argv];
  if (value !== name) {
    reportError(`--app ${value} conflicts with this directory, deployment ${name} of the checkout — run ./clawforge --app ${value} from the checkout root`);
    process.exit(1);
  }
  return ["--app", name, ...rest];
}

/** Lets the deployment's app.ts import @clawforge/framework from this very package when it
 *  has no install of its own (the system-wide case): resolved as a self-reference. */
export function resolveFrameworkFromSelf(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== PACKAGE && !specifier.startsWith(`${PACKAGE}/`)) return nextResolve(specifier, context);
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
        return nextResolve(specifier, { ...context, parentURL: import.meta.url });
      }
    },
  });
}

/** The checkout gate: the package has no dist build here, so a deployment's app.ts importing
 *  `@clawforge/framework/<export>` resolves onto the sibling sources (the recipe hook loader
 *  maps the same table for hook imports on its own loader thread). */
export function resolveFrameworkFromSources(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== PACKAGE && !specifier.startsWith(`${PACKAGE}/`)) return nextResolve(specifier, context);
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
        const source = checkoutFrameworkSource(specifier);
        if (source === undefined) throw error;
        return { url: pathToFileURL(source).href, shortCircuit: true };
      }
    },
  });
}
