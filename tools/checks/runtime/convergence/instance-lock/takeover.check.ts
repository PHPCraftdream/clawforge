// A takeover is where the lock's atomicity is easiest to lose: the directory already exists,
// so winning it is not "the mkdir that succeeds" the way a fresh claim is. These checks cover
// a stale lock being described rather than silently taken, a takeover's holder surviving the
// run it displaced, two `--break-lock` callers racing the same contested directory with only
// one allowed to actually enter the body, and — the two cases the generation CAS exists for —
// a pathname re-created underneath a caller that had read it, and a release whose remove runs
// after a takeover has finished.

import { hostname } from "node:os";
import { machineName, localLiveness } from "#framework/runtime/lock/process-identity.ts";
import { takeLock, withInstanceLock, readLockHolder, isStale, lockPath, guardedWith, STALE_AFTER_MS, type LockHolder, type LockOptions } from "#framework/runtime/lock/instance-lock.ts";
import { stubContext, refused } from "./fixture.ts";
import { UserError } from "#framework/core/io/log.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function userRefusal(body: () => Promise<unknown>): Promise<string> {
  let failure: unknown;
  const message = await refused(async () => {
    try { await body(); } catch (error) { failure = error; throw error; }
  });
  check("refusal is a UserError, not success or an incidental exception", failure instanceof UserError, true);
  return message;
}

async function guardRefusal(body: () => Promise<unknown>, expectedError?: Error): Promise<string> {
  let failure: unknown;
  const message = await refused(async () => {
    try { await body(); } catch (error) { failure = error; throw error; }
  });
  check("guard refusal throws rather than succeeding", failure !== undefined, true);
  check("guard refusal is an Error", failure instanceof Error, true);
  if (expectedError !== undefined) check("guard refusal preserves the injected error identity", failure === expectedError, true);
  return message;
}

// --- stale locks are described, not stolen ------------------------------------------------------

{
  const { ctx, files, dirs } = stubContext();
  const old = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString();
  dirs.add(lockPath(ctx));
  const original = JSON.stringify({ operationId: "op-dead", what: "apply", by: "someone", takenAt: old, host: machineName(), pid: 99999999 });
  files.set(`${lockPath(ctx)}/holder.json`, original);

  const holder = (await readLockHolder(ctx))!;
  check("a long-held lock is recognised as stale", isStale(holder), true);

  const message = await userRefusal(() => takeLock(ctx, "apply", "op-new"));
  check("refusal preserves the original holder bytes", files.get(`${lockPath(ctx)}/holder.json`), original);
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
  dirs.add(lockPath(ctx).replace(/\/operation\.lock$/, ""));
  const originalFiles = new Map(files);
  const originalDirs = new Set(dirs);
  const listingFailure = new Error("EIO");
  ctx.transport.listFiles = async () => { throw listingFailure; };

  const message = await guardRefusal(() => takeLock(ctx, "apply", "op-list-failure"), listingFailure);
  check("a guard listing failure is reported, not treated as no claims", message.includes("EIO"), true);
  check("listing failure preserves all original files", files, originalFiles);
  check("listing failure preserves all original directories", dirs, originalDirs);
  check("listing failure preserves the original guard owner", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "dead");
  check("listing failure removes its temporary claim", [...files.keys()].some((path) => path.includes(".claim-")), false);
}

{
  const { ctx, files, dirs } = stubContext();
  const guard = `${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "live", pid: process.pid, machine, takenAt: new Date().toISOString() }));

  dirs.add(lockPath(ctx).replace(/\/operation\.lock$/, ""));
  const originalFiles = new Map(files);
  const originalDirs = new Set(dirs);
  await guardRefusal(() => takeLock(ctx, "apply", "op-must-wait", { breakLock: true }));
  check("live guard refusal preserves all original files", files, originalFiles);
  check("live guard refusal preserves all original directories", dirs, originalDirs);
  check("a live guard is left untouched", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "live");
  check("a refused live guard creates no instance lock", dirs.has(lockPath(ctx)), false);
}

{
  const { ctx, files, dirs } = stubContext();
  const guard = `${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "remote", pid: 99999999, machine: `${machine}-other`, takenAt: new Date().toISOString() }));

  dirs.add(lockPath(ctx).replace(/\/operation\.lock$/, ""));
  const originalFiles = new Map(files);
  const originalDirs = new Set(dirs);
  const message = await guardRefusal(() => takeLock(ctx, "apply", "op-unverifiable", { breakLock: true }));
  check("foreign guard refusal preserves all original files", files, originalFiles);
  check("foreign guard refusal preserves all original directories", dirs, originalDirs);
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

  dirs.add(lockPath(ctx).replace(/\/operation\.lock$/, ""));
  const originalFiles = new Map(files);
  const originalDirs = new Set(dirs);
  const message = await guardRefusal(() =>
    takeLock(ctx, "apply", "op-wrong-host", { breakLock: true, breakForeignLockHost: `${machine}-not-it` }),
  );
  check("wrong host refusal preserves all original files", files, originalFiles);
  check("wrong host refusal preserves all original directories", dirs, originalDirs);
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
  check("recording who did it", typeof entries[0]?.by === "string" && (entries[0].by as string).includes(String(process.pid)), true);

  await held.release();
}

