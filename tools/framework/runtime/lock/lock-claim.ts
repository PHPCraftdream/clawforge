// The instance lock's primitives: on-disk holder shape, staleness/aging maths,
// human-readable refusal text, and the directory-claim/takeover/publish steps one
// acquisition goes through. Imports nothing from instance-lock.ts — the reentrancy layer
// (chainLocks/heldScopes) and the HeldLock handle live there and import these instead,
// re-exporting the ones callers use so instance-lock.ts stays every consumer's import path.

import { randomBytes } from "node:crypto";

import { locksDir } from "../../core/env.ts";
import { log, die } from "../../core/io/log.ts";
import { machineName, ownProcessStartedAt, removeEmptyDirectory } from "./process-identity.ts";
import type { Context } from "../../core/context.ts";

/** Legacy fallback: judges staleness for a holder with no `heartbeatAt` (pre-field record).
 *  Anything newer is judged by HEARTBEAT_STALE_AFTER_MS instead (isStale below), since
 *  `recipe install` legitimately holds the lock across a build that outlives this. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** A holder with a heartbeat this old has stopped refreshing, not merely running long. Far
 *  above HEARTBEAT_INTERVAL_MS so a few missed writes aren't mistaken for a dead holder. */
export const HEARTBEAT_STALE_AFTER_MS = 10 * 60 * 1000;

export interface LockHolder {
  readonly operationId: string;
  /** What the holder is doing: "apply", "rollback", "provision-agent example-recipe". */
  readonly what: string;
  /** Best effort, for a human reading a refusal: the machine and process that took it. */
  readonly by: string;
  readonly takenAt: string;
  /** Which acquisition of the lock directory this record belongs to. Absent on a legacy
   *  holder; `undefined === undefined` still lets a takeover be checked against it. */
  readonly generation?: string;
  /** This host's identity (machineName()). `pid` is only askable against THIS machine's
   *  process table when `host` matches — every recorded pid is the CLI's own, never a
   *  WSL/SSH transport target's. */
  readonly host?: string;
  /** The acquiring process's own pid. */
  readonly pid?: number;
  /** Approximate start time, recorded to catch pid reuse. */
  readonly startedAt?: string;
  /** Last time the holder proved it is alive, refreshed on interval, set at acquisition too.
   *  Absent on a legacy record; isStale() then falls back to `takenAt`. */
  readonly heartbeatAt?: string;
}

/** Whether `holder`'s process is provably gone: recorded on THIS machine (never a WSL/SSH
 *  target) and signalling it fails with ESRCH. A different machine, no pid, a live process,
 *  or an inconclusive probe are all "not provable" and stay silent — only a human decides.
 *  No pid-reuse cross-check against `startedAt` (too costly on every ordinary refusal). */
function isProvablyDeadHere(holder: LockHolder): boolean {
  if (holder.host !== machineName() || holder.pid === undefined) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** The lock itself is a DIRECTORY: `mkdir` on an existing path fails atomically on every
 *  POSIX filesystem, works through wsl.exe and ssh too. Must be a plain `mkdir`, not `mkdir
 *  -p` (which succeeds on an existing directory), hence exec rather than transport.mkdirp.
 *
 *  Lives beside the data directory, never inside it: `restore` moves the old one aside and
 *  unpacks a new one, so a lock inside would let a second process create its own in the new
 *  tree mid-restore. Beside it alone isn't enough either (the data directory's parent can
 *  stay root:root), so the lock lives in its own directory (datadir.ts), owned by whoever
 *  runs the tooling; the data directory's name is kept so two deployments sharing a parent
 *  cannot collide. */
export function lockHome(ctx: Context): string {
  return locksDir(ctx.settings.dataDir);
}

export function lockPath(ctx: Context): string {
  return `${lockHome(ctx)}/operation.lock`;
}

function holderPath(ctx: Context): string {
  return `${lockPath(ctx)}/holder.json`;
}

