// One instance, one change at a time.
//
// Several people can reach the same instance now — a coder, an agent through MCP, a cron
// job — and two applying at once is a real race: `apply` writes config, restarts, then
// re-provisions recipes over a window seconds long. Interleaved, the instance ends up in a
// state neither run planned, and both report success.
//
// The lock is a file on the target naming who has it and what they're doing — advisory
// (stops only commands that ask, but every mutating one does). A stale lock is REPORTED,
// never silently taken. Taking one over is `--break-lock`, deliberately not `--force` (which
// MCP sets automatically from the caller's confirm argument) — reusing that name would let
// every confirmed tool call take over any lock another operation was holding.
//
// On-disk primitives live in lock-claim.ts; this file adds reentrancy (chainLocks/
// heldScopes) and the HeldLock handle.

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

/** Which lock paths the current asynchronous chain holds. `apply` runs `provision-agent` as
 *  a step, which takes the lock on its own — without reentrancy recognition, apply would
 *  refuse itself. What nests is the chain: an operation's body runs inside the scope
 *  runOwning() gives it, and only a call about the same instance reads as reentrant. */
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

      // Only ours, checked with one operation instead of two: read-then-remove left a gap
      // where a takeover completing in between had its fresh lock deleted by a release that
      // read the old holder. Ownership is answered by moving this acquisition's own
      // generation marker aside — atomic, and only we can still own that exact path.
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
 *  in order: win or take over the directory, mint this acquisition's identity, stake its
 *  generation marker, publish holder.json, start its heartbeat, hand back the release handle. */
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
 *  hold until `body` settles. Releasing stays in the caller's own finally. `held === undefined`
 *  is the nested shape: the calling chain is already inside the owning operation's scope. */
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

/** Pulls the confirmed host id out of `--break-foreign-lock <hostId>` — see
 *  `breakForeignLockHost` on `LockOptions` (lock-claim.ts). Exported so the few direct
 *  `withLockUnlessHeld()`/`takeLock()` callers read it the same way `guarded()` does below. */
export function parseBreakForeignLockHost(args: string[]): string | undefined {
  const index = args.indexOf("--break-foreign-lock");
  return index === -1 ? undefined : args[index + 1];
}

/** What every mutating command wraps its work in: reads the takeover flags from argv so no
 *  caller has to pass them on. Nested calls are a no-op. `options.breakLockSupported` is the
 *  one thing a call site still states explicitly, for a command whose parser refuses
 *  --break-lock. */
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
