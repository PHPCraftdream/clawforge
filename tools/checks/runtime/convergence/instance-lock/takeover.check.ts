// A takeover is where the lock's atomicity is easiest to lose: the directory already exists,
// so winning it is not "the mkdir that succeeds" the way a fresh claim is. These checks cover
// a stale lock being described rather than silently taken, a takeover's holder surviving the
// run it displaced, two `--break-lock` callers racing the same contested directory with only
// one allowed to actually enter the body, and — the two cases the generation CAS exists for —
// a pathname re-created underneath a caller that had read it, and a release whose remove runs
// after a takeover has finished.

import { hostname } from "node:os";
import { machineName, localLiveness } from "#framework/runtime/lock/process-identity.ts";
import { takeLock, withInstanceLock, readLockHolder, isStale, lockPath, guardedWith, STALE_AFTER_MS, heartbeatAgeMs } from "#framework/runtime/lock/instance-lock.ts";
import { breakLockAdvice, staleHeartbeatLine, TAKEOVER_LOST_LINE } from "#framework/runtime/lock/lock-claim.ts";
import { mutationBusyMessage, foreignTakeoverBy } from "#framework/security/instance-mutation-guard.ts";
import { stubContext, refused } from "./fixture.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

function mutationGuardPath(ctx: Context): string {
  return `${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`;
}

// --- stale locks are described, not stolen ------------------------------------------------------

{
  const { ctx, files, dirs } = stubContext();
  const old = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString();
  dirs.add(lockPath(ctx));
  files.set(`${lockPath(ctx)}/holder.json`, JSON.stringify({ operationId: "op-dead", what: "apply", by: "someone", takenAt: old }));

  const holder = (await readLockHolder(ctx))!;
  check("a long-held lock is recognised as stale", isStale(holder), true);

  const message = await refused(() => takeLock(ctx, "apply", "op-new"));
  check("but it still refuses rather than taking it", message !== "", true);
  check("saying it has not been refreshed", message.includes(staleHeartbeatLine(heartbeatAgeMs(holder))), true);
  check("and that the reader is the one who decides", message.includes("--break-lock"), true);
  check("the dead holder is still in place", (await readLockHolder(ctx))?.operationId, "op-dead");

  const taken = await takeLock(ctx, "apply", "op-new", { breakLock: true });
  check("--break-lock takes it over", (await readLockHolder(ctx))?.operationId, "op-new");
  await taken.release();
}

// --- abandoned mutation guards are recoverable only when their owner is known dead -----------

{
  const { ctx, files, dirs } = stubContext();
  const guard = `${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "dead", pid: 99999999, machine, takenAt: new Date(0).toISOString() }));

  const held = await takeLock(ctx, "apply", "op-after-crash");
  check("a guard owned by a dead local process is recovered automatically", (await readLockHolder(ctx))?.operationId, "op-after-crash");
  await held.release();
  check("recovery leaves no stale guard artifacts", [...files.keys()].some((path) => path.includes("operation.mutation/")), false);
}

{
  const { ctx, files, dirs } = stubContext();
  const guard = `${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "dead", pid: 99999999, machine, takenAt: new Date(0).toISOString() }));
  const listingFailure = "guard listing failed";
  ctx.transport.listFiles = async () => { throw new Error(listingFailure); };

  const message = await refused(() => takeLock(ctx, "apply", "op-list-failure"));
  check("a guard listing failure is reported, not treated as no claims", message.includes(listingFailure), true);
  check("listing failure preserves the original guard owner", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "dead");
  check("listing failure removes its temporary claim", [...files.keys()].some((path) => path.includes(".claim-")), false);
}

