// The holder refreshes its own record while it lives — the fix for STALE_AFTER_MS alone
// reading a long `recipe install` as abandoned mid-build. This file covers the refresh logic
// itself, heartbeat-based staleness against a legacy record's takenAt-only fallback, and that
// takeLock()/release() actually wire heartbeatScheduler rather than heartbeat.ts's functions
// only existing in isolation.
//
// No real waiting anywhere: heartbeatScheduler is swapped for a synchronous stand-in a check
// fires on demand, and every age comparison below takes an explicit `now` instead of the wall
// clock.

import {
  takeLock,
  readLockHolder,
  isStale,
  ageMs,
  heartbeatAgeMs,
  STALE_AFTER_MS,
  HEARTBEAT_STALE_AFTER_MS,
  type LockHolder,
} from "#framework/runtime/lock/instance-lock.ts";
import { heartbeatScheduler, refreshHeartbeat, startHeartbeat, HEARTBEAT_INTERVAL_MS } from "#framework/runtime/lock/heartbeat.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { stubContext } from "./fixture.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

/** Flushes pending microtasks (readHolder/writeHolder inside refreshHeartbeat) before a check
 *  reads their effect — a fire-and-forget scheduled tick is not awaited by design. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --- staleness reads the heartbeat once one exists, never just takenAt -------------------------

{
  const now = Date.now();
  const legacyFresh: LockHolder = { operationId: "op-1", what: "apply", by: "x", takenAt: new Date(now - 60_000).toISOString() };
  const legacyStale: LockHolder = { operationId: "op-2", what: "apply", by: "x", takenAt: new Date(now - STALE_AFTER_MS - 60_000).toISOString() };
  check("a legacy record with no heartbeatAt falls back to takenAt/STALE_AFTER_MS (fresh)", isStale(legacyFresh, now), false);
  check("...and the same fallback catches a genuinely old one", isStale(legacyStale, now), true);

  // The bug this whole file exists for: a build older than STALE_AFTER_MS that is still
  // refreshing its heartbeat must never read as abandoned.
  const longBuildLiveHeartbeat: LockHolder = {
    operationId: "op-3", what: "recipe install", by: "x",
    takenAt: new Date(now - STALE_AFTER_MS - 60_000).toISOString(),
    heartbeatAt: new Date(now - 5_000).toISOString(),
  };
  check("a record older than STALE_AFTER_MS is NOT stale once its heartbeat is recent", isStale(longBuildLiveHeartbeat, now), false);

  const heartbeatStopped: LockHolder = {
    operationId: "op-4", what: "recipe install", by: "x",
    takenAt: new Date(now - 20 * 60_000).toISOString(),
    heartbeatAt: new Date(now - HEARTBEAT_STALE_AFTER_MS - 60_000).toISOString(),
  };
  check("a record with a heartbeat is judged by how long it has gone quiet, not takenAt", isStale(heartbeatStopped, now), true);

  const heartbeatFresh: LockHolder = {
    operationId: "op-5", what: "recipe install", by: "x",
    takenAt: new Date(now - 20 * 60_000).toISOString(),
    heartbeatAt: new Date(now - HEARTBEAT_STALE_AFTER_MS + 60_000).toISOString(),
  };
  check("just under the heartbeat threshold still reads as live", isStale(heartbeatFresh, now), false);
}

// --- ageMs stays "since takenAt"; heartbeatAgeMs is the separate, new signal --------------------

{
  const now = Date.now();
  const holder: LockHolder = {
    operationId: "op-6", what: "apply", by: "x",
    takenAt: new Date(now - 3 * 60_000).toISOString(), heartbeatAt: new Date(now - 5_000).toISOString(),
  };
  check("ageMs still measures since takenAt, not the heartbeat", ageMs(holder, now) > 2 * 60_000, true);
  check("heartbeatAgeMs measures since the heartbeat instead", heartbeatAgeMs(holder, now) < 60_000, true);
}

// --- refreshHeartbeat only ever touches a holder it still owns ----------------------------------

{
  const ctx = {} as Context;
  let written: LockHolder | undefined;
  const ownHolder: LockHolder = { operationId: "op-7", what: "apply", by: "x", takenAt: new Date().toISOString(), generation: "gen-a" };

  await refreshHeartbeat(ctx, "gen-a", async () => ownHolder, async (_c, holder) => { written = holder; });
  check("a matching generation gets a fresh heartbeatAt", typeof written?.heartbeatAt, "string");
  check("everything else about the holder is preserved", written?.operationId, "op-7");

  written = undefined;
  await refreshHeartbeat(ctx, "gen-a", async () => ({ ...ownHolder, generation: "gen-b" }), async (_c, holder) => { written = holder; });
  check("a generation a takeover rotated out is never rewritten", written, undefined);

  written = undefined;
  await refreshHeartbeat(ctx, "gen-a", async () => undefined, async (_c, holder) => { written = holder; });
  check("no current holder at all is also a no-op, not a crash", written, undefined);
}

// --- startHeartbeat wires heartbeatScheduler, swallows a failure, logs only the first -----------

{
  const originalSchedule = heartbeatScheduler.schedule;
  const originalCancel = heartbeatScheduler.cancel;
  let scheduledMs: number | undefined;
  let tick: (() => void) | undefined;
  const fakeTimer = {} as NodeJS.Timeout;
  heartbeatScheduler.schedule = (fn: () => void, ms: number) => { scheduledMs = ms; tick = fn; return fakeTimer; };
  heartbeatScheduler.cancel = () => {};

  try {
    let calls = 0;
    const ctx = {} as Context;
    const timer = startHeartbeat(ctx, "gen-c", async () => ({
      operationId: "op-8", what: "apply", by: "x", takenAt: new Date().toISOString(), generation: "gen-c",
    }), async () => { calls += 1; throw new Error("boom"); });

    check("startHeartbeat schedules on HEARTBEAT_INTERVAL_MS", scheduledMs, HEARTBEAT_INTERVAL_MS);
    check("and returns exactly the scheduler's own timer handle", timer, fakeTimer);

    const previousDebug = process.env.OC_DEBUG;
    process.env.OC_DEBUG = "1";
    let logged = "";
    await withOutputSink((chunk) => { logged += chunk; }, async () => {
      tick?.();
      tick?.();
      await flush();
    });
    if (previousDebug === undefined) delete process.env.OC_DEBUG; else process.env.OC_DEBUG = previousDebug;

    check("a failing refresh never throws out of the scheduled tick", calls, 2);
    const occurrences = logged.split("heartbeat refresh failed").length - 1;
    check("only the first failure is logged", occurrences, 1);
  } finally {
    heartbeatScheduler.schedule = originalSchedule;
    heartbeatScheduler.cancel = originalCancel;
  }
}

// --- end to end: takeLock()/release() actually start and stop a real heartbeat ------------------

{
  const originalSchedule = heartbeatScheduler.schedule;
  const originalCancel = heartbeatScheduler.cancel;
  let scheduled = 0;
  let cancelled = 0;
  let tick: (() => void) | undefined;
  heartbeatScheduler.schedule = (fn: () => void) => { scheduled += 1; tick = fn; return {} as NodeJS.Timeout; };
  heartbeatScheduler.cancel = () => { cancelled += 1; };

  try {
    const { ctx } = stubContext();
    let writes = 0;
    const originalWriteFile = ctx.transport.writeFile;
    ctx.transport.writeFile = async (path: string, content: string | Uint8Array, mode?: string) => {
      writes += 1;
      return originalWriteFile(path, content, mode);
    };

    // Two writes to win a fresh claim: the mutation guard's own owner-claim file (temp +
    // link, instance-mutation-guard.ts) and the instance lock's holder.json.
    const held = await takeLock(ctx, "recipe install", "op-9");
    const afterClaim = writes;
    check("taking the lock writes both the guard's owner file and the holder record", afterClaim, 2);
    check("and starts exactly one heartbeat", scheduled, 1);

    tick?.();
    await flush();
    check("a real tick writes the holder record again — the heartbeat refresh", writes, afterClaim + 1);
    check("the refreshed record is still readable and still this generation's", (await readLockHolder(ctx))?.operationId, "op-9");

    await held.release();
    check("releasing stops the heartbeat", cancelled, 1);
  } finally {
    heartbeatScheduler.schedule = originalSchedule;
    heartbeatScheduler.cancel = originalCancel;
  }
}

finish("instance lock heartbeat");
