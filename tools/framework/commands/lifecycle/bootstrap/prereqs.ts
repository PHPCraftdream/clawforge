// The probes `bootstrap --check` runs, and nothing else: each one is a pure parser over
// command output (parseDockerInfo, parseComposeVersion, parseDiskSpace — trivially fed a
// canned ExecResult by a check) plus a thin runner that gets that output from the target.
// check.ts owns the report format and the exit-code contract; this file owns only "what is
// true on the target right now".
//
// PREREQ_PROBES is the whole list, one line per entry on purpose — a later probe (task X7:
// GNU-tool capabilities) is meant to be exactly one more line here, not a second run loop.

import { TransportUnreachableError } from "../../../runtime/transport/transport.ts";
import type { ExecResult } from "../../../runtime/transport/transport.ts";
import { listeningPortHolder } from "../lifecycle.ts";
import { parseDfAvailableKb } from "../../operate/watch/health.ts";
import type { Context } from "../../../core/context.ts";

export type PrereqStatus = "ok" | "warn" | "fail";

export interface PrereqResult {
  readonly status: PrereqStatus;
  /** What was checked and, for anything short of ok, what was found. */
  readonly what: string;
  /** What to do about it — absent for ok, since there is nothing to do. */
  readonly next?: string;
}

export interface PrereqProbe {
  readonly run: (ctx: Context) => Promise<PrereqResult>;
}

function ok(what: string): PrereqResult {
  return { status: "ok", what };
}
function warn(what: string, next: string): PrereqResult {
  return { status: "warn", what, next };
}
function fail(what: string, next: string): PrereqResult {
  return { status: "fail", what, next };
}

// Below the free-space threshold, bootstrap can still start but is one log rotation away
// from a full disk; a constant rather than an env var, unlike watch's own OC_WATCH_DISK_MIN_MB
// (health.ts) — that one tunes an ALREADY-running instance's alerting, this one is a one-time
// "is this machine roomy enough to start on" sanity check.
const MIN_FREE_DISK_MB = 5 * 1024;

/** Walks up from `path` to the nearest ancestor that actually exists on the target — the
 *  same boundary datadir.ts's own ancestry resolution walks, kept as its own small copy here
 *  rather than exported from there: that module's version is entangled with the destructive
 *  chown/mkdir it guards, and this one is read-only and must stay that way. A transport that
 *  cannot even answer `exists` for an ancestor stops the walk there rather than guessing
 *  further up. */
async function nearestExistingAncestor(ctx: Context, path: string): Promise<string> {
  let probe = path;
  for (;;) {
    let present: boolean;
    try {
      present = await ctx.transport.exists(probe);
    } catch (error) {
      if (error instanceof TransportUnreachableError) throw error;
      return probe;
    }
    if (present) return probe;
    const parent = probe.slice(0, Math.max(probe.lastIndexOf("/"), 1));
    if (parent === probe) return probe;
    probe = parent;
  }
}

/** The target user's own name and primary group, `id -un`/`id -gn` — read-only, and named
 *  rather than numeric (unlike datadir.ts's fixed uid:gid OWNER, which chown needs as
 *  numbers to match the container) because this line is read by a person deciding whether to
 *  type it, and a name is what they typed to log in. Undefined when either call fails to
 *  answer 0 — the ready line then falls back to a path-only form rather than guessing a name. */
async function targetUserIdentity(ctx: Context): Promise<{ user: string; group: string } | undefined> {
  try {
    const user = await ctx.transport.exec("id", ["-un"], { allowFailure: true });
    if (user.code !== 0) return undefined;
    const group = await ctx.transport.exec("id", ["-gn"], { allowFailure: true });
    if (group.code !== 0) return undefined;
    const userName = user.stdout.trim();
    const groupName = group.stdout.trim();
    return userName === "" || groupName === "" ? undefined : { user: userName, group: groupName };
  } catch (error) {
    if (error instanceof TransportUnreachableError) throw error;
    return undefined;
  }
}

async function readyLine(ctx: Context, path: string): Promise<string> {
  const identity = await targetUserIdentity(ctx);
  return identity === undefined
    ? `sudo install -d ${path}  (then hand it to whoever runs ./clawforge bootstrap)`
    : `sudo install -d -o ${identity.user} -g ${identity.group} ${path}`;
}

/** ok when `path` (or, absent that, its nearest existing ancestor) is already writable — the
 *  same "can this be prepared without a password prompt" question sudoFor() (datadir.ts) asks
 *  mid-bootstrap, answered here read-only and without dying, so every directory in the report
 *  gets its own line instead of the report stopping at the first one that needs work. */
async function dirReadinessProbe(ctx: Context, role: string, path: string): Promise<PrereqResult> {
  const nearest = await nearestExistingAncestor(ctx, path);
  const writable = await ctx.transport.exec("test", ["-w", nearest], { allowFailure: true });
  if (writable.code === 0) {
    return ok(nearest === path ? `${role} ${path} is writable` : `${role} ${path} can be created (${nearest} is writable)`);
  }
  return fail(`${role} ${path} needs root to prepare`, await readyLine(ctx, path));
}

/** `docker info`'s exit code and server version, parsed from a plain ExecResult — the pure
 *  half of dockerProbe, fed a canned result by a check. */