/** The one place holder.json is written, initial claim and every heartbeat refresh alike —
 *  transport.writeFile is write-temp-then-rename, so a reader never sees a partial record. */
export async function writeHolderRecord(ctx: Context, holder: LockHolder): Promise<void> {
  await ctx.transport.writeFile(holderPath(ctx), `${JSON.stringify(holder, null, 2)}\n`);
}

/** A directory marker that proves which acquisition won the lock directory. `mkdir lockPath`
 *  only says the directory didn't exist a moment ago, not who owns it NOW. The marker names
 *  the winner instead: `gen-<token>`, minted before the acquisition's first command,
 *  created with the same atomic fail-if-exists `mkdir`. */
function generationMarkerPath(ctx: Context, generation: string): string {
  return `${lockPath(ctx)}/gen-${generation}`;
}

/** Claims the lock directory as this acquisition's, by moving its own generation marker out
 *  of the way. This is the compare-and-swap both races turn on: a gap between a separate
 *  read and write is where a takeover could put a different owner's lock at the same path.
 *  `rename` is atomic, so moving a path only this acquisition can still own settles the
 *  question and acts on it in one operation. Returns where the marker was parked, or
 *  undefined when the directory is not ours to touch. */
export async function claimOwnedLockDirectory(ctx: Context, generation: string): Promise<string | undefined> {
  const trash = `${lockPath(ctx)}/.released-${randomBytes(6).toString("hex")}`;
  try {
    const moved = await ctx.transport.exec("mv", [generationMarkerPath(ctx, generation), trash], { allowFailure: true });
    return moved.code === 0 ? trash : undefined;
  } catch {
    return undefined;
  }
}

/** Empties a lock directory this caller has proven it owns: the parked marker, the holder
 *  file while still this acquisition's, then the root via plain rmdir, never recursive —
 *  anything that appeared inside meanwhile makes rmdir fail, leaving a stale lock for a
 *  human rather than deleting a live one. Best effort throughout. */
export async function removeOwnedLock(ctx: Context, generation: string, trash: string): Promise<void> {
  await ctx.transport.exec("rm", ["-rf", trash], { allowFailure: true });
  const current = await readLockHolder(ctx);
  if (current === undefined || current.generation === generation) {
    // A file, not a directory: an empty-directory remove would refuse it.
    await ctx.transport.remove(holderPath(ctx)).catch(() => {});
  }
  await removeEmptyDirectory(ctx, lockPath(ctx));
}

/** Cleans an uncommitted claim without traversing another owner's marker. */
async function removeFailedMarkerClaim(ctx: Context, generation: string): Promise<void> {
  // The marker command may have created its directory before losing the acknowledgement.
  // Remove only that exact marker, then the lock root only if it is still empty.
  await removeEmptyDirectory(ctx, generationMarkerPath(ctx, generation));
  await removeEmptyDirectory(ctx, lockPath(ctx));
}

async function readHolderAt(ctx: Context, path: string): Promise<LockHolder | undefined> {
  try {
    const raw = await ctx.transport.readFile(path);
    const parsed = JSON.parse(raw) as LockHolder;
    return typeof parsed.operationId === "string" ? parsed : undefined;
  } catch {
    // Absent, unreadable, or not JSON. The directory may still exist, and takeLock treats
    // that as held-by-someone-unknown rather than free — a reason to ask a human, not proceed.
    return undefined;
  }
}

export async function readLockHolder(ctx: Context): Promise<LockHolder | undefined> {
  // A takeover's compare-and-swap reads the holder from the directory it just moved aside,
  // not from the lock path — this is the plain lock-path read.
  return readHolderAt(ctx, holderPath(ctx));
}

/** Wins the lock, or says why not. Plain mkdir's exit code is the answer. A failure isn't
 *  automatically a held lock — an unwritable parent fails the same way — so the directory
 *  itself settles it: present means someone holds it, absent means mkdir failed for its own
 *  reason, worth repeating verbatim. */