{
  const { ctx, files, dirs } = stubContext();
  const guard = `${lockPath(ctx).replace(/\/operation\.lock$/, "")}/operation.mutation`;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "uncertain", pid: 99999999, machine, takenAt: new Date(0).toISOString() }));
  dirs.add(lockPath(ctx).replace(/\/operation\.lock$/, ""));
  const originalFiles = new Map(files);
  const originalDirs = new Set(dirs);
  const originalKill = process.kill;
  process.kill = (() => { throw Object.assign(new Error("process probe failed"), { code: "EIO" }); }) as typeof process.kill;
  try {
    await guardRefusal(() => takeLock(ctx, "apply", "op-kill-probe-failure", { breakLock: true }));
  } finally {
    process.kill = originalKill;
  }
  check("process probe failure preserves all original files", files, originalFiles);
  check("process probe failure preserves all original directories", dirs, originalDirs);
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
  dirs.add(lockPath(ctx).replace(/\/operation\.lock$/, ""));
  const originalFiles = new Map(files);
  const originalDirs = new Set(dirs);
  const originalKill = process.kill;
  process.kill = (() => { throw Object.assign(new Error("process probe failed"), { code: "EIO" }); }) as typeof process.kill;
  try {
    await guardRefusal(() => takeLock(ctx, "apply", "op-local-probe-failure", { breakLock: true, breakForeignLockHost: machine }));
  } finally {
    process.kill = originalKill;
  }
  check("local probe failure preserves all original files", files, originalFiles);
  check("local probe failure preserves all original directories", dirs, originalDirs);
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
  const { ctx, files } = stubContext();
  const overrun = await takeLock(ctx, "apply", "op-slow");
  files.set(`${lockPath(ctx)}/holder.json`, JSON.stringify({ ...await readLockHolder(ctx), host: machineName(), pid: 99999999 }));
  const stolen = await takeLock(ctx, "apply", "op-fast", { breakLock: true });

  await overrun.release();
  // The overrun run must not hand the instance to a third run while op-fast is still working.
  check("releasing a lock someone else now holds leaves theirs alone", (await readLockHolder(ctx))?.operationId, "op-fast");
  await stolen.release();
  check("and its real holder can still release it", await readLockHolder(ctx), undefined);
}

// --- two racing --break-lock callers: only one may enter the critical section -----------------
//
// Both callers observe one contested lock. Pause the first before displacement; the second
// must refuse without entering its body. Resume the first and require a clean release.

{
  const { ctx, files, dirs } = stubContext();
  const oldHolder = JSON.stringify({ operationId: "op-old", host: machineName(), pid: 99999999, what: "apply", by: "old", takenAt: new Date().toISOString() });
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

  const guardedFiles = new Map(files);
  const guardedDirs = new Set(dirs);
  let fastError: unknown;
  let fastEnteredBody = false;
  await withInstanceLock(ctx, "apply", "op-fast", { breakLock: true }, async () => { fastEnteredBody = true; })
    .catch((error: unknown) => { fastError = error; });
  check("another takeover cannot enter while the first owns the mutation guard", fastError !== undefined, true);
  check("the competing caller receives a guard Error", fastError instanceof Error, true);
  check("the competing caller preserves the guarded files", files, guardedFiles);
  check("the competing caller preserves the guarded directories", dirs, guardedDirs);
  check("the competing caller never enters its body", fastEnteredBody, false);

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
    operationId: "op-live", host: machineName(), pid: 99999999, what: "apply", by: "live", takenAt: new Date().toISOString(), generation: oldGeneration,
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
        operationId: "op-live", host: machineName(), pid: 99999999, what: "apply", by: "live", takenAt: new Date().toISOString(), generation: newGeneration,
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

  const guardedFiles = new Map(files);
  const guardedDirs = new Set(dirs);
  await guardRefusal(() => takeLock(ctx, "apply", "op-third"));
  check("the third caller preserves the displaced files and guard owner", files, guardedFiles);
  check("the third caller preserves the displaced directories and guard", dirs, guardedDirs);
  releaseRead();
  await takeover;

  check("the generation mismatch refuses takeover", takeoverError instanceof UserError, true);
  check("the live lock is restored before the guard is released", dirs.has(lockPath(ctx)), true);
  check("the restored lock holder remains readable", (await readLockHolder(ctx))?.operationId, "op-live");
  check("a refused takeover leaves no displaced directory", [...dirs].some((path) => path.includes(".stale-")), false);
}

