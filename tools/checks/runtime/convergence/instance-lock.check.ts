// One instance, one change at a time.
//
// The lock's job is to refuse, so most of what is worth asserting is about refusals: that
// the second run is stopped, that it is told enough to do something about it, that a failed
// run does not keep the lock, and that a lock left by a dead run is described rather than
// quietly taken. The last one is the one that would be tempting to get wrong: stealing a
// stale lock automatically is the same bug one layer down.

import {
  takeLock,
  withInstanceLock,
  guarded,
  readLockHolder,
  refusalMessage,
  isStale,
  lockHeldHere,
  lockPath,
  lockHome,
  STALE_AFTER_MS,
} from "#framework/runtime/instance-lock.ts";
import { withOutputSink } from "#framework/core/output.ts";
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

/** A target with the one property the lock is built on: `mkdir` of an existing directory
 *  fails. Emulated rather than assumed, because it is the entire mechanism — a stub whose
 *  mkdir always succeeded would let this file pass against a lock that locks nothing. */
function stubContext() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    ctx: {
      settings: { dataDir: "/srv/clawforge" },
      transport: {
        async exec(command: string, args: string[]) {
          if (command === "mkdir") {
            const target = args[args.length - 1];
            if (dirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
            dirs.add(target);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "rmdir") {
            const target = args[args.length - 1];
            const hasFile = [...files.keys()].some((entry) => entry.startsWith(`${target}/`));
            const hasChild = [...dirs].some((entry) => entry.startsWith(`${target}/`));
            if (hasFile || hasChild) return { code: 1, stdout: "", stderr: "Directory not empty" };
            dirs.delete(target);
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        async readFile(path: string): Promise<string> {
          const content = files.get(path);
          if (content === undefined) throw new Error(`no such file: ${path}`);
          return content;
        },
        async writeFile(path: string, content: string): Promise<void> {
          files.set(path, content);
        },
        async remove(path: string): Promise<void> {
          files.delete(path);
          dirs.delete(path);
          for (const key of files.keys()) {
            if (key.startsWith(`${path}/`)) files.delete(key);
          }
        },
        async removeEmptyTree(path: string): Promise<boolean> {
          for (const dir of [...dirs].filter((entry) => entry.startsWith(`${path}/`)).sort((a, b) => b.length - a.length)) {
            const hasFile = [...files.keys()].some((entry) => entry.startsWith(`${dir}/`));
            const hasChild = [...dirs].some((entry) => entry.startsWith(`${dir}/`));
            if (!hasFile && !hasChild) dirs.delete(dir);
          }
          const hasFile = [...files.keys()].some((entry) => entry.startsWith(`${path}/`));
          const hasChild = [...dirs].some((entry) => entry.startsWith(`${path}/`));
          if (!hasFile && !hasChild) {
            dirs.delete(path);
            return true;
          }
          return false;
        },
      },
    } as unknown as Context,
  };
}

async function refused(body: () => Promise<unknown>): Promise<string> {
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try {
        await body();
      } catch (error) {
        message = (error as Error).message;
      }
    },
  );
  return message;
}

// --- taking and releasing --------------------------------------------------------------------

{
  const { ctx, files } = stubContext();
  const held = await takeLock(ctx, "apply", "op-1");
  check("taking the lock writes it where both sides can see it", files.has(`${lockPath(ctx)}/holder.json`), true);
  check("the holder says what it is doing", (await readLockHolder(ctx))?.what, "apply");
  check("and which operation holds it", (await readLockHolder(ctx))?.operationId, "op-1");

  await held.release();
  check("releasing removes it", await readLockHolder(ctx), undefined);
}

// --- the refusal ------------------------------------------------------------------------------

{
  const { ctx } = stubContext();
  const first = await takeLock(ctx, "apply", "op-1");

  const message = await refused(() => takeLock(ctx, "provision-agent demo", "op-2"));
  check("a second operation is refused", message !== "", true);
  // A refusal that does not say who holds it leaves the reader deleting files and hoping.
  check("the refusal names the holder's operation", message.includes("op-1"), true);
  check("and what it is doing", message.includes("apply"), true);
  check("and offers the way out", message.includes("--break-lock"), true);

  await first.release();
  const second = await takeLock(ctx, "provision-agent demo", "op-2");
  check("once released, the next operation gets it", (await readLockHolder(ctx))?.operationId, "op-2");
  await second.release();
}