async function claimDirectory(ctx: Context): Promise<{ won: boolean; heldByOther: boolean; detail: string }> {
  // Idempotent container prep, not a signal: costs nothing and saves every command from
  // needing a bootstrap first. Only the lock itself is claimed with a plain mkdir below.
  await ctx.transport.exec("mkdir", ["-p", lockHome(ctx)], { allowFailure: true });

  const result = await ctx.transport.exec("mkdir", [lockPath(ctx)], { allowFailure: true });
  if (result.code === 0) return { won: true, heldByOther: false, detail: "" };

  const exists = await ctx.transport.exec("test", ["-d", lockPath(ctx)], { allowFailure: true });
  return { won: false, heldByOther: exists.code === 0, detail: (result.stderr || result.stdout).trim() };
}

/** Moves a lock aside and accepts it only if its generation still matches the observation. */
async function claimTakeover(
  ctx: Context,
  observedGeneration: string | undefined,
): Promise<{ won: boolean; detail: string }> {
  const displaced = `${lockPath(ctx)}.stale-${randomBytes(6).toString("hex")}`;
  const moved = await ctx.transport.exec("mv", [lockPath(ctx), displaced], { allowFailure: true });
  if (moved.code !== 0) return { won: false, detail: (moved.stderr || moved.stdout).trim() };

  // Compare-and-swap. `undefined === undefined` is the legacy shape: a holder with no
  // generation is still checked against the lock it read.
  const displacedHolder = await readHolderAt(ctx, `${displaced}/holder.json`);
  if (displacedHolder?.generation !== observedGeneration) {
    // Not the lock that was observed — a newer owner holds the path now. Put the displaced
    // directory back only into an absent path; if something appeared there meanwhile, park
    // the displaced directory rather than destroying what may be a live lock.
    const present = await ctx.transport.exec("test", ["-d", lockPath(ctx)], { allowFailure: true });
    if (present.code !== 0) {
      await ctx.transport.exec("mv", [displaced, lockPath(ctx)], { allowFailure: true });
    }
    return { won: false, detail: "" };
  }

  const result = await ctx.transport.exec("mkdir", [lockPath(ctx)], { allowFailure: true });
  // Best-effort cleanup of the now-unreachable displaced directory must not turn an
  // already-won takeover into a reported failure.
  await ctx.transport.exec("rm", ["-rf", displaced], { allowFailure: true });
  if (result.code !== 0) return { won: false, detail: (result.stderr || result.stdout).trim() };
  return { won: true, detail: "" };
}

/** Since the lock was taken, never affected by the heartbeat. For the refusal's "started by
 *  X, N ago" line. */
export function ageMs(holder: LockHolder, now = Date.now()): number {
  const taken = Date.parse(holder.takenAt);
  return Number.isNaN(taken) ? 0 : now - taken;
}

/** Since the holder last proved it is alive: `heartbeatAt`, or `takenAt` for a legacy record
 *  — correctly reading as "never refreshed". */
export function heartbeatAgeMs(holder: LockHolder, now = Date.now()): number {
  const at = Date.parse(holder.heartbeatAt ?? holder.takenAt);
  return Number.isNaN(at) ? 0 : now - at;
}

/** A legacy record with no heartbeatAt is judged by how long ago it was taken
 *  (STALE_AFTER_MS); everything else by how long its heartbeat has gone quiet
 *  (HEARTBEAT_STALE_AFTER_MS), regardless of when taken — the fix for a live `recipe install`
 *  outliving STALE_AFTER_MS. */
export function isStale(holder: LockHolder, now = Date.now()): boolean {
  if (holder.heartbeatAt === undefined) return ageMs(holder, now) > STALE_AFTER_MS;
  return heartbeatAgeMs(holder, now) > HEARTBEAT_STALE_AFTER_MS;
}

