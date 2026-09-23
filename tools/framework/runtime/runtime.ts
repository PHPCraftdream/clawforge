// The runtime contract: what a command may ask of the thing that runs OpenClaw.
//
// Commands talk to this interface and never to Docker. Today there is exactly one
// implementation (Docker); a native installation would be a sibling file, and no command
// would change. That is the whole point of the indirection — it is checked by grepping the
// command files for "docker" and "compose".

import type { ExecResult } from "./transport.ts";

/** Thrown by `execInHelper` when the helper container is not up, so callers can fall back
 *  to `runOneOff` without mistaking it for the command itself having failed. */
export class HelperNotRunning extends Error {
  constructor(service: string) {
    super(`no running helper for "${service}"`);
    this.name = "HelperNotRunning";
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
   *  that must inspect the *full* stdout/stderr of a failure — the thrown-error path
   *  truncates the detail to a few lines, which is fine for a human-readable message but
   *  loses content a caller might need to pattern-match on. */
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
   *  startup. Not the same as start(): starting an already-healthy instance is a no-op,
   *  because nothing the runtime compares (image, ports, environment) has changed when the
   *  edit was to a file inside a bind mount. */
  restart(): Promise<void>;
  /** Brings the running instance back in step with the deployment's current configuration
   *  by asking compose to recreate it — the counterpart of restart(), which keeps the
   *  container exactly as created. A container's environment is fixed once at creation
   *  from whatever the deployment's .env said that day, so restart() re-reads only what
   *  lives in bind-mounted files; a changed .env value reaches the running service only
   *  through a recreate, and this is the one method that performs it. Reads the
   *  deployment's .env at call time, not the snapshot this process was started with:
   *  the caller may have rewritten that file moments ago. Optional because it replaces
   *  the container — a runtime that cannot pay that cost leaves the decision to the
   *  operator, and the caller must say so instead of pretending. */
  reconcile?(): Promise<void>;
  /** Follows the log until interrupted. */
  followLogs(extraArgs?: string[]): Promise<void>;
  /** Reads the last `tail` lines and returns them. The bounded counterpart of followLogs:
   *  a caller that cannot be interrupted — a tool call, which owes its client exactly one
   *  result — needs an end to the output, not a stream. Omitting `tail` uses the same
   *  default the application declared for followLogs. */
  readLogs(tail?: string, extraArgs?: string[]): Promise<string>;
  /** Shows what is running. */
  showStatus(): Promise<void>;
  /** Fetches the image without starting anything. */
  pullImage(): Promise<void>;

  /** True when the instance's main process is up. */
  isRunning(): Promise<boolean>;
  /** The runtime's own health verdict, separate from an HTTP probe: the two can disagree,
   *  and that disagreement has already caught a broken healthcheck here. */
  health(): Promise<string>;
  /** Identifier of the exact image in use, for reproducibility. */
  imageReference(): Promise<string | undefined>;
  /** The running container's image, independent of the configured tag. */
  runningImageIdentity?(): Promise<{ imageId: string; digests: string[]; version?: string; containerId: string } | undefined>;
  /** The running container's own environment — what it actually started with, not what this
   *  machine's .env currently says. A repo-env value (the gateway token) is injected once at
   *  container-creation time and lives on inside the container from then on; if the operator
   *  side's own copy is later lost, this is the one place it still exists. Undefined when the
   *  instance is not running or this runtime cannot introspect it. */
  runningEnvironment?(): Promise<Record<string, string> | undefined>;
  /** The running container's connection facts — the plumbing values (data dir, gateway port,
   *  compose project, image reference) that tell this deployment how to reach its own
   *  instance, read back from Docker the same way runningEnvironment() reads the environment.
   *  They live in the deployment's .env, so a stale or half-filled copy is repairable from
   *  the instance still running. Deliberately NOT a secret — that is runningEnvironment()'s
   *  job (the gateway token); these fields are all safe to print. Undefined when the instance
   *  is not running or this runtime cannot introspect it, while an individual field absent
   *  inside a successful result means Docker's own answer did not carry that fact, which is
   *  reported, never guessed. */
  runningConnectionFacts?(): Promise<
    { dataDir?: string; port?: string; composeProject?: string; image?: string } | undefined
  >;
  /** When the running instance started, as epoch milliseconds, or undefined when it is not
   *  running.
   *
   *  The instance reads its configuration at startup and never again, so "the file on disk
   *  is correct" and "the instance is running that configuration" are different claims, and
   *  nothing visible from outside distinguishes them. Comparing this against the
   *  configuration file's own timestamp is what makes the difference observable. */
  startedAt(): Promise<number | undefined>;

  /** Runs a throwaway container for `service`. */
  runOneOff(service: string, args: string[], options?: RunOneOffOptions): Promise<ExecResult>;

  /** Starts a long-lived helper container for `service` under `profile`, so `execInHelper`
   *  can exec into an already-running container instead of paying `runOneOff`'s per-call
   *  create/destroy cost — measured directly: ~5-7s one-off vs ~1-3s exec once warm. */
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
   *  for ad hoc diagnostics execInHelper cannot reach (reading a file bundled in the image, a
   *  curl probe against something only reachable from inside the container's own network
   *  namespace). Same container, same failure mode: throws HelperNotRunning when it is not
   *  up, so callers can fall back the same way execInHelper's callers already do.
   *
   *  `options.timeoutMs` bounds the WHOLE call in milliseconds: the transport kills the child
   *  when it runs out, so a wedged container, resolver or client cannot stall the caller
   *  past its own budget. */
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

  /** Operates a side stack — a service deployed next to the instance but isolated from it,
   *  with its own project name. Used for recipes, so a third-party service can never take
   *  the gateway down or leak into its state snapshots. */
  stack(project: string, definitionPath: string): Stack;
}

/** One compose service's state, as `serviceStates()` reports it. */
export interface StackServiceState {
  /** True when the container's own state is "running" — not "exited", "created" or
   *  missing entirely. */
  readonly running: boolean;
  /** Compose's own healthcheck verdict ("healthy", "unhealthy", "starting"), or undefined
   *  when the service declares no healthcheck at all — compose then has no health opinion,
   *  distinct from a healthcheck that has not settled yet. */
  readonly health?: string;
}

export interface Stack {
  /** Builds images defined by the stack. */
  build(): Promise<void>;
  /** Starts it in the background. `wait` asks compose itself to block until every service is
   *  running (and healthy, where a healthcheck is declared) or `timeoutSeconds` elapses —
   *  only requested by a caller that already has a bounded readiness declaration for this
   *  stack, so a recipe with no such declaration and a healthcheck that never turns healthy
   *  cannot hang install indefinitely (audit 2026-09-23, P2-04). */
  up(options?: { wait?: boolean; timeoutSeconds?: number }): Promise<void>;
  /** Stops and removes it; --volumes only when explicitly asked. */
  down(removeVolumes?: boolean): Promise<void>;
  status(): Promise<void>;
  followLogs(): Promise<void>;
  /** Same bound as Runtime.readLogs, for a recipe's own stack. */
  readLogs(tail: string): Promise<string>;
  /** True when ANY container from this project is up — the historical, coarse probe that
   *  `recipe status` and the backup/restore warnings (runningRecipeStacks) still read: a
   *  single live sidecar satisfies it even while the recipe's main service is down. Kept as
   *  is for those readers; install's own readiness check uses serviceStates() instead, which
   *  does not have that blind spot. */
  isRunning(): Promise<boolean>;
  /** Per-service state, keyed by compose service name, for every service compose currently
   *  reports for this project — the readiness primitive isRunning() cannot be: a caller can
   *  require ALL of a multi-service recipe's declared services instead of being satisfied by
   *  one live container. */
  serviceStates(): Promise<Record<string, StackServiceState>>;
}
