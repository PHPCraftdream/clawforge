// Which framework runs a deployment when `clawforge` is the system-wide command.
//
// The deployment's own framework wins, so one global install serves every app without
// changing any of them: a local @clawforge/framework dependency (the app's version pin),
// or — for apps/<name> and the root of a ClawForge checkout — that checkout's own gate.
// Only an app with neither runs on the global package itself, whose @clawforge/framework
// imports then resolve to that package. Two framework copies in one process would split
// module state (the selected deployment, registered secrets), so it is always one or the other.

import { createRequire, registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { INVOCATION_ENV, invocation, serializeInvocation } from "../core/io/invocation/index.ts";
import { checkoutFrameworkSource } from "../core/env.ts";
import { reportError, UserError } from "../core/io/log.ts";
import { command } from "../core/io/invocation/advice.ts";
import { renderArgument } from "../core/io/invocation/render.ts";
import { nodeFs, checkoutGateIn, findCheckoutRootIn, frameworkOwner, strayCheckoutApp, importsCheckoutSourcesIn } from "./resolve.ts";

const PACKAGE = "@clawforge/framework";
const DELEGATED = "CLAWFORGE_DELEGATED";

/** Fixed parts of the hand-over refusals, exported for the system-install check. */
export const APP_CONFLICT_NOTE = "conflicts with this directory";
export const FOREIGN_SOURCES_NOTE = "imports the framework sources";

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
  return checkoutGateIn(root, nodeFs);
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
 *  install (same entry point), `argv` (without --project-root) to a checkout gate. Which
 *  copy that is — the decision — is entry/resolve.ts's; here only the effects remain. */
export function delegateToOwnFramework(self: string, appRoot: string, launchArgv: string[], argv: string[], handedOver: boolean): void {
  const decision = frameworkOwner({ self, appRoot, launchArgv, argv, handedOver, platform: process.platform, fs: nodeFs, localEntry: localEntry(appRoot) });
  if (decision.kind === "run-here") return;
  if (decision.kind === "spawn") {
    runInstead(decision.entry, [...decision.args], decision.delegated);
    return;
  }
  if (decision.reason === "missing-app-value") {
    reportError("--app needs a deployment name");
    process.exit(1);
  }
  reportError(new UserError(`--app ${renderArgument(decision.typed, invocation().program)} ${APP_CONFLICT_NOTE}, deployment ${decision.app} of the checkout — run this from the checkout root:`, { advice: [command([], { app: decision.typed })] }));
  process.exit(1);
}

// No hand-over, yet its app.ts imports a checkout's framework sources: this package would
// load a second copy next to its own. An installed-style app.ts (the package specifier) is fine.
// Called after the gate commands have had their turn, so `version` etc. still answer here.
export function refuseStrayCheckoutApp(self: string, appRoot: string): void {
  const stray = strayCheckoutApp({ self, appRoot, fs: nodeFs });
  if (stray === undefined) return;
  reportError(`${appRoot} ${FOREIGN_SOURCES_NOTE} of the ClawForge checkout ${stray.checkout} but is not one of its apps/<name> deployments — move it into apps/<name> (new-app), or switch its imports to @clawforge/framework`);
  process.exit(1);
}

/** True when `appRoot/app.ts` loads the framework from a checkout's sources rather than the package. */
export function importsCheckoutSources(appRoot: string): boolean {
  return importsCheckoutSourcesIn(appRoot, nodeFs);
}

/** The ClawForge checkout at or above `start` (the same test as the hand-over gate). */
export function findCheckoutRoot(start: string): string | undefined {
  return findCheckoutRootIn(start, nodeFs);
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
