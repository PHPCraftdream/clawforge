// The instance lock's own primitives, split out of instance-lock.ts to keep that file under
// its line budget: the on-disk holder shape, staleness/aging maths, human-readable refusal
// text, and the directory-claim/takeover/publish steps one acquisition goes through. This file
// imports nothing from instance-lock.ts — the reentrancy layer (chainLocks/heldScopes) and the
// returned HeldLock handle live there and import these instead, re-exporting the ones callers
// use directly so `#framework/runtime/lock/instance-lock.ts` remains every consumer's import path.

import { randomBytes } from "node:crypto";

import { locksDir } from "../../core/env.ts";
import { log, die } from "../../core/io/log.ts";
import { machineName, ownProcessStartedAt, removeEmptyDirectory } from "./process-identity.ts";
import type { Context } from "../../core/context.ts";

/** Legacy fallback only: judges staleness for a holder with no `heartbeatAt` at all — a
 *  record written by a framework version before that field existed. Anything newer is judged
 *  by HEARTBEAT_STALE_AFTER_MS instead (isStale below), since `recipe install` legitimately
 *  holds the lock across a whole build that can run well past this. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** A holder with a heartbeat this old has stopped refreshing — not merely "running a long
 *  operation", which is exactly the false positive STALE_AFTER_MS alone used to produce for a
 *  live `recipe install`. Far above HEARTBEAT_INTERVAL_MS (heartbeat.ts) so a few missed
 *  writes in a row are never mistaken for a dead holder. */
export const HEARTBEAT_STALE_AFTER_MS = 10 * 60 * 1000;

export interface LockHolder {
  readonly operationId: string;
  /** What the holder is doing: "apply", "rollback", "provision-agent example-recipe". */
  readonly what: string;
  /** Best effort, for a human reading a refusal: the machine and process that took it. */
  readonly by: string;
  readonly takenAt: string;
  /** Which acquisition of the lock directory this record belongs to. A holder written before
   *  generations existed has none, and that is a state of its own: `undefined` compares equal
   *  to `undefined`, so a takeover of an unnamed lock is still checked against the one it
   *  read. */
  readonly generation?: string;
  /** This host's own identity, as machineName() computes it — set by every acquisition since
   *  this field existed, absent on a holder written before it did. `pid` is only askable
   *  against THIS machine's own process table when `host` matches it: every pid this
   *  framework records is the CLI's own process.pid, never anything living on a WSL/SSH
   *  transport target (process-identity.ts). */
  readonly host?: string;
  /** The acquiring process's own pid. */
  readonly pid?: number;
  /** This process's own approximate start time, recorded to catch pid reuse — nothing here
   *  compares it yet (see isProvablyDeadHere's own note), but a later reader can. */
  readonly startedAt?: string;
  /** Last time the holder proved it is still alive, rewritten on heartbeatScheduler's
   *  interval (heartbeat.ts) — set at acquisition too, so a lock never spends its first
   *  HEARTBEAT_INTERVAL_MS looking legacy. Absent only on a record written before this field
   *  existed; isStale() then falls back to `takenAt` under STALE_AFTER_MS. */
  readonly heartbeatAt?: string;
}

/** Whether `holder`'s process is provably gone: recorded on THIS machine — never a WSL/SSH
 *  target, see process-identity.ts — and signalling it fails with ESRCH. A different machine,
 *  no pid recorded, a live process, or a probe error that proves nothing are all "not
 *  provable", and the refusal stays silent about them: this only ever adds a fact on top of
 *  the human's own judgment call, never substitutes for it. Deliberately synchronous and
 *  ESRCH-only — no pid-reuse cross-check against `startedAt` here, since that needs shelling
 *  out to `ps`/`wmic` and this runs on every ordinary refusal, most of which are against a
 *  genuinely running peer; a reused pid on this exact host is rare enough that the safe,
 *  unenhanced message ("wait, or --break-lock if you are sure") is an acceptable fallback. */
