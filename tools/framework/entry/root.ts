// Where the deployment is when `clawforge` runs in one of its subfolders.

import { relative, resolve, sep } from "node:path";
import { frameworkPackage } from "../core/env.ts";
import { classifyCopy } from "../integration/version.ts";
import { SHIM_PROGRAM, WINDOWS_BIN_PROGRAM } from "../core/io/invocation/render.ts";
import type { Invocation } from "../core/io/invocation/index.ts";

/** Hint prefix and mode when no entry named itself: `clawforge` only for the system-wide
 *  copy. The checkout's own installed-style entry (run directly, or npm-linked) names the
 *  checkout's shim where it really is — the root spelling from the checkout root, the
 *  monorepo MCP launcher's two-levels-up path from apps/<name> — in checkout mode; the
 *  app's own dependency (MCP launcher, npx, node_modules/.bin) has no global command
 *  behind it, but init always commits the clawforge shim. There the hint is the
 *  local-package one, and on Windows names npm's bin wrapper: the shim is bash-only and
 *  cmd.exe and PowerShell cannot run it (see WINDOWS_BIN_PROGRAM). */
export async function defaultInvocation(appRoot: string, platform: string = process.platform, checkout: string | undefined = undefined): Promise<Pick<Invocation, "program" | "mode">> {
  const pkg = await frameworkPackage();
  const copy = pkg === undefined ? undefined : classifyCopy(pkg.dir, appRoot);
  if (pkg === undefined || copy === undefined || copy.source === "global") {
    return { program: "clawforge", mode: "installed" };
  }
  if (copy.source === "checkout") {
    // A checkout spelling for a checkout copy: the shim at the checkout root — the checkout
    // the entry's decision walked to (bin.ts passes it; it can differ from the running
    // copy's when a run refuses inside another checkout) — spelled from the root the run is
    // about (the app root, or the cwd it refused from). The monorepo MCP launcher spells
    // the same path from apps/<name>.
    const up = relative(resolve(appRoot), checkout ?? copy.path).split(sep).join("/");
    return { program: up === "" ? SHIM_PROGRAM : `${up}/${SHIM_PROGRAM.slice("./".length)}`, mode: "checkout" };
  }
  return platform === "win32"
    ? { program: WINDOWS_BIN_PROGRAM, mode: "local-package" }
    : { program: SHIM_PROGRAM, mode: "local-package" };
}
