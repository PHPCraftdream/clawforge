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
  readLockHolder,
  refusalMessage,
  isStale,
  lockHeldHere,
  lockPath,
  lockHome,
  STALE_AFTER_MS,
} from "../framework/instance-lock.ts";
import { withOutputSink } from "../framework/output.ts";
import type { Context } from "../framework/context.ts";

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
          for (const key of [...files.keys()]) {
            if (key.startsWith(`${path}/`)) files.delete(key);
          }
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

{
  const { ctx } = stubContext();
  check("nothing is held to begin with", lockHeldHere(), false);

  await withInstanceLock(ctx, "apply", "op-1", {}, async () => {
    // apply runs provision-agent as a step, and that command takes the lock when invoked on
    // its own. Without this, an apply would be refused by its own lock at its own fourth
    // step, with a message accusing itself.
    check("while an operation runs, this process knows it holds the lock", lockHeldHere(), true);
  });

  check("and stops knowing it afterwards", lockHeldHere(), false);
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
      async exec(command: string, args: string[]) {
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
