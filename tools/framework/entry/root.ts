// Where the deployment is when `clawforge` runs in one of its subfolders.

import { frameworkPackage } from "../core/env.ts";
import { classifyCopy } from "../integration/version.ts";
import { SHIM_PROGRAM, WINDOWS_BIN_PROGRAM } from "../core/io/invocation/render.ts";
import type { Invocation } from "../core/io/invocation/index.ts";

/** Hint prefix and mode when no entry named itself: `clawforge` only for the system-wide
 *  copy; the app's own dependency (MCP launcher, npx, node_modules/.bin) has no global
 *  command behind it, but init always commits the clawforge shim. On Windows the hint
 *  names npm's bin wrapper: the shim is bash-only and cmd.exe and PowerShell cannot run
 *  it (see WINDOWS_BIN_PROGRAM). */
export async function defaultInvocation(appRoot: string, platform: string = process.platform): Promise<Pick<Invocation, "program" | "mode">> {
  const pkg = await frameworkPackage();
  return pkg === undefined || classifyCopy(pkg.dir, appRoot).source === "global"
    ? { program: "clawforge", mode: "installed" }
    : platform === "win32"
      ? { program: WINDOWS_BIN_PROGRAM, mode: "local-package" }
      : { program: SHIM_PROGRAM, mode: "local-package" };
}
