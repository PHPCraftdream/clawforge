// Compose invocation and the per-call environment file it needs. Settings can be replaced
// wholesale by reconcile(), so this class never caches them in a field of its own: every
// read and write goes through the accessors the caller supplies.

import { randomUUID } from "node:crypto";
import { composeFile, locksDir, toSettings, loadEnv, type Settings } from "../../core/env.ts";
import { deploymentDir, composeProjectName } from "../deployment.ts";
import { machineName, ownProcessStartedAt, localLiveness } from "../lock/process-identity.ts";
import type { PathBridge } from "../../core/paths.ts";
import type { ExecResult, Transport } from "../transport/transport.ts";
import { NotBootstrapped, type RunOneOffOptions } from "../runtime.ts";

/** Removes `compose-*` directories a PAST call to `withEnvFile` left behind (a crash between
 *  mkdir and this method's finally block). Only ones provably abandoned: owner.json naming
 *  this machine, with a pid provably gone. Best-effort: a failure here must never block the
 *  real compose call that follows. */
async function sweepStaleComposeEnvs(transport: Transport, directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await transport.listFiles(directory);
  } catch {
    return;
  }
  const names = new Set(
    entries
      .map((entry) => entry.split("/")[0] ?? "")
      .filter((name) => /^compose-[0-9a-f-]+$/.test(name)),
  );
  for (const name of names) {
    const path = `${directory}/${name}`;
    let owner: { pid?: unknown; machine?: unknown; startedAt?: unknown } | undefined;
    try {
      owner = JSON.parse(await transport.readFile(`${path}/owner.json`)) as typeof owner;
    } catch {
      continue; // Unreadable or missing: cannot prove this run is gone, so it is left alone.
    }
    if (typeof owner !== "object" || owner === null) continue;
    if (typeof owner.machine !== "string" || owner.machine !== machineName() || typeof owner.pid !== "number") continue;
    const liveness = await localLiveness({
      pid: owner.pid,
      machine: owner.machine,
      startedAt: typeof owner.startedAt === "string" ? owner.startedAt : undefined,
    });
    if (liveness !== "dead") continue;
    await transport.remove(path).catch(() => {});
  }
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

/** Runs `docker compose` for one service, with the per-call env-file plumbing (`withEnvFile`,
 *  `compose`) that every invocation needs. Settings are read/written through accessors:
 *  reconcile() replaces the whole object, and every caller must see it immediately. */
export class ComposeOperations {
  #transport: Transport;
  #getSettings: () => Settings;
  #setSettings: (settings: Settings) => void;
  #paths: PathBridge;
  #service: string;
  #logTail: string;
  #reconcileSettings?: () => Promise<Settings>;

  constructor(
    transport: Transport,
    getSettings: () => Settings,
    setSettings: (settings: Settings) => void,
    paths: PathBridge,
    service: string,
    logTail: string,
    reconcileSettings: (() => Promise<Settings>) | undefined,
  ) {
    this.#transport = transport;
    this.#getSettings = getSettings;
    this.#setSettings = setSettings;
    this.#paths = paths;
    this.#service = service;
    this.#logTail = logTail;
    this.#reconcileSettings = reconcileSettings;
  }