{
  const { ctx, files, dirs } = stubContext();
  const guard = `${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "live", pid: process.pid, machine, takenAt: new Date().toISOString() }));

  const message = await refused(() => takeLock(ctx, "apply", "op-must-wait", { breakLock: true }));
  check("--break-lock cannot break a live mutation guard", message, mutationBusyMessage(guard, { generation: "live", pid: process.pid, machine, takenAt: "" }).message);
  check("a live guard is left untouched", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "live");
  check("a refused live guard creates no instance lock", dirs.has(lockPath(ctx)), false);
}

{
  const { ctx, files, dirs } = stubContext();
  const guard = `${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "remote", pid: 99999999, machine: `${machine}-other`, takenAt: new Date().toISOString() }));

  const message = await refused(() => takeLock(ctx, "apply", "op-unverifiable", { breakLock: true }));
  check("--break-lock keeps a guard owned by an unverifiable host", message, mutationBusyMessage(guard, { generation: "remote", pid: 99999999, machine: `${machine}-other`, takenAt: "" }).message);
  check("an unverifiable guard is not replaced", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "remote");
  // The recovery path from here is --break-foreign-lock, not --break-lock — the refusal
  // names the exact flag, the recorded host id, and the runbook that says how to verify first.
  check("and the refusal names the flag that actually recovers this", message.includes("--break-foreign-lock"), true);
  check("naming the recorded host id to confirm", message.includes(`${machine}-other`), true);
  check("and the runbook", message.includes("docs/architecture.md"), true);
}

// --- an explicit, host-confirmed takeover of a foreign guard --------------------------------
//
// Plain --break-lock never breaks a foreign owner (proven above: "an unverifiable guard is not
// replaced"). --break-foreign-lock <hostId> is the separate, explicit path: it must refuse on
// any host id that does not match the recorded owner's machine exactly, take over only on an
// exact match, and leave a durable, readable record of who did it, when, and which foreign
// owner it replaced — since the guard directory itself is gone once the takeover completes.

{
  const { ctx, files, dirs } = stubContext();
  const home = lockPath(ctx).replace(/\/operation\.lock$/, "");
  const guard = `${home}/operation.mutation`;
  const machine = machineName();
  const foreignOwner = { generation: "remote", pid: 424242, machine: `${machine}-other`, takenAt: new Date().toISOString() };
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify(foreignOwner));

  const message = await refused(() =>
    takeLock(ctx, "apply", "op-wrong-host", { breakLock: true, breakForeignLockHost: `${machine}-not-it` }),
  );
  check("the wrong host id is refused", message !== "", true);
  check("naming the host id that was actually recorded", message.includes(`${machine}-other`), true);
  check("and the one that was typed", message.includes(`${machine}-not-it`), true);
  check("a wrong host id never takes the guard", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "remote");
  check("and never appends an audit record", files.has(`${home}/foreign-lock-takeovers.jsonl`), false);

  const held = await takeLock(ctx, "apply", "op-right-host", { breakLock: true, breakForeignLockHost: `${machine}-other` });
  check("the exact host id takes over the guard", (await readLockHolder(ctx))?.operationId, "op-right-host");

  const audit = files.get(`${home}/foreign-lock-takeovers.jsonl`) ?? "";
  const entries = audit.trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  check("exactly one takeover is recorded", entries.length, 1);
  check("naming the confirmed host", entries[0]?.confirmedHost, `${machine}-other`);
  check("and the exact foreign owner it replaced", entries[0]?.foreignOwner, foreignOwner);
  check("recording when it happened", typeof entries[0]?.at === "string" && (entries[0].at as string).length > 0, true);
  check("recording who did it", typeof entries[0]?.by === "string" && (entries[0].by as string).includes(foreignTakeoverBy()), true);

  await held.release();
}