// --- releases and takeovers share the same mutation guard -------------------------------------

{
  const { ctx, files, dirs } = stubContext();
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
  const guardedFiles = new Map(files);
  const guardedDirs = new Set(dirs);
  let takeoverError: unknown;
  let takeoverEnteredBody = false;
  await withInstanceLock(ctx, "apply", "op-fast", { breakLock: true }, async () => { takeoverEnteredBody = true; })
    .catch((error: unknown) => { takeoverError = error; });
  check("a takeover blocked by release throws rather than succeeding", takeoverError !== undefined, true);
  check("a takeover cannot race a release mutation", takeoverError instanceof Error, true);
  check("a takeover blocked by release preserves the guarded files", files, guardedFiles);
  check("a takeover blocked by release preserves the guarded directories", dirs, guardedDirs);
  check("a takeover blocked by release never enters its body", takeoverEnteredBody, false);
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
  interface GuardOutcome {
    failure: unknown;
    message: string;
    entered: boolean;
    holder: LockHolder | undefined;
    originalPreserved: boolean;
  }
  async function outcome(options: LockOptions): Promise<GuardOutcome> {
    const { ctx, files, dirs } = stubContext();
    const old = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString();
    const original = JSON.stringify({ operationId: "op-dead", what: "apply", by: "someone", takenAt: old, host: machineName(), pid: 99999999 });
    dirs.add(lockPath(ctx));
    files.set(`${lockPath(ctx)}/holder.json`, original);
    let entered = false;
    let failure: unknown;
    const message = await refused(async () => {
      try {
        await guardedWith(ctx, "apply", { ...options, breakLock: options.breakLock === true }, async () => { entered = true; }, { breakLockSupported: options.breakLockSupported });
      } catch (error) { failure = error; throw error; }
    });
    return { failure, message, entered, holder: await readLockHolder(ctx), originalPreserved: files.get(`${lockPath(ctx)}/holder.json`) === original };
  }

  for (const options of [
    { breakLock: false },
    { breakLock: false, breakLockSupported: false },
    { breakLock: false, breakForeignLockHost: "other" },
  ]) {
    const result = await outcome(options);
    check("no takeover: guardedWith returns a user refusal", result.failure instanceof UserError, true);
    check("no takeover: body is not entered", result.entered, false);
    check("no takeover: original holder bytes are preserved", result.originalPreserved, true);
    check("no takeover: remediation is manual", (result.failure as UserError).advice.map(entry => entry.kind), ["manual"]);
    check("no takeover: remediation has no mutation argv", (result.failure as UserError).advice.some(entry => "argv" in entry), false);
    if (options.breakLockSupported !== false) check("supported refusal names --break-lock", result.message.includes("--break-lock"), true);
  }
  const taken = await outcome({ breakLock: true });
  check("breakLock takes the stale lock and runs", taken.entered, true);
  check("takeover completes without failure", taken.failure, undefined);
  check("takeover releases cleanly", taken.holder, undefined);
}

// --- holder CAS: race after the observed owner's liveness check, before displacement ---------