  /** Supplies one operation's environment by file and removes it on completion. Defaults to
   *  the settings this runtime was built with; reconcile() hands in fresh ones read from
   *  disk. Public: helper-container and side-stack callers share this exact plumbing. */
  async withEnvFile<T>(
    action: (path: string) => Promise<T>,
    settings: Settings = this.#getSettings(),
  ): Promise<T> {
    const directory = locksDir(settings.dataDir);
    const privateDirectory = `${directory}/compose-${randomUUID()}`;
    const path = `${privateDirectory}/compose.env`;
    const ownerPath = `${privateDirectory}/owner.json`;
    const owner = JSON.stringify({ pid: process.pid, machine: machineName(), startedAt: ownProcessStartedAt() });
    const body = serializeComposeEnv(settings.env);
    let cleanupNeeded = false;
    let operationFailed = false;
    let operationError: unknown;
    let cleanupError: unknown;
    let result!: T;
    try {
      try {
        await this.#transport.mkdirp(directory);
      } catch (error) {
        // A missing data directory means nobody bootstrapped this deployment; the sibling
        // "-locks" directory shares that parent. Any other failure propagates as-is.
        if (!(await this.#transport.exists(settings.dataDir))) {
          throw new NotBootstrapped(settings.dataDir);
        }
        throw error;
      }
      await sweepStaleComposeEnvs(this.#transport, directory);
      // Keep file creation private even before writeFile applies its mode.
      await this.#transport.exec("mkdir", ["-m", "700", privateDirectory]);
      cleanupNeeded = true;
      // Owner recorded before the token-bearing file: a crash between these two writes still
      // leaves owner.json in place, which the sweep above needs.
      await this.#transport.writeFile(ownerPath, owner, "600");
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
    // Project directory is the deployment's, so two deployments sharing a definition stay
    // separate. Project name is stated rather than left to compose, or they'd share
    // containers/networks/volumes. --env-file REPLACES the project directory's own .env, so
    // the file written above carries the whole environment, not just the secret part.
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

  // Failures propagate by default: only the read-only queries below opt out, since "the
  // project doesn't exist yet" is an answer, not an error.
  async compose(
    args: string[],
    stream = false,
    allowFailure = false,
    settings: Settings = this.#getSettings(),
    beforeExec?: () => void,
  ): Promise<ExecResult> {
    return this.withEnvFile(async (envFile) => {
      const base = await this.#composeArgs(envFile);
      beforeExec?.();
      return this.#transport.exec("docker", [...base, ...args], {
        stream,
        allowFailure,
        unsetEnv: Object.keys(settings.env),
      });
    }, settings);
  }

  async start(): Promise<void> {
    await this.compose(["up", "--detach", this.#service], true);
  }

  async stop(extraArgs: string[] = []): Promise<void> {
    await this.compose(["--profile", "cli", "down", ...extraArgs], true);
  }

  async pause(): Promise<void> {
    await this.compose(["stop", this.#service], true);
  }

  /** Keeps the container — environment included, interpolated once at creation: an edited
   *  .env needs reconcile(), an edited bind-mounted file is exactly what this is for. */
  async restart(): Promise<void> {
    await this.compose(["restart", this.#service], true);
  }

  /** `up` against the deployment .env as it is on disk NOW, not this process's start-time
   *  snapshot. The fresh settings are then kept: a later compose call with the old ones would
   *  make compose recreate the service with them (a rotated token silently reverted). */
  async reconcile(): Promise<void> {
    const current = this.#reconcileSettings !== undefined
      ? await this.#reconcileSettings()
      : toSettings(await loadEnv());
    await this.compose(["up", "--detach", this.#service], true, false, current);
    this.#setSettings(current);
  }

  async followLogs(extraArgs: string[] = []): Promise<void> {
    await this.compose(["logs", "--follow", "--tail", this.#logTail, this.#service, ...extraArgs], true);
  }

  /** No --follow, and captured rather than streamed: the caller wants the text back, not a
   *  stream on the terminal. */
  async readLogs(tail: string | undefined, extraArgs: string[] = []): Promise<string> {
    const result = await this.compose(["logs", "--tail", tail ?? this.#logTail, this.#service, ...extraArgs]);
    return result.stdout;
  }

  async showStatus(): Promise<void> {
    await this.compose(["ps"], true);
  }

  async pullImage(): Promise<void> {
    await this.compose(["pull", this.#service], true);
  }

  async isRunning(): Promise<boolean> {
    const result = await this.compose(["ps", "--quiet", this.#service], false, true);
    if (result.code !== 0) {
      throw new Error(`could not determine whether service "${this.#service}" is running: ${result.stderr.trim() || `docker compose ps exited ${result.code}`}`);
    }
    return result.stdout.trim() !== "";
  }

  /** Recreate on a digest and keep that image in this runtime's transient settings for
   *  subsequent validation and start calls. The deployment's durable .env stays untouched. */
  async recreateWithImage(reference: string, onMutationStart?: () => void): Promise<void> {
    const current = this.#reconcileSettings !== undefined ? await this.#reconcileSettings() : toSettings(await loadEnv());
    const target = { ...current, image: reference, env: { ...current.env, OPENCLAW_IMAGE: reference } };
    await this.compose(["up", "--detach", this.#service], true, false, target, () => {
      this.#setSettings(target);
      onMutationStart?.();
    });
  }

  /** `-T` is added whenever our stdout is not a terminal: compose otherwise allocates a
   *  pseudo-TTY, and a TTY does not survive the trip through wsl.exe — the command
   *  succeeds while its output vanishes. */
  async runOneOff(service: string, args: string[], options: RunOneOffOptions = {}): Promise<ExecResult> {
    const prefix: string[] = [];
    if (options.profile !== undefined) prefix.push("--profile", options.profile);

    const runArgs = ["run", "--rm"];
    if (options.stdioProtocol === true || process.stdout.isTTY !== true) runArgs.push("-T");
    if (options.noDeps === true) runArgs.push("--no-deps");
    if (options.entrypoint !== undefined) runArgs.push("--entrypoint", options.entrypoint);

    return this.withEnvFile(async (envFile) => {
      const base = await this.#composeArgs(envFile);
      return this.#transport.exec("docker", [...base, ...prefix, ...runArgs, service, ...args], {
        stream: options.input === undefined,
        input: options.input,
        stdioProtocol: options.stdioProtocol,
        allowFailure: options.allowFailure,
        unsetEnv: Object.keys(this.#getSettings().env),
      });
    });
  }
}
