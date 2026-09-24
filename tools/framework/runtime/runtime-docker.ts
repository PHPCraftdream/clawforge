// Docker implementation of the runtime contract.
//
// The only module that knows the words "docker" and "compose". It takes the transport,
// settings and path bridge directly rather than a Context, so the context can build it
// without a circular import.

import { randomUUID } from "node:crypto";
import { composeFile, locksDir, toSettings, loadEnv, type Settings } from "../core/env.ts";
import { deploymentDir, composeProjectName } from "./deployment.ts";
import type { PathBridge } from "../core/paths.ts";
import type { ExecResult, Transport } from "./transport.ts";
import { HelperNotRunning, type Runtime, type RunOneOffOptions, type Stack, type StackServiceState } from "./runtime.ts";

/** Which service this runtime operates. Supplied by the application: the framework has no
 *  opinion about what the managed service is called.
 *
 *  There is no container name here on purpose — the container is found through the compose
 *  project, so two deployments of the same definition cannot answer for each other. */
export interface DockerRuntimeOptions {
  /** Compose service name, e.g. "gateway". */
  readonly service: string;
  /** How many log lines to show by default. */
  readonly logTail?: string;
  /** Builds the Settings a recreate interpolates, re-reading .env at call time and
   *  layering the application's computed settings back on top — the way the context
   *  itself builds them. Without it reconcile() falls back to a bare .env re-read,
   *  which silently drops app-computed Compose variables that .env does not carry. */
  readonly reconcileSettings?: () => Promise<Settings>;
}

/** Detects control characters unsupported by the env-file serializer. */
function hasUnsupportedControls(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9) || code === 127) return true;
  }
  return false;
}

/** Encodes values as literal double-quoted Compose env-file entries. */
export function serializeComposeEnv(env: Record<string, string>): string {
  const entries = Object.entries(env);
  const invalidNames = entries.filter(([name]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).map(([name]) => name);
  if (invalidNames.length > 0) throw new Error(`invalid environment variable name: ${invalidNames.join(", ")}`);
  const invalidValues = entries
    .filter(([, value]) => typeof value !== "string" || hasUnsupportedControls(value))
    .map(([name]) => name);
  if (invalidValues.length > 0) {
    throw new Error(`cannot pass ${invalidValues.join(", ")} to compose: a value contains an unsupported control character`);
  }
  return entries
    .map(([name, value]) => `${name}=${JSON.stringify(value).replaceAll("$", "$$$$")}`)
    .join("\n") + "\n";
}

/** Parses `compose ps --format json`: one JSON object per line for multiple containers, a
 *  single bare object for one, and empty for none. A line that fails to parse is dropped
 *  rather than failing the whole read — readiness treats an unparsable/missing entry for a
 *  required service the same as one compose never reported at all. */
function parseComposePs(stdout: string): Array<{ Service?: unknown; State?: unknown; Health?: unknown }> {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as Array<{ Service?: unknown; State?: unknown; Health?: unknown }>;
    if (parsed !== null && typeof parsed === "object") return [parsed as { Service?: unknown; State?: unknown; Health?: unknown }];
  } catch {
    // Not one JSON value — try newline-delimited below.
  }
  const entries: Array<{ Service?: unknown; State?: unknown; Health?: unknown }> = [];
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      entries.push(JSON.parse(text) as { Service?: unknown; State?: unknown; Health?: unknown });
    } catch {
      // Skipped: a single malformed line must not hide the services compose did report.
    }
  }
  return entries;
}

/** The replica-aggregated health for one service: a defined non-healthy verdict from any
 *  replica fails the service, a healthy one only holds when no replica reports otherwise,
 *  and a replica with no health opinion at all neither passes nor fails the aggregate. */
function worstHealth(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (left === "healthy") return right;
  if (right === "healthy") return left;
  return left;
}

export class DockerRuntime implements Runtime {
  readonly description = "docker";
  readonly requiredTools = ["docker"];

  #transport: Transport;
  #settings: Settings;
  #paths: PathBridge;
  #service: string;
  #logTail: string;
  #reconcileSettings?: () => Promise<Settings>;

