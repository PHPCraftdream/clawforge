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
function checkoutGate(root: string): string | undefined {
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

function runInstead(entry: string, args: string[]): never {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", entry, ...args], {
    stdio: "inherit",
    env: { ...process.env, [DELEGATED]: "1" },
  });
  process.exit(result.status ?? 1);
}

/** Hands the whole invocation to the deployment's own framework when it has one; returns
 *  only when this package is the one to run. `launchArgv` is passed on untouched to a local
 *  install (same entry point), `argv` (without --project-root) to a checkout gate. */
export function delegateToOwnFramework(self: string, appRoot: string, launchArgv: string[], argv: string[]): void {
  if (process.env[DELEGATED] === "1") return;

  const local = localEntry(appRoot);
  if (local !== undefined && existsSync(local) && !sameFile(local, self)) runInstead(local, launchArgv);

  const inCheckout = checkoutGate(appRoot);
  if (inCheckout !== undefined) runInstead(inCheckout, argv);
  const parent = dirname(appRoot);
  const appGate = basename(parent) === "apps" && existsSync(resolve(appRoot, "app.ts")) ? checkoutGate(dirname(parent)) : undefined;
  if (appGate !== undefined) runInstead(appGate, ["--app", basename(appRoot), ...argv]);
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
