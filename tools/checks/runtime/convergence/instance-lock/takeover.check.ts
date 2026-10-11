// A takeover is where the lock's atomicity is easiest to lose: the directory already exists,
// so winning it is not "the mkdir that succeeds" the way a fresh claim is. These checks cover
// a stale lock being described rather than silently taken, a takeover's holder surviving the
// run it displaced, two `--break-lock` callers racing the same contested directory with only
// one allowed to actually enter the body, and — the two cases the generation CAS exists for —
// a pathname re-created underneath a caller that had read it, and a release whose remove runs
// after a takeover has finished.

import { hostname } from "node:os";
import { machineName, localLiveness } from "#framework/runtime/lock/process-identity.ts";
import { takeLock, withInstanceLock, readLockHolder, isStale, guardedWith, STALE_AFTER_MS } from "#framework/runtime/lock/instance-lock.ts";
import { stubContext, captureFailure, FIXTURE_LOCK_PATH, FIXTURE_LOCK_HOME } from "./fixture.ts";
import { UserError } from "#framework/core/io/log.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";

const MUTATION_PATH = "/srv/clawforge-locks/operation.mutation";

// --- stale locks are described, not stolen ------------------------------------------------------

{
  const { ctx, files, dirs } = stubContext();
  const old = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString();
  dirs.add(FIXTURE_LOCK_PATH);
  files.set(`${FIXTURE_LOCK_PATH}/holder.json`, JSON.stringify({ operationId: "op-dead", what: "apply", by: "someone", takenAt: old, host: machineName(), pid: 99999999 }));

  const holder = (await readLockHolder(ctx))!;
  check("a long-held lock is recognised as stale", isStale(holder), true);

  const original = files.get(`${FIXTURE_LOCK_PATH}/holder.json`);
  let entered = false;
  const failure = await captureFailure(() => withInstanceLock(ctx, "apply", "op-new", {}, async () => { entered = true; }));
  check("but it still refuses rather than taking it", failure instanceof UserError, true);
  check("a stale refusal never enters body", entered, false);
  check("a stale refusal preserves bytes and root", [files.get(`${FIXTURE_LOCK_PATH}/holder.json`), dirs.has(FIXTURE_LOCK_PATH)], [original, true]);
  check("the dead holder is still in place", (await readLockHolder(ctx))?.operationId, "op-dead");

  const taken = await takeLock(ctx, "apply", "op-new", { breakLock: true });
  check("--break-lock takes it over", (await readLockHolder(ctx))?.operationId, "op-new");
  await taken.release();
}

// --- abandoned mutation guards are recoverable only when their owner is known dead -----------

{
  const { ctx, files, dirs } = stubContext();
  const guard = MUTATION_PATH;
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
  const guard = MUTATION_PATH;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "dead", pid: 99999999, machine, takenAt: new Date(0).toISOString() }));
  const original = files.get(`${guard}/owner.json`);
  const listingFailure = new Error("guard listing failed");
  let listings = 0;
  let entered = false;
  ctx.transport.listFiles = async () => { listings += 1; throw listingFailure; };

  const failure = await captureFailure(() => withInstanceLock(ctx, "apply", "op-list-failure", {}, async () => { entered = true; }));
  check("a guard listing failure is reported, not treated as no claims", failure === listingFailure, true);
  check("listing failure reaches injected fault without body entry", [listings, entered], [1, false]);
  check("listing failure preserves owner bytes and guard root", [files.get(`${guard}/owner.json`), dirs.has(guard)], [original, true]);
  check("listing failure creates no instance lock", dirs.has(FIXTURE_LOCK_PATH), false);
  check("listing failure preserves the original guard owner", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "dead");
  check("listing failure removes its temporary claim", [...files.keys()].some((path) => path.includes(".claim-")), false);
}

{
  const { ctx, files, dirs } = stubContext();
  const guard = MUTATION_PATH;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "live", pid: process.pid, machine, takenAt: new Date().toISOString() }));

  const original = files.get(`${guard}/owner.json`);
  let entered = false;
  const failure = await captureFailure(() => withInstanceLock(ctx, "apply", "op-must-wait", { breakLock: true }, async () => { entered = true; }));
  check("--break-lock cannot break a live mutation guard", failure instanceof Error, true);
  check("live guard refusal preserves bytes and root without body entry", [entered, files.get(`${guard}/owner.json`), dirs.has(guard)], [false, original, true]);
  check("a live guard is left untouched", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "live");
  check("a refused live guard creates no instance lock", dirs.has(FIXTURE_LOCK_PATH), false);
}