  constructor(
    transport: Transport,
    settings: Settings,
    paths: PathBridge,
    options: DockerRuntimeOptions,
  ) {
    this.#transport = transport;
    this.#settings = settings;
    this.#paths = paths;
    this.#service = options.service;
    this.#logTail = options.logTail ?? "100";
    this.#reconcileSettings = options.reconcileSettings;
  }

  /** Supplies one operation's environment by file and removes it on completion. Defaults
   *  to the settings this runtime was built with; reconcile() is the one caller that hands
   *  in fresh ones read from disk. */
  async #withEnvFile<T>(action: (path: string) => Promise<T>, settings: Settings = this.#settings): Promise<T> {
    const directory = locksDir(settings.dataDir);
    const privateDirectory = `${directory}/compose-${randomUUID()}`;
    const path = `${privateDirectory}/compose.env`;
    const body = serializeComposeEnv(settings.env);
    let cleanupNeeded = false;
    let operationFailed = false;
    let operationError: unknown;
    let cleanupError: unknown;
    let result!: T;
    try {
      await this.#transport.mkdirp(directory);
      // Keep file creation private even before writeFile applies its mode.
      await this.#transport.exec("mkdir", ["-m", "700", privateDirectory]);
      cleanupNeeded = true;
      await this.#transport.writeFile(path, body, "600");
      result = await action(path);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    } finally {
      if (cleanupNeeded) {
        try {
          await this.#transport.remove(privateDirectory);
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    if (operationFailed) throw operationError;
    if (cleanupError !== undefined) {
      throw new Error(`could not remove the temporary compose environment: ${(cleanupError as Error).message}`);
    }
    return result;
  }

  /** Compose needs the file and project directory in the target's coordinates: the tooling
   *  may be on Windows while compose runs inside WSL. */
  async #composeArgs(envFileOnTarget: string): Promise<string[]> {
    // The service definition is shared, but the project directory is the deployment's, so two
    // deployments running the same definition stay separate.
    //
    // The project name is the deployment's, stated rather than left to compose: it would
    // otherwise come from COMPOSE_PROJECT_NAME in the project's .env, and two deployments
    // copied from the same template would share containers, networks and volumes.
    //
    // --env-file REPLACES the project directory's own .env rather than adding to it (checked
    // against compose v5: a variable only that .env defines comes out unset). That is why the
    // file written above carries the whole environment and not just the secret part of it —
    // and it is an improvement for a remote target, where the deployment directory, and the
    // .env in it, is not necessarily on the machine compose runs on at all.
    const [file, projectDir] = await Promise.all([
      this.#paths.toTarget(composeFile),
      this.#paths.toTarget(deploymentDir()),
    ]);
    return [
      "compose",
      "--env-file",
      envFileOnTarget,
      "--project-name",
      composeProjectName(),
      "--file",
      file,
      "--project-directory",
      projectDir,
    ];
  }

  /** The service's container id, or undefined when it does not exist. Asked of compose
   *  rather than matched by name: `docker ps --filter name=x` is a substring match, so a
   *  second deployment's container answers for the first. */
  async #containerId(): Promise<string | undefined> {
    const result = await this.#compose(["ps", "--quiet", "--all", this.#service], false, true);
    const id = result.stdout.trim().split("\n")[0]?.trim();
    return id === undefined || id === "" ? undefined : id;
  }

