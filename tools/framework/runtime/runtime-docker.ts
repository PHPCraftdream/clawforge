// Docker implementation of the runtime contract.
//
// The only module that knows the words "docker" and "compose". It takes the transport,
// settings and path bridge directly rather than a Context, so the context can build it
// without a circular import.

import { composeFile, locksDir, type Settings } from "../core/env.ts";
import { deploymentDir, composeProjectName } from "./deployment.ts";
import type { PathBridge } from "../core/paths.ts";
import type { ExecResult, Transport } from "./transport.ts";
import { HelperNotRunning, type Runtime, type RunOneOffOptions, type Stack } from "./runtime.ts";

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
}

export class DockerRuntime implements Runtime {
  readonly description = "docker";
  readonly requiredTools = ["docker"];

  #transport: Transport;
  #settings: Settings;
  #paths: PathBridge;
  #service: string;
  #logTail: string;
  #envFilePromise: Promise<string> | undefined;

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
  }

  /** The deployment's environment, in a file on the target that compose reads itself.
   *
   *  It used to travel as `env VAR=value … docker compose …`, which put
   *  OPENCLAW_GATEWAY_TOKEN in the target's process list and shell history for the duration
   *  of every container command — and the longest-running commands (`up`, `logs --follow`,
   *  the MCP bridge) held it there longest. A file referenced by path shows a path.
   *
   *  Written once per process: settings do not change inside one context, and a write per
   *  compose call would be a round trip per call. Mode 600, in the framework's own directory
   *  beside the data directory — not inside it, which `restore` replaces wholesale.
   *
   *  A failure here is not worked around. Falling back to the command line would put the
   *  token back where this exists to remove it, quietly, on exactly the hosts where writing
   *  a file failed for a reason worth knowing. */
  async #envFileOnTarget(): Promise<string> {
    this.#envFilePromise ??= this.#writeEnvFile();
    return this.#envFilePromise;
  }

  async #writeEnvFile(): Promise<string> {
    const directory = locksDir(this.#settings.dataDir);
    const path = `${directory}/compose.env`;

    // compose's env-file parser is line-oriented; a value with a newline in it would read as
    // a new assignment. Named, never printed: these values are the credentials themselves.
    const broken = Object.entries(this.#settings.env)
      .filter(([, value]) => value.includes("\n"))
      .map(([name]) => name);
    if (broken.length > 0) {
      throw new Error(`cannot pass ${broken.join(", ")} to compose: a value containing a newline cannot be written to an env file`);
    }

    const body = Object.entries(this.#settings.env)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n");

    try {
      await this.#transport.mkdirp(directory);
      await this.#transport.writeFile(path, `${body}\n`, "600");
    } catch (error) {
      throw new Error(`could not write the compose environment to ${path}: ${(error as Error).message}`);
    }
    return path;
  }

  /** Compose needs the file and project directory in the target's coordinates: the tooling
   *  may be on Windows while compose runs inside WSL. */
  async #composeArgs(): Promise<string[]> {
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
    const [file, projectDir, envFileOnTarget] = await Promise.all([
      this.#paths.toTarget(composeFile),
      this.#paths.toTarget(deploymentDir()),
      this.#envFileOnTarget(),
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
  async #compose(args: string[], stream = false, allowFailure = false): Promise<ExecResult> {
    const base = await this.#composeArgs();
    return this.#transport.exec("docker", [...base, ...args], { stream, allowFailure });
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

  async restart(): Promise<void> {
    await this.#compose(["restart", this.#service], true);
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
   *  does not survive the trip through wsl.exe.
   *
   *  "node dist/index.js" is hardcoded rather than taken from options: it is the `cli`
   *  service's own entrypoint (see docker-compose.yml), which `docker exec` does not apply
   *  on its own the way `compose run` does. */
  async execInHelper(
    service: string,
    args: string[],
    options: { input?: string; allowFailure?: boolean } = {},
  ): Promise<ExecResult> {
    const result = await this.#compose(["ps", "--quiet", service], false, true);
    const id = result.stdout.trim().split("\n")[0]?.trim();
    if (id === undefined || id === "") {
      throw new HelperNotRunning(service);
    }

    const execArgs = ["exec", "-i"];
    if (process.stdout.isTTY === true) execArgs.push("-t");
    return this.#transport.exec("docker", [...execArgs, id, "node", "dist/index.js", ...args], {
      stream: options.input === undefined,
      input: options.input,
      allowFailure: options.allowFailure,
    });
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

    const base = await this.#composeArgs();
    return this.#transport.exec("docker", [...base, ...prefix, ...runArgs, service, ...args], {
      stream: options.input === undefined,
      input: options.input,
      allowFailure: options.allowFailure,
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
    const envFileOnTarget = (): Promise<string> => this.#envFileOnTarget();

    const compose = async (args: string[], stream = true): Promise<ExecResult> => {
      // The definition lives in our checkout; compose runs on the target.
      //
      // Same environment file as the main stack, for the same reason: a recipe's variables
      // are declared in recipe.json and supplied from the deployment's .env (recipe.ts
      // refuses to install one whose variables are not set there), so this is the environment
      // a side stack is entitled to — and none of it belongs on the target's command line.
      const [file, envFile] = await Promise.all([paths.toTarget(definitionPath), envFileOnTarget()]);
      const directory = file.slice(0, file.lastIndexOf("/"));
      return transport.exec(
        "docker",
        ["compose", "--env-file", envFile, "--project-name", project, "--file", file, "--project-directory", directory, ...args],
        { stream },
      );
    };

    const voidly = async (args: string[]): Promise<void> => {
      await compose(args);
    };

    return {
      build: () => voidly(["build"]),
      up: () => voidly(["up", "--detach"]),
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
        return result.code === 0 && result.stdout.trim() !== "";
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
