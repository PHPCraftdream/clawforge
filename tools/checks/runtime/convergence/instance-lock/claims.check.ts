// One instance, one change at a time.
//
// The lock's job is to refuse, so most of what is worth asserting is about refusals: that
// the second run is stopped, that it is told enough to do something about it, and that a
// failed run does not keep the lock. Marker and write-failure recovery — not stranding a
// claim half-made — lives here too, including a takeover's own: a won takeover is a genuinely
// fresh directory (instance-lock/takeover.check.ts covers who wins one; this file only cares
// that a failure afterwards is cleaned up like any other fresh claim's).

import { takeLock, withInstanceLock, readLockHolder, lockPath } from "#framework/runtime/instance-lock.ts";
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
      dirs.add(`${lockPath(ctx)}/gen-someone-elses`);
      return { code: 1, stdout: "", stderr: "foreign marker appeared" };
    }
    return originalExec(command, args);
  };

  const message = await refused(() => takeLock(ctx, "apply", "op-foreign-marker"));
  check("a foreign marker failure is reported", message.includes("foreign marker appeared"), true);
  check("a foreign marker prevents root cleanup", dirs.has(lockPath(ctx)), true);
  await ctx.transport.remove(lockPath(ctx));
}

// A takeover wins a genuinely fresh directory (the old one is moved aside first), so a write
// failure afterwards is the same case a failed fresh claim already handles: cleaned up, not
// left half-written for the next attempt to trip over.
{
  const { ctx, files, dirs } = stubContext();
  const originalWrite = ctx.transport.writeFile;
  const holderPath = `${lockPath(ctx)}/holder.json`;
  const oldHolder = JSON.stringify({ operationId: "op-old", what: "apply", by: "old", takenAt: new Date().toISOString() });
  dirs.add(lockPath(ctx));
  files.set(holderPath, oldHolder);
  ctx.transport.writeFile = async (path: string, content: string) => {
    files.set(path, content);
    throw new Error("takeover write failed");
  };

  const message = await refused(() => takeLock(ctx, "apply", "op-takeover", { breakLock: true }));
  check("a failed takeover write reports its own failure", message, "takeover write failed");
  check("a failed takeover is cleaned up rather than left half-written", dirs.has(lockPath(ctx)), false);

  ctx.transport.writeFile = originalWrite;
  const retry = await takeLock(ctx, "apply", "op-takeover-retry");
  check("the lock can be retaken after a failed takeover write", (await readLockHolder(ctx))?.operationId, "op-takeover-retry");
  await retry.release();
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
  const originalExec = ctx.transport.exec;
  ctx.transport.writeFile = async () => {
    throw new Error("holder write is the useful failure");
  };
  // The cleanup is an empty-directory rmdir of the lock root, so a failure to remove the
  // root is what must not mask the holder write failure.
  ctx.transport.exec = async (command: string, args: string[]) => {
    if (command === "rmdir" && args[0] === lockPath(ctx)) return { code: 1, stdout: "", stderr: "rmdir failed" };
    return originalExec(command, args);
  };

  const message = await refused(() => takeLock(ctx, "apply", "op-cleanup"));
  check("cleanup failure does not hide the holder write failure", message, "holder write is the useful failure");
  check("the lock remains observable when cleanup itself fails", dirs.has(lockPath(ctx)), true);
  ctx.transport.exec = originalExec;
  await ctx.transport.remove(lockPath(ctx));
}

process.stderr.write(failed === 0 ? "all instance lock claim checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
