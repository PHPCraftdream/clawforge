// `apply` runs `provision-agent` as one of its steps, and that command takes the lock when
// invoked on its own. Without reentrancy recognition, an apply would be refused by its own
// lock at its own fourth step, with a message accusing itself. What makes the step nested —
// rather than a second operation that happens to run in this process — is that it runs
// inside the lock-holding operation's asynchronous chain, against the SAME instance. The
// chain scope the lock module hands the operation's body is how that is known.

import { takeLock, withInstanceLock, guarded, readLockHolder, refusalMessage, lockHeldHere, lockPath } from "#framework/runtime/instance-lock.ts";
import { stubContext } from "./fixture.ts";
import type { Context } from "#framework/core/context.ts";

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

// --- nesting -------------------------------------------------------------------------------------

{
  const { ctx, dirs } = stubContext();
  const originalExec = ctx.transport.exec;
  let lockClaims = 0;
  ctx.transport.exec = async (command: string, args: string[]) => {
    if (command === "mkdir" && args[0] === lockPath(ctx)) lockClaims += 1;
    return originalExec(command, args);
  };

  check("nothing is held to begin with", lockHeldHere(ctx), false);

  await withInstanceLock(ctx, "apply", "op-1", {}, async () => {
    check("while an operation runs, its own chain knows it holds this instance's lock", lockHeldHere(ctx), true);

    // The step shape: a command that takes the lock when invoked on its own, called from
    // inside the operation that already holds it.
    let stepRan = false;
    await guarded(ctx, "provision-agent demo", [], async () => {
      stepRan = true;
    });
    check("a genuinely nested call runs without refusing", stepRan, true);
    check("without taking a second lock", lockClaims, 1);
  });

  check("and stops knowing it afterwards", lockHeldHere(ctx), false);
  check("and the lock directory is gone", dirs.has(lockPath(ctx)), false);
}

// --- an independent operation in the same process is a stranger, not a nested call ---------------
//
// Reentrancy replaced a process-global counter, which knew only "some lock is held in this
// process": a second operation started beside a running one slipped past acquisition
// entirely and changed the instance unlocked. Chains, not processes, are what nest — so the
// second operation goes through normal acquisition and is refused exactly the way another
// process is refused. No queue, no wait, no second chance.

{
  const { ctx, dirs } = stubContext();
  const originalExec = ctx.transport.exec;
  // Release removes the lock root with an empty-directory rmdir, exactly once.
  let lockRemovals = 0;
  ctx.transport.exec = async (command: string, args: string[]) => {
    if (command === "rmdir" && args[0] === lockPath(ctx)) lockRemovals += 1;
    return originalExec(command, args);
  };

  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });

  let firstRan = false;
  let firstChainKnows = false;
  let secondRan = false;
  const first = guarded(ctx, "apply", [], async () => {
    firstRan = true;
    firstChainKnows = lockHeldHere(ctx);
    firstStarted();
    await gate;
  });
  await started;

  check("the first operation holds the lock while it runs", dirs.has(lockPath(ctx)), true);
  check("the chain running the operation knows it holds the lock", firstChainKnows, true);
  check("a chain outside the operation does not inherit the hold", lockHeldHere(ctx), false);

  // Started from outside the first operation's callback: no ancestry, no reentrancy.
  const holder = (await readLockHolder(ctx))!;
  let secondError: Error | undefined;
  await guarded(ctx, "restart", [], async () => {
    secondRan = true;
  }).then(() => undefined, (error: Error) => { secondError = error; });

  check("an independent operation does not enter its body while the first holds the lock", secondRan, false);
  check("it is refused, not queued or waved through", secondError !== undefined, true);
  check("with the same refusal another process gets", secondError?.message, refusalMessage(holder));
  check("naming what holds it", secondError?.message.includes("apply"), true);

  releaseFirst();
  await first;
  check("the first operation still ran to completion", firstRan, true);
  check("its lock was removed exactly once", lockRemovals, 1);
  check("the lock directory is gone afterwards", dirs.has(lockPath(ctx)), false);
  check("and this chain no longer knows the lock", lockHeldHere(ctx), false);

  const next = await takeLock(ctx, "apply", "op-after");
  check("the lock it freed can be won again", (await readLockHolder(ctx))?.operationId, "op-after");
  await next.release();
  check("and gone again after that run too", dirs.has(lockPath(ctx)), false);
}

