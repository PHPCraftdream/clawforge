// Where the deployment is when `clawforge` runs in one of its subfolders.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { frameworkPackage } from "../core/env.ts";
import { classifyCopy } from "../integration/version.ts";

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

/** Hint prefix when no entry named itself: `clawforge` only for the system-wide copy; the
 *  app's own dependency (MCP launcher, npx, node_modules/.bin) has no global command behind
 *  it, but init always commits the ./clawforge shim. */
export async function defaultInvocation(appRoot: string): Promise<string> {
  const pkg = await frameworkPackage();
  return pkg === undefined || classifyCopy(pkg.dir, appRoot).source === "global" ? "clawforge" : "./clawforge";
}