// --- a failure must not keep the lock ----------------------------------------------------------

{
  const { ctx } = stubContext();
  await refused(() =>
    withInstanceLock(ctx, "apply", "op-1", {}, async () => {
      throw new Error("the restart failed");
    }),
  );
  // A failed operation that kept the lock would block the very command someone runs next to
  // fix it.
  check("a lock is released even when the operation throws", await readLockHolder(ctx), undefined);
}

// --- a failed holder write must not strand a fresh claim ------------------------------------

{
  const { ctx, dirs } = stubContext();
  const originalWrite = ctx.transport.writeFile;
  let fail = true;
  ctx.transport.writeFile = async (path: string, content: string) => {
    if (fail) {
      fail = false;
      throw new Error("holder write failed");
    }
    await originalWrite(path, content);
  };

  const message = await refused(() => takeLock(ctx, "apply", "op-write-fails"));
  check("the original holder write failure is reported", message, "holder write failed");
  check("a failed fresh claim is cleaned up", dirs.has(lockPath(ctx)), false);

  const retry = await takeLock(ctx, "apply", "op-retry");
  check("the next operation can retry after a failed holder write", (await readLockHolder(ctx))?.operationId, "op-retry");
  await retry.release();
}

{
  const { ctx, files, dirs } = stubContext();
  ctx.transport.writeFile = async (path: string, content: string) => {
    files.set(path, content.slice(0, 24));
    throw new Error("partial holder write");
  };

  const message = await refused(() => takeLock(ctx, "apply", "op-partial"));
  check("a partial holder write reports its own failure", message, "partial holder write");
  check("a partial fresh claim is cleaned up", dirs.has(lockPath(ctx)), false);
}

for (const mode of ["throw", "nonzero"] as const) {
  const { ctx, dirs } = stubContext();
  const originalExec = ctx.transport.exec;
  ctx.transport.exec = async (command: string, args: string[]) => {
    if (command === "mkdir" && args[0] === "-m") {
      if (mode === "throw") throw new Error("marker transport failed");
      return { code: 1, stdout: "", stderr: "marker mkdir failed" };
    }
    return originalExec(command, args);
  };

  const message = await refused(() => takeLock(ctx, "apply", `op-marker-${mode}`));
  check(`marker ${mode} failure is reported`, message.includes(mode === "throw" ? "marker transport failed" : "marker mkdir failed"), true);
  check(`marker ${mode} failure removes the empty fresh claim`, dirs.has(lockPath(ctx)), false);

  ctx.transport.exec = originalExec;
  const retry = await takeLock(ctx, "apply", `op-marker-${mode}-retry`);
  check(`retry succeeds after marker ${mode} failure`, (await readLockHolder(ctx))?.operationId, `op-marker-${mode}-retry`);
  await retry.release();
}

// The marker command can have created our marker before its result was lost. Cleanup must
// remove that exact marker and then the empty lock root, while leaving an unrelated marker.
{
  const { ctx, dirs } = stubContext();
  const originalExec = ctx.transport.exec;
  ctx.transport.exec = async (command: string, args: string[]) => {
    if (command === "mkdir" && args[0] === "-m") {
      dirs.add(args[args.length - 1]);
      return { code: 1, stdout: "", stderr: "marker result lost" };
    }
    return originalExec(command, args);
  };

  const message = await refused(() => takeLock(ctx, "apply", "op-lost-marker"));
  check("lost marker acknowledgement is reported", message.includes("marker result lost"), true);
  check("lost marker acknowledgement does not strand the fresh claim", dirs.has(lockPath(ctx)), false);
}