{
  const { ctx, files, dirs } = stubContext();
  const guard = MUTATION_PATH;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "remote", pid: 99999999, machine: `${machine}-other`, takenAt: new Date().toISOString() }));

  const original = files.get(`${guard}/owner.json`);
  let entered = false;
  const failure = await captureFailure(() => withInstanceLock(ctx, "apply", "op-unverifiable", { breakLock: true }, async () => { entered = true; }));
  check("--break-lock keeps a guard owned by an unverifiable host", failure instanceof Error, true);
  check("foreign guard refusal preserves bytes and root without body entry", [entered, files.get(`${guard}/owner.json`), dirs.has(guard)], [false, original, true]);
  check("foreign guard refusal creates no instance lock", dirs.has(FIXTURE_LOCK_PATH), false);
  check("an unverifiable guard is not replaced", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "remote");
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
  const home = FIXTURE_LOCK_HOME;
  const guard = MUTATION_PATH;
  const machine = machineName();
  const foreignOwner = { generation: "remote", pid: 424242, machine: `${machine}-other`, takenAt: new Date().toISOString() };
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify(foreignOwner));

  const original = files.get(`${guard}/owner.json`);
  let entered = false;
  const failure = await captureFailure(() =>
    withInstanceLock(ctx, "apply", "op-wrong-host", { breakLock: true, breakForeignLockHost: `${machine}-not-it` }, async () => { entered = true; }),
  );
  check("the wrong host id is refused", failure instanceof Error, true);
  check("wrong host refusal preserves bytes and root without body entry", [entered, files.get(`${guard}/owner.json`), dirs.has(guard)], [false, original, true]);
  check("wrong host refusal creates no instance lock", dirs.has(FIXTURE_LOCK_PATH), false);
  check("a wrong host id never takes the guard", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "remote");
  check("and never appends an audit record", files.has(`${home}/foreign-lock-takeovers.jsonl`), false);

  const previousUsername = process.env.USERNAME;
  const previousUser = process.env.USER;
  const before = Date.now();
  let held: Awaited<ReturnType<typeof takeLock>>;
  try {
    process.env.USERNAME = "takeover-audit-caller";
    process.env.USER = "takeover-audit-fallback";
    held = await takeLock(ctx, "apply", "op-right-host", { breakLock: true, breakForeignLockHost: `${machine}-other` });
  } finally {
    if (previousUsername === undefined) delete process.env.USERNAME; else process.env.USERNAME = previousUsername;
    if (previousUser === undefined) delete process.env.USER; else process.env.USER = previousUser;
  }
  const after = Date.now();
  check("the exact host id takes over the guard", (await readLockHolder(ctx))?.operationId, "op-right-host");

  const audit = files.get(`${home}/foreign-lock-takeovers.jsonl`) ?? "";
  const entries = audit.trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  check("exactly one takeover is recorded", entries.length, 1);
  check("naming the confirmed host", entries[0]?.confirmedHost, `${machine}-other`);
  check("and the exact foreign owner it replaced", entries[0]?.foreignOwner, foreignOwner);
  const at = typeof entries[0]?.at === "string" ? Date.parse(entries[0].at) : NaN;
  check("recording when it happened", Number.isFinite(at) && at >= before && at <= after, true);
  const caller = typeof entries[0]?.by === "string" ? /^([^@]+)@(.+) pid ([1-9][0-9]*)$/.exec(entries[0].by) : null;
  const callerHost = (caller?.[2] ?? "").split(":");
  check("recording who did it", [caller?.[1], caller?.[3]], ["takeover-audit-caller", String(process.pid)]);
  check("recording the caller's physical host", [callerHost.length, callerHost[0]], [2, process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? hostname()]);
  await requires("linux-host", "takeover audit records Linux pid scope", () => check("recording the caller's Linux pid scope", /^(?:linux-[1-9][0-9]*|linux-unknown)$/.test(callerHost[1] ?? ""), true));
  await requires("windows-host", "takeover audit records Windows pid scope", () => check("recording the caller's Windows pid scope", callerHost[1], "win32"));

  await held.release();
}

