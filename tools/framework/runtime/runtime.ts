// The runtime contract: what a command may ask of the thing that runs OpenClaw.
//
// Commands talk to this interface and never to Docker. Today there is exactly one
// implementation (Docker); a native installation would be a sibling file, and no command
// would change. That is the whole point of the indirection — it is checked by grepping the
// command files for "docker" and "compose".

import { die } from "../core/io/log.ts";
import type { ExecResult } from "./transport/transport.ts";
import type { Context } from "../core/context.ts";

/** Thrown by `execInHelper` when the helper container is not up, so callers can fall back
 *  to `runOneOff` without mistaking it for the command itself having failed. */
export class HelperNotRunning extends Error {
  constructor(service: string) {
    super(`no running helper for "${service}"`);
    this.name = "HelperNotRunning";
  }
}

/** Thrown by a read-only runtime query when the deployment's data directory doesn't exist on
 *  the target — a never-bootstrapped deployment. Every runtime call needs somewhere to write
 *  private files beside the data directory, and a still-root-owned parent refuses that mkdir
 *  pre-bootstrap. Callers that answer plainly (status, doctor, inspect) catch this. */
export class NotBootstrapped extends Error {
  constructor(dataDir: string) {
    super(`${dataDir} does not exist on the target — this deployment has never been bootstrapped`);
    this.name = "NotBootstrapped";
  }
}

/** The shared preflight for a command that mutates an EXISTING instance: refuses with
 *  NotBootstrapped's message before takeLock() runs. Commands that CREATE the instance
 *  (bootstrap, restore into an empty target, push, deploy) must never call this. */
export async function requireBootstrapped(ctx: Context): Promise<void> {
  try {
    await ctx.runtime.isRunning();
  } catch (error) {
    if (!(error instanceof NotBootstrapped)) throw error;
    die(`${error.message} — run ./clawforge bootstrap`);
  }
}

export interface RunOneOffOptions {
  /** Compose profile or equivalent grouping. */
  profile?: string;
  /** Skip dependencies — used when the service itself must not be started. */
  noDeps?: boolean;
  /** Override the entrypoint, e.g. to run `node dist/index.js …`. */
  entrypoint?: string;
  /** Feed stdin instead of inheriting it; also switches output to captured mode. */
  input?: string;
  /** Return a non-zero exit as a normal ExecResult instead of throwing. Needed by callers
   *  that must inspect the *full* stdout/stderr — the thrown-error path truncates detail to
   *  a few lines. */
  allowFailure?: boolean;
}

export interface Runtime {
  /** Human-readable name for diagnostics. */
  readonly description: string;
  /** Executables this runtime needs on the machine that hosts the service. Asked for when
   *  provisioning a new host, so applications do not have to name them. */
  readonly requiredTools: string[];

  /** Starts the instance in the background. */
  start(): Promise<void>;
  /** Stops and removes it; persistent data is untouched. */
  stop(extraArgs?: string[]): Promise<void>;
  /** Stops without removing — used to quiesce before a snapshot. */
  pause(): Promise<void>;
  /** Restarts the running instance in place, so it re-reads configuration it only loads at
   *  startup. Not start(): starting an already-healthy instance is a no-op for a bind-mount
   *  edit, since nothing the runtime compares (image, ports, environment) changed. */
  restart(): Promise<void>;
  /** Brings the instance in step with current configuration via compose recreate — restart()'s
   *  counterpart, which keeps the container as created. Environment is fixed at creation, so
   *  a changed .env value reaches the service only through this. Reads .env at call time, not
   *  the process's start-time snapshot. Optional: replaces the container, so a runtime that
   *  can't pay that cost leaves the decision to the operator. */
  reconcile?(): Promise<void>;
  /** Follows the log until interrupted. */
  followLogs(extraArgs?: string[]): Promise<void>;
  /** Reads the last `tail` lines. Bounded counterpart of followLogs, for a caller that
   *  cannot be interrupted. Omitting `tail` uses followLogs's default. */
  readLogs(tail?: string, extraArgs?: string[]): Promise<string>;
  /** Shows what is running. */
  showStatus(): Promise<void>;
  /** Fetches the image without starting anything. */
  pullImage(): Promise<void>;
  /** The digest a reference resolves to, read without pulling any layer or moving any local
   *  tag — a shared tag another deployment uses must not start pointing at different content
   *  just because this deployment checked it. Undefined when the registry can't be asked. */
  resolveImageDigest?(reference: string): Promise<string | undefined>;
  /** Recreates the service pinned to `reference` for this one call only — .env is read but
   *  never rewritten, so a rollback needs no undo of this step. */
  recreateWithImage?(reference: string): Promise<void>;
  /** The running (or last) container's own exit code, or undefined when unreadable — a
   *  migration exiting during startup is otherwise indistinguishable from one still starting. */
  lastExitCode?(): Promise<number | undefined>;