  // Failures propagate by default: only the read-only queries below opt out, because
  // "the project does not exist yet" is an answer, not an error.
  async #compose(args: string[], stream = false, allowFailure = false, settings: Settings = this.#settings): Promise<ExecResult> {
    return this.#withEnvFile(async (envFile) => {
      const base = await this.#composeArgs(envFile);
      return this.#transport.exec("docker", [...base, ...args], {
        stream,
        allowFailure,
        unsetEnv: Object.keys(settings.env),
      });
    }, settings);
  }

  async start(): Promise<void> {
    await this.#compose(["up", "--detach", this.#service], true);
  }

  async stop(extraArgs: string[] = []): Promise<void> {
    await this.#compose(["--profile", "cli", "down", ...extraArgs], true);
  }

  async pause(): Promise<void> {
    await this.#compose(["stop", this.#service], true);
  }

  /** Keeps the container — environment included, interpolated once at creation: an edited
   *  .env needs reconcile(), an edited bind-mounted file is exactly what this is for. */
  async restart(): Promise<void> {
    await this.#compose(["restart", this.#service], true);
  }

  /** `up` against the deployment .env as it is on disk NOW. start() would interpolate the
   *  env snapshot this process was built from — the values the operator is rotating away
   *  from when secrets --apply rewrites .env and then calls this in the same breath — and
   *  compose would then converge on the stale container instead of recreating it. With a
   *  settings builder supplied, the rebuild is layered: the application's computed settings
   *  are applied on top of the fresh .env read, the way the context itself builds them. */
  async reconcile(): Promise<void> {
    const current = this.#reconcileSettings !== undefined
      ? await this.#reconcileSettings()
      : toSettings(await loadEnv());
    await this.#compose(["up", "--detach", this.#service], true, false, current);
  }

  async followLogs(extraArgs: string[] = []): Promise<void> {
    await this.#compose(["logs", "--follow", "--tail", this.#logTail, this.#service, ...extraArgs], true);
  }

  /** No --follow, and captured rather than streamed: the caller wants the text back, not a
   *  stream on the terminal. */
  async readLogs(tail?: string, extraArgs: string[] = []): Promise<string> {
    const result = await this.#compose(["logs", "--tail", tail ?? this.#logTail, this.#service, ...extraArgs]);
    return result.stdout;
  }

  async showStatus(): Promise<void> {
    await this.#compose(["ps"], true);
  }

  async pullImage(): Promise<void> {
    await this.#compose(["pull", this.#service], true);
  }

  async isRunning(): Promise<boolean> {
    const result = await this.#compose(["ps", "--quiet", this.#service], false, true);
    if (result.code !== 0) {
      throw new Error(`could not determine whether service "${this.#service}" is running: ${result.stderr.trim() || `docker compose ps exited ${result.code}`}`);
    }
    return result.stdout.trim() !== "";
  }

  async health(): Promise<string> {
    const id = await this.#containerId();
    if (id === undefined) return "missing";

    const result = await this.#transport.exec(
      "docker",
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", id],
      { allowFailure: true },
    );
    return result.code === 0 ? result.stdout.trim() : "missing";
  }

  /** Refuses to start when the published port already belongs to another compose project.
   *  Compose would otherwise fail with a bind error naming only the port, and the usual
   *  cause is a second deployment copied from the same template. */
  async portConflict(port: string): Promise<string | undefined> {
    const result = await this.#transport.exec(
      "docker",
      [
        "ps",
        "--filter",
        `publish=${port}`,
        "--format",
        // .Labels is a comma-joined string here, not a map: `index` on it fails and docker
        // exits non-zero. `.Label` is the accessor `docker ps` provides.
        '{{.Label "com.docker.compose.project"}}\t{{.Names}}',
      ],
      { allowFailure: true },
    );
    if (result.code !== 0) return undefined;

    for (const line of result.stdout.split("\n")) {
      const [project, container] = line.split("\t");
      if (container === undefined || container.trim() === "") continue;
      if (project === composeProjectName()) continue;
      return `${container.trim()} (compose project ${project === "" ? "none" : project})`;
    }
    return undefined;
  }

  async imageReference(): Promise<string | undefined> {
    const result = await this.#transport.exec(
      "docker",
      ["image", "inspect", "--format", "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}", this.#settings.image],
      { allowFailure: true },
    );
    const digest = result.stdout.trim();
    return result.code === 0 && digest !== "" ? digest : undefined;
  }

  async runningImageIdentity(): Promise<{ imageId: string; digests: string[]; version?: string; containerId: string } | undefined> {
    const containerId = await this.#containerId();
    if (containerId === undefined) return undefined;
    const container = await this.#transport.exec("docker", ["inspect", "--format", "{{json .}}", containerId], { allowFailure: true });
    if (container.code !== 0) return undefined;
    let state: { Image?: string; State?: { Running?: boolean } };
    try { state = JSON.parse(container.stdout); } catch { return undefined; }
    if (state?.State?.Running !== true || typeof state.Image !== "string") return undefined;
    const image = await this.#transport.exec("docker", ["image", "inspect", "--format", "{{json .}}", state.Image], { allowFailure: true });
    let metadata: { RepoDigests?: unknown; Config?: { Labels?: Record<string, string> } } = {};
    if (image.code === 0) {
      try { metadata = JSON.parse(image.stdout) ?? {}; } catch { /* Identity is still known. */ }
    }
    const digests = Array.isArray(metadata.RepoDigests) ? metadata.RepoDigests.filter((value): value is string => typeof value === "string") : [];
    const version = metadata.Config?.Labels?.["org.opencontainers.image.version"];
    return { imageId: state.Image, digests, containerId, ...(typeof version === "string" ? { version } : {}) };
  }

  /** Reads the container's OWN environment back from Docker rather than from any file this
   *  machine keeps — the container already has it, set once at creation from whatever .env
   *  compose read that day, and it lives on inside the container across restarts of THIS
   *  method's own caller even if the operator's copy is later lost. `docker inspect` is the
   *  same introspection imageReference()/runningImageIdentity() already use; nothing here
   *  reads more than an operator who can already reach this target could read directly. */
  async runningEnvironment(): Promise<Record<string, string> | undefined> {
    const containerId = await this.#containerId();
    if (containerId === undefined) return undefined;
    const result = await this.#transport.exec(
      "docker",
      ["inspect", "--format", "{{json .Config.Env}}", containerId],
      { allowFailure: true },
    );
    if (result.code !== 0) return undefined;
    let entries: unknown;
    try {
      entries = JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
    if (!Array.isArray(entries)) return undefined;
    const env: Record<string, string> = {};
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const split = entry.indexOf("=");
      if (split <= 0) continue;
      env[entry.slice(0, split)] = entry.slice(split + 1);
    }
    return env;
  }

  /** Reads the connection facts the running instance is actually reachable through. Compose
   *  resolved all of these from .env at container-creation time, so the values Docker holds
   *  are what reach the instance however stale the operator's own copy has become. One
   *  whole-object inspect, the same call runningImageIdentity() already makes; each field
   *  keeps its provenance: the config bind mount strips to the data dir, the published
   *  18789/tcp gives the port, Docker's own compose label — which portConflict() already
   *  reads — gives the project, and .Config.Image keeps the original tag where the top-level
   *  .Image is the resolved ID and would pin .env to a digest it never wrote. */
  async runningConnectionFacts(): Promise<
    { dataDir?: string; port?: string; composeProject?: string; image?: string } | undefined
  > {
    const containerId = await this.#containerId();
    if (containerId === undefined) return undefined;
    const result = await this.#transport.exec("docker", ["inspect", "--format", "{{json .}}", containerId], { allowFailure: true });
    if (result.code !== 0) return undefined;
    let parsed: {
      State?: { Running?: boolean };
      Mounts?: unknown;
      NetworkSettings?: { Ports?: Record<string, unknown> };
      Config?: { Labels?: Record<string, string>; Image?: unknown };
    };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
    if (parsed?.State?.Running !== true) return undefined;
    const facts: { dataDir?: string; port?: string; composeProject?: string; image?: string } = {};
    if (Array.isArray(parsed.Mounts)) {
      const mount = parsed.Mounts.find(
        (entry) =>
          typeof entry === "object" && entry !== null &&
          (entry as { Destination?: unknown }).Destination === "/home/node/.openclaw",
      );
      const source = typeof mount === "object" && mount !== null ? (mount as { Source?: unknown }).Source : undefined;
      // The config bind mount is "<dataDir>/config"; only a Source carrying that exact suffix
      // yields the data dir — any other shape stays absent rather than guessed.
      if (typeof source === "string" && source.endsWith("/config") && source.length > "/config".length) {
        facts.dataDir = source.slice(0, -"/config".length);
      }
    }
    const ports = parsed.NetworkSettings?.Ports?.["18789/tcp"];
    if (Array.isArray(ports)) {
      const hostPort = (ports[0] as { HostPort?: unknown } | undefined)?.HostPort;
      if (typeof hostPort === "string" && hostPort !== "") facts.port = hostPort;
    }
    const project = parsed.Config?.Labels?.["com.docker.compose.project"];
    if (typeof project === "string" && project !== "") facts.composeProject = project;
    const image = parsed.Config?.Image;
    if (typeof image === "string" && image !== "") facts.image = image;
    return facts;
  }

  async startedAt(): Promise<number | undefined> {
    const id = await this.#containerId();
    if (id === undefined) return undefined;

    const result = await this.#transport.exec(
      "docker",
      ["inspect", "--format", "{{.State.StartedAt}}", id],
      { allowFailure: true },
    );
    if (result.code !== 0) return undefined;

    // Docker prints RFC 3339 with nanoseconds, which Date happily truncates to
    // milliseconds. An unparseable value is reported as unknown rather than as epoch zero,
    // which would make every configuration file look newer than the instance.
    const parsed = Date.parse(result.stdout.trim());
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  async startHelper(service: string, profile: string): Promise<void> {
    await this.#compose(["--profile", profile, "up", "--detach", service], true);
  }

  async stopHelper(service: string, profile: string): Promise<void> {
    await this.#compose(["--profile", profile, "rm", "--force", "--stop", service], true);
  }

  async helperRunning(service: string): Promise<boolean> {
    const result = await this.#compose(["ps", "--quiet", service], false, true);
    return result.stdout.trim() !== "";
  }

  /** `-i` keeps stdin open — required for the MCP stdio bridge, harmless otherwise. `-t` is
   *  added only on a real terminal, mirroring the `-T` compose gets from `runOneOff`: a PTY
   *  does not survive the trip through wsl.exe. */
  async #execInContainer(
    service: string,
    command: string,
    args: string[],
    options: { input?: string; allowFailure?: boolean; timeoutMs?: number },
  ): Promise<ExecResult> {
    const result = await this.#compose(["ps", "--quiet", service], false, true);
    const id = result.stdout.trim().split("\n")[0]?.trim();
    if (id === undefined || id === "") {
      throw new HelperNotRunning(service);
    }

    const execArgs = ["exec", "-i"];
    if (process.stdout.isTTY === true) execArgs.push("-t");
    return this.#transport.exec("docker", [...execArgs, id, command, ...args], {
      stream: options.input === undefined,
      input: options.input,
      allowFailure: options.allowFailure,
      timeoutMs: options.timeoutMs,
    });
  }

  /** "node dist/index.js" is hardcoded rather than taken from options: it is the `cli`
   *  service's own entrypoint (see docker-compose.yml), which `docker exec` does not apply
   *  on its own the way `compose run` does. execCommand below is the same call with the
   *  entrypoint left to the caller, for everything that is not the app's own CLI. */
  async execInHelper(
    service: string,
    args: string[],
    options: { input?: string; allowFailure?: boolean; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return this.#execInContainer(service, "node", ["dist/index.js", ...args], options);
  }

  async execCommand(
    service: string,
    command: string,
    args: string[],
    options: { input?: string; allowFailure?: boolean; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return this.#execInContainer(service, command, args, options);
  }

  /** `-T` is added whenever our stdout is not a terminal: compose otherwise allocates a
   *  pseudo-TTY, and a TTY does not survive the trip through wsl.exe — the command
   *  succeeds while its output vanishes. */
  async runOneOff(service: string, args: string[], options: RunOneOffOptions = {}): Promise<ExecResult> {
    const prefix: string[] = [];
    if (options.profile !== undefined) prefix.push("--profile", options.profile);

    const runArgs = ["run", "--rm"];
    if (process.stdout.isTTY !== true) runArgs.push("-T");
    if (options.noDeps === true) runArgs.push("--no-deps");
    if (options.entrypoint !== undefined) runArgs.push("--entrypoint", options.entrypoint);

    return this.#withEnvFile(async (envFile) => {
      const base = await this.#composeArgs(envFile);
      return this.#transport.exec("docker", [...base, ...prefix, ...runArgs, service, ...args], {
        stream: options.input === undefined,
        input: options.input,
        allowFailure: options.allowFailure,
        unsetEnv: Object.keys(this.#settings.env),
      });
    });
  }

  /** Probed from the instance's side: the port is published on the target's loopback and
   *  may be unreachable from this machine. */
  async probe(endpoint: string, timeoutMs = 5000): Promise<number> {
    const url = `${this.#settings.serviceUrl}/${endpoint}`;
    const result = await this.#transport.exec(
      "curl",
      ["-fsS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", String(Math.ceil(timeoutMs / 1000)), url],
      { allowFailure: true },
    );
    const code = Number.parseInt(result.stdout.trim(), 10);
    return Number.isNaN(code) ? 0 : code;
  }

  /** A side stack: separate compose project, separate lifecycle. */
  stack(project: string, definitionPath: string): Stack {
    const transport = this.#transport;
    const paths = this.#paths;

    const compose = async (args: string[], stream = true): Promise<ExecResult> => {
      // The definition lives in our checkout; compose runs on the target.
      //
      // Same environment file as the main stack, for the same reason: a recipe's variables
      // are declared in recipe.json and supplied from the deployment's .env (recipe.ts
      // refuses to install one whose variables are not set there), so this is the environment
      // a side stack is entitled to — and none of it belongs on the target's command line.
      return this.#withEnvFile(async (envFile) => {
        const file = await paths.toTarget(definitionPath);
        const directory = file.slice(0, file.lastIndexOf("/"));
        return transport.exec(
          "docker",
          ["compose", "--env-file", envFile, "--project-name", project, "--file", file, "--project-directory", directory, ...args],
          { stream, unsetEnv: Object.keys(this.#settings.env) },
        );
      });
    };

    const voidly = async (args: string[]): Promise<void> => {
      await compose(args);
    };

    return {
      build: () => voidly(["build"]),
      up: (options) =>
        voidly([
          "up",
          "--detach",
          ...(options?.wait === true
            ? ["--wait", ...(options.timeoutSeconds !== undefined ? ["--wait-timeout", String(options.timeoutSeconds)] : [])]
            : []),
        ]),
      down: (removeVolumes = false) => voidly(["down", ...(removeVolumes ? ["--volumes"] : [])]),
      status: () => voidly(["ps"]),
      followLogs: () => voidly(["logs", "--follow", "--tail", "100"]),
      readLogs: async (tail: string) => (await compose(["logs", "--tail", tail], false)).stdout,
      isRunning: async () => {
        const result = await transport.exec(
          "docker",
          ["ps", "--quiet", "--filter", `label=com.docker.compose.project=${project}`],
          { allowFailure: true },
        );
        if (result.code !== 0) {
          throw new Error(`could not determine whether recipe stack "${project}" is running: ${result.stderr.trim() || `docker ps exited ${result.code}`}`);
        }
        return result.stdout.trim() !== "";
      },
      serviceStates: async () => {
        // --all: without it compose lists only running containers, and the recipe installer
        // derives the required set from this very response when a recipe declares none — a
        // crashed service absent from the listing would shrink the requirement set to
        // whichever sidecars happened to survive. (audit 2026-09-23, P2-09)
        const result = await compose(["ps", "--all", "--format", "json"], false).catch(() => undefined);
        if (result === undefined) return {};
        const states: Record<string, StackServiceState> = {};
        for (const entry of parseComposePs(result.stdout)) {
          if (typeof entry.Service !== "string" || entry.Service === "") continue;
          const running = entry.State === "running";
          const health = typeof entry.Health === "string" && entry.Health !== "" ? entry.Health : undefined;
          // Replicas of one service arrive as separate entries under the same name.
          // Requiring every replica to be running (and healthy, where a healthcheck
          // exists) keeps the last-enumerated replica from answering for its dead
          // siblings. A state that is not exactly "running" counts as not running, so
          // the caller reports the service by name instead of dropping it from the
          // requirement set.
          const existing = states[entry.Service];
          states[entry.Service] = existing === undefined
            ? { running, health }
            : { running: existing.running && running, health: worstHealth(existing.health, health) };
        }
        return states;
      },
    };
  }

  async waitForHealth(timeoutSeconds = 180): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if ((await this.probe("healthz")) === 200) return;
      if (!(await this.isRunning())) {
        throw new Error("the service container stopped while starting up — check ./clawforge logs");
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    }
    throw new Error(`the service did not become healthy within ${timeoutSeconds}s`);
  }
}