const legacyOwner = {
  operationId: "legacy-A", what: "apply", by: "legacy", host: machineName(), pid: 99999999,
  takenAt: "2026-10-01T00:00:00.000Z", startedAt: "2026-09-30T23:59:00.000Z",
};
for (const [field, replacement] of [
  ["operationId", "legacy-B"], ["host", `${machineName()}-other`], ["pid", 99999998],
  ["takenAt", "2026-10-02T00:00:00.000Z"], ["startedAt", "2026-09-29T23:59:00.000Z"],
] as const) {
  const { ctx, files, dirs } = stubContext();
  const root = lockPath(ctx);
  dirs.add(root);
  files.set(`${root}/holder.json`, JSON.stringify(legacyOwner));
  const racedOwner = { ...legacyOwner, [field]: replacement };
  const exec = ctx.transport.exec;
  let raced = false;
  ctx.transport.exec = async (command, args) => {
    if (command === "mv" && args[0] === root && !raced) {
      raced = true;
      files.set(`${root}/holder.json`, JSON.stringify(racedOwner));
    }
    return exec(command, args);
  };
  let entered = false;
  await userRefusal(() => withInstanceLock(ctx, "apply", "must-not-enter", { breakLock: true }, async () => { entered = true; }));
  check(`legacy ${field} race reaches displacement after liveness`, raced, true);
  check(`legacy ${field} race never enters body`, entered, false);
  check(`legacy ${field} race restores B exactly`, JSON.parse(files.get(`${root}/holder.json`) ?? "null"), racedOwner);
  check(`legacy ${field} race leaves no displaced tree`, [...dirs].some((path) => path.includes(".stale-")), false);
}

// Invalid identity must be refused on the initial read, not merely detected as a changed
// string after displacement. Identical invalid timestamps otherwise pass exact equality.
for (const field of ["takenAt", "startedAt"] as const) {
  const { ctx, files, dirs } = stubContext();
  const root = lockPath(ctx);
  const original = `${JSON.stringify({ ...legacyOwner, [field]: "not-a-date" }, null, 2)}\n`;
  dirs.add(root);
  files.set(`${root}/holder.json`, original);
  files.set(`${root}/keep.txt`, "unrelated contents");
  const originalKeep = files.get(`${root}/keep.txt`);
  const exec = ctx.transport.exec;
  let displacements = 0;
  ctx.transport.exec = async (command, args) => {
    if (command === "mv" && args[0] === root) displacements += 1;
    return exec(command, args);
  };
  let entered = false;
  let failure: unknown;
  try { await withInstanceLock(ctx, "apply", "must-not-enter", { breakLock: true }, async () => { entered = true; }); } catch (error) { failure = error; }
  check(`initial legacy invalid ${field} refuses malformed acquisition`, failure instanceof UserError, true);
  check(`initial legacy invalid ${field} never enters body`, entered, false);
  check(`initial legacy invalid ${field} has zero displacement`, displacements, 0);
  check(`initial legacy invalid ${field} preserves original bytes`, files.get(`${root}/holder.json`), original);
  check(`initial legacy invalid ${field} preserves root`, dirs.has(root), true);
  check(`initial legacy invalid ${field} preserves unrelated contents`, files.get(`${root}/keep.txt`), originalKeep);
}

for (const record of [undefined, "unreadable JSON", JSON.stringify({ ...legacyOwner, takenAt: "not-a-date" }),
  JSON.stringify({ ...legacyOwner, operationId: "" }), JSON.stringify({ ...legacyOwner, startedAt: "invalid" }),
  JSON.stringify({ ...legacyOwner, generation: "" }), JSON.stringify({ ...legacyOwner, generation: null })]) {
  const { ctx, files, dirs } = stubContext();
  const root = lockPath(ctx);
  dirs.add(root);
  files.set(`${root}/holder.json`, JSON.stringify(legacyOwner));
  files.set(`${root}/keep.txt`, "unrelated contents");
  const originalKeep = files.get(`${root}/keep.txt`);
  const exec = ctx.transport.exec;
  let displaced = false;
  ctx.transport.exec = async (command, args) => {
    if (command === "mv" && args[0] === root) {
      displaced = true;
      if (record === undefined) files.delete(`${root}/holder.json`);
      else files.set(`${root}/holder.json`, record);
    }
    return exec(command, args);
  };
  await userRefusal(() => withInstanceLock(ctx, "apply", "must-not-enter", { breakLock: true }, async () => {
    check("malformed displaced legacy cannot enter body", true, false);
  }));
  check(`displaced ${record ?? "missing"} was actually read`, displaced, true);
  check(`malformed displaced legacy restores root: ${record ?? "missing"}`, dirs.has(root), true);
  check(`malformed displaced legacy preserves unrelated contents: ${record ?? "missing"}`, files.get(`${root}/keep.txt`), originalKeep);
  check(`malformed displaced legacy preserves record: ${record ?? "missing"}`, files.get(`${root}/holder.json`), record);
}