{
  const { ctx, files, dirs } = stubContext();
  const guard = MUTATION_PATH;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "uncertain", pid: 99999999, machine, takenAt: new Date(0).toISOString() }));
  const originalKill = process.kill;
  const original = files.get(`${guard}/owner.json`);
  let probes = 0;
  let entered = false;
  process.kill = (() => { probes += 1; throw Object.assign(new Error("process probe failed"), { code: "EIO" }); }) as typeof process.kill;
  let failure: unknown;
  try {
    failure = await captureFailure(() => withInstanceLock(ctx, "apply", "op-kill-probe-failure", { breakLock: true }, async () => { entered = true; }));
  } finally {
    process.kill = originalKill;
  }
  check("a process probe error does not prove the owner is dead", failure instanceof Error, true);
  check("probe fault reached without body entry or owner mutation", [probes, entered, files.get(`${guard}/owner.json`), dirs.has(guard), dirs.has(FIXTURE_LOCK_PATH)], [1, false, original, true, false]);
  check("a process probe error preserves the guard", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "uncertain");
}

// A probe error on an owner already recorded as THIS machine must never be read as a foreign
// one, even if --break-foreign-lock happens to name this exact machine: there is nothing
// foreign here to confirm, and treating "cannot verify" as "confirmed foreign" would let a
// local probe hiccup take over a guard that may still be genuinely held.
{
  const { ctx, files, dirs } = stubContext();
  const guard = MUTATION_PATH;
  const machine = machineName();
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "uncertain-local", pid: 99999999, machine, takenAt: new Date(0).toISOString() }));
  const originalKill = process.kill;
  const original = files.get(`${guard}/owner.json`);
  let probes = 0;
  let entered = false;
  process.kill = (() => { probes += 1; throw Object.assign(new Error("process probe failed"), { code: "EIO" }); }) as typeof process.kill;
  let failure: unknown;
  try {
    failure = await captureFailure(() => withInstanceLock(ctx, "apply", "op-local-probe-failure", { breakLock: true, breakForeignLockHost: machine }, async () => { entered = true; }));
  } finally {
    process.kill = originalKill;
  }
  check("--break-foreign-lock naming this machine does not rescue a local probe error", failure instanceof Error, true);
  check("local probe fault reached without body entry or owner mutation", [probes, entered, files.get(`${guard}/owner.json`), dirs.has(guard), dirs.has(FIXTURE_LOCK_PATH)], [1, false, original, true, false]);
  check("the guard is preserved", JSON.parse(files.get(`${guard}/owner.json`) ?? "{}").generation, "uncertain-local");
}

