// The object every command receives: configuration, the way to reach the target, the path
// bridge between coordinate systems, and the runtime that actually runs OpenClaw.
//
// Commands never construct any of these themselves — that is what keeps them free of any
// knowledge about WSL, SSH, Docker or Windows drive letters.

import { settings, monorepoRoot, type Settings } from "./env.ts";
import { registerSecret } from "./log.ts";
import { createTransport, WslTransport, SshTransport, type Transport } from "./transport.ts";
import { createPathBridge, type PathBridge, type MountPoint } from "./paths.ts";
import { DockerRuntime } from "./runtime-docker.ts";
import type { Runtime } from "./runtime.ts";

export interface Context {
  readonly settings: Settings;
  readonly transport: Transport;
  readonly paths: PathBridge;
  readonly runtime: Runtime;
}

/** The application supplies what the framework cannot know: how its container is laid out
 *  inside. Everything else is derived from the environment. */
export interface ContextOptions {
  mounts?: (dataDir: string) => MountPoint[];
  service?: { name: string; logTail?: string };
}

export async function createContext(options: ContextOptions = {}): Promise<Context> {
  const config = await settings();
  // Registered here rather than where it is generated: every entry point builds a context,
  // and a failing child process is reported with its whole command line.
  registerSecret(config.env.OPENCLAW_GATEWAY_TOKEN);
  const transport = await createTransport({
    location: config.location,
    wslDistro: config.wslDistro,
    sshHost: config.sshHost,
  });

  const kind = transport instanceof WslTransport
    ? "wsl"
    : transport instanceof SshTransport
      ? "ssh"
      : "local";

  const paths = await createPathBridge({
    readFile: (path) => transport.readFile(path),
    mounts: options.mounts?.(config.dataDir) ?? [],
    kind,
    distro: transport instanceof WslTransport ? transport.distro : undefined,
    localRepo: monorepoRoot,
    remoteRepo: config.remotePath,
  });

  // Docker is the only runtime today; the contract exists so a native one could be added
  // without touching a single command.
  const service = options.service ?? { name: "app" };
  const runtime = new DockerRuntime(transport, config, paths, {
    service: service.name,
    logTail: service.logTail,
  });

  return { settings: config, transport, paths, runtime };
}
