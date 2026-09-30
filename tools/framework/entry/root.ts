// Where the deployment is when `clawforge` runs in one of its subfolders.

import { existsSync } from "node:fs";
import { dirname, relative, isAbsolute, resolve } from "node:path";
import { frameworkPackage } from "../commands/management/lock.ts";
import { classifyCopy } from "../integration/version.ts";
import { checkoutGate } from "./delegate.ts";

/** The nearest deployment at or above `start`. The start itself counts with app.ts alone, as
 *  before; an ancestor also needs config/desired-state.json (init and new-app both write it),
 *  so an unrelated project's app.ts higher up is never taken for a deployment. */
export function findAppRoot(start: string): string | undefined {
  let dir = resolve(start);
  if (existsSync(resolve(dir, "app.ts"))) return dir;
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
    if (existsSync(resolve(dir, "app.ts")) && existsSync(resolve(dir, "config", "desired-state.json"))) return dir;
  }
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

/** Hint prefix when no entry named itself: `clawforge` only for the system-wide copy; the
 *  app's own dependency (MCP launcher, npx, node_modules/.bin) has no global command behind
 *  it, but init always commits the ./clawforge shim. */
export async function defaultInvocation(appRoot: string): Promise<string> {
  const pkg = await frameworkPackage();
  return pkg === undefined || classifyCopy(pkg.dir, appRoot).source === "global" ? "clawforge" : "./clawforge";
}

/** Whether `dir` is `root` or inside it. */
export function isWithin(root: string, dir: string): boolean {
  const within = relative(resolve(root), resolve(dir));
  return within === "" || (!within.startsWith("..") && !isAbsolute(within));
}
