// The holder refreshes its own lock record while it lives, so a build that legitimately runs
// past STALE_AFTER_MS is never read as abandoned — only a stopped heartbeat means that now
// (isStale in instance-lock.ts reads heartbeatAt over takenAt once a record has one).
//
// Dependency-injected rather than importing instance-lock.ts's own readLockHolder/holderPath:
// this module only needs "read the current holder" and "write it back", and taking those as
// parameters keeps the two files from importing each other's values.

import { info } from "../../core/io/log.ts";
import type { Context } from "../../core/context.ts";
import type { LockHolder } from "./instance-lock.ts";

/** How often the holder rewrites heartbeatAt. Far below HEARTBEAT_STALE_AFTER_MS (instance-
 *  lock.ts) so a handful of missed writes in a row still reads as alive. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Swappable for checks: a real 30s interval has no place in a fast, deterministic unit check
 *  — the same "swappable for checks" idiom as process-identity.ts's platformProbes. A check
 *  replaces `schedule` with a synchronous stand-in it fires on demand, and asserts `cancel`
 *  runs when the lock is released. */
export const heartbeatScheduler = {
  schedule(tick: () => void, intervalMs: number): TimerHandle {
    const timer = setInterval(tick, intervalMs);
    // Never keeps the process alive on its own — a command that finished its real work must
    // not hang around for a lock heartbeat.
    timer.unref();
    return timer;
  },
  cancel(timer: TimerHandle): void {
    clearInterval(timer as Parameters<typeof clearInterval>[0]);
  },
};

/** Opaque timer handle: keeps `@types/node` out of the published typings. */
export type TimerHandle = object;

export type ReadHolder = (ctx: Context) => Promise<LockHolder | undefined>;
export type WriteHolder = (ctx: Context, holder: LockHolder) => Promise<void>;

/** Rewrites the holder's heartbeatAt — atomically, since `writeHolder` is expected to be
 *  transport.writeFile underneath — and only once `readHolder` proves `generation` still
 *  owns the lock: a takeover's fresh holder must never be overwritten by a heartbeat that
 *  started before the takeover landed. */
export async function refreshHeartbeat(
  ctx: Context,
  generation: string,
  readHolder: ReadHolder,
  writeHolder: WriteHolder,
): Promise<void> {
  const current = await readHolder(ctx);
  if (current === undefined || current.generation !== generation) return;
  await writeHolder(ctx, { ...current, heartbeatAt: new Date().toISOString() });
}

/** Starts the holder's own heartbeat on heartbeatScheduler's interval. A refresh failure is
 *  swallowed — the lock must never crash the command over a heartbeat write — and only the
 *  first one is logged, at debug level, since every one after it restates the same fact. */
export function startHeartbeat(
  ctx: Context,
  generation: string,
  readHolder: ReadHolder,
  writeHolder: WriteHolder,
): TimerHandle {
  let failureLogged = false;
  return heartbeatScheduler.schedule(() => {
    refreshHeartbeat(ctx, generation, readHolder, writeHolder).catch((error: unknown) => {
      if (failureLogged) return;
      failureLogged = true;
      if (process.env.OC_DEBUG === "1") {
        const message = error instanceof Error ? error.message : String(error);
        info(`instance lock heartbeat refresh failed — retrying silently from here on: ${message}`);
      }
    });
  }, HEARTBEAT_INTERVAL_MS);
}
