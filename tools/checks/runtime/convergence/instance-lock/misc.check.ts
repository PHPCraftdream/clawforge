// Grab-bag for what does not belong to claims or takeovers specifically: the refusal message's
// own wording, where the lock lives relative to the data directory `restore` replaces, that a
// plain claim is genuinely atomic, and that a `mkdir` failure is never misread as "held".

import { takeLock, readLockHolder, refusalMessage, lockPath, lockHome } from "#framework/runtime/instance-lock.ts";
import { stubContext, refused } from "./fixture.ts";
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

// --- the message itself ----------------------------------------------------------------------------

{
  const fresh = { operationId: "op-1", what: "apply", by: "coder@box pid 1", takenAt: new Date().toISOString() };
  const message = refusalMessage(fresh);
  check("a fresh lock suggests waiting", message.includes("Wait for it to finish"), true);
  check("and does not call it stale", message.includes("may be left over"), false);
}

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

process.stderr.write(failed === 0 ? "all instance lock misc checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
