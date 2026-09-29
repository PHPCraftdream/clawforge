import { takeLock, readLockHolder, lockPath } from "#framework/runtime/lock/instance-lock.ts";
import { heartbeatScheduler } from "#framework/runtime/lock/heartbeat.ts";
import { withMutationGuard } from "#framework/security/instance-mutation-guard.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { stubContext, refused } from "./fixture.ts";

/** A manually released transport boundary. */
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const originalSchedule = heartbeatScheduler.schedule;
const originalCancel = heartbeatScheduler.cancel;
const ticks: (() => Promise<void>)[] = [];
heartbeatScheduler.schedule = (tick) => { ticks.push(tick); return {}; };
heartbeatScheduler.cancel = () => {};

try {
  // A refresh already writing keeps acquisition and release outside its transaction.
  {
    const { ctx, dirs } = stubContext();
    const heldA = await takeLock(ctx, "apply", "write-A");
    const tickA = ticks.at(-1)!;
    const started = barrier();
    const publish = barrier();
    const originalWrite = ctx.transport.writeFile;
    let refreshWrites = 0;
    ctx.transport.writeFile = async (path, content, mode) => {
      if (path === `${lockPath(ctx)}/holder.json`) {
        refreshWrites += 1;
        started.resolve();
        await publish.promise;
      }
      await originalWrite(path, content, mode);
    };

    const refresh = tickA();
    await started.promise;
    const overlappingRefresh = tickA();
    let releasedA = false;
    const releaseA = heldA.release().then(() => { releasedA = true; });
    let secondReleaseDone = false;
    const secondRelease = heldA.release().then(() => { secondReleaseDone = true; });
    check("a delayed heartbeat excludes even a break-lock acquisition",
      (await refused(() => takeLock(ctx, "apply", "blocked-B", { breakLock: true }))).includes("instance-lock change"), true);
    check("release waits for publication already in flight", releasedA, false);
    check("repeated release also waits for the active refresh", secondReleaseDone, false);
    check("pending publication leaves A's record readable", (await readLockHolder(ctx))?.operationId, "write-A");

    publish.resolve();
    await refresh;
    await overlappingRefresh;
    await releaseA;
    await secondRelease;
    check("only one overlapping heartbeat publishes", refreshWrites, 1);
    check("release drains and removes A's lock", dirs.has(lockPath(ctx)), false);
    ctx.transport.writeFile = originalWrite;
    const heldB = await takeLock(ctx, "apply", "write-B");
    await tickA();
    check("old callbacks cannot overwrite B after release", (await readLockHolder(ctx))?.operationId, "write-B");
    await heldB.release();
    check("B's release removes its lock", dirs.has(lockPath(ctx)), false);
  }

  // Cancellation after reading A suppresses its remaining publication.
  {
    const { ctx, dirs } = stubContext();
    const held = await takeLock(ctx, "apply", "read-A");
    const tick = ticks.at(-1)!;
    const read = barrier();
    const resume = barrier();
    const originalRead = ctx.transport.readFile;
    const originalWrite = ctx.transport.writeFile;
    let publications = 0;
    ctx.transport.readFile = async (path) => {
      const value = await originalRead(path);
      if (path === `${lockPath(ctx)}/holder.json`) {
        read.resolve();
        await resume.promise;
      }
      return value;
    };
    ctx.transport.writeFile = async (path, content, mode) => {
      if (path === `${lockPath(ctx)}/holder.json`) publications += 1;
      await originalWrite(path, content, mode);
    };
    const refresh = tick();
    await read.promise;
    const release = held.release();
    resume.resolve();
    await refresh;
    await release;
    check("release after generation read suppresses publication", publications, 0);
    check("a cancelled generation read leaves no lock", dirs.has(lockPath(ctx)), false);
  }

  // A guard acquisition pending across takeover must not publish the old owner.
  {
    const { ctx, dirs } = stubContext();
    const heldA = await takeLock(ctx, "apply", "guard-A");
    const tickA = ticks.at(-1)!;
    const waiting = barrier();
    const resume = barrier();
    const originalExec = ctx.transport.exec;
    const originalWrite = ctx.transport.writeFile;
    let pause = true;
    let oldPublications = 0;
    ctx.transport.exec = async (command, args, options) => {
      if (pause && command === "mkdir" && args.at(-1)?.endsWith("/operation.mutation")) {
        pause = false;
        waiting.resolve();
        await resume.promise;
      }
      return originalExec(command, args, options);
    };
    ctx.transport.writeFile = async (path, content, mode) => {
      if (path === `${lockPath(ctx)}/holder.json` && String(content).includes("guard-A")) oldPublications += 1;
      await originalWrite(path, content, mode);
    };
    const refresh = tickA();
    await waiting.promise;
    const releaseA = heldA.release();
    const heldB = await takeLock(ctx, "apply", "guard-B", { breakLock: true });
    resume.resolve();
    await refresh;
    await releaseA;
    check("a refresh waiting on the guard cannot publish after release", oldPublications, 0);
    check("release of the displaced owner preserves B", (await readLockHolder(ctx))?.operationId, "guard-B");
    await heldB.release();
    check("B releases after the cancelled guard acquisition", dirs.has(lockPath(ctx)), false);
  }

  // Contention skips this tick; the next tick retries without breaking the guard.
  {
    const { ctx } = stubContext();
    const heldA = await takeLock(ctx, "apply", "retry-A");
    const tickA = ticks.at(-1)!;
    const started = barrier();
    const resume = barrier();
    const originalWrite = ctx.transport.writeFile;
    let publications = 0;
    ctx.transport.writeFile = async (path, content, mode) => {
      if (path === `${lockPath(ctx)}/holder.json`) publications += 1;
      await originalWrite(path, content, mode);
    };
    const guarded = withMutationGuard(ctx, async () => { started.resolve(); await resume.promise; });
    await started.promise;
    await tickA();
    check("a heartbeat never breaks a live mutation guard", publications, 0);
    resume.resolve();
    await guarded;
    await tickA();
    check("a busy heartbeat retries successfully on its next tick", publications, 1);
    const heldB = await takeLock(ctx, "apply", "retry-B", { breakLock: true });
    await tickA();
    check("a displaced owner cannot refresh B", (await readLockHolder(ctx))?.operationId, "retry-B");
    await heldA.release();
    await heldB.release();
  }

  // Heartbeats have no authority to confirm a foreign guard takeover.
  {
    const { ctx, files, dirs } = stubContext();
    const held = await takeLock(ctx, "apply", "foreign-guard");
    const tick = ticks.at(-1)!;
    const guard = lockPath(ctx).replace(/operation\.lock$/, "operation.mutation");
    const foreignOwner = JSON.stringify({
      generation: "foreign", pid: 42, machine: "other-host:other-scope", takenAt: new Date().toISOString(),
    });
    dirs.add(guard);
    files.set(`${guard}/owner.json`, foreignOwner);
    const before = files.get(`${lockPath(ctx)}/holder.json`);
    await tick();
    check("heartbeat preserves an unverifiable foreign mutation owner", files.get(`${guard}/owner.json`), foreignOwner);
    check("heartbeat skips publication while a foreign guard holds", files.get(`${lockPath(ctx)}/holder.json`), before);
    await ctx.transport.remove(guard);
    await held.release();
  }

  // A failed publication still drains, returns the guard, and allows release to clean up.
  {
    const { ctx, dirs } = stubContext();
    const heldA = await takeLock(ctx, "apply", "failed-write-A");
    const tickA = ticks.at(-1)!;
    const started = barrier();
    const fail = barrier();
    const originalWrite = ctx.transport.writeFile;
    ctx.transport.writeFile = async (path, content, mode) => {
      if (path === `${lockPath(ctx)}/holder.json`) {
        started.resolve();
        await fail.promise;
        throw new Error("controlled heartbeat publication failure");
      }
      await originalWrite(path, content, mode);
    };
    const refresh = tickA();
    await started.promise;
    const releaseA = heldA.release();
    fail.resolve();
    await refresh;
    await releaseA;
    check("failed pending publication does not prevent release cleanup", dirs.has(lockPath(ctx)), false);
    ctx.transport.writeFile = originalWrite;
    const heldB = await takeLock(ctx, "apply", "failed-write-B");
    await tickA();
    check("failed old refresh cannot corrupt the next holder", (await readLockHolder(ctx))?.operationId, "failed-write-B");
    await heldB.release();
    check("next holder releases after a failed pending publication", dirs.has(lockPath(ctx)), false);
  }

  // Failure while claiming the heartbeat guard must not strand it or disable future ticks.
  {
    const { ctx, dirs } = stubContext();
    const held = await takeLock(ctx, "apply", "failed-guard");
    const tick = ticks.at(-1)!;
    const originalWrite = ctx.transport.writeFile;
    const guard = lockPath(ctx).replace(/operation\.lock$/, "operation.mutation");
    const before = await readLockHolder(ctx);
    ctx.transport.writeFile = async (path, content, mode) => {
      if (path.startsWith(`${guard}/`)) throw new Error("controlled heartbeat guard failure");
      await originalWrite(path, content, mode);
    };
    await tick();
    check("guard publication failure returns the mutation directory", dirs.has(guard), false);
    check("guard publication failure preserves the holder", (await readLockHolder(ctx))?.heartbeatAt, before?.heartbeatAt);
    ctx.transport.writeFile = originalWrite;
    const publishing = barrier();
    ctx.transport.writeFile = async (path, content, mode) => {
      await originalWrite(path, content, mode);
      if (path === `${lockPath(ctx)}/holder.json`) publishing.resolve();
    };
    const retry = tick();
    await publishing.promise;
    await retry;
    check("the retried heartbeat preserves ownership", (await readLockHolder(ctx))?.generation, held.holder.generation);
    await held.release();
    check("release cleans up after a failed guard and successful retry", dirs.has(lockPath(ctx)), false);
  }

} finally {
  heartbeatScheduler.schedule = originalSchedule;
  heartbeatScheduler.cancel = originalCancel;
}

finish("instance lock heartbeat lifecycle");