{
  const { ctx, dirs } = stubContext();
  const guard = MUTATION_PATH;
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
  files.set(`${FIXTURE_LOCK_PATH}/holder.json`, JSON.stringify({ ...await readLockHolder(ctx), host: machineName(), pid: 99999999 }));
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
  const oldHolder = JSON.stringify({ operationId: "op-old", host: machineName(), pid: 99999999, what: "apply", by: "old", takenAt: new Date().toISOString() });
  dirs.add(FIXTURE_LOCK_PATH);
  files.set(`${FIXTURE_LOCK_PATH}/holder.json`, oldHolder);

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

  let stalledBodies = 0;
  let stalledError: unknown;
  const stalled = withInstanceLock(ctx, "apply", "op-stalled", { breakLock: true }, async () => {
    stalledBodies += 1;
  }).then(() => undefined, (error: unknown) => { stalledError = error; });

  await stalledAtMove;
  check("the stalled caller has not moved the contested directory yet", dirs.has(FIXTURE_LOCK_PATH), true);

  const guardOwner = files.get(`${MUTATION_PATH}/owner.json`);
  let fastBodies = 0;
  const fastError = await captureFailure(() => withInstanceLock(ctx, "apply", "op-fast", { breakLock: true }, async () => { fastBodies += 1; }));
  check("another takeover cannot enter while the first owns the mutation guard", fastError instanceof Error, true);
  check("racing callers do not enter while move is gated", [stalledBodies, fastBodies, gated], [0, 0, true]);
  check("gated takeover preserves contested holder and guard owner", [files.get(`${FIXTURE_LOCK_PATH}/holder.json`), files.get(`${MUTATION_PATH}/owner.json`)], [oldHolder, guardOwner]);

  releaseStalled();
  await stalled;
  check("the lock change resumes and enters once the guard is released", stalledBodies, 1);
  check("the serialized caller completes its takeover", stalledError, undefined);
  check("the mutation guard and lock are clear after release", dirs.has(FIXTURE_LOCK_PATH) || dirs.has(MUTATION_PATH), false);
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
  dirs.add(FIXTURE_LOCK_PATH);
  dirs.add(`${FIXTURE_LOCK_PATH}/gen-${oldGeneration}`);
  files.set(`${FIXTURE_LOCK_PATH}/holder.json`, JSON.stringify({
    operationId: "op-live", host: machineName(), pid: 99999999, what: "apply", by: "live", takenAt: new Date().toISOString(), generation: oldGeneration,
  }));

  const originalReadFile = ctx.transport.readFile;
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  let reachedDisplacedRead!: () => void;
  const displacedRead = new Promise<void>((resolve) => { reachedDisplacedRead = resolve; });
  let displacedReads = 0;
  ctx.transport.readFile = async (path: string) => {
    if (path.startsWith(`${FIXTURE_LOCK_PATH}.stale-`) && path.endsWith("/holder.json")) {
      displacedReads += 1;
      const movedRoot = path.slice(0, -"/holder.json".length);
      files.set(path, JSON.stringify({
        operationId: "op-live", host: machineName(), pid: 99999999, what: "apply", by: "live", takenAt: new Date().toISOString(), generation: newGeneration,
      }));
      reachedDisplacedRead();
      await readGate;
      check("the failed takeover has temporarily moved the live root", dirs.has(FIXTURE_LOCK_PATH), false);
      check("the live generation remains in the displaced tree", dirs.has(`${movedRoot}/gen-${oldGeneration}`), true);
    }
    return originalReadFile(path);
  };

  let takeoverError: unknown;
  let takeoverBodies = 0;
  const takeover = captureFailure(() => withInstanceLock(ctx, "apply", "op-stale", { breakLock: true }, async () => { takeoverBodies += 1; }))
    .then((error) => { takeoverError = error; });
  await displacedRead;

  const guardedOwner = files.get(`${MUTATION_PATH}/owner.json`);
  const displacedOwners = [...files.entries()].filter(([path]) => path.startsWith(`${FIXTURE_LOCK_PATH}.stale-`));
  let thirdBodies = 0;
  const thirdCaller = await captureFailure(() => withInstanceLock(ctx, "apply", "op-third", {}, async () => { thirdBodies += 1; }));
  check("a third caller is refused while the takeover owns the mutation guard", thirdCaller instanceof Error, true);
  check("displaced read gate prevents both bodies", [takeoverBodies, thirdBodies, displacedReads], [0, 0, 1]);
  check("displaced read gate preserves guard and displaced bytes", [files.get(`${MUTATION_PATH}/owner.json`), [...files.entries()].filter(([path]) => path.startsWith(`${FIXTURE_LOCK_PATH}.stale-`))], [guardedOwner, displacedOwners]);
  releaseRead();
  await takeover;

  check("generation mismatch restores displaced holder bytes", files.get(`${FIXTURE_LOCK_PATH}/holder.json`), displacedOwners[0]?.[1]);
  check("the generation mismatch refuses takeover", takeoverError instanceof UserError, true);
  check("generation mismatch never enters body", takeoverBodies, 0);
  check("restored lock retains original generation marker", dirs.has(`${FIXTURE_LOCK_PATH}/gen-${oldGeneration}`), true);
  check("the live lock is restored before the guard is released", dirs.has(FIXTURE_LOCK_PATH), true);
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
  const owner = files.get(`${FIXTURE_LOCK_PATH}/holder.json`);
  const guardOwner = files.get(`${MUTATION_PATH}/owner.json`);
  let bodies = 0;
  const takeoverError = await captureFailure(() => withInstanceLock(ctx, "apply", "op-fast", { breakLock: true }, async () => { bodies += 1; }));
  check("a takeover cannot race a release mutation", takeoverError instanceof Error, true);
  check("release gate reached without competing body entry", [gated, bodies], [true, 0]);
  check("release gate preserves owner bytes and marker", [files.get(`${FIXTURE_LOCK_PATH}/holder.json`), files.get(`${MUTATION_PATH}/owner.json`), dirs.has(`${FIXTURE_LOCK_PATH}/gen-${slow.holder.generation}`)], [owner, guardOwner, true]);
  releaseOwnership();
  await releasing;
  check("the release removes its own lock after the guard clears", dirs.has(FIXTURE_LOCK_PATH), false);
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
  async function outcome(takeover: { breakLock: boolean; breakForeignLockHost?: string }, options: { breakLockSupported?: boolean } = {}) {
    const { ctx, files, dirs } = stubContext();
    const old = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString();
    const original = JSON.stringify({ operationId: "op-dead", what: "apply", by: "someone", takenAt: old, host: machineName(), pid: 99999999 });
    dirs.add(FIXTURE_LOCK_PATH);
    files.set(`${FIXTURE_LOCK_PATH}/holder.json`, original);
    let bodies = 0;
    const failure = await captureFailure(() => guardedWith(ctx, "apply", takeover, async () => { bodies += 1; }, options));
    return { failure, bodies, holder: files.get(`${FIXTURE_LOCK_PATH}/holder.json`), root: dirs.has(FIXTURE_LOCK_PATH), guard: dirs.has(MUTATION_PATH), original };
  }
  for (const [label, takeover, options] of [
    ["no takeover", { breakLock: false }, {}],
    ["breakLockSupported: false", { breakLock: false }, { breakLockSupported: false }],
    ["foreign host id without breakLock", { breakLock: false, breakForeignLockHost: "other" }, {}],
  ] as const) {
    const result = await outcome(takeover, options);
    check(`${label}: a stale lock is refused, not taken`, result.failure instanceof UserError, true);
    check(`${label}: no body or holder mutation`, [result.bodies, result.holder, result.root, result.guard], [0, result.original, true, false]);
  }
  const taken = await outcome({ breakLock: true });
  check("breakLock: takes the stale lock and runs", [taken.failure, taken.bodies], [undefined, 1]);
  check("and releases cleanly: no holder remains after the guard", [taken.holder, taken.root, taken.guard], [undefined, false, false]);
}

