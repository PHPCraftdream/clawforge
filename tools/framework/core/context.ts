// The object every command receives: configuration, the way to reach the target, the path
// bridge between coordinate systems, and the runtime that actually runs OpenClaw.
//
// Commands never construct any of these themselves — that is what keeps them free of any
// knowledge about WSL, SSH, Docker or Windows drive letters.

import { loadEnv, toSettings, monorepoRoot, type Env, type Settings } from "./env.ts";
import { registerSecret } from "./log.ts";
import { createTransport, WslTransport, SshTransport, type Transport } from "../runtime/transport.ts";
import { createPathBridge, type PathBridge, type MountPoint } from "./paths.ts";
import { DockerRuntime } from "../runtime/runtime-docker.ts";
import { useComposeProjectOverride } from "../runtime/deployment.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { AppSecret } from "./app.ts";

export interface Context {
  readonly settings: Settings;
  readonly transport: Transport;
  readonly paths: PathBridge;
  readonly runtime: Runtime;
  /** Application-owned requirements, evaluated against this context when needed. */
  readonly applicationSecrets?: () => Promise<AppSecret[]>;
}

/** The application supplies what the framework cannot know: how its container is laid out
 *  inside. Everything else is derived from the environment. */
export interface ContextOptions {
  mounts?: (dataDir: string) => MountPoint[];
  service?: { name: string; logTail?: string };
  settings?: (env: Env) => Record<string, string>;
  secrets?: (ctx: Context) => Promise<AppSecret[]>;
}

export async function createContext(options: ContextOptions = {}): Promise<Context> {
  const base = await loadEnv();
  // Application settings provide defaults for the parsed environment. Values explicitly
  // present in .env win, and derived settings are rebuilt from the merged environment.
  const extra = options.settings === undefined ? {} : options.settings({ ...base });
  if (typeof extra !== "object" || extra === null || Array.isArray(extra)) {
    throw new Error("application settings must be an object of strings");
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid application setting name: ${name}`);
    if (typeof value !== "string") throw new Error(`application setting ${name} must be a string`);
  }
  const config = toSettings({ ...extra, ...base });
  // Registered here rather than where it is generated: every entry point builds a context,
  // and a failing child process is reported with its whole command line.
  registerSecret(config.env.OPENCLAW_GATEWAY_TOKEN);
  // Optional, and read from this same .env rather than a separate file: an instance that
  // already exists under a compose project name the deployment directory itself cannot use
  // (Docker allows underscores, safeName does not) is managed under its real name instead
  // of being forced to rename.
  useComposeProjectOverride(config.env.OC_COMPOSE_PROJECT === "" ? undefined : config.env.OC_COMPOSE_PROJECT);
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

  const baseContext = { settings: config, transport, paths, runtime };
  let context: Context;
  context = {
    ...baseContext,
    ...(options.secrets === undefined
      ? {}
      : { applicationSecrets: (): Promise<AppSecret[]> => options.secrets!(context) }),
  };
  return context;
}
