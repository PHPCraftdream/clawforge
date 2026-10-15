// The release-time guard claim must survive a race with a concurrent release: the other
// process's guard vanishes between our failed `mkdir` and the `test -d` follow-up, and the
// old code reported "could not serialize" instead of just retrying the same atomic mkdir —
// so the releaser kept its own lock behind it, silently. And when release cleanup genuinely
// fails, the stale lock must be reported loudly, never swallowed.

import { takeLock, readLockHolder, lockPath } from "#framework/runtime/lock/instance-lock.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { BLOCKING_MARK } from "#framework/core/io/log.ts";
import { FIXTURE_LOCK_HOME, stubContext } from "../fixture.ts";
import { machineName } from "#framework/runtime/lock/process-identity.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";

const guard = `${FIXTURE_LOCK_HOME}/operation.mutation`;

// The wrapper is installed AFTER takeLock returns, so wrapper seen 1 IS the release-time
// guard claim — takeLock's own acquisition claim happened before the wrapper existed.
function interceptFirstGuardMkdir(ctx: Context, original: Context["transport"]["exec"]): void {
  let seen = 0;
  ctx.transport.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    if (command === "mkdir" && args[args.length - 1].endsWith("/operation.mutation")) {
      seen++;
      if (seen === 1) {
        // Fail WITHOUT creating anything: by the next `test -d` the concurrent release has
        // removed the guard, so it reads absent — the exact interleaving from the field.
        return { code: 1, stdout: "", stderr: `mkdir: cannot create directory '${args[args.length - 1]}': File exists` };
      }
    }
    return original(command, args);
  };
}

// --- the race: guard vanishes between failed mkdir and test -d -------------------------------

{
  const { ctx, dirs, files } = stubContext();
  const held = await takeLock(ctx, "apply", "op-race");
  const original = ctx.transport.exec.bind(ctx.transport);
  interceptFirstGuardMkdir(ctx, original);

  await withOutputSink(
    () => {},
    async () => {
      await held.release();
    },
  );

  check("the raced release removes the holder", await readLockHolder(ctx), undefined);
  check("the raced release removes the lock directory", dirs.has(lockPath(ctx)), false);
  check("the raced release removes the guard directory", dirs.has(guard), false);
  check("no claim marker is stranded", [...files.keys()].some((key) => key.includes("/operation.mutation/")), false);
}

// --- a genuinely failed cleanup must be reported, never silent --------------------------------

{
  const { ctx, dirs, files } = stubContext();
  const held = await takeLock(ctx, "apply", "op-report");
  const original = ctx.transport.exec.bind(ctx.transport);
  ctx.transport.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    // Persistent guard contention: every release-time claim fails the same way.
    if (command === "mkdir" && args[args.length - 1].endsWith("/operation.mutation") && dirs.has(lockPath(ctx))) {
      return { code: 1, stdout: "", stderr: `mkdir: cannot create directory '${args[args.length - 1]}': File exists` };
    }
    return original(command, args);
  };

  const lines: string[] = [];
  await withOutputSink(
    (text: string) => {
      lines.push(text);
    },
    async () => {
      await held.release();
    },
  );

  const reported = lines.join("");
  checkTrue("a failed release cleanup is reported loudly", reported.includes(BLOCKING_MARK));
  checkTrue("the report names the retained lock", reported.includes(lockPath(ctx)));
  check("the stale holder remains observable", (await readLockHolder(ctx))?.operationId, "op-report");
  check("the lock directory is retained", dirs.has(lockPath(ctx)), true);
  check("holder.json is still on disk", files.has(`${lockPath(ctx)}/holder.json`), true);
}

// --- the release loses its guard claim to a live competing claim ------------------------------

{
  const { ctx, dirs, files } = stubContext();
  const held = await takeLock(ctx, "apply", "op-live-competitor");
  const original = ctx.transport.exec.bind(ctx.transport);
  let seen = 0;
  ctx.transport.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    if (command === "mkdir" && args[args.length - 1].endsWith("/operation.mutation")) {
      seen++;
      if (seen === 1 || seen === 2) {
        // A LIVE competitor holds the guard for its first two release-time claims: the
        // directory exists with this process's own pid as owner, so resolveGuardOwner reads
        // a live local owner and refuses the claim.
        dirs.add(guard);
        files.set(`${guard}/owner.json`, JSON.stringify({ generation: "competitor", pid: process.pid, machine: machineName(), takenAt: new Date().toISOString() }) + "\n");
        return { code: 1, stdout: "", stderr: `mkdir: cannot create directory '${args[args.length - 1]}': File exists` };
      }
      // The competitor's claim window closed: the guard is free, so the releaser's retry
      // wins it and the cleanup runs.
      dirs.delete(guard);
      files.delete(`${guard}/owner.json`);
    }
    return original(command, args);
  };

  await held.release();

  check("the release that lost twice cleans the holder", await readLockHolder(ctx), undefined);
  check("the release that lost twice removes the lock directory", dirs.has(lockPath(ctx)), false);
  check("the release that lost twice removes the guard directory", dirs.has(guard), false);
  check("no claim marker is stranded after the retry", [...files.keys()].some((key) => key.includes("/operation.mutation/")), false);
}

// --- a permanently lost guard claim must still be reported -------------------------------------

{
  const { ctx, dirs, files } = stubContext();
  const held = await takeLock(ctx, "apply", "op-live-competitor");
  const original = ctx.transport.exec.bind(ctx.transport);
  ctx.transport.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    if (command === "mkdir" && args[args.length - 1].endsWith("/operation.mutation") && dirs.has(lockPath(ctx))) {
      // The live competitor never lets go: every release-time claim is refused the same way.
      dirs.add(guard);
      files.set(`${guard}/owner.json`, JSON.stringify({ generation: "competitor", pid: process.pid, machine: machineName(), takenAt: new Date().toISOString() }) + "\n");
      return { code: 1, stdout: "", stderr: `mkdir: cannot create directory '${args[args.length - 1]}': File exists` };
    }
    return original(command, args);
  };

  const lines: string[] = [];
  await withOutputSink(
    (text: string) => {
      lines.push(text);
    },
    async () => {
      await held.release();
    },
  );

  const reported = lines.join("");
  checkTrue("a permanently refused release claim is reported loudly", reported.includes(BLOCKING_MARK));
  checkTrue("the permanent-refusal report names the retained lock", reported.includes(lockPath(ctx)));
  check("the holder survives the exhausted retries", (await readLockHolder(ctx))?.operationId, "op-live-competitor");
  check("the lock directory is retained after exhausted retries", dirs.has(lockPath(ctx)), true);
}

finish("instance lock release guard race");
