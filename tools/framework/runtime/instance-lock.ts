// One instance, one change at a time.
//
// Several people can reach the same instance now, and not all of them are people: a coder in
// a terminal, an agent through the MCP surface, a cron job on the gateway itself. Two of
// them applying at once is not a rare race — `apply` writes a configuration, restarts, then
// re-provisions recipes, and the window between those steps is seconds long. Interleaved,
// the instance ends up in a state neither run planned, both runs report success, and the
// journal shows two tidy records of it.
//
// The lock is a file on the target holding who has it and what they are doing, because that
// is the only place both of them can see. It is advisory in the sense that it only stops
// commands that ask — but every mutating command does ask, and nothing outside this
// framework is trying to apply a declaration to this instance.
//
// A stale lock is REPORTED, never silently taken. Silently stealing a lock is the same bug
// one layer down: the run that lost it had no idea, and now two of them are writing again.
// Whoever is looking at the message can see whether that process is really gone.
//
// Taking one over is `--break-lock`, and deliberately not `--force`. `--force` already means
// "yes, I mean it" for a destructive command, and the MCP layer sets it automatically from
// the caller's confirm argument — there being no terminal prompt to answer. Reusing that name
// here would have made every confirmed tool call take over whatever lock another operation
// was holding: two different permissions collapsed into one, and the more dangerous one
// granted by default.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import { locksDir } from "../core/env.ts";
import { log, die } from "../core/log.ts";
import { newOperationId } from "../service/operations.ts";
import type { Context } from "../core/context.ts";

/** After this, a lock is described as stale — long enough that no ordinary operation is
 *  still holding it (`apply` on a slow target is minutes, not tens of them) and short
 *  enough that a crashed run does not block the instance for a working day. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

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
}

/** The lock itself is a DIRECTORY, and that is the whole mechanism.
 *
 *  Creating a directory that already exists fails, atomically, on every POSIX filesystem —
 *  and the same one command works through wsl.exe and ssh, which is where an atomic
 *  primitive is otherwise hard to come by. Read-then-write, which this used to be, lets two
 *  runs starting together both conclude the lock was free; the window is small and entirely
 *  real, and it is the only thing standing between two coders.
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

/** Stable resource identity for reentrancy: equal paths on different transports are different targets. */
function lockResource(ctx: Context): string {
  return `${ctx.transport.description}\u0000${lockPath(ctx)}`;
}

