// Where the deployment is when `clawforge` runs in one of its subfolders.

import { frameworkPackage } from "../core/env.ts";
import { classifyCopy } from "../integration/version.ts";
import type { HostPlatform, Frame, Launch } from "../core/io/invocation/frame.ts";
import { defaultLaunch, modeOf, pasteShells, spell } from "../core/io/invocation/frame.ts";
import type { Invocation } from "../core/io/invocation/index.ts";

export async function defaultInvocation(appRoot: string, platform: string = process.platform, checkout: string | undefined = undefined): Promise<Pick<Invocation, "program" | "mode">> {
  const launch = await decideLaunch(appRoot, { host: platform === "win32" ? "win32" : "posix", checkout });
  const host = platform === "win32" ? "win32" : "posix";
  return {
    // The entry default's own spelling: the npm wrapper under cmd on Windows, POSIX elsewhere.
    program: (host === "win32" ? spell(launch, "cmd", host, appRoot) : undefined) ?? spell(launch, "posix", host, appRoot)!,
    mode: modeOf(launch),
  };
}

// The launch decision shared by the default Invocation and the default frame: which copy runs.
async function decideLaunch(appRoot: string, facts: { host: HostPlatform; checkout?: string }): Promise<Launch> {
  const pkg = await frameworkPackage();
  const copy = pkg === undefined ? undefined : classifyCopy(pkg.dir, appRoot);
  return pkg === undefined || copy === undefined || copy.source === "global"
    ? defaultLaunch({ source: "global" })
    : copy.source === "checkout"
      ? defaultLaunch({ source: "checkout-copy", root: facts.checkout ?? copy.path })
      : defaultLaunch({ source: "local-package", appRoot, host: facts.host });
}

export async function defaultFrame(appRoot: string, facts: { host: HostPlatform; msys: boolean; cwd: string; checkout?: string }): Promise<Frame> {
  const launch = await decideLaunch(appRoot, { host: facts.host, checkout: facts.checkout });
  const hostFact = { kind: "operator" as const, platform: facts.host };
  return { launch, host: hostFact, shells: pasteShells(launch, hostFact, facts.msys), cwd: { kind: "dir", path: facts.cwd }, places: { ...(facts.checkout === undefined ? {} : { checkoutRoot: facts.checkout }), deploymentRoot: appRoot }, app: { state: "none" }, audience: "terminal" };
}
