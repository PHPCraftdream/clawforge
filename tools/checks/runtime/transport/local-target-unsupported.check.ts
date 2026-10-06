// LOCAL_TARGET_UNSUPPORTED — createTransport() refuses a `local` target (explicit or via
// `auto`) on a host that cannot run it: the target-side commands this framework issues are
// GNU/Linux-specific (find -printf, stat -c, readlink -f, sha256sum, tar --numeric-owner,
// /proc, /srv). The supported host x target matrix (docs/guide/requirements.md):
//   Linux host   — local, or ssh
//   Windows host — wsl, or ssh (no local: not GNU/Linux)
//   macOS host   — ssh only (no local: not GNU/Linux)
//
// createTransport() takes the host platform as a parameter (default process.platform), so
// every cell below is exercised by injection — no process.platform stubbing, no dependency
// on which OS actually runs this check, and no wsl.exe/ssh process spawned: transport
// construction itself does no I/O, only exec() would.

import { createTransport, LocalTargetUnsupportedError, LocalTransport, WslTransport, SshTransport } from "#framework/runtime/transport/transport.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function expectRefusal(platform: NodeJS.Platform, location: string | undefined): Promise<LocalTargetUnsupportedError> {
  let error: unknown;
  try {
    await createTransport({ location, platform, sshHost: "user@host" });
  } catch (thrown) {
    error = thrown;
  }
  check(`${platform}/${location ?? "auto"} raises LocalTargetUnsupportedError`, error instanceof LocalTargetUnsupportedError, true);
  return error as LocalTargetUnsupportedError;
}

// --- one cell per row of the matrix, exactly as the docs table states it --------------------

{
  // linux/local: ok
  const transport = await createTransport({ location: "local", platform: "linux" });
  check("linux + local resolves to LocalTransport", transport instanceof LocalTransport, true);
}

{
  // linux/ssh: ok
  const transport = await createTransport({ location: "ssh", platform: "linux", sshHost: "user@host" });
  check("linux + ssh resolves to SshTransport", transport instanceof SshTransport, true);
}

{
  // linux/auto: existing behaviour (resolves to local) must stay
  const transport = await createTransport({ location: undefined, platform: "linux" });
  check("linux + auto still resolves to LocalTransport", transport instanceof LocalTransport, true);
}

{
  // win32/wsl: ok
  const transport = await createTransport({ location: "wsl", platform: "win32" });
  check("win32 + wsl resolves to WslTransport", transport instanceof WslTransport, true);
}

{
  // win32/ssh: ok
  const transport = await createTransport({ location: "ssh", platform: "win32", sshHost: "user@host" });
  check("win32 + ssh resolves to SshTransport", transport instanceof SshTransport, true);
}

{
  // win32/auto: existing behaviour (resolves to wsl, never local) must stay
  const transport = await createTransport({ location: undefined, platform: "win32" });
  check("win32 + auto still resolves to WslTransport", transport instanceof WslTransport, true);
}

{
  // win32/local: refused — Windows is not Linux, target commands need Linux
  const error = await expectRefusal("win32", "local");
  check("...names the host OS", error?.message.includes("win32") ?? false, true);
  check("...says local needs Linux", error?.message.includes("needs Linux") ?? false, true);
  check("...next step names OC_TARGET_LOCATION=wsl", error?.nextAction.includes("OC_TARGET_LOCATION=wsl") ?? false, true);
  check("...next step also names OC_TARGET_LOCATION=ssh", error?.nextAction.includes("OC_TARGET_LOCATION=ssh") ?? false, true);
  // The remedy is advice now (rf6-fix33): the message is the headline, the arrow line is
  // rendered per surface — asserted once here as the class's own contract.
  check("...the refusal carries the remedy as advice", error?.advice, [{ kind: "manual", text: error?.nextAction ?? "" }]);
  // The arrow line spelled from pieces, not a literal: this file is counted by the prose
  // ratchets, and the assertion is structural (the message never carries the rendered line).
  const arrowLine = String.fromCharCode(10) + "    →";
  check("...the message is the headline without a baked-in arrow", error?.message.includes(arrowLine) ?? true, false);
}

{
  // darwin/ssh: ok — macOS host, ssh target only
  const transport = await createTransport({ location: "ssh", platform: "darwin", sshHost: "user@host" });
  check("darwin + ssh resolves to SshTransport", transport instanceof SshTransport, true);
}

{
  // darwin/local: refused — macOS as a local target is not supported
  const error = await expectRefusal("darwin", "local");
  check("...names the host OS", error?.message.includes("darwin") ?? false, true);
  check("...says local needs Linux", error?.message.includes("needs Linux") ?? false, true);
  check("...next step names OC_TARGET_LOCATION=ssh", error?.nextAction.includes("OC_TARGET_LOCATION=ssh") ?? false, true);
  check("...next step does not suggest wsl on a non-Windows host", error?.nextAction.includes("wsl") ?? false, false);
}

{
  // darwin/auto: previously fell back to local (process.platform !== "win32"); must now refuse
  const error = await expectRefusal("darwin", undefined);
  check("...names the host OS", error?.message.includes("darwin") ?? false, true);
  check("...next step names OC_TARGET_LOCATION=ssh", error?.nextAction.includes("OC_TARGET_LOCATION=ssh") ?? false, true);
}

finish("local-target-unsupported");