{
  const { ctx, files, dirs } = stubContext();
  const root = lockPath(ctx);
  dirs.add(root);
  files.set(`${root}/holder.json`, JSON.stringify(legacyOwner));
  const exec = ctx.transport.exec;
  ctx.transport.exec = async (command, args) => {
    if (command === "mv" && args[0] === root) files.set(`${root}/holder.json`, JSON.stringify({ ...legacyOwner, heartbeatAt: "2026-10-09T00:00:00.000Z" }));
    return exec(command, args);
  };
  let entered = false;
  await withInstanceLock(ctx, "apply", "same-legacy", { breakLock: true }, async () => {
    entered = true;
    check("same legacy publishes the new owner", (await readLockHolder(ctx))?.operationId, "same-legacy");
  });
  check("same legacy succeeds despite changed heartbeat", entered, true);
  check("same legacy releases root cleanly", dirs.has(root), false);
}

{
  const { ctx, files, dirs } = stubContext();
  const root = lockPath(ctx);
  dirs.add(root);
  files.set(`${root}/holder.json`, JSON.stringify(legacyOwner));
  files.set(`${root}/keep.txt`, "unrelated contents");
  const originalKeep = files.get(`${root}/keep.txt`);
  const read = ctx.transport.readFile;
  let unreadable = false;
  ctx.transport.readFile = async (path) => {
    if (path.includes(".stale-") && path.endsWith("/holder.json")) {
      unreadable = true;
      throw new Error("permission denied reading displaced holder");
    }
    return read(path);
  };
  await userRefusal(() => withInstanceLock(ctx, "apply", "must-not-enter", { breakLock: true }, async () => {
    check("unreadable displaced record cannot enter body", true, false);
  }));
  check("unreadable displaced record reaches failed read", unreadable, true);
  check("unreadable displaced record restores original bytes", files.get(`${root}/holder.json`), JSON.stringify(legacyOwner));
  check("unreadable displaced record preserves unrelated contents", files.get(`${root}/keep.txt`), originalKeep);
}

for (const uncertain of [false, true]) {
  const { ctx, files, dirs } = stubContext();
  const root = lockPath(ctx);
  dirs.add(root);
  files.set(`${root}/holder.json`, JSON.stringify(legacyOwner));
  const racedOwner = { ...legacyOwner, operationId: "legacy-B" };
  const collidingOwner = { ...legacyOwner, operationId: "live-C", pid: process.pid };
  const exec = ctx.transport.exec;
  let parked = "";
  let originalLiveOnly: string | undefined;
  ctx.transport.exec = async (command, args) => {
    if (command === "mv" && args[0] === root) files.set(`${root}/holder.json`, JSON.stringify(racedOwner));
    // Inject at the restoration operation itself, not at an earlier absence probe.
    // Removing -T must expose real mv nesting; removing -n must not overwrite C.
    if (command === "mv" && args.at(-1) === root && (args.at(-2) ?? "").includes(".stale-")) {
      parked = args.at(-2)!;
      dirs.add(root);
      files.set(`${root}/holder.json`, JSON.stringify(collidingOwner));
      files.set(`${root}/live-only.txt`, "live data");
      originalLiveOnly = files.get(`${root}/live-only.txt`);
      if (uncertain) throw new Error("restore acknowledgement unavailable");
    }
    return exec(command, args);
  };
  const message = await userRefusal(() => withInstanceLock(ctx, "apply", "must-not-enter", { breakLock: true }, async () => {
    check("restore collision cannot enter body", true, false);
  }));
  check(`restore collision ${uncertain} identifies safe park`, parked !== "" && message.includes(parked), true);
  check(`restore collision ${uncertain} preserves C`, JSON.parse(files.get(`${root}/holder.json`) ?? "null"), collidingOwner);
  check(`restore collision ${uncertain} preserves B safely parked`, JSON.parse(files.get(`${parked}/holder.json`) ?? "null"), racedOwner);
  check(`restore collision ${uncertain} keeps displaced root`, dirs.has(parked), true);
  check(`restore collision ${uncertain} never nests into live root`, [...dirs].some((path) => path.startsWith(`${root}/operation.lock.stale-`)), false);
  check(`restore collision ${uncertain} preserves unrelated live data`, files.get(`${root}/live-only.txt`), originalLiveOnly);
}

finish("instance lock takeover");