{
  const { ctx, files, dirs } = stubContext();
  const guard = `${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "uncertain", pid: 99999999, machine, takenAt: new Date(0).toISOString() }));
  const originalKill = process.kill;
  process.kill = (() => { throw Object.assign(new Error("process probe failed"), { code: "EIO" }); }) as typeof process.kill;
  let message = "";
  try {
    message = await refused(() => takeLock(ctx, "apply", "op-kill-probe-failure", { breakLock: true }));
  } finally {
    process.kill = originalKill;
  }
  check("a process probe error does not prove the owner is dead", message, mutationBusyMessage(guard, { generation: "uncertain", pid: 99999999, machine, takenAt: "" }).message);
  check("a process probe error preserves the guard", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "uncertain");
}

// A probe error on an owner already recorded as THIS machine must never be read as a foreign
// one, even if --break-foreign-lock happens to name this exact machine: there is nothing
// foreign here to confirm, and treating "cannot verify" as "confirmed foreign" would let a
// local probe hiccup take over a guard that may still be genuinely held.
{
  const { ctx, files, dirs } = stubContext();
  const guard = `${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "uncertain-local", pid: 99999999, machine, takenAt: new Date(0).toISOString() }));
  const originalKill = process.kill;
  process.kill = (() => { throw Object.assign(new Error("process probe failed"), { code: "EIO" }); }) as typeof process.kill;
  let message = "";
  try {
    message = await refused(() => takeLock(ctx, "apply", "op-local-probe-failure", { breakLock: true, breakForeignLockHost: machine }));
  } finally {
    process.kill = originalKill;
  }
  check("--break-foreign-lock naming this machine does not rescue a local probe error", message, mutationBusyMessage(guard, { generation: "uncertain-local", pid: 99999999, machine, takenAt: "" }).message);
  check("the guard is preserved", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "uncertain-local");
}

{
  const { ctx, dirs } = stubContext();
  const guard = `${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`;
  dirs.add(guard);

  const held = await takeLock(ctx, "apply", "op-recover-empty-guard", { breakLock: true });
  check("--break-lock recovers a guard left before owner publication", (await readLockHolder(ctx))?.operationId, "op-recover-empty-guard");
  await held.release();
  check("ownerless guard recovery releases its new guard", dirs.has(guard), false);
}

// --- a lock taken over by --break-lock is not removed by the run that lost it -------------------------

{
  const { ctx } = stubContext();
  const overrun = await takeLock(ctx, "apply", "op-slow");
  const stolen = await takeLock(ctx, "apply", "op-fast", { breakLock: true });

  await overrun.release();
  // The overrun run must not hand the instance to a third run while op-fast is still working.
  check("releasing a lock someone else now holds leaves theirs alone", (await readLockHolder(ctx))?.operationId, "op-fast");
  await stolen.release();
  check("and its real holder can still release it", await readLockHolder(ctx), undefined);
}

// --- two racing --break-lock callers: only one may enter the critical section -----------------
//
// `--break-lock` used to write straight into the directory it found: both callers could read
// the old holder, remove its marker, and write their own holder.json — the second only renamed
// the winner, while the first had already started its body with no lease left to check. The
// fix moves the contested directory aside before winning a fresh `mkdir`, so at most one racing
// mover can win. This gates the first caller right before that move, runs a second, uncontested
// takeover to completion, then releases it and checks only the mover that won ran its body.