function isProvablyDeadHere(holder: LockHolder): boolean {
  if (holder.host !== machineName() || holder.pid === undefined) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** The lock itself is a DIRECTORY, and that is the whole mechanism.
 *
 *  Creating a directory that already exists fails, atomically, on every POSIX filesystem —
 *  and the same one command works through wsl.exe and ssh, which is where an atomic
 *  primitive is otherwise hard to come by. Read-then-write would let two runs starting
 *  together both conclude the lock was free; the window is small and entirely real, and it
 *  is the only thing standing between two coders.
 *
 *  Note it must be a plain `mkdir`, not `mkdir -p`: -p succeeds on an existing directory,
 *  which would turn the test into no test at all. That is why this goes through exec rather
 *  than transport.mkdirp. */
/** Beside the data directory, never inside it, and inside a home prepared for it.
 *
 *  `restore` replaces the whole data directory: it moves the old one aside and unpacks a new
 *  one in its place. A lock living inside left with the old tree, so a second process
 *  cheerfully created its own lock in the new one and started work while the restore was
 *  still running — the lock covered every operation except the one most worth covering.
 *
 *  Beside it is not enough on its own, though: bootstrap gives the data directory an owner
 *  but its parent can stay root:root, and then nothing next to it can be created at all. So
 *  the lock lives in a directory of its own, prepared with the rest of the target's layout
 *  (datadir.ts) and owned by whoever runs the tooling — the container never sees this. The
 *  data directory's name is kept so two deployments sharing a parent cannot collide. */
export function lockHome(ctx: Context): string {
  return locksDir(ctx.settings.dataDir);
}

export function lockPath(ctx: Context): string {
  return `${lockHome(ctx)}/operation.lock`;
}

function holderPath(ctx: Context): string {
  return `${lockPath(ctx)}/holder.json`;
}

/** The one place holder.json is written, initial claim and every later heartbeat refresh
 *  alike — transport.writeFile is write-temp-then-rename on every transport, so a reader never
 *  sees a partial record. */
export async function writeHolderRecord(ctx: Context, holder: LockHolder): Promise<void> {
  await ctx.transport.writeFile(holderPath(ctx), `${JSON.stringify(holder, null, 2)}\n`);
}

/** A directory marker that proves this process won the lock directory, and which
 *  acquisition of it won.
 *
 *  `mkdir lockPath` only says the directory did not exist a moment ago; it says nothing
 *  about who owns it NOW, and the path can be re-created underneath whoever took it. The
 *  marker names the winner instead: `gen-<token>`, the token being a random generation the
 *  acquisition mints before its first command and records in its holder.json. It is created
 *  with the same atomic plain `mkdir` the claim itself uses, so it is fail-if-exists too —
 *  nobody can sit on somebody else's identity by creating the marker late. */
function generationMarkerPath(ctx: Context, generation: string): string {
  return `${lockPath(ctx)}/gen-${generation}`;
}

/** Claims the lock directory as this acquisition's, by moving its own generation marker out
 *  of the way — and by nothing else.
 *
 *  This is the compare-and-swap both races turn on. Every other step in this module is a
 *  separate read and a separate write, and the gap between them is where a takeover can put
 *  a different owner's lock at the same path: a late release then deletes a lock it never
 *  held, and a stale takeover cleans up a claim that is already live. `rename` is atomic on
 *  every filesystem this reaches, so one move of a path only this acquisition can still own
 *  settles the question and acts on the answer in the same operation — the marker is either
 *  still there, meaning this acquisition is the current one and the directory is ours to
 *  finish with, or it is already gone, meaning a takeover rotated this exact identity away
 *  and everything left inside belongs to whoever did that. Returns where the marker was
 *  parked, or undefined when the directory is not ours to touch. */
export async function claimOwnedLockDirectory(ctx: Context, generation: string): Promise<string | undefined> {
  const trash = `${lockPath(ctx)}/.released-${randomBytes(6).toString("hex")}`;
  try {
    const moved = await ctx.transport.exec("mv", [generationMarkerPath(ctx, generation), trash], { allowFailure: true });
    return moved.code === 0 ? trash : undefined;
  } catch {
    return undefined;
  }
}

/** Empties a lock directory this caller has just proven it owns: the marker it parked there,
 *  the holder file while that file is still this acquisition's, and finally the root itself.
 *
 *  The root goes with a plain rmdir, never a recursive remove. Anything that appeared inside
 *  between the ownership check above and this step — a newer holder, another owner's marker
 *  — makes that rmdir fail, and what survives is a stale lock for a human to look at rather
 *  than a live one deleted by a late release. The holder file is read back for the same
 *  reason and removed only when it is absent, unreadable, or names this generation. All of
 *  it best effort: a lock that cannot be removed is reported and can be forced, while
 *  failing the operation here would report a failure of work that already succeeded. */
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
    // Absent, unreadable, or not JSON. A lock nobody can read is not a lock — but the
    // directory may still exist, and takeLock treats that as held-by-someone-unknown rather
    // than free: an unreadable holder is a reason to ask a human, not to proceed.
    return undefined;
  }
}