{
  const { ctx, dirs } = stubContext();
  const originalExec = ctx.transport.exec;
  ctx.transport.exec = async (command: string, args: string[]) => {
    if (command === "mkdir" && args[0] === "-m") {
      dirs.add(`${lockPath(ctx)}/claim-op-foreign`);
      return { code: 1, stdout: "", stderr: "foreign marker appeared" };
    }
    return originalExec(command, args);
  };

  const message = await refused(() => takeLock(ctx, "apply", "op-foreign-marker"));
  check("a foreign marker failure is reported", message.includes("foreign marker appeared"), true);
  check("a foreign marker prevents root cleanup", dirs.has(lockPath(ctx)), true);
  await ctx.transport.remove(lockPath(ctx));
}

// A failed takeover did not create the directory. It must leave both an old holder and a
// holder written by a concurrent takeover untouched, even when writing the requested holder
// throws after changing the file.
{
  const { ctx, files, dirs } = stubContext();
  const holderPath = `${lockPath(ctx)}/holder.json`;
  const oldHolder = JSON.stringify({ operationId: "op-old", what: "apply", by: "old", takenAt: new Date().toISOString() });
  dirs.add(lockPath(ctx));
  files.set(holderPath, oldHolder);
  ctx.transport.writeFile = async (path: string, content: string) => {
    files.set(path, content);
    throw new Error("takeover write failed");
  };

  const message = await refused(() => takeLock(ctx, "apply", "op-takeover", { breakLock: true }));
  check("a failed takeover reports its write failure", message, "takeover write failed");
  check("a failed takeover preserves the newer holder", (await readLockHolder(ctx))?.operationId, "op-takeover");
}

{
  const { ctx, files, dirs } = stubContext();
  ctx.transport.writeFile = async (path: string, _content: string) => {
    files.set(path, JSON.stringify({ operationId: "op-new", what: "apply", by: "new", takenAt: new Date().toISOString() }));
    throw new Error("fresh holder write failed");
  };

  const message = await refused(() => takeLock(ctx, "apply", "op-fresh"));
  check("a fresh write failure reports its error when another holder appears", message, "fresh holder write failed");
  check("a newer holder is never removed by fresh-claim cleanup", dirs.has(lockPath(ctx)), true);
  check("the newer holder remains recorded", (await readLockHolder(ctx))?.operationId, "op-new");
  await ctx.transport.remove(lockPath(ctx));
}