function humanAge(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute(s)`;
  return `${Math.floor(minutes / 60)} hour(s)`;
}

/** Same as humanAge, but second-level resolution below a minute — "12 seconds ago" beats
 *  "less than a minute ago" for the refusal's "still running" line. */
function humanShortAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds} second(s)` : humanAge(ms);
}

/** Every command that supports break-lock must actually accept it. A command that doesn't
 *  passes `false` here so the advice never names a flag it would then reject as unknown. */
export function breakLockAdvice(breakLockSupported: boolean): string {
  return breakLockSupported
    ? "take it over with --break-lock"
    : `this command does not accept --break-lock — run one that does (for example ${commandLine(["up", "--break-lock"])}) to take it over`;
}

/** The stale holder's heartbeat line, shared with the checks that prove it. */
export function staleHeartbeatLine(ageMs: number): string {
  return `not refreshed for ${humanAge(ageMs)}.`;
}

/** The takeover lost to a concurrent one. */
export const TAKEOVER_LOST_LINE = "Another operation already took it over. Re-run if the instance is still locked.";

/** The message a blocked run gets. Exported so the checks can assert what it tells the
 *  reader — a refusal that does not say who holds the lock leaves them with nothing to do
 *  but delete files and hope. */
export function refusalMessage(holder: LockHolder, now = Date.now(), breakLockSupported = true): string {
  const age = ageMs(holder, now);
  const lines = [
    `another operation is changing this instance: ${holder.what} (${holder.operationId})`,
    `started by ${holder.by}, ${humanAge(age)} ago`,
  ];
  const stale = isStale(holder, now);
  // A fact, not a guess: recorded on this machine and the pid is provably gone. Independent
  // of staleness — a crash seconds ago is just as dead as one thirty minutes ago.
  const deadHere = isProvablyDeadHere(holder);
  lines.push(
    stale
      ? staleHeartbeatLine(heartbeatAgeMs(holder, now))
      : `refreshed ${humanShortAge(heartbeatAgeMs(holder, now))} ago — the operation is still running.`,
  );
  if (deadHere) {
    lines.push(DEAD_HERE_LINE);
  }
  lines.push(
    // --break-lock is offered only once one of the two facts above supports it — a live,
    // recently-refreshed holder is never told to break its own lock.
    stale || deadHere
      ? `If you are sure nothing is running, ${breakLockAdvice(breakLockSupported)}.`
      : liveWaitLine(holder.operationId),
  );
  return lines.join("\n");
}

export const DEAD_HERE_LINE = "Its recorded process is not running on this machine anymore — not a guess, the pid itself is gone.";

/** A live holder is waited out, never broken. */
export function liveWaitLine(operationId: string): string {
  return `Wait for it to finish, or run ${commandLine(["operations", operationId])} to see what it is doing.`;
}

/** Held by something that never said what it was. Worth its own message: the reader needs to
 *  know there is no name to look for, rather than assuming the report lost it. */
export function unreadableLockMessage(ctx: Context, breakLockSupported = true): string {
  return [
    `this instance is locked by an operation that did not record who it is (${lockPath(ctx)})`,
    "Most likely a run that won the lock and stopped before naming itself.",
    `If you are sure nothing is running, ${breakLockAdvice(breakLockSupported)}.`,
  ].join("\n");
}

/** Options every lock-taking entry point threads through unchanged. `breakLockSupported`
 *  defaults true; a command that doesn't accept --break-lock passes false.
 *  `breakForeignLockHost` is the exact host id an operator confirmed as an orphaned
 *  mutation-guard owner's machine — never inferred. */
export interface LockOptions {
  readonly breakLock?: boolean;
  readonly breakLockSupported?: boolean;
  readonly breakForeignLockHost?: string;
}