{
  const { ctx, files, dirs } = stubContext();
  const oldHolder = JSON.stringify({ operationId: "op-old", what: "apply", by: "old", takenAt: new Date().toISOString() });
  dirs.add(lockPath(ctx));
  files.set(`${lockPath(ctx)}/holder.json`, oldHolder);

  const originalExec = ctx.transport.exec;
  let releaseStalled!: () => void;
  const gate = new Promise<void>((resolve) => { releaseStalled = resolve; });
  let reachedMove!: () => void;
  const stalledAtMove = new Promise<void>((resolve) => { reachedMove = resolve; });
  let gated = false;
  ctx.transport.exec = async (command: string, args: string[]) => {
    if (command === "mv" && !gated) {
      gated = true;
      reachedMove();
      await gate; // Paused before the move itself: the directory is still there, untouched.
    }
    return originalExec(command, args);
  };

  let stalledEnteredBody = false;
  let stalledError: Error | undefined;
  const stalled = withInstanceLock(ctx, "apply", "op-stalled", { breakLock: true }, async () => {
    stalledEnteredBody = true;
  }).then(() => undefined, (error: Error) => { stalledError = error; });

  await stalledAtMove;
  check("the stalled caller has not moved the contested directory yet", dirs.has(lockPath(ctx)), true);

  let fastError: Error | undefined;
  await withInstanceLock(ctx, "apply", "op-fast", { breakLock: true }, async () => {})
    .catch((error: Error) => { fastError = error; });
  check("another takeover cannot enter while the first owns the mutation guard", fastError !== undefined, true);
  check("the competing caller is told the lock change is in progress", fastError?.message,
    mutationBusyMessage(mutationGuardPath(ctx), { generation: "", pid: process.pid, machine: machineName(), takenAt: "" }).message);

  releaseStalled();
  await stalled;
  check("the lock change resumes and enters once the guard is released", stalledEnteredBody, true);
  check("the serialized caller completes its takeover", stalledError, undefined);
  check("the mutation guard and lock are clear after release", dirs.has(lockPath(ctx)) || dirs.has(`${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`), false);
}

// --- the mutation guard keeps claimants out while a failed takeover restores the live lock ---
//
// The takeover still has to compare identity after moving the directory. While it checks a
// mismatched generation, ordinary claimants must see the guard and refuse instead of winning
// the briefly empty pathname.

{
  const { ctx, files, dirs } = stubContext();
  const oldGeneration = "generation-old";
  const newGeneration = "generation-live";
  dirs.add(lockPath(ctx));
  dirs.add(`${lockPath(ctx)}/gen-${oldGeneration}`);
  files.set(`${lockPath(ctx)}/holder.json`, JSON.stringify({
    operationId: "op-live", what: "apply", by: "live", takenAt: new Date().toISOString(), generation: oldGeneration,
  }));

  const originalReadFile = ctx.transport.readFile;
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  let reachedDisplacedRead!: () => void;
  const displacedRead = new Promise<void>((resolve) => { reachedDisplacedRead = resolve; });
  ctx.transport.readFile = async (path: string) => {
    if (path.includes(".stale-") && path.endsWith("/holder.json")) {
      const movedRoot = path.slice(0, -"/holder.json".length);
      files.set(path, JSON.stringify({
        operationId: "op-live", what: "apply", by: "live", takenAt: new Date().toISOString(), generation: newGeneration,
      }));
      reachedDisplacedRead();
      await readGate;
      check("the failed takeover has temporarily moved the live root", dirs.has(lockPath(ctx)), false);
      check("the live generation remains in the displaced tree", dirs.has(`${movedRoot}/gen-${oldGeneration}`), true);
    }
    return originalReadFile(path);
  };

  let takeoverError: Error | undefined;
  const takeover = takeLock(ctx, "apply", "op-stale", { breakLock: true })
    .then((held) => held.release(), (error: Error) => { takeoverError = error; });
  await displacedRead;

  const thirdCaller = await refused(() => takeLock(ctx, "apply", "op-third"));
  check("a third caller is refused while the takeover owns the mutation guard", thirdCaller,
    mutationBusyMessage(mutationGuardPath(ctx), { generation: "", pid: process.pid, machine: machineName(), takenAt: "" }).message);
  releaseRead();
  await takeover;

  check("the generation mismatch refuses takeover", takeoverError?.message.includes(TAKEOVER_LOST_LINE), true);
  check("the live lock is restored before the guard is released", dirs.has(lockPath(ctx)), true);
  check("the restored lock holder remains readable", (await readLockHolder(ctx))?.operationId, "op-live");
  check("a refused takeover leaves no displaced directory", [...dirs].some((path) => path.includes(".stale-")), false);
}

// --- releases and takeovers share the same mutation guard -------------------------------------

