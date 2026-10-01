// Where the deployment is when `clawforge` runs in one of its subfolders.

import { frameworkPackage } from "../core/env.ts";
import { classifyCopy } from "../integration/version.ts";
import { findAppRootIn, nodeFs } from "./resolve.ts";
import type { Invocation } from "../core/io/invocation/index.ts";

/** The nearest deployment at or above `start`. The walk itself (the decision) lives in
 *  entry/resolve.ts; this is the real file system's adapter. */
export function findAppRoot(start: string): string | undefined {
  return findAppRootIn(start, nodeFs);
}

/** Hint prefix and mode when no entry named itself: `clawforge` only for the system-wide
 *  copy; the app's own dependency (MCP launcher, npx, node_modules/.bin) has no global
 *  command behind it, but init always commits the ./clawforge shim. */
export async function defaultInvocation(appRoot: string): Promise<Pick<Invocation, "program" | "mode">> {
  const pkg = await frameworkPackage();
  return pkg === undefined || classifyCopy(pkg.dir, appRoot).source === "global"
    ? { program: "clawforge", mode: "installed" }
    : { program: "./clawforge", mode: "local-package" };
}