{
  const { ctx, dirs } = stubContext();
  const originalRemove = ctx.transport.remove;
  ctx.transport.writeFile = async () => {
    throw new Error("holder write is the useful failure");
  };
  ctx.transport.remove = async () => {
    throw new Error("cleanup failed");
  };

  const message = await refused(() => takeLock(ctx, "apply", "op-cleanup"));
  check("cleanup failure does not hide the holder write failure", message, "holder write is the useful failure");
  check("the lock remains observable when cleanup itself fails", dirs.has(lockPath(ctx)), true);
  ctx.transport.remove = originalRemove;
  await ctx.transport.remove(lockPath(ctx));
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

// --- nesting -------------------------------------------------------------------------------------
//
// `apply` runs `provision-agent` as one of its steps, and that command takes the lock when
// invoked on its own. Without reentrancy recognition, an apply would be refused by its own
// lock at its own fourth step, with a message accusing itself. What makes the step nested —
// rather than a second operation that happens to run in this process — is that it runs
// inside the lock-holding operation's asynchronous chain, against the SAME instance. The
// chain scope the lock module hands the operation's body is how that is known.

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
  const originalRemove = ctx.transport.remove;
  let lockRemovals = 0;
  ctx.transport.remove = async (path: string) => {
    if (path === lockPath(ctx)) lockRemovals += 1;
    return originalRemove(path);
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

// --- the message itself ----------------------------------------------------------------------------

{
  const fresh = { operationId: "op-1", what: "apply", by: "coder@box pid 1", takenAt: new Date().toISOString() };
  const message = refusalMessage(fresh);
  check("a fresh lock suggests waiting", message.includes("Wait for it to finish"), true);
  check("and does not call it stale", message.includes("may be left over"), false);
}

process.stderr.write(failed === 0 ? "all instance lock checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;

// --- the lock is not inside the tree restore replaces ------------------------------------------
//
// `restore` moves the whole data directory aside and unpacks a new one in its place. A lock
// living inside left with the old tree, so a second process created its own lock in the new
// one and started work while the restore was still running — the lock covered every
// operation except the one most worth covering.

{
  const { ctx } = stubContext();
  const path = lockPath(ctx);
  check("the lock is not under the data directory", path.startsWith("/srv/clawforge/"), false);
  // In a home of its own, beside the data directory. Beside it alone was not enough: the
  // parent can be root-owned, and then nothing next to the data directory is creatable at
  // all — bootstrap prepares this directory so the lock has somewhere it can go.
  check("it sits in a prepared home beside it", path, "/srv/clawforge-locks/operation.lock");
  check("whose name is derived from the data directory", lockHome(ctx), "/srv/clawforge-locks");
  // The data directory's own name is kept, so two deployments sharing a parent — which is
  // how a second deployment on one host is set up — cannot collide on one lock.
  const other = { settings: { dataDir: "/srv/other" } } as unknown as Context;
  check("two deployments under one parent get different locks", lockPath(other) === path, false);
}

// --- the claim is atomic ---------------------------------------------------------------------
//
// The whole mechanism is that creating a directory which already exists fails. Read-then-write,
// which this used to be, let two runs starting together both conclude the lock was free — a
// small window, entirely real, and the only thing standing between two coders.

{
  const { ctx, dirs } = stubContext();
  const first = await takeLock(ctx, "apply", "op-1");
  check("winning the lock creates the directory", dirs.has(lockPath(ctx)), true);

  // Second acquire with the directory already there: refused, without ever reading a holder
  // file to decide.
  const message = await refused(() => takeLock(ctx, "apply", "op-2"));
  check("a second claim against an existing directory is refused", message !== "", true);

  await first.release();
  check("releasing frees the directory for the next run", dirs.has(lockPath(ctx)), false);
  const third = await takeLock(ctx, "apply", "op-3");
  check("which the next run then wins", (await readLockHolder(ctx))?.operationId, "op-3");
  await third.release();
}

{
  // A directory won by a run that died before naming itself. Proceeding would be assuming
  // the best about a state nobody understands; the reader is told there is no name to look
  // for rather than being left to think the report lost it.
  const { ctx, dirs } = stubContext();
  dirs.add(lockPath(ctx));

  const message = await refused(() => takeLock(ctx, "apply", "op-new"));
  check("a lock with no readable holder still refuses", message !== "", true);
  check("and says so plainly", message.includes("did not record who it is"), true);

  const taken = await takeLock(ctx, "apply", "op-new", { breakLock: true });
  check("--break-lock takes over an unnamed lock too", (await readLockHolder(ctx))?.operationId, "op-new");
  await taken.release();
}

process.stderr.write(failed === 0 ? "all instance lock checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;

// --- a lock that cannot be created is not a lock that is held ---------------------------------
//
// Any non-zero mkdir used to read as "someone holds it", so a directory the tooling cannot
// write into produced a report about a lock that was not there, and offered --break-lock,
// which removes nothing and then fails the same way. The directory itself settles which it
// is: present means held, absent means the mkdir failed for a reason of its own.

{
  const denied = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async exec(command: string, _args: string[]) {
        if (command === "mkdir") return { code: 1, stdout: "", stderr: "mkdir: cannot create directory: Permission denied" };
        // The lock directory is genuinely absent — nothing is holding anything.
        if (command === "test") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(): Promise<string> {
        throw new Error("no such file");
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
    },
  } as unknown as Context;

  const message = await refused(() => takeLock(denied, "apply", "op-1"));
  check("a mkdir that fails with the directory absent is not reported as held", message.includes("another operation is changing"), false);
  check("the real reason is repeated verbatim", message.includes("Permission denied"), true);
  check("it says nothing holds it", message.includes("Nothing holds it"), true);
  // --break-lock cannot help here, so it is not suggested.
  check("and does not offer a takeover that would not work", message.includes("--break-lock"), false);
  check("pointing at what prepares the directory instead", message.includes("./clawforge bootstrap"), true);
}

process.stderr.write(failed === 0 ? "all instance lock checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