{
  const { ctx, dirs } = stubContext();
  const slow = await takeLock(ctx, "apply", "op-slow");
  const originalExec = ctx.transport.exec;
  let releaseOwnership!: () => void;
  const releaseGate = new Promise<void>((resolve) => { releaseOwnership = resolve; });
  let reachedOwnership!: () => void;
  const ownershipCheck = new Promise<void>((resolve) => { reachedOwnership = resolve; });
  let gated = false;
  ctx.transport.exec = async (command: string, args: string[]) => {
    if (command === "mv" && (args[1] ?? "").includes(".released-") && !gated) {
      gated = true;
      reachedOwnership();
      await releaseGate;
    }
    return originalExec(command, args);
  };

  const releasing = slow.release();
  await ownershipCheck;
  let takeoverError: Error | undefined;
  await withInstanceLock(ctx, "apply", "op-fast", { breakLock: true }, async () => {})
    .catch((error: Error) => { takeoverError = error; });
  check("a takeover cannot race a release mutation", takeoverError?.message,
    mutationBusyMessage(mutationGuardPath(ctx), { generation: "", pid: process.pid, machine: machineName(), takenAt: "" }).message);
  releaseOwnership();
  await releasing;
  check("the release removes its own lock after the guard clears", dirs.has(lockPath(ctx)), false);
}

// Windows Node and a WSL distro Node on one PC share a host name, not pids: machineName()
// carries the pid scope, so the other side's pid is never probed (and never called dead) here.
{
  const host = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? hostname();
  check("machineName scopes the host by pid space", machineName().startsWith(`${host}:`) && machineName() !== `${host}:`, true);
  const otherScope = `${host}:${process.platform === "win32" ? "linux-4026531836" : "win32"}`;
  check("a same-host record from another pid space is unknown, not dead", await localLiveness({ pid: 99999999, machine: otherScope }), "unknown");
  check("an own-scope record with a gone pid is dead", await localLiveness({ pid: 99999999, machine: machineName() }), "dead");
}

// --- guardedWith: the takeover is explicit, and its outcomes are observable --------------------

{
  /** The outcome of one guard over a stale lock: the refusal text, or what happened to the holder. */
  async function outcome(run: (ctx: Context) => Promise<void>): Promise<string> {
    const { ctx, files, dirs } = stubContext();
    const old = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString();
    dirs.add(lockPath(ctx));
    files.set(`${lockPath(ctx)}/holder.json`, JSON.stringify({ operationId: "op-dead", what: "apply", by: "someone", takenAt: old }));
    const refusal = await refused(() => run(ctx));
    return refusal !== "" ? refusal : `ran, holder: ${(await readLockHolder(ctx))?.operationId}`;
  }
  const body = async (): Promise<void> => {};

  const refusedOutcome = await outcome((ctx) => guardedWith(ctx, "apply", { breakLock: false }, body));
  check("no takeover: a stale lock is refused, not taken", refusedOutcome.startsWith("another operation"), true);
  check("no takeover: the refusal advises --break-lock", refusedOutcome.includes(breakLockAdvice(true)), true);
  const unsupported = await outcome((ctx) => guardedWith(ctx, "apply", { breakLock: false }, body, { breakLockSupported: false }));
  check("breakLockSupported: false never advises a --break-lock the command refuses", unsupported.includes(breakLockAdvice(false)), true);
  check("and it still refuses the stale lock", unsupported.startsWith("another operation"), true);
  const taken = await outcome((ctx) => guardedWith(ctx, "apply", { breakLock: true }, body));
  check("breakLock: takes the stale lock and runs", taken.startsWith("ran"), true);
  check("and releases cleanly: no holder remains after the guard", taken, "ran, holder: undefined");
  const foreignHostOnly = await outcome((ctx) => guardedWith(ctx, "apply", { breakLock: false, breakForeignLockHost: "other" }, body));
  check("a foreign host id without breakLock does not take a stale lock", foreignHostOnly.startsWith("another operation"), true);
}

finish("instance lock takeover");