export function parseDockerInfo(result: Pick<ExecResult, "code" | "stdout" | "stderr">): PrereqResult {
  if (result.code === 0) {
    const version = result.stdout.trim();
    return ok(`docker daemon is reachable${version === "" ? "" : ` (server ${version})`}`);
  }
  return fail(
    "docker is installed but the daemon did not answer `docker info`",
    "start the Docker daemon (Docker Desktop, or the docker service) on the target",
  );
}

async function dockerProbe(ctx: Context): Promise<PrereqResult> {
  let result: ExecResult;
  try {
    result = await ctx.transport.exec("docker", ["info", "--format", "{{.ServerVersion}}"], { allowFailure: true });
  } catch (error) {
    if (error instanceof TransportUnreachableError) throw error;
    return fail("docker is not on PATH on the target", "install Docker Engine, then re-run ./clawforge bootstrap --check");
  }
  return parseDockerInfo(result);
}

/** `docker compose version`'s exit code, parsed the same way parseDockerInfo is. */
export function parseComposeVersion(result: Pick<ExecResult, "code" | "stdout" | "stderr">): PrereqResult {
  if (result.code === 0) {
    const version = result.stdout.trim();
    return ok(`compose v2 is available${version === "" ? "" : ` (${version})`}`);
  }
  return fail(
    "`docker compose version` failed — the compose v2 plugin is missing",
    "install the Docker Compose v2 plugin (docker-compose-plugin)",
  );
}

async function composeProbe(ctx: Context): Promise<PrereqResult> {
  let result: ExecResult;
  try {
    result = await ctx.transport.exec("docker", ["compose", "version"], { allowFailure: true });
  } catch (error) {
    if (error instanceof TransportUnreachableError) throw error;
    return fail("could not run `docker compose version` on the target", "install Docker Engine and the Compose v2 plugin");
  }
  return parseComposeVersion(result);
}

async function portProbe(ctx: Context): Promise<PrereqResult> {
  const { bindAddress, gatewayPort } = ctx.settings;
  const holder = await listeningPortHolder(ctx, bindAddress, gatewayPort);
  if (holder === "unavailable") {
    return warn(
      `could not determine whether ${bindAddress}:${gatewayPort} is free — neither ss nor netstat answered on the target`,
      "bootstrap's own preflight will still catch a conflict when it actually starts",
    );
  }
  if (holder !== undefined) {
    return fail(
      `${bindAddress}:${gatewayPort} is already listening (${holder})`,
      "give this deployment its own OPENCLAW_GATEWAY_PORT in .env, or stop whatever is using it",
    );
  }
  return ok(`gateway port ${gatewayPort} is free`);
}

/** `df -Pk`'s exit code and parsed availability against the threshold — the pure half of
 *  diskProbe. Below the threshold is a warning, never a failure: bootstrap can still start,
 *  it just should not be a surprise when it later cannot. */
export function parseDiskSpace(path: string, result: Pick<ExecResult, "code" | "stdout" | "stderr">, minFreeMb: number): PrereqResult {
  if (result.code !== 0) {
    return warn(`could not determine free disk space at ${path}`, "run df -h on the target and check by hand");
  }
  const availableKb = parseDfAvailableKb(result.stdout);
  if (availableKb === undefined) {
    return warn(`df -Pk ${path} returned output this could not parse`, "run df -h on the target and check by hand");
  }
  const availableMb = availableKb / 1024;
  if (availableMb < minFreeMb) {
    return warn(
      `only ${availableMb.toFixed(0)} MB free at ${path}`,
      `free up space, or point OC_DATA_DIR at a volume with at least ${minFreeMb} MB free`,
    );
  }
  return ok(`${availableMb.toFixed(0)} MB free at ${path}`);
}

async function diskProbe(ctx: Context): Promise<PrereqResult> {
  const nearest = await nearestExistingAncestor(ctx, ctx.settings.dataDir);
  let result: ExecResult;
  try {
    result = await ctx.transport.exec("df", ["-Pk", nearest], { allowFailure: true });
  } catch (error) {
    if (error instanceof TransportUnreachableError) throw error;
    return warn(`could not run df -Pk ${nearest} on the target`, "run df -h on the target and check by hand");
  }
  return parseDiskSpace(nearest, result, MIN_FREE_DISK_MB);
}

/** Every prerequisite `bootstrap --check` reports, in report order. Add one to this list —
 *  nothing else — to add a prerequisite to the report. */
export const PREREQ_PROBES: PrereqProbe[] = [
  { run: dockerProbe },
  { run: composeProbe },
  { run: (ctx) => dirReadinessProbe(ctx, "data directory", ctx.settings.dataDir) },
  { run: (ctx) => dirReadinessProbe(ctx, "backup directory", ctx.settings.backupDir) },
  { run: (ctx) => dirReadinessProbe(ctx, "snapshot directory", ctx.settings.snapshotDir) },
  { run: portProbe },
  { run: diskProbe },
];

/** Runs every probe in order and collects the results. A TransportUnreachableError from any
 *  one of them is never caught here — check.ts turns it into the same TARGET_UNREACHABLE
 *  finding every other command reports it as, instead of a partial report that pretends the
 *  probes after it still mean something. */
export async function runPrereqProbes(ctx: Context, probes: readonly PrereqProbe[] = PREREQ_PROBES): Promise<PrereqResult[]> {
  const results: PrereqResult[] = [];
  for (const probe of probes) results.push(await probe.run(ctx));
  return results;
}