function holderPath(ctx: Context): string {
  return `${lockPath(ctx)}/holder.json`;
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

/** Removes only an empty directory; another owner's contents must survive. */
async function removeEmptyDirectory(ctx: Context, path: string): Promise<void> {
  if (ctx.transport.removeEmptyDir !== undefined) {
    await ctx.transport.removeEmptyDir(path).catch(() => {});
    return;
  }
  await ctx.transport.exec("rmdir", [path], { allowFailure: true });
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
async function claimOwnedLockDirectory(ctx: Context, generation: string): Promise<string | undefined> {
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
async function removeOwnedLock(ctx: Context, generation: string, trash: string): Promise<void> {
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

/** Wins a takeover by winning a fresh `mkdir`, the same primitive an uncontested claim wins.
 *
 *  Writing a new `holder.json` into a directory both callers merely saw already existing is
 *  not a claim: nothing stops two concurrent `--break-lock` callers from each reading the old
 *  holder, each removing its marker, and each then writing theirs. The second only renames
 *  who the winner is — the first has already started running its body with no lease left to
 *  check when the second overwrites it.
 *
 *  `rename` is atomic on every filesystem this reaches, so of several callers racing to move
 *  the SAME source path away, at most one succeeds; the rest find it already gone and are
 *  refused. The winner then takes an ordinary fresh `mkdir` of the now-empty path, so a
 *  takeover ends up on the identical, already-atomic path a first claim takes — there is no
 *  moment where two processes both believe they hold the directory.
 *
 *  Atomic is not the same as identified, though, and this is the caller that found the gap:
 *  a `mv` of a PATH proves nothing about WHICH lock that path held a moment earlier. B reads
 *  the old holder and pauses before its move; A takes the lock over properly and is running
 *  its body; B resumes, moves A's LIVE lock aside, mkdirs its own, and both are inside the
 *  critical section. So the move is followed by a compare-and-swap: the holder inside the
 *  displaced directory must be the one observed before the move, generation for generation.
 *  A different generation means the path was re-created between that read and this move —
 *  the displaced directory is somebody else's live lock, it is put back exactly as it was,
 *  and the caller is refused the same way a lost move is. */
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

export function ageMs(holder: LockHolder, now = Date.now()): number {
  const taken = Date.parse(holder.takenAt);
  return Number.isNaN(taken) ? 0 : now - taken;
}

export function isStale(holder: LockHolder, now = Date.now()): boolean {
  return ageMs(holder, now) > STALE_AFTER_MS;
}

function humanAge(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute(s)`;
  return `${Math.floor(minutes / 60)} hour(s)`;
}

/** The message a blocked run gets. Exported so the checks can assert what it tells the
 *  reader — a refusal that does not say who holds the lock leaves them with nothing to do
 *  but delete files and hope. */
export function refusalMessage(holder: LockHolder, now = Date.now()): string {
  const age = ageMs(holder, now);
  const lines = [
    `another operation is changing this instance: ${holder.what} (${holder.operationId})`,
    `started by ${holder.by}, ${humanAge(age)} ago`,
  ];
  if (isStale(holder, now)) {
    // Described, not acted on. Whoever is reading can tell whether that run is really gone;
    // this process cannot.
    lines.push(
      "That is longer than any operation should take, so it may be left over from a run that died.",
      "If you are sure nothing is running, take it over with --break-lock.",
    );
  } else {
    lines.push("Wait for it to finish, or --break-lock if you are sure it is not running.");
  }
  return lines.join("\n");
}

/** Held by something that never said what it was. Worth its own message: the reader needs to
 *  know there is no name to look for, rather than assuming the report lost it. */
export function unreadableLockMessage(ctx: Context): string {
  return [
    `this instance is locked by an operation that did not record who it is (${lockPath(ctx)})`,
    "Most likely a run that won the lock and stopped before naming itself.",
    "If you are sure nothing is running, take it over with --break-lock.",
  ].join("\n");
}

export interface HeldLock {
  readonly holder: LockHolder;
  /** The resource this lock is on — what reentrancy is recognised by. */
  readonly path: string;
  readonly resource: string;
  release(): Promise<void>;
}

/** Which lock paths the current asynchronous chain holds.
 *
 *  `apply` runs `provision-agent` as one of its steps, and that command takes the lock when
 *  invoked on its own. Without reentrancy recognition, an apply would be refused by its own
 *  lock, at its own fourth step, with a message accusing itself. The old answer was a
 *  process-global counter, and the counter knew too little: it could not tell a nested call
 *  of the current operation from an independent asynchronous chain that happens to run in
 *  the same process, and it was not tied to the instance being locked — the commands `set
 *  try` runs against its throwaway instance rode the outer operation's count and ran
 *  unlocked. What nests is the chain: an operation's body runs inside the chain scope
 *  runOwning() gives it, and only a call about the same instance reads as reentrant. The
 *  alternative — passing a "nested" flag down through every runner — spreads a fact about
 *  this process across the signatures of commands that otherwise have nothing to do with
 *  locking. */
interface LockLease {
  released: boolean;
}

const chainLocks = new AsyncLocalStorage<Map<string, LockLease>>();
const heldScopes = new WeakMap<HeldLock, { scope: Map<string, LockLease>; lease: LockLease }>();

/** Whether the current asynchronous chain already holds this instance's lock. */
export function lockHeldHere(ctx: Context): boolean {
  const lease = chainLocks.getStore()?.get(lockResource(ctx));
  return lease !== undefined && lease.released !== true;
}

/** Takes the lock for the duration of an operation, or refuses. */
export async function takeLock(
  ctx: Context,
  what: string,
  operationId: string,
  options: { breakLock?: boolean } = {},
): Promise<HeldLock> {
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

  if (!claim.won) {
    const existing = await readLockHolder(ctx);

    if (options.breakLock !== true) {
      // An existing directory with no readable holder is still someone's — a run that won
      // the directory and died before writing its name, most likely. Refusing on it is the
      // safe reading; proceeding would be assuming the best about a state nobody understands.
      die(existing === undefined ? unreadableLockMessage(ctx) : refusalMessage(existing));
    }

    const takeover = await claimTakeover(ctx, existing?.generation);
    if (!takeover.won) {
      // Another caller's takeover — or a release — already changed what this path is between
      // the read above and this attempt. Moving it aside a second time would not be a claim,
      // so this run is refused exactly like a fresh claim against a directory that is still
      // there: whoever is now holding it is reported by re-running rather than guessed at.
      die(
        `could not take over the instance lock at ${lockPath(ctx)}: ${takeover.detail === "" ? "mv failed" : takeover.detail}\n` +
          "Another operation already took it over. Re-run if the instance is still locked.",
      );
    }

    log(
      existing === undefined
        ? "taking over a lock whose holder could not be read — --break-lock"
        : `taking over the lock held by ${existing.what} (${existing.operationId}) — --break-lock`,
    );
  }

  // The identity of this acquisition: a fresh random generation, minted before the first
  // command of the claim so every step below can name exactly which lock directory this is.
  // Holding the path is not holding the lock — a path can be re-created underneath whoever
  // took it, which is what claimTakeover now guards against.
  const generation = randomBytes(12).toString("hex");

  const holder: LockHolder = {
    operationId,
    what,
    by: `${process.env.USERNAME ?? process.env.USER ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown"} pid ${process.pid}`,
    takenAt: new Date().toISOString(),
    generation,
  };

  // A fresh mkdir — an uncontested claim's own, or the one a won takeover just repeated —
  // proves this process created the lock, but that proof is otherwise lost if writing
  // holder.json fails. Keep an owner marker inside the directory so cleanup can still
  // distinguish our incomplete claim from a lock that another process took over meanwhile.
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

  try {
    await ctx.transport.writeFile(holderPath(ctx), `${JSON.stringify(holder, null, 2)}\n`);
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
  let released = false;
  const resource = lockResource(ctx);
  let handle: HeldLock;
  handle = {
    holder,
    path: lockPath(ctx),
    resource,
    async release(): Promise<void> {
      if (released) return;
      released = true;

      const binding = heldScopes.get(handle);
      if (binding !== undefined) {
        binding.lease.released = true;
        if (binding.scope.get(resource) === binding.lease) binding.scope.delete(resource);
        heldScopes.delete(handle);
      }

      // Only ours, and checked with one operation instead of two. Reading the holder and
      // then removing the directory left the whole gap open: a takeover completing between
      // those two steps had its fresh lock deleted by the release that read the old holder.
      // So ownership is answered by moving this acquisition's own generation marker aside —
      // atomic, and only we can still own that exact path. A marker already moved away means
      // a takeover rotated this identity out and the directory is somebody else's: nothing is
      // touched, down to the holder file naming who it belongs to now.
      const trash = await claimOwnedLockDirectory(ctx, generation);
      if (trash === undefined) return;
      try {
        await removeOwnedLock(ctx, generation, trash);
      } catch {
        // A lock that cannot be removed becomes a stale one, which is reported and can be
        // forced. Failing the operation here would be worse: the work is already done.
      }
    },
  };
  return handle;
}

/** Runs `body` holding the lock, and releases it whatever happens — including when the body
 *  throws, which is the case that matters: a failed operation that keeps the lock blocks the
 *  very command someone would run next to fix it. */
export async function withInstanceLock<T>(
  ctx: Context,
  what: string,
  operationId: string,
  options: { breakLock?: boolean },
  body: () => Promise<T>,
): Promise<T> {
  const held = await takeLock(ctx, what, operationId, options);
  try {
    return await runOwning(held, body);
  } finally {
    await held.release();
  }
}

/** Runs `body` as the chain that owns `held`'s lock: everything `body` calls recognises the
 *  hold, and the recognition ends when `body` settles. Releasing stays where it already was
 *  — the caller's own finally — so the paths in and out of `body` are exactly the paths the
 *  caller wrote. `held === undefined` is the nested shape: the calling chain is already
 *  inside the owning operation's scope, so there is nothing to register. */
export async function runOwning<T>(held: HeldLock | undefined, body: () => Promise<T>): Promise<T> {
  if (held === undefined) return body();
  const scope = new Map(chainLocks.getStore() ?? []);
  const lease: LockLease = { released: false };
  scope.set(held.resource, lease);
  heldScopes.set(held, { scope, lease });
  try {
    return await chainLocks.run(scope, body);
  } finally {
    lease.released = true;
    if (scope.get(held.resource) === lease) scope.delete(held.resource);
    if (heldScopes.get(held)?.scope === scope) heldScopes.delete(held);
  }
}

/** The command-level shape: hold the lock for the duration of `body` unless the calling
 *  chain already does. `provision-agent` under `apply`, `apply --set` under `rollback
 *  --set`, `set forget` under `apply` — each takes the lock when someone invoked it
 *  directly and rides its caller's when it runs as a step. */
export async function withLockUnlessHeld<T>(
  ctx: Context,
  what: string,
  operationId: string,
  options: { breakLock?: boolean },
  body: () => Promise<T>,
): Promise<T> {
  if (lockHeldHere(ctx)) return body();
  const held = await takeLock(ctx, what, operationId, options);
  try {
    return await runOwning(held, body);
  } finally {
    await held.release();
  }
}

/** What every mutating command wraps its work in.
 *
 *  A lock only two commands respected was a lock in name: `apply` took it while `restart`,
 *  `apply-config` and `push` changed the same instance beside it, which is the interleaving
 *  it exists to prevent. This is the one line each of them needs, and it reads the takeover
 *  flag from that command's own argv so no caller has to remember to pass it on.
 *
 *  Nested calls are a no-op: `apply` runs several of these commands as its steps and is
 *  already holding the lock, so acquiring again would refuse the run that started them. */
export async function guarded<T>(ctx: Context, what: string, args: string[], body: () => Promise<T>): Promise<T> {
  return withLockUnlessHeld(ctx, what, newOperationId(what), { breakLock: args.includes("--break-lock") }, body);
}