// --- a nested call about a DIFFERENT instance is not this lock ------------------------------------
//
// `set try` is the live case: its throwaway instance has its own data directory and its own
// lock, and the commands it runs against the throwaway must take THAT lock — a "nested"
// flag that waved anything through would have left the whole trial running unlocked beside
// the outer operation. Different resource means normal acquisition, whatever the ancestry.

{
  const first = stubContext();
  const other = { ...first.ctx, settings: { dataDir: "/srv/other" } } as unknown as Context;

  let releaseOuter!: () => void;
  const gate = new Promise<void>((resolve) => { releaseOuter = resolve; });
  let outerStarted!: () => void;
  const started = new Promise<void>((resolve) => { outerStarted = resolve; });

  let innerRan = false;
  const outer = guarded(first.ctx, "apply", [], async () => {
    outerStarted();
    await guarded(other, "provision-agent demo", [], async () => {
      innerRan = true;
      // Observed from inside the inner body: it really won the other instance's lock.
      check("the nested different-instance call took its own lock", first.dirs.has(lockPath(other)), true);
      check("which records what it is doing", (await readLockHolder(other))?.what, "provision-agent demo");
      check("while the outer instance's lock stays in place", first.dirs.has(lockPath(first.ctx)), true);
      check("and the outer chain still knows its own hold", lockHeldHere(first.ctx), true);
    });
    check("the inner lock is released once the inner call is done", first.dirs.has(lockPath(other)), false);
    await gate;
  });
  await started;
  releaseOuter();
  await outer;
  check("the nested different-instance call ran", innerRan, true);
  check("neither lock directory survives", first.dirs.has(lockPath(first.ctx)) || first.dirs.has(lockPath(other)), false);
}

// The same path on a different transport is a different target. Reentrancy must not use the
// path alone, or a nested local call could wave an SSH call through without taking its lock.
{
  const first = stubContext();
  const second = stubContext();
  const secondCtx = {
    ...second.ctx,
    settings: { dataDir: first.ctx.settings.dataDir },
    transport: { ...second.ctx.transport, description: "ssh:other-target" },
  } as unknown as Context;
  let innerRan = false;

  await withInstanceLock(first.ctx, "local", "op-local", {}, async () => {
    await guarded(secondCtx, "remote", [], async () => {
      innerRan = true;
      check("same path on another transport takes its own lock", second.dirs.has(lockPath(secondCtx)), true);
    });
  });
  check("the different transport operation ran", innerRan, true);
  check("the different transport lock was released", second.dirs.has(lockPath(secondCtx)), false);
}

// Async descendants created by an owning operation must not retain its lease after release.
{
  const { ctx, dirs } = stubContext();
  let releaseParent!: () => void;
  const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
  let releaseLate!: () => void;
  const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
  let late!: Promise<void>;
  let lateEntered = false;

  const parent = guarded(ctx, "parent", [], async () => {
    late = lateGate.then(async () => {
      await guarded(ctx, "late", [], async () => {
        lateEntered = true;
        throw new Error("late operation entered after release");
      });
    });
    await parentGate;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  check("parent owns the lock before release", dirs.has(lockPath(ctx)), true);
  releaseParent();
  await parent;

  const competing = await takeLock(ctx, "competing", "op-competing");
  releaseLate();
  let lateError: Error | undefined;
  await late.then(() => undefined, (error: Error) => { lateError = error; });
  check("a released descendant does not enter while another operation owns the lock", lateError !== undefined, true);
  check("the released descendant body was not waved through", lateEntered, false);
  check("the competing operation remains the holder", (await readLockHolder(ctx))?.operationId, "op-competing");
  await competing.release();
}

process.stderr.write(failed === 0 ? "all instance lock nesting checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
