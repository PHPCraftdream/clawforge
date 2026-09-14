// Checks backup rotation removes only the single oldest archive beyond the retention
// count, not the whole backlog at once — however a backlog beyond OC_BACKUP_KEEP got
// there (a lowered keep count, archives merged in from elsewhere), it should drain one
// backup at a time across future runs, not vanish in one rotation.
//
// No target: a stub transport drives the real rotate() end to end.

import { resolve } from "node:path";
import { rotate, createBackup } from "../../../framework/commands/lifecycle/backup.ts";
import { useDeployment, deploymentName } from "../../../framework/runtime/deployment.ts";
import { monorepoRoot } from "../../../framework/core/env.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import type { Context } from "../../../framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

useDeployment(resolve(monorepoRoot, "apps", "example app"));

{
  const name = deploymentName();
  const backupDir = "/srv/openclaw/backups";

  // 12 backups, newest first — exactly what `ls -1t` returns — with OC_BACKUP_KEEP=10, so
  // 2 are stale. Only the oldest of those two should be removed by a single rotate() call.
  const listing = Array.from(
    { length: 12 },
    (_, i) => `${backupDir}/${name}-2026010${String(12 - i).padStart(2, "0")}-000000.tar.gz`,
  );

  const execCalls: { command: string; args: string[] }[] = [];
  const ctx = {
    settings: { env: { OC_BACKUP_KEEP: "10" } },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push({ command, args });
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) {
          return { code: 0, stdout: `${listing.join("\n")}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  await withOutputSink(
    () => {},
    () => rotate(ctx, backupDir),
  );

  const rmCalls = execCalls.filter((call) => call.command === "rm");
  check("exactly one rm call", rmCalls.length, 1);

  const oldest = listing[listing.length - 1];
  const secondOldest = listing[listing.length - 2];
  check("the single oldest archive is targeted", rmCalls[0]?.args.includes(oldest), true);
  check(
    "the second-oldest (also stale, but not the very oldest) is left for next time",
    rmCalls[0]?.args.includes(secondOldest),
    false,
  );
  check("nothing kept within the retention count is targeted", rmCalls[0]?.args.includes(listing[0]), false);
}

// --- createBackup must respect the instance lock, not bypass it ---------------------------
//
// Before the fix, createBackup() never called guarded()/takeLock() at all — it paused,
// archived and restarted the gateway regardless of what else was touching the same
// instance. This simulates a lock already held by another operation (the same mkdir-based
// claim takeLock itself uses) and asserts backup refuses before ever touching the gateway.

function stubBackupCtx(lockAlreadyHeld: boolean): { ctx: Context; calls: string[] } {
  const calls: string[] = [];
  const holder = JSON.stringify({
    operationId: "op-holder", what: "apply", by: "someone@host pid 1", takenAt: new Date().toISOString(),
  });
  const ctx = {
    settings: { dataDir: "/srv/clawforge/data", backupDir: "/srv/clawforge/backups", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return path === "/srv/clawforge/data";
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        calls.push(`exec ${command} ${args.join(" ")}`);
        // The lock directory itself: a plain `mkdir` (no -p) is the atomic claim takeLock
        // makes; `test -d` is how it tells "someone holds it" from "mkdir just failed".
        if (command === "mkdir" && args[0] !== "-p") return { code: lockAlreadyHeld ? 1 : 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-d") return { code: lockAlreadyHeld ? 0 : 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("holder.json")) return holder;
        throw new Error(`no such file: ${path}`);
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
    },
    runtime: {
      async isRunning(): Promise<boolean> { calls.push("isRunning"); return true; },
      async pause(): Promise<void> { calls.push("pause"); },
      async start(): Promise<void> { calls.push("start"); },
      async waitForHealth(): Promise<void> { calls.push("waitForHealth"); },
    },
  } as unknown as Context;
  return { ctx, calls };
}

{
  const { ctx, calls } = stubBackupCtx(true);
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try { await createBackup(ctx, {}); } catch (error) { message = (error as Error).message; }
    },
  );
  check("backup refuses when another operation already holds the instance lock", message.includes("another operation is changing this instance"), true);
  check("a refused backup never pauses the gateway", calls.includes("pause"), false);
}

{
  const { ctx, calls } = stubBackupCtx(false);
  const archive = await withOutputSink(() => {}, () => createBackup(ctx, {}));
  check("with no competing lock, backup runs and returns the archive path", typeof archive === "string" && archive.length > 0, true);
  check("and it does pause/start the gateway around the archive", calls.includes("pause") && calls.includes("start"), true);
}

process.stderr.write(failed === 0 ? "all backup checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
