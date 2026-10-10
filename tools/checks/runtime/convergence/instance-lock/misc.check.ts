// Lock placement, refusal actions, atomic claims, and failed creation without false held-lock advice.

import { takeLock, readLockHolder, lockPath, lockHome } from "#framework/runtime/lock/instance-lock.ts";
import { stubContext, refused } from "./fixture.ts";
import type { Context } from "#framework/core/context.ts";
import { UserError } from "#framework/core/io/log.ts";
import { refusalAdvice } from "#framework/runtime/lock/lock-claim.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function userRefusal(body: () => Promise<unknown>): Promise<UserError> {
  let failure: unknown;
  await refused(async () => {
    try { await body(); } catch (error) { failure = error; throw error; }
  });
  check("lock acquisition refuses with UserError", failure instanceof UserError, true);
  return failure as UserError;
}

// --- fresh ownership requires manual action --------------------------------------------------

{
  const fresh = { operationId: "op-1", what: "apply", by: "coder@box pid 1", takenAt: new Date().toISOString() };
  const advice = refusalAdvice(fresh);
  check("fresh ownership requires manual action", advice.kind, "manual");
  check("fresh ownership never invents mutation argv", "argv" in advice, false);
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

  // The second acquire must refuse without replacing the first holder.
  await userRefusal(() => takeLock(ctx, "apply", "op-2"));
  check("a refused second claim preserves the first holder", (await readLockHolder(ctx))?.operationId, "op-1");

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

  const refusal = await userRefusal(() => takeLock(ctx, "apply", "op-new"));
  check("unknown ownership remediation is manual", refusal.advice.map(entry => entry.kind), ["manual"]);
  check("unknown ownership remediation has no mutation argv", refusal.advice.some(entry => "argv" in entry), false);

  await userRefusal(() => takeLock(ctx, "apply", "op-new", { breakLock: true }));
  check("unknown ownership preserves the unnamed lock", dirs.has(lockPath(ctx)), true);
}

// --- a lock that cannot be created is not a lock that is held ---------------------------------
//
// Any non-zero mkdir used to read as "someone holds it", so a directory the tooling cannot
// write into produced a report about a lock that was not there, and offered --break-lock,
// which removes nothing and then fails the same way. The directory itself settles which it
// is: present means held, absent means the mkdir failed for a reason of its own.

{
  let writes = 0;
  let removals = 0;
  const denied = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async exec(command: string, _args: string[]) {
        if (command === "mkdir") return { code: 1, stdout: "", stderr: "EACCES" };
        // The lock directory is genuinely absent — nothing is holding anything.
        if (command === "test") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(): Promise<string> {
        throw new Error("no such file");
      },
      async writeFile(): Promise<void> { writes += 1; },
      async remove(): Promise<void> { removals += 1; },
    },
  } as unknown as Context;

  const failure = await userRefusal(() => takeLock(denied, "apply", "op-1"));
  check("failed creation retains transport error detail", failure.message.includes("EACCES"), true);
  check("failed creation has no held-owner remediation", failure.advice, []);
  check("failed creation does not offer takeover", failure.message.includes("--break-lock"), false);
  check("failed creation writes no holder", writes, 0);
  check("failed creation removes no owner files", removals, 0);
}

finish("instance lock misc");
