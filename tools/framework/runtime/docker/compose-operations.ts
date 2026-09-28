// Compose invocation and the per-call environment file it needs — DockerRuntime's single
// largest responsibility, split out of runtime-docker.ts to keep that file orchestration-only.
// Settings can be replaced wholesale by reconcile(), so this class never caches them in a
// field of its own: every read and write goes through the accessors the caller supplies,
// which is the same Settings the constructing DockerRuntime instance holds.

import { randomUUID } from "node:crypto";
import { composeFile, locksDir, toSettings, loadEnv, type Settings } from "../../core/env.ts";
import { deploymentDir, composeProjectName } from "../deployment.ts";
import { machineName, ownProcessStartedAt, sweepStaleComposeEnvs } from "../../security/instance-mutation-guard.ts";
import type { PathBridge } from "../../core/paths.ts";
import type { ExecResult, Transport } from "../transport/transport.ts";
import { NotBootstrapped, type RunOneOffOptions } from "../runtime.ts";

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

/** Runs `docker compose` for one service against the deployment's own compose file, with the
 *  per-call env-file plumbing (`withEnvFile`, `compose`) that every compose invocation needs —
 *  the runtime's own env-file for a helper container start, a side stack's, a one-off run.
 *  Settings are read and written through accessors rather than a field: reconcile() replaces
 *  the whole object, and every other caller must see that replacement immediately. */
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

  /** Supplies one operation's environment by file and removes it on completion. Defaults
   *  to the settings this runtime was built with; reconcile() is the one caller that hands
   *  in fresh ones read from disk. Public: the helper-container and side-stack callers share
   *  this exact plumbing rather than each opening their own env-file. */
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
        // Distinguished from every other reason this mkdir can fail: a data directory that
        // genuinely does not exist means nobody ever bootstrapped this deployment, and the
        // sibling "-locks" directory this call is trying to create shares that parent — the
        // exact write a still-root-owned parent refuses. Anything else (the parent exists,
        // but permissions or disk space are wrong for some other reason) is a real failure
        // and propagates as before.
        if (!(await this.#transport.exists(settings.dataDir))) {
          throw new NotBootstrapped(settings.dataDir);
        }
        throw error;
      }
      await sweepStaleComposeEnvs(this.#transport, directory);
      // Keep file creation private even before writeFile applies its mode.
      await this.#transport.exec("mkdir", ["-m", "700", privateDirectory]);
      cleanupNeeded = true;
      // Owner recorded before the token-bearing file, not after: a crash between these two
      // writes then leaves owner.json in place, which is exactly what the sweep above needs
      // to prove the directory abandoned on a later run rather than leave it unowned forever.
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

  // Failures propagate by default: only the read-only queries below opt out, because
  // "the project does not exist yet" is an answer, not an error. Public: the helper-container
  // group runs startHelper/stopHelper/helperRunning through this same entry point.
  async compose(
    args: string[],
    stream = false,
    allowFailure = false,
    settings: Settings = this.#getSettings(),
  ): Promise<ExecResult> {
    return this.withEnvFile(async (envFile) => {
      const base = await this.#composeArgs(envFile);
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
   *  snapshot (secrets --apply and incident rewrite .env, then call this). A settings builder,
   *  when supplied, layers the app's computed settings over the fresh read, as the context does.
   *  The fresh settings are then kept: a later compose call with the old ones would make
   *  compose recreate the service with them (a rotated token silently reverted). */
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

  /** reconcile(), pinned to a digest for this one call — compose pulls it, .env stays untouched. */
  async recreateWithImage(reference: string): Promise<void> {
    const current = this.#reconcileSettings !== undefined ? await this.#reconcileSettings() : toSettings(await loadEnv());
    await this.compose(
      ["up", "--detach", this.#service],
      true,
      false,
      { ...current, image: reference, env: { ...current.env, OPENCLAW_IMAGE: reference } },
    );
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

    return this.withEnvFile(async (envFile) => {
      const base = await this.#composeArgs(envFile);
      return this.#transport.exec("docker", [...base, ...prefix, ...runArgs, service, ...args], {
        stream: options.input === undefined,
        input: options.input,
        allowFailure: options.allowFailure,
        unsetEnv: Object.keys(this.#getSettings().env),
      });
    });
  }
}
