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
    options?: { input?: string; allowFailure?: boolean },
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

export interface Stack {
  /** Builds images defined by the stack. */
  build(): Promise<void>;
  /** Starts it in the background. */
  up(): Promise<void>;
  /** Stops and removes it; --volumes only when explicitly asked. */
  down(removeVolumes?: boolean): Promise<void>;
  status(): Promise<void>;
  followLogs(): Promise<void>;
  /** Same bound as Runtime.readLogs, for a recipe's own stack. */
  readLogs(tail: string): Promise<string>;
  isRunning(): Promise<boolean>;
}
