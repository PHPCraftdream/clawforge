// Where the deployment is when `clawforge` runs in one of its subfolders.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
