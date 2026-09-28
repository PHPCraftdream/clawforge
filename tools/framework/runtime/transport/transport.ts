// Transport: how the tooling reaches the machine the instance lives on.
//
// This is the abstraction that lets the same code run from Windows, from WSL, or against a
// server. "Where our code executes" and "where the target lives" are different things:
// the Windows Node reaches a WSL target through wsl.exe, and nothing above this layer
// needs to know that.
//
// This file is the module's public entry point. The contract and every implementation live
// in their own files beside it — exec.ts (ExecOptions/ExecResult/Transport, spawnLocal),
// quoting.ts (shell quoting, remote staging scripts, existsVia), local.ts, wsl.ts, ssh.ts —
// and are re-exported here so nothing above this layer has to know the module was split, and
// this file stays the one place that assembles a Transport from a TransportConfig.
//
// Rule for everything built on top: never touch target files with node:fs directly. The
// target may not share a filesystem with us. Go through the transport.

import { die } from "../../core/io/log.ts";
import type { Transport } from "./exec.ts";
import { LocalTransport } from "./local.ts";
import { WslTransport } from "./wsl.ts";
import { SshTransport } from "./ssh.ts";

export type { ExecOptions, ExecResult, CommandFailure, Transport } from "./exec.ts";
export { spawnLocal, TransportUnreachableError, isWrapperFailureCode, toSignedExitCode } from "./exec.ts";
export { PRIVATE_STAGING_MARKER, PUBLISH_STAGING_MARKER, withEnvPrefix, existsVia } from "./quoting.ts";
export { LocalTransport } from "./local.ts";
export { WslTransport, stripWslNuls } from "./wsl.ts";
export { SshTransport } from "./ssh.ts";
export { listFilesVia } from "../../security/transport-listing.ts";
export { describeInvocation } from "./spawn-failure.ts";

export interface TransportConfig {
  location?: string;
  wslDistro?: string;
  sshHost?: string;
}

/** Picks the transport. "auto" means: Windows tooling reaches a WSL target, everything
 *  else is local. An explicit setting always wins. */
export async function createTransport(config: TransportConfig = {}): Promise<Transport> {
  const location = (config.location ?? "auto").toLowerCase();
  const distro = config.wslDistro ?? "Ubuntu-24.04";

  switch (location) {
    case "local":
      return new LocalTransport();
    case "wsl":
      return new WslTransport(distro);
    case "ssh": {
      const host = config.sshHost;
      if (host === undefined || host === "") {
        die("OC_TARGET_LOCATION=ssh requires OC_SSH_HOST (user@host)");
      }
      return new SshTransport(host);
    }
    case "auto":
      return process.platform === "win32" ? new WslTransport(distro) : new LocalTransport();
    default:
      return die(`unknown target location: ${location} (expected local, wsl, ssh or auto)`);
  }
}
