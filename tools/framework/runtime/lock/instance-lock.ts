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
//
// The on-disk primitives (holder shape, staleness maths, directory claim/takeover/publish
// steps) live in lock-claim.ts, same directory — this file adds reentrancy (chainLocks/
// heldScopes below) and the released HeldLock handle on top, and re-exports what callers use.

import { AsyncLocalStorage } from "node:async_hooks";

import { withMutationGuard } from "../../security/instance-mutation-guard.ts";
import { newOperationId } from "../../service/operations.ts";
import { heartbeatScheduler, startHeartbeat, type TimerHandle } from "./heartbeat.ts";
import {
  type LockHolder,
  type LockOptions,
  STALE_AFTER_MS,
  HEARTBEAT_STALE_AFTER_MS,
  lockHome,
  lockPath,
  writeHolderRecord,
  claimOwnedLockDirectory,
  removeOwnedLock,
  readLockHolder,
  ageMs,
  heartbeatAgeMs,
  isStale,
  refusalMessage,
  unreadableLockMessage,
  acquireOrTakeOver,
  mintHolder,
  claimGenerationMarker,
  writeHolderOrRollback,
} from "./lock-claim.ts";
import type { Context } from "../../core/context.ts";

export {
  STALE_AFTER_MS,
  HEARTBEAT_STALE_AFTER_MS,
  lockHome,
  lockPath,
  readLockHolder,
  ageMs,
  heartbeatAgeMs,
  isStale,
  refusalMessage,
  unreadableLockMessage,
};
export type { LockHolder, LockOptions };

export interface HeldLock {
  readonly holder: LockHolder;
  /** The resource this lock is on — what reentrancy is recognised by. */
  readonly path: string;
  readonly resource: string;
  release(): Promise<void>;
}

/** Stable resource identity for reentrancy: equal paths on different transports are different targets. */
function lockResource(ctx: Context): string {
  return `${ctx.transport.description}\u0000${lockPath(ctx)}`;
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

/** Assembles the handle a caller releases; release() closes over this acquisition's own generation. */
function buildHeldLock(ctx: Context, holder: LockHolder, generation: string, heartbeatTimer: TimerHandle): HeldLock {
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
      heartbeatScheduler.cancel(heartbeatTimer);

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
      try {
        await withMutationGuard(ctx, async () => {
          const trash = await claimOwnedLockDirectory(ctx, generation);
          if (trash !== undefined) await removeOwnedLock(ctx, generation, trash);
        });
      } catch {
        // A lock that cannot be removed becomes a stale one, which is reported and can be
        // forced. Failing the operation here would be worse: the work is already done.
      }
    },
  };
  return handle;
}

/** Takes the lock for the duration of an operation, or refuses. Each step (lock-claim.ts) runs
 *  in the order a claim actually has to happen in: win or take over the directory, mint this
 *  acquisition's identity, stake its generation marker, publish holder.json, start its
 *  heartbeat, hand back the handle that releases it. */
async function takeLockClaim(
  ctx: Context,
  what: string,
  operationId: string,
  options: LockOptions = {},
): Promise<HeldLock> {
  await acquireOrTakeOver(ctx, options);

  const { generation, holder } = mintHolder(what, operationId);
  await claimGenerationMarker(ctx, generation);
  await writeHolderOrRollback(ctx, generation, holder);

  // Refreshes heartbeatAt on an interval for as long as this acquisition is held — the fix
  // for STALE_AFTER_MS alone reading a live `recipe install` as abandoned mid-build.
  const heartbeatTimer = startHeartbeat(ctx, generation, readLockHolder, writeHolderRecord);

  return buildHeldLock(ctx, holder, generation, heartbeatTimer);
}

/** Serializes every path-changing claim from the initial read through holder publication. */
export async function takeLock(
  ctx: Context,
  what: string,
  operationId: string,
  options: LockOptions = {},
): Promise<HeldLock> {
  return withMutationGuard(
    ctx,
    () => takeLockClaim(ctx, what, operationId, options),
    options.breakLock === true,
    options.breakForeignLockHost,
  );
}

/** Runs `body` holding the lock, and releases it whatever happens — including when the body
 *  throws, which is the case that matters: a failed operation that keeps the lock blocks the
 *  very command someone would run next to fix it. */
export async function withInstanceLock<T>(
  ctx: Context,
  what: string,
  operationId: string,
  options: LockOptions,
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
 *  --previous-set`, `set forget` under `apply` — each takes the lock when someone invoked
 *  it directly and rides its caller's when it runs as a step. */
export async function withLockUnlessHeld<T>(
  ctx: Context,
  what: string,
  operationId: string,
  options: LockOptions,
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

/** Pulls the confirmed host id out of `--break-foreign-lock <hostId>`, for the commands that
 *  parse their own argv well enough to leave it in place — see the `breakForeignLockHost` doc
 *  on `LockOptions` (lock-claim.ts) and instance-mutation-guard.ts. Exported so the few direct
 *  `withLockUnlessHeld()`/`takeLock()` callers (apply.ts, provision-agent, set.ts) read it the
 *  same way `guarded()` does below. */
export function parseBreakForeignLockHost(args: string[]): string | undefined {
  const index = args.indexOf("--break-foreign-lock");
  return index === -1 ? undefined : args[index + 1];
}

/** What every mutating command wraps its work in.
 *
 *  A lock only two commands respected was a lock in name: `apply` took it while `restart`,
 *  `apply-config` and `push` changed the same instance beside it, which is the interleaving
 *  it exists to prevent. This is the one line each of them needs, and it reads the takeover
 *  flags from that command's own argv so no caller has to remember to pass them on.
 *
 *  Nested calls are a no-op: `apply` runs several of these commands as its steps and is
 *  already holding the lock, so acquiring again would refuse the run that started them.
 *
 *  `options.breakLockSupported` is the one thing a call site still states explicitly: a
 *  command whose own parser refuses --break-lock (backup, secrets, the internal smoke
 *  round-trip step) passes false so its refusal never offers a flag it cannot accept.
 *  configure-provider used to be in that list too; it now threads --break-lock like every
 *  other ordinary lock-taking command. */
export async function guarded<T>(
  ctx: Context,
  what: string,
  args: string[],
  body: () => Promise<T>,
  options: { breakLockSupported?: boolean } = {},
): Promise<T> {
  return withLockUnlessHeld(
    ctx,
    what,
    newOperationId(what),
    {
      breakLock: args.includes("--break-lock"),
      breakLockSupported: options.breakLockSupported,
      breakForeignLockHost: parseBreakForeignLockHost(args),
    },
    body,
  );
}