/** Wins the lock directory, or takes over an existing one under --break-lock; never both silently. */
export async function acquireOrTakeOver(ctx: Context, options: LockOptions): Promise<void> {
  const claim = await claimDirectory(ctx);

  if (!claim.won && !claim.heldByOther) {
    // Not a lock at all: mkdir could not run. --break-lock would fail the same way, so it's
    // not offered.
    die(
      `could not take the instance lock at ${lockPath(ctx)}: ${claim.detail === "" ? "mkdir failed" : claim.detail}\n` +
        `Nothing holds it — the directory is not there. ${lockHome(ctx)} has to exist and be writable ` +
        `by whoever runs this tooling; ${commandLine(["bootstrap"])} prepares it.`,
    );
  }

  if (claim.won) return;

  const existing = await readLockHolder(ctx);

  if (options.breakLock !== true) {
    // An existing directory with no readable holder is still someone's — most likely a run
    // that won it and died before writing its name. Refusing is the safe reading.
    die(
      existing === undefined
        ? unreadableLockMessage(ctx, options.breakLockSupported)
        : refusalMessage(existing, undefined, options.breakLockSupported),
    );
  }

  const takeover = await claimTakeover(ctx, existing?.generation);
  if (!takeover.won) {
    // Another caller's takeover or release already changed this path between the read above
    // and this attempt — refused like a fresh claim against a directory still there.
    die(
      `could not take over the instance lock at ${lockPath(ctx)}: ${takeover.detail === "" ? "the lock changed during takeover" : takeover.detail}\n` +
        TAKEOVER_LOST_LINE,
    );
  }

  log(
    existing === undefined
      ? "taking over a lock whose holder could not be read — --break-lock"
      : `taking over the lock held by ${existing.what} (${existing.operationId}) — --break-lock`,
  );
}

/** Mints this acquisition's identity — a fresh random generation, before its first command. */
export function mintHolder(what: string, operationId: string): { generation: string; holder: LockHolder } {
  const generation = randomBytes(12).toString("hex");
  const takenAt = new Date().toISOString();
  const holder: LockHolder = {
    operationId,
    what,
    by: `${process.env.USERNAME ?? process.env.USER ?? "unknown"}@${machineName()} pid ${process.pid}`,
    takenAt,
    generation,
    host: machineName(),
    pid: process.pid,
    startedAt: ownProcessStartedAt(),
    // Set at acquisition, not left for the first tick, so the lock never looks pre-heartbeat.
    heartbeatAt: takenAt,
  };
  return { generation, holder };
}

/** A fresh mkdir proves this process created the lock, but that proof is lost if writing
 *  holder.json then fails. This marker lets cleanup distinguish our incomplete claim from a
 *  lock another process took over meanwhile. */
export async function claimGenerationMarker(ctx: Context, generation: string): Promise<void> {
  let marker;
  try {
    marker = await ctx.transport.exec("mkdir", ["-m", "700", generationMarkerPath(ctx, generation)], { allowFailure: true });
  } catch (error) {
    await removeFailedMarkerClaim(ctx, generation).catch(() => {});
    throw error;
  }
  if (marker.code !== 0) {
    const detail = (marker.stderr || marker.stdout).trim();
    await removeFailedMarkerClaim(ctx, generation).catch(() => {});
    throw new Error(`could not record instance lock ownership${detail === "" ? "" : `: ${detail}`}`);
  }
}

/** Publishes holder.json, or rolls this claim back via the same CAS release() uses in instance-lock.ts. */
export async function writeHolderOrRollback(ctx: Context, generation: string, holder: LockHolder): Promise<void> {
  try {
    await writeHolderRecord(ctx, holder);
  } catch (error) {
    // The holder never got written, so whether this directory is still ours is settled by
    // the marker alone, via one atomic operation rather than a read-then-remove (which a
    // takeover could race, leaving the cleanup deleting a claim already live).
    const trash = await claimOwnedLockDirectory(ctx, generation);
    if (trash !== undefined) {
      try {
        await removeOwnedLock(ctx, generation, trash);
      } catch {
        // Preserve the write failure. A cleanup error must not hide the useful cause.
      }
    }
    throw error;
  }
}
import { commandLine } from "../../core/io/invocation/render.ts";