export async function readLockHolder(ctx: Context): Promise<LockHolder | undefined> {
  // A holder is read from somewhere other than the lock path by a takeover's compare-and-
  // swap: the directory it just moved aside has to be checked for the holder that was
  // observed at the lock path before the move.
  return readHolderAt(ctx, holderPath(ctx));
}

/** Wins the lock, or says why not. The exit code of a plain mkdir is the answer to "did I
 *  get it", so there is no moment between deciding and taking.
 *
 *  A failure is not automatically a held lock, and treating it as one produced a report about
 *  a lock that was not there together with a `--break-lock` suggestion that could not
 *  possibly help: a parent the tooling cannot write into fails exactly the same way. The
 *  directory itself settles it — present means someone holds it, absent means the mkdir
 *  failed for a reason of its own, and the stderr is worth repeating verbatim then. */
async function claimDirectory(ctx: Context): Promise<{ won: boolean; heldByOther: boolean; detail: string }> {
  // The home is a container, not a signal: `mkdir -p` on it is idempotent and says nothing
  // about who holds what, so making it here costs nothing and saves every command from
  // needing a bootstrap first. Only the lock itself is claimed with a plain mkdir, where the
  // exit code is the answer. A home that cannot be made leaves the real failure to be
  // reported below rather than swallowing it.
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

  // Compare-and-swap. `undefined === undefined` is the legacy shape: a holder written before
  // generations existed names no identity, and a takeover of one is still checked against
  // the lock it read.
  const displacedHolder = await readHolderAt(ctx, `${displaced}/holder.json`);
  if (displacedHolder?.generation !== observedGeneration) {
    // Not the lock that was observed — it is gone, and a newer owner holds the path now. Put
    // the displaced directory back: what sits at the lock path is that owner's, and
    // restoring keeps the winner it chose. Only into an absent path; if something has
    // appeared there meanwhile, the displaced directory is parked where it is rather than
    // destroying what may be a live lock.
    const present = await ctx.transport.exec("test", ["-d", lockPath(ctx)], { allowFailure: true });
    if (present.code !== 0) {
      await ctx.transport.exec("mv", [displaced, lockPath(ctx)], { allowFailure: true });
    }
    return { won: false, detail: "" };
  }

  const result = await ctx.transport.exec("mkdir", [lockPath(ctx)], { allowFailure: true });
  // The displaced directory is unreachable through the lock path either way once the move has
  // happened; best-effort cleanup of it must not turn an already-won takeover into a reported
  // failure.
  await ctx.transport.exec("rm", ["-rf", displaced], { allowFailure: true });
  if (result.code !== 0) return { won: false, detail: (result.stderr || result.stdout).trim() };
  return { won: true, detail: "" };
}

/** Since the lock was taken — "how long has this operation been running", never affected by
 *  the heartbeat. Used for the refusal's "started by X, N ago" line. */
export function ageMs(holder: LockHolder, now = Date.now()): number {
  const taken = Date.parse(holder.takenAt);
  return Number.isNaN(taken) ? 0 : now - taken;
}

/** Since the holder last proved it is alive: `heartbeatAt` when the record has one, `takenAt`
 *  for a legacy record that never did — which reads as "never refreshed", correctly. */
export function heartbeatAgeMs(holder: LockHolder, now = Date.now()): number {
  const at = Date.parse(holder.heartbeatAt ?? holder.takenAt);
  return Number.isNaN(at) ? 0 : now - at;
}

/** A legacy record with no heartbeatAt is judged by how long ago it was simply taken
 *  (STALE_AFTER_MS) — the only signal it ever recorded. Everything since then is judged by how
 *  long its heartbeat has gone quiet (HEARTBEAT_STALE_AFTER_MS) instead, regardless of how long
 *  ago it was taken: that is the fix for a live `recipe install` outliving STALE_AFTER_MS. */
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

/** Same as humanAge, but with second-level resolution below a minute — the refusal's "still
 *  running" line names how recently the holder was heard from, and "less than a minute ago" is
 *  a worse answer to that than "12 seconds ago" is. */
function humanShortAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds} second(s)` : humanAge(ms);
}

/** Every command that supports break-lock must actually accept it (checks/.../advice.check.ts
 *  cross-references this against openclawCommands' own declarations). A command that does
 *  not passes `false` here (via guarded()'s own options) so the advice never names a flag it
 *  will then reject as unknown — pointing instead at one that does accept it. */
function breakLockAdvice(breakLockSupported: boolean): string {
  return breakLockSupported
    ? "take it over with --break-lock"
    : "this command does not accept --break-lock — run one that does (for example ./clawforge up --break-lock) to take it over";
}

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
  // of staleness — a crash seconds ago is just as dead as one thirty minutes ago, and the
  // reader should not have to wait out the clock to be told the process itself already is.
  const deadHere = isProvablyDeadHere(holder);
  // Facts, not a guess at how long an operation "should" take — `recipe install` holds this
  // lock across a whole build, which routinely runs longer than STALE_AFTER_MS on its own.
  lines.push(
    stale
      ? `not refreshed for ${humanAge(heartbeatAgeMs(holder, now))}.`
      : `refreshed ${humanShortAge(heartbeatAgeMs(holder, now))} ago — the operation is still running.`,
  );
  if (deadHere) {
    lines.push("Its recorded process is not running on this machine anymore — not a guess, the pid itself is gone.");
  }
  lines.push(
    stale || deadHere
      // --break-lock is only ever offered once one of the two facts above actually supports
      // it — a live, recently-refreshed holder is never told to break its own lock.
      ? `If you are sure nothing is running, ${breakLockAdvice(breakLockSupported)}.`
      : `Wait for it to finish, or run ./clawforge operations ${holder.operationId} to see what it is doing.`,
  );
  return lines.join("\n");
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

/** Options every lock-taking entry point threads through unchanged, down to the mutation
 *  guard that serializes the claim itself.
 *
 *  `breakLockSupported` is not something a caller decides per-call — it is a fact about which
 *  command is asking, set once at the command's own `guarded()`/`withLockUnlessHeld()` call
 *  site (default true; a command that genuinely does not accept --break-lock passes false so
 *  the refusal never names a flag it will then reject as unknown).
 *
 *  `breakForeignLockHost` is the exact host id an operator has confirmed as an orphaned
 *  mutation-guard owner's own machine (instance-mutation-guard.ts, runbook in
 *  docs/architecture.md) — never inferred, always typed out by a human. */
export interface LockOptions {
  readonly breakLock?: boolean;
  readonly breakLockSupported?: boolean;
  readonly breakForeignLockHost?: string;
}

/** Wins the lock directory, or takes over an existing one under --break-lock; never both silently. */
export async function acquireOrTakeOver(ctx: Context, options: LockOptions): Promise<void> {
  const claim = await claimDirectory(ctx);

  if (!claim.won && !claim.heldByOther) {
    // Not a lock at all: the mkdir could not run. --break-lock would remove a directory that
    // does not exist and then fail the same way, so it is not offered.
    die(
      `could not take the instance lock at ${lockPath(ctx)}: ${claim.detail === "" ? "mkdir failed" : claim.detail}\n` +
        `Nothing holds it — the directory is not there. ${lockHome(ctx)} has to exist and be writable ` +
        "by whoever runs this tooling; ./clawforge bootstrap prepares it.",
    );
  }

  if (claim.won) return;

  const existing = await readLockHolder(ctx);

  if (options.breakLock !== true) {
    // An existing directory with no readable holder is still someone's — a run that won
    // the directory and died before writing its name, most likely. Refusing on it is the
    // safe reading; proceeding would be assuming the best about a state nobody understands.
    die(
      existing === undefined
        ? unreadableLockMessage(ctx, options.breakLockSupported)
        : refusalMessage(existing, undefined, options.breakLockSupported),
    );
  }

  const takeover = await claimTakeover(ctx, existing?.generation);
  if (!takeover.won) {
    // Another caller's takeover — or a release — already changed what this path is between
    // the read above and this attempt. Moving it aside a second time would not be a claim,
    // so this run is refused exactly like a fresh claim against a directory that is still
    // there: whoever is now holding it is reported by re-running rather than guessed at.
    die(
      `could not take over the instance lock at ${lockPath(ctx)}: ${takeover.detail === "" ? "the lock changed during takeover" : takeover.detail}\n` +
        "Another operation already took it over. Re-run if the instance is still locked.",
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
    // Set at acquisition too, not left for the first tick: a lock must not spend its first
    // HEARTBEAT_INTERVAL_MS looking like a pre-heartbeat legacy record.
    heartbeatAt: takenAt,
  };
  return { generation, holder };
}

/** A fresh mkdir — an uncontested claim's own, or the one a won takeover just repeated —
 *  proves this process created the lock, but that proof is otherwise lost if writing
 *  holder.json fails. Keep an owner marker inside the directory so cleanup can still
 *  distinguish our incomplete claim from a lock that another process took over meanwhile. */
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
    // the marker alone — and by one atomic operation rather than a read followed by a
    // remove: between those two, a takeover could put a different owner's lock at this path,
    // and the cleanup would then delete a claim that is already live.
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