// --- holder CAS: race after the observed owner's liveness check, before displacement ---------

const legacyOwner = {
  operationId: "legacy-A", what: "apply", by: "legacy", host: machineName(), pid: 99999999,
  takenAt: "2026-10-01T00:00:00.000Z", startedAt: "2026-09-30T23:59:00.000Z",
};
for (const [field, replacement] of [
  ["operationId", "legacy-B"], ["host", "different-host:win32"], ["pid", 99999998],
  ["takenAt", "2026-10-02T00:00:00.000Z"], ["startedAt", "2026-09-29T23:59:00.000Z"],
] as const) {
  const { ctx, files, dirs } = stubContext();
  const root = FIXTURE_LOCK_PATH;
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
  const failure = await captureFailure(() => withInstanceLock(ctx, "apply", "must-not-enter", { breakLock: true }, async () => { entered = true; }));
  check(`legacy ${field} race reaches displacement after liveness`, raced, true);
  check(`legacy ${field} race refuses takeover`, failure instanceof UserError, true);
  check(`legacy ${field} race never enters body`, entered, false);
  check(`legacy ${field} race restores root and bytes`, [dirs.has(root), files.get(`${root}/holder.json`)], [true, JSON.stringify(racedOwner)]);
  check(`legacy ${field} race restores B exactly`, JSON.parse(files.get(`${root}/holder.json`) ?? "null"), racedOwner);
  check(`legacy ${field} race leaves no displaced tree`, [...dirs].some((path) => path.includes(".stale-")), false);
}

