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
  /** The checks' way to run a real Context against stubbed answers instead of building
   *  one from .env's OC_TARGET_LOCATION. */
  transport?: Transport;
}

/** The .env on disk layered under the application's own computed settings — the one way
 *  both process startup and any later re-derivation build Settings, so the two can never
 *  disagree about what the application contributes. */
async function buildSettings(options: ContextOptions): Promise<Settings> {
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
  return toSettings({ ...extra, ...base });
}

const creationRecords = new WeakMap<Context, { options: ContextOptions; service: { name: string; logTail?: string } }>();

export async function createContext(options: ContextOptions = {}): Promise<Context> {
  const config = await buildSettings(options);
  // Registered here rather than where it is generated: every entry point builds a context,
  // and a failing child process is reported with its whole command line.
  registerSecret(config.env.OPENCLAW_GATEWAY_TOKEN);
  // Optional, and read from this same .env rather than a separate file: an instance that
  // already exists under a compose project name the deployment directory itself cannot use
  // (Docker allows underscores, safeName does not) is managed under its real name instead
  // of being forced to rename.
  useComposeProjectOverride(config.env.OC_COMPOSE_PROJECT === "" ? undefined : config.env.OC_COMPOSE_PROJECT);
  const transport = options.transport ?? await createTransport({
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
    reconcileSettings: () => buildSettings(options),
  });

  const baseContext = { settings: config, transport, paths, runtime };
  let context: Context;
  context = {
    ...baseContext,
    ...(options.secrets === undefined
      ? {}
      : { applicationSecrets: (): Promise<AppSecret[]> => options.secrets!(context) }),
  };
  creationRecords.set(context, { options, service });
  return context;
}

/** Which derived Settings fields constitute "a different deployment target" — the
 *  coordinates a lock is taken for and a plan is computed against. Values that merely
 *  carry secrets do not belong here: rotating one changes what runs, not what is run. */
const TARGET_FIELDS = ["dataDir", "gatewayPort", "bindAddress", "location", "wslDistro", "sshHost", "remotePath"] as const;

export interface ContextRefresh {
  readonly context: Context;
  /** Names of the .env entries whose values differ from the previous snapshot — names
   *  only, never values. */
  readonly changed: string[];
  /** Target coordinates that moved (e.g. "dataDir", "gatewayPort"). Non-empty means the
   *  rest of a run planned against the old coordinates must not continue under them:
   *  the plan and the instance lock were taken for the previous target. */
  readonly targetChanges: string[];
}

/** Re-derives a context from the deployment's .env as it is on disk NOW, for a run whose
 *  own steps rewrote that file (recover-env, secrets --apply). Settings are rebuilt the
 *  same way createContext builds them — the application's computed settings layered back
 *  on top, so a re-derivation cannot lose variables the app defines that .env does not
 *  carry. Transport and path bridge are reused: they depend only on coordinates that are
 *  part of the target identity, and a caller seeing a non-empty targetChanges must stop
 *  rather than continue on the returned context. Returns undefined for a context not
 *  built by createContext (hand-assembled ones carry no creation record and cannot be
 *  re-derived); callers treat that as "nothing to refresh", which keeps direct-command
 *  callers — and the checks driving them — on their own lifecycle. */
export async function refreshContext(previous: Context): Promise<ContextRefresh | undefined> {
  const creation = creationRecords.get(previous);
  if (creation === undefined) return undefined;
  const settings = await buildSettings(creation.options);
  // Same registration createContext makes: a token rotated on disk must be masked too.
  registerSecret(settings.env.OPENCLAW_GATEWAY_TOKEN);
  useComposeProjectOverride(settings.env.OC_COMPOSE_PROJECT === "" ? undefined : settings.env.OC_COMPOSE_PROJECT);

  const changed = [...new Set(
    [...Object.keys(previous.settings.env), ...Object.keys(settings.env)]
      .filter((name) => previous.settings.env[name] !== settings.env[name]),
  )].sort();

  const targetChanges: string[] = TARGET_FIELDS.filter(
    (field) => previous.settings[field] !== settings[field],
  );
  if ((previous.settings.env.OC_COMPOSE_PROJECT ?? "") !== (settings.env.OC_COMPOSE_PROJECT ?? "")) {
    targetChanges.push("composeProject");
  }

  // The path bridge is reused, which is only sound while the target is unchanged — a
  // target change is a stop, not a continue (targetChanges above).
  const runtime = new DockerRuntime(previous.transport, settings, previous.paths, {
    service: creation.service.name,
    logTail: creation.service.logTail,
    reconcileSettings: () => buildSettings(creation.options),
  });

  const baseContext = { settings, transport: previous.transport, paths: previous.paths, runtime };
  let context: Context;
  context = {
    ...baseContext,
    ...(creation.options.secrets === undefined
      ? {}
      : { applicationSecrets: (): Promise<AppSecret[]> => creation.options.secrets!(context) }),
  };
  creationRecords.set(context, { options: creation.options, service: creation.service });
  return { context, changed, targetChanges };
}