  /** True when the instance's main process is up. */
  isRunning(): Promise<boolean>;
  /** The runtime's own health verdict, separate from an HTTP probe: the two can disagree,
   *  and that disagreement has already caught a broken healthcheck here. */
  health(): Promise<string>;
  /** Identifier of the exact image in use, for reproducibility. */
  imageReference(): Promise<string | undefined>;
  /** The running container's image, independent of the configured tag. */
  runningImageIdentity?(): Promise<{ imageId: string; digests: string[]; version?: string; containerId: string } | undefined>;
  /** The running container's own environment — what it started with, not what this machine's
   *  .env currently says. A repo-env value injected once at creation lives on inside the
   *  container even if the operator's copy is later lost. Undefined when not introspectable. */
  runningEnvironment?(): Promise<Record<string, string> | undefined>;
  /** The running container's connection facts — plumbing values read back from Docker, so a
   *  stale .env is repairable from the instance still running. NOT a secret — safe to print.
   *  Undefined when not introspectable; an absent field means Docker's answer didn't carry it. */
  runningConnectionFacts?(): Promise<
    { dataDir?: string; port?: string; bindAddress?: string; composeProject?: string; image?: string } | undefined
  >;
  /** A log tail plus an env-redacted `docker inspect` dump of the container running right
   *  NOW — for incident evidence, captured before a caller mutates it. Undefined when
   *  there's nothing to snapshot. */
  captureIncidentSnapshot?(tail: string): Promise<{ logs: string; inspect: string } | undefined>;

  /** When the running instance started, as epoch milliseconds, or undefined when not running.
   *  The instance reads its configuration only at startup, so comparing this against the
   *  config file's timestamp is what makes a stale-but-running instance observable. */
  startedAt(): Promise<number | undefined>;

  /** Runs a throwaway container for `service`. */
  runOneOff(service: string, args: string[], options?: RunOneOffOptions): Promise<ExecResult>;

  /** Starts a long-lived helper container so `execInHelper` can exec into it instead of
   *  paying `runOneOff`'s per-call create/destroy cost (~5-7s one-off vs ~1-3s exec warm). */
  startHelper(service: string, profile: string): Promise<void>;
  /** Stops and removes the helper container started by `startHelper`. */
  stopHelper(service: string, profile: string): Promise<void>;
  /** True when the helper container for `service` exists and is running. */
  helperRunning(service: string): Promise<boolean>;
  /** Runs a command inside the already-running helper container for `service`. */
  execInHelper(
    service: string,
    args: string[],
    options?: { input?: string; allowFailure?: boolean; timeoutMs?: number },
  ): Promise<ExecResult>;
  /** The general form of execInHelper: any command, not just the app's own CLI entrypoint —
   *  for ad hoc diagnostics. Throws HelperNotRunning when not up. `options.timeoutMs` bounds
   *  the WHOLE call, so a wedged container/resolver/client can't stall past its budget. */
  execCommand?(
    service: string,
    command: string,
    args: string[],
    options?: { input?: string; allowFailure?: boolean; timeoutMs?: number },
  ): Promise<ExecResult>;

  /** Name of whatever already publishes `port` and does not belong to this deployment,
   *  or undefined when the port is free to bind. */
  portConflict(port: string): Promise<string | undefined>;

  /** Probes an unauthenticated service endpoint from the instance's own network. */
  probe(endpoint: string, timeoutMs?: number): Promise<number>;
  /** Polls until the service serves or the timeout expires. */
  waitForHealth(timeoutSeconds?: number): Promise<void>;

  /** Operates a side stack — deployed next to the instance but isolated, with its own
   *  project name. Used for recipes, so a third-party service can't take the gateway down. */
  stack(project: string, definitionPath: string): Stack;
}

/** One compose service's state, as `serviceStates()` reports it. */
export interface StackServiceState {
  /** True when the container's own state is "running" — not "exited", "created" or
   *  missing entirely. */
  readonly running: boolean;
  /** Compose's own healthcheck verdict ("healthy", "unhealthy", "starting"), or undefined
   *  when the service declares no healthcheck at all, distinct from one not settled yet. */
  readonly health?: string;
}

export interface Stack {
  /** Builds images defined by the stack. */
  build(): Promise<void>;
  /** Starts it in the background. `wait` asks compose to block until every service is
   *  running (and healthy, where declared) or `timeoutSeconds` elapses — only when a caller
   *  has a bounded readiness declaration, so a stuck healthcheck can't hang install forever. */
  up(options?: { wait?: boolean; timeoutSeconds?: number }): Promise<void>;
  /** Stops and removes it; --volumes only when explicitly asked. */
  down(removeVolumes?: boolean): Promise<void>;
  status(): Promise<void>;
  followLogs(): Promise<void>;
  /** Same bound as Runtime.readLogs, for a recipe's own stack. */
  readLogs(tail: string): Promise<string>;
  /** True when ANY container from this project is up — a single live sidecar satisfies it
   *  even while the main service is down. install's readiness check uses serviceStates()
   *  instead, which doesn't have that blind spot. */
  isRunning(): Promise<boolean>;
  /** Per-service state, keyed by compose service name — lets a caller require ALL of a
   *  multi-service recipe's declared services instead of one live container. */
  serviceStates(): Promise<Record<string, StackServiceState>>;
}

/** Delays without blocking the event loop — the one polling primitive every wait loop that
 *  watches a runtime transition shares. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `runningConnectionFacts()` behind one try/catch: not running and "this runtime could not
 *  introspect it" both read as `undefined` here, since every caller treats them the same —
 *  nothing to check right now either way. */
export async function safeConnectionFacts(
  ctx: Context,
): Promise<{ bindAddress?: string; port?: string } | undefined> {
  try {
    return await ctx.runtime.runningConnectionFacts?.();
  } catch {
    return undefined;
  }
}