// Invalid identity must be refused on the initial read, not merely detected as a changed
// string after displacement. Identical invalid timestamps otherwise pass exact equality.
for (const field of ["takenAt", "startedAt"] as const) {
  const { ctx, files, dirs } = stubContext();
  const root = FIXTURE_LOCK_PATH;
  const original = `${JSON.stringify({ ...legacyOwner, [field]: "not-a-date" }, null, 2)}\n`;
  dirs.add(root);
  files.set(`${root}/holder.json`, original);
  files.set(`${root}/keep.txt`, "unrelated contents");
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
  check(`initial legacy invalid ${field} preserves unrelated contents`, files.get(`${root}/keep.txt`), "unrelated contents");
}

for (const record of [undefined, "unreadable JSON", JSON.stringify({ ...legacyOwner, takenAt: "not-a-date" }),
  JSON.stringify({ ...legacyOwner, operationId: "" }), JSON.stringify({ ...legacyOwner, startedAt: "invalid" }),
  JSON.stringify({ ...legacyOwner, generation: "" }), JSON.stringify({ ...legacyOwner, generation: null })]) {
  const { ctx, files, dirs } = stubContext();
  const root = FIXTURE_LOCK_PATH;
  dirs.add(root);
  files.set(`${root}/holder.json`, JSON.stringify(legacyOwner));
  files.set(`${root}/keep.txt`, "unrelated contents");
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
  const read = ctx.transport.readFile;
  let reads = 0;
  ctx.transport.readFile = async (path) => {
    if (path.startsWith(`${root}.stale-`) && path.endsWith("/holder.json")) reads += 1;
    return read(path);
  };
  let entered = false;
  const failure = await captureFailure(() => withInstanceLock(ctx, "apply", "must-not-enter", { breakLock: true }, async () => { entered = true; }));
  check(`malformed displaced legacy never enters body: ${record ?? "missing"}`, entered, false);
  check(`displaced ${record ?? "missing"} was actually read`, [displaced, reads], [true, 1]);
  check(`malformed displaced legacy refuses: ${record ?? "missing"}`, failure instanceof UserError, true);
  check(`malformed displaced legacy restores root: ${record ?? "missing"}`, dirs.has(root), true);
  check(`malformed displaced legacy preserves unrelated contents: ${record ?? "missing"}`, files.get(`${root}/keep.txt`), "unrelated contents");
  check(`malformed displaced legacy preserves record: ${record ?? "missing"}`, files.get(`${root}/holder.json`), record);
}

{
  const { ctx, files, dirs } = stubContext();
  const root = FIXTURE_LOCK_PATH;
  dirs.add(root);
  files.set(`${root}/holder.json`, JSON.stringify(legacyOwner));
  const exec = ctx.transport.exec;
  let heartbeatChanges = 0;
  ctx.transport.exec = async (command, args) => {
    if (command === "mv" && args[0] === root) {
      heartbeatChanges += 1;
      files.set(`${root}/holder.json`, JSON.stringify({ ...legacyOwner, heartbeatAt: "2026-10-09T00:00:00.000Z" }));
    }
    return exec(command, args);
  };
  let entered = false;
  await withInstanceLock(ctx, "apply", "same-legacy", { breakLock: true }, async () => {
    entered = true;
    check("same legacy publishes the new owner", (await readLockHolder(ctx))?.operationId, "same-legacy");
  });
  check("same legacy reaches heartbeat-only race", heartbeatChanges, 1);
  check("same legacy succeeds despite changed heartbeat", entered, true);
  check("same legacy releases root cleanly", dirs.has(root), false);
}

{
  const { ctx, files, dirs } = stubContext();
  const root = FIXTURE_LOCK_PATH;
  dirs.add(root);
  files.set(`${root}/holder.json`, JSON.stringify(legacyOwner));
  files.set(`${root}/keep.txt`, "unrelated contents");
  const read = ctx.transport.readFile;
  let unreadable = 0;
  ctx.transport.readFile = async (path) => {
    if (path.includes(".stale-") && path.endsWith("/holder.json")) {
      unreadable += 1;
      throw new Error("permission denied reading displaced holder");
    }
    return read(path);
  };
  let entered = false;
  const failure = await captureFailure(() => withInstanceLock(ctx, "apply", "must-not-enter", { breakLock: true }, async () => { entered = true; }));
  check("unreadable displaced record never enters body", entered, false);
  check("unreadable displaced record restores root", dirs.has(root), true);
  check("unreadable displaced record reaches failed read", unreadable, 1);
  check("unreadable displaced record refuses", failure instanceof UserError, true);
  check("unreadable displaced record restores original bytes", files.get(`${root}/holder.json`), JSON.stringify(legacyOwner));
  check("unreadable displaced record preserves unrelated contents", files.get(`${root}/keep.txt`), "unrelated contents");
}

