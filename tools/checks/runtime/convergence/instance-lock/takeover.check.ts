// A takeover is where the lock's atomicity is easiest to lose: the directory already exists,
// so winning it is not "the mkdir that succeeds" the way a fresh claim is. These checks cover
// a stale lock being described rather than silently taken, a takeover's holder surviving the
// run it displaced, two `--break-lock` callers racing the same contested directory with only
// one allowed to actually enter the body, and — the two cases the generation CAS exists for —
// a pathname re-created underneath a caller that had read it, and a release whose remove runs
// after a takeover has finished.

import { takeLock, withInstanceLock, readLockHolder, isStale, lockPath, STALE_AFTER_MS } from "#framework/runtime/instance-lock.ts";
import { stubContext, refused } from "./fixture.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
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
  check("saying it may be left over from a run that died", message.includes("may be left over"), true);
  check("and that the reader is the one who decides", message.includes("--break-lock"), true);
  check("the dead holder is still in place", (await readLockHolder(ctx))?.operationId, "op-dead");

  const taken = await takeLock(ctx, "apply", "op-new", { breakLock: true });
  check("--break-lock takes it over", (await readLockHolder(ctx))?.operationId, "op-new");
  await taken.release();
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
  check("the competing caller is told the lock change is in progress", fastError?.message.includes("in progress"), true);

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
  check("a third caller is refused while the takeover owns the mutation guard", thirdCaller.includes("in progress"), true);
  releaseRead();
  await takeover;

  check("the generation mismatch refuses takeover", takeoverError?.message.includes("already took it over"), true);
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
  check("a takeover cannot race a release mutation", takeoverError?.message.includes("in progress"), true);
  releaseOwnership();
  await releasing;
  check("the release removes its own lock after the guard clears", dirs.has(lockPath(ctx)), false);
}

process.stderr.write(failed === 0 ? "all instance lock takeover checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
