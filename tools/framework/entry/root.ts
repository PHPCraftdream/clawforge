// Where the deployment is when `clawforge` runs in one of its subfolders.

import { frameworkPackage } from "../core/env.ts";
import { classifyCopy } from "../integration/version.ts";
import type { HostPlatform, Launch } from "../core/io/invocation/frame.ts";
import { defaultLaunch, spell } from "../core/io/invocation/frame.ts";
import type { Invocation } from "../core/io/invocation/index.ts";

/** Hint prefix and mode when no entry named itself: `clawforge` only for the system-wide
 *  copy. The checkout's own installed-style entry (run directly, or npm-linked) names the
 *  checkout's shim where it really is — the root spelling from the checkout root, the
 *  monorepo MCP launcher's two-levels-up path from apps/<name> — in checkout mode; the
 *  app's own dependency (MCP launcher, npx, node_modules/.bin) has no global command
 *  behind it, but init always commits the clawforge shim. There the hint is the
 *  local-package one, and on Windows names npm's bin wrapper: the shim is bash-only and
 *  cmd.exe and PowerShell cannot run it (WINDOWS_BIN_PROGRAM, frame.ts). The three cases
 *  are one launch each (defaultLaunch); the program is the launch's own spelling,
 *  relative to the root the run is about (the app root, or the cwd it refused from). */
export async function defaultInvocation(appRoot: string, platform: string = process.platform, checkout: string | undefined = undefined): Promise<Pick<Invocation, "program" | "mode">> {
  const host: HostPlatform = platform === "win32" ? "win32" : "posix";
  const pkg = await frameworkPackage();
  const copy = pkg === undefined ? undefined : classifyCopy(pkg.dir, appRoot);
  if (pkg === undefined || copy === undefined || copy.source === "global") {
    return { program: spell(defaultLaunch({ source: "global" }), "posix", host, appRoot)!, mode: "installed" };
  }
  if (copy.source === "checkout") {
    // A checkout spelling for a checkout copy: the shim at the checkout root — the checkout
    // the entry's decision walked to (bin.ts passes it; it can differ from the running
    // copy's when a run refuses inside another checkout). The monorepo MCP launcher spells
    // the same path from apps/<name>.
    const launch: Launch = defaultLaunch({ source: "checkout-copy", root: checkout ?? copy.path });
    return { program: spell(launch, "posix", host, appRoot)!, mode: "checkout" };
  }
  const launch = defaultLaunch({ source: "local-package", appRoot, host });
  // The wrapper spelling on Windows; the committed shim's POSIX one elsewhere.
  const program = (host === "win32" ? spell(launch, "cmd", host, appRoot) : spell(launch, "posix", host, appRoot))!;
  return { program, mode: "local-package" };
}