for (const uncertain of [false, true]) {
  const { ctx, files, dirs } = stubContext();
  const root = FIXTURE_LOCK_PATH;
  dirs.add(root);
  files.set(`${root}/holder.json`, JSON.stringify(legacyOwner));
  const racedOwner = { ...legacyOwner, operationId: "legacy-B" };
  const collidingOwner = { ...legacyOwner, operationId: "live-C", pid: process.pid };
  const exec = ctx.transport.exec;
  let restores = 0;
  let faults = 0;
  let parked = "";
  ctx.transport.exec = async (command, args) => {
    if (command === "mv" && args[0] === root) files.set(`${root}/holder.json`, JSON.stringify(racedOwner));
    // Inject at the restoration operation itself, not at an earlier absence probe.
    // Removing -T must expose real mv nesting; removing -n must not overwrite C.
    if (command === "mv" && args.at(-1) === root && (args.at(-2) ?? "").includes(".stale-")) {
      restores += 1;
      parked = args.at(-2)!;
      dirs.add(root);
      files.set(`${root}/holder.json`, JSON.stringify(collidingOwner));
      files.set(`${root}/live-only.txt`, "live data");
      if (uncertain) { faults += 1; throw new Error("restore acknowledgement unavailable"); }
    }
    return exec(command, args);
  };
  let entered = false;
  const failure = await captureFailure(() => withInstanceLock(ctx, "apply", "must-not-enter", { breakLock: true }, async () => { entered = true; }));
  check(`restore collision ${uncertain} never enters body`, entered, false);
  check(`restore collision ${uncertain} refuses`, failure instanceof UserError, true);
  check(`restore collision ${uncertain} reaches restoration`, [restores, faults, parked.startsWith(`${root}.stale-`)], [1, uncertain ? 1 : 0, true]);
  check(`restore collision ${uncertain} preserves C`, JSON.parse(files.get(`${root}/holder.json`) ?? "null"), collidingOwner);
  check(`restore collision ${uncertain} preserves B safely parked`, JSON.parse(files.get(`${parked}/holder.json`) ?? "null"), racedOwner);
  check(`restore collision ${uncertain} keeps displaced root`, dirs.has(parked), true);
  check(`restore collision ${uncertain} never nests into live root`, [...dirs].some((path) => path.startsWith(`${root}/operation.lock.stale-`)), false);
  check(`restore collision ${uncertain} preserves unrelated live data`, files.get(`${root}/live-only.txt`), "live data");
}

