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

  let fastEnteredBody = false;
  let fastHolderId: string | undefined;
  await withInstanceLock(ctx, "apply", "op-fast", { breakLock: true }, async () => {
    fastEnteredBody = true;
    fastHolderId = (await readLockHolder(ctx))?.operationId;
  });
  check("a second, unstalled takeover wins the directory while the first is paused", fastEnteredBody, true);
  check("and is the one recorded as holder while its body runs", fastHolderId, "op-fast");

  releaseStalled();
  await stalled;
  check("the stalled caller never enters the critical section", stalledEnteredBody, false);
  check("its takeover is refused once the directory it tried to move is already gone", stalledError !== undefined, true);
  check("saying another operation already won the takeover", stalledError?.message.includes("already took it over"), true);
  check("exactly one of the two racing callers ran, and the lock is clear again", dirs.has(lockPath(ctx)), false);
}

// --- a faster takeover re-creating the pathname is not the lock the slower one read ----------
//
// The rename above is atomic, and that is ALL it proves: nothing in it says the caller moved
// the lock it had just read. B reads the old holder and pauses before its move; A takes the
// lock over properly and is running its body; B resumes and moves away A's LIVE lock — a
// directory that did not exist when B looked, and that B has no identity for — mkdirs its
// own, and both are inside the critical section. The generation inside the displaced
// directory is what tells the two apart: it is the one observed before the move, or the
// directory belongs to someone else and goes back untouched.
//
// The old holder names no generation, so B observes `undefined` and must accept it; the lock
// A leaves at the path names A's, and comparing the two is what refuses B.

{
  const { ctx, files, dirs } = stubContext();
  // A holder written before generations existed: no identity recorded, and `undefined`
  // compares equal to `undefined`, so a takeover of it is still checked.
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

  // A takeover that runs to completion while B is paused: it rotates the old lock away and is
  // sitting in its body, still holding what it won, by the time B resumes.
  let fastInBody!: () => void;
  const fastInBodySignal = new Promise<void>((resolve) => { fastInBody = resolve; });
  let releaseFast!: () => void;
  const fastGate = new Promise<void>((resolve) => { releaseFast = resolve; });
  let fastEnteredBody = false;
  let fastHolderId: string | undefined;
  const fast = withInstanceLock(ctx, "apply", "op-fast", { breakLock: true }, async () => {
    fastEnteredBody = true;
    fastHolderId = (await readLockHolder(ctx))?.operationId;
    fastInBody();
    await fastGate; // Fully in the body, holding the lock it won.
  });
  await fastInBodySignal;

  check("a takeover that completes in the meantime wins the directory", fastEnteredBody, true);
  check("and is the one recorded as holder while its body runs", fastHolderId, "op-fast");
  check("leaving its own live lock at the path", [...dirs].some((entry) => entry.startsWith(`${lockPath(ctx)}/gen-`)), true);

  releaseStalled();
  await stalled;
  check("the stalled caller still never enters the critical section", stalledEnteredBody, false);
  check("its move succeeded — and moved the wrong directory", stalledError !== undefined, true);
  check("saying another operation already won the takeover", stalledError?.message.includes("already took it over"), true);
  check("the live lock it moved aside was restored, not stolen", dirs.has(lockPath(ctx)), true);
  check("so the faster takeover is still the recorded holder", (await readLockHolder(ctx))?.operationId, "op-fast");

  releaseFast();
  await fast;
  check("and once the faster takeover releases, the lock is gone", dirs.has(lockPath(ctx)), false);
}

// --- a release finishing after a takeover removes nothing of the new owner's -----------------
//
// The other side of the same gap. Release used to read the holder, see its own operation id,
// and then remove the directory — two operations with the whole takeover in between, so the
// remove deleted the lock of whoever had taken it over in the meantime. It is now one atomic
// ownership check instead: moving its own generation marker aside, which either succeeds
// (the directory is ours to finish with) or finds the marker already gone (a takeover rotated
// this exact identity out, and nothing is touched at all).
//
// The slow holder's release is paused at its ownership check with the takeover free to
// complete in the meantime, so the removal step — had it been a remove — would run strictly
// after a finished takeover. A holder read is gated too: that is where the old release did
// its checking, and the gate answers what that read saw before the takeover happened.

{
  const { ctx, files, dirs } = stubContext();
  const slow = await takeLock(ctx, "apply", "op-slow");
  const slowHolderPath = `${lockPath(ctx)}/holder.json`;
  // What the slow holder's release read before the takeover happened.
  const slowHolder = files.get(slowHolderPath) ?? "";

  let takeoverInBody!: () => void;
  const takeoverInBodySignal = new Promise<void>((resolve) => { takeoverInBody = resolve; });
  let releaseTakeover!: () => void;
  const takeoverGate = new Promise<void>((resolve) => { releaseTakeover = resolve; });

  const originalExec = ctx.transport.exec;
  const originalRead = ctx.transport.readFile;
  let reachedOwnershipCheck!: () => void;
  const atOwnershipCheck = new Promise<void>((resolve) => { reachedOwnershipCheck = resolve; });
  let releaseOwnershipCheck!: () => void;
  const ownershipGate = new Promise<void>((resolve) => { releaseOwnershipCheck = resolve; });
  let gated = false;
  ctx.transport.readFile = async (path: string) => {
    if (path === slowHolderPath && !gated) {
      gated = true;
      reachedOwnershipCheck();
      await ownershipGate;
      return slowHolder; // What that read saw, before anything took the lock over.
    }
    return originalRead(path);
  };
  ctx.transport.exec = async (command: string, args: string[]) => {
    // The ownership check proper: moving this holder's own generation marker out of the way,
    // held until the takeover below has finished rotating the lock away under it.
    if (command === "mv" && (args[1] ?? "").includes(".released-") && !gated) {
      gated = true;
      reachedOwnershipCheck();
      await ownershipGate;
    }
    return originalExec(command, args);
  };

  let releaseResolved = false;
  const releasing = slow.release().then(() => { releaseResolved = true; });
  await atOwnershipCheck;

  const takeover = withInstanceLock(ctx, "apply", "op-fast", { breakLock: true }, async () => {
    takeoverInBody();
    await takeoverGate;
  });
  await takeoverInBodySignal;

  check("the takeover is fully inside its body, marker and holder written", (await readLockHolder(ctx))?.operationId, "op-fast");
  check("with its own lock in place at the path", dirs.has(lockPath(ctx)), true);

  releaseOwnershipCheck();
  await releasing;
  check("the late release resolves without disturbing the new holder", releaseResolved, true);
  check("it removed nothing: the takeover's directory is still there", dirs.has(lockPath(ctx)), true);
  check("and the takeover is still the recorded holder", (await readLockHolder(ctx))?.operationId, "op-fast");

  releaseTakeover();
  await takeover;
  check("and once the takeover releases, the lock is gone", dirs.has(lockPath(ctx)), false);
}

process.stderr.write(failed === 0 ? "all instance lock takeover checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