// --- actual historical by-only acquisition: permission, publication and raw-identity CAS ---
const historicalOwner = {
  operationId: "20260919205351298-restart-e1f2f4", what: "restart",
  by: "Computer@PC pid 17012", takenAt: "2026-09-19T20:53:51.503Z",
};
function historicalFixture() {
  const target = stubContext();
  const root = FIXTURE_LOCK_PATH;
  target.dirs.add(root);
  target.files.set(`${root}/holder.json`, `${JSON.stringify(historicalOwner, null, 2)}\n`);
  target.files.set(`${root}/keep.txt`, "unrelated old bytes");
  return target;
}
for (const [label, options] of [
  ["missing flags", {}], ["break only", { breakLock: true }],
  ["wrong host", { breakLock: true, breakForeignLockHost: "pc" }],
  ["foreign only", { breakForeignLockHost: "PC" }],
] as const) {
  const { ctx, files, dirs } = historicalFixture();
  const root = FIXTURE_LOCK_PATH;
  const before = files.get(`${root}/holder.json`);
  const exec = ctx.transport.exec;
  let moved = 0;
  ctx.transport.exec = async (command, args) => {
    if (command === "mv" && args[0] === root) moved += 1;
    return exec(command, args);
  };
  let entered = false;
  let failure: unknown;
  try {
    await withInstanceLock(ctx, "restart", "unauthorized", options, async () => { entered = true; });
  } catch (error) { failure = error; }
  check(`historical ${label} refuses with UserError`, failure instanceof UserError, true);
  check(`historical ${label} never enters or moves`, [entered, moved], [false, 0]);
  check(`historical ${label} preserves original bytes`, files.get(`${root}/holder.json`), before);
  check(`historical ${label} preserves unrelated bytes and root`, [files.get(`${root}/keep.txt`), dirs.has(root)], ["unrelated old bytes", true]);
  const advice = failure instanceof UserError ? failure.advice : [];
  check(`historical ${label} manual only, no executable argv`, advice.map((entry) => [entry.kind, "argv" in entry]), [["manual", false]]);
}
{
  const { ctx, files, dirs } = historicalFixture();
  const root = FIXTURE_LOCK_PATH;
  let entered = false;
  await withInstanceLock(ctx, "apply", "approved-new-owner", { breakLock: true, breakForeignLockHost: "PC" }, async () => {
    entered = true;
    const owner = (await readLockHolder(ctx))!;
    check("historical approved takeover publishes only new acquisition", [owner.operationId, owner.what, owner.pid], ["approved-new-owner", "apply", process.pid]);
    const ownerHost = (owner.host ?? "").split(":");
    check("historical approved takeover publishes the physical host", [ownerHost.length, ownerHost[0]], [2, process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? hostname()]);
    await requires("linux-host", "historical takeover publishes Linux pid scope", () => check("historical approved takeover publishes Linux pid scope", /^(?:linux-[1-9][0-9]*|linux-unknown)$/.test(ownerHost[1] ?? ""), true));
    await requires("windows-host", "historical takeover publishes Windows pid scope", () => check("historical approved takeover publishes Windows pid scope", ownerHost[1], "win32"));
    check("historical approved takeover mints a generation marker", typeof owner.generation === "string" && dirs.has(`${root}/gen-${owner.generation}`), true);
    check("historical approved takeover never retains historical acquisition fields", owner.by !== historicalOwner.by && owner.takenAt !== historicalOwner.takenAt, true);
    check("historical approved takeover never copies unrelated old bytes", files.has(`${root}/keep.txt`), false);
  });
  check("historical exact both flags enter and release", [entered, dirs.has(root)], [true, false]);
}
for (const [field, replacement] of [
  ["by", "OtherUser@PC pid 17012"], ["by", "Computer@PC pid 17013"],
  ["by", "Computer@OTHER-PC pid 17012"], ["operationId", "historical-B"],
  ["takenAt", "2026-09-19T20:53:51.504Z"], ["what", "apply"],
] as const) {
  const { ctx, files, dirs } = historicalFixture();
  const root = FIXTURE_LOCK_PATH;
  const racedBytes = `${JSON.stringify({ ...historicalOwner, [field]: replacement }, null, 2)}\n`;
  const exec = ctx.transport.exec;
  let raced = false;
  ctx.transport.exec = async (command, args) => {
    if (command === "mv" && args[0] === root && !raced) {
      raced = true; // After observed approval, immediately before the initial move.
      files.set(`${root}/holder.json`, racedBytes);
    }
    return exec(command, args);
  };
  let entered = false;
  let failure: unknown;
  try {
    await withInstanceLock(ctx, "restart", "must-not-enter", { breakLock: true, breakForeignLockHost: "PC" }, async () => { entered = true; });
  } catch (error) { failure = error; }
  const label = `historical ${field}=${replacement} CAS`;
  check(`${label} reaches race and refuses UserError`, [raced, failure instanceof UserError], [true, true]);
  check(`${label} never enters body`, entered, false);
  check(`${label} restores B byte-for-byte`, files.get(`${root}/holder.json`), racedBytes);
  check(`${label} restores root and unrelated bytes`, [dirs.has(root), files.get(`${root}/keep.txt`)], [true, "unrelated old bytes"]);
  check(`${label} leaves no parked directory without collision`, [...dirs].some((path) => path.includes(".stale-")), false);
}

finish("instance lock takeover");
