// Checks backup rotation removes only the single oldest archive beyond the retention
// count, not the whole backlog at once — however a backlog beyond OC_BACKUP_KEEP got
// there (a lowered keep count, archives merged in from elsewhere), it should drain one
// backup at a time across future runs, not vanish in one rotation.
//
// No target: a stub transport drives the real rotate() end to end.

import { resolve } from "node:path";
import { rotate, createBackup } from "#framework/commands/lifecycle/backup.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";

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
  // Real stamps: rotation reads the profile out of the name now, and a name that is not one
  // this framework writes is not its archive to delete.
  const listing = Array.from(
    { length: 12 },
    (_, i) => `${backupDir}/${name}-202601${String(12 - i).padStart(2, "0")}-000000.tar.gz`,
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

function stubBackupCtx(
  lockAlreadyHeld: boolean,
  options: { tarFailure?: boolean; publishCollision?: boolean } = {},
): { ctx: Context; calls: string[]; files: Set<string>; contents: Map<string, string> } {
  const calls: string[] = [];
  const files = new Set(["/srv/clawforge/data"]);
  const contents = new Map<string, string>();
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
        if (command === "mkdir" && args.length === 1) return { code: lockAlreadyHeld ? 1 : 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-d") return { code: lockAlreadyHeld ? 0 : 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-e") {
          return { code: files.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "mkdir" && args.includes("-m")) {
          files.add(args.at(-1) ?? "");
        }
        if (command === "tar") {
          const index = args.indexOf("-czf");
          const archive = args[index + 1] ?? "";
          if (index !== -1) {
            files.add(archive);
            contents.set(archive, "new archive");
          }
          if (options.tarFailure === true) throw new Error("tar failed after creating its output");
        }
        if (command === "mv") {
          const source = args.at(-2) ?? "";
          const destination = args.at(-1) ?? "";
          if (options.publishCollision === true) {
            files.add(destination);
            contents.set(destination, "old archive");
          }
          if (!files.has(destination)) {
            files.delete(source);
            files.add(destination);
            contents.set(destination, contents.get(source) ?? "");
            contents.delete(source);
          }
        }
        if (command === "rm") {
          const target = args.at(-1) ?? "";
          for (const file of files) {
            if (file === target || (args.includes("-rf") && file.startsWith(`${target}/`))) {
              files.delete(file);
              contents.delete(file);
            }
          }
        }
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
  return { ctx, calls, files, contents };
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

// --- retention counts each profile on its own -----------------------------------------------
//
// `pull` writes migrate and share archives into the same directory `backup` writes full ones
// into. Counted together against OC_BACKUP_KEEP, a week of pulls rotated away every full
// backup the instance had — the archives an operator would actually restore from.

function rotationContext(listing: string[], keep: string): { ctx: Context; execCalls: { command: string; args: string[] }[] } {
  const execCalls: { command: string; args: string[] }[] = [];
  const ctx = {
    settings: { env: { OC_BACKUP_KEEP: keep } },
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
  return { ctx, execCalls };
}

{
  const name = deploymentName();
  const backupDir = "/srv/openclaw/backups";
  const full = `${backupDir}/${name}-20260101-000000.tar.gz`;
  // Three share snapshots, all newer than the one full backup, with keep = 2.
  const listing = [
    `${backupDir}/${name}-20260104-000000-share.tar.gz`,
    `${backupDir}/${name}-20260103-000000-share.tar.gz`,
    `${backupDir}/${name}-20260102-000000-share.tar.gz`,
    full,
  ];

  const { ctx, execCalls } = rotationContext(listing, "2");
  await withOutputSink(() => {}, () => rotate(ctx, backupDir));

  const rmCalls = execCalls.filter((call) => call.command === "rm");
  check("share snapshots do not push a full backup out of retention", rmCalls[0]?.args.includes(full), false);
  check("the oldest excess share snapshot goes instead", rmCalls[0]?.args.includes(`${backupDir}/${name}-20260102-000000-share.tar.gz`), true);
}

{
  const name = deploymentName();
  const backupDir = "/srv/openclaw/backups";
  // A sibling deployment sharing the directory: `ls <name>-*.tar.gz` matches its archives
  // too, and rotating them away deletes backups this deployment never made.
  const sibling = `${backupDir}/${name}-staging-20260101-000000.tar.gz`;
  const listing = [
    `${backupDir}/${name}-20260104-000000.tar.gz`,
    `${backupDir}/${name}-20260103-000000.tar.gz`,
    sibling,
  ];

  const { ctx, execCalls } = rotationContext(listing, "1");
  await withOutputSink(() => {}, () => rotate(ctx, backupDir));

  const rmCalls = execCalls.filter((call) => call.command === "rm");
  check("a sibling deployment's archive is never rotated away", rmCalls[0]?.args.includes(sibling), false);
  check("this deployment's own excess archive is", rmCalls[0]?.args.includes(`${backupDir}/${name}-20260103-000000.tar.gz`), true);
}

// --- the archive a profile produces says which profile it was --------------------------------

{
  const { ctx, calls } = stubBackupCtx(false);
  const archive = await withOutputSink(() => {}, () => createBackup(ctx, { profile: "share" }));
  check("a share backup is named as one", archive.endsWith("-share.tar.gz"), true);
  check("and it is the file that was actually written", calls.some((call) => call.includes(archive)), true);
}

{
  const { ctx, files } = stubBackupCtx(false);
  const archive = await withOutputSink(() => {}, () => createBackup(ctx, {}));
  // Unchanged on purpose: a backup directory written before this still reads correctly.
  check("a full backup keeps the plain name", /-\d{8}-\d{6}\.tar\.gz$/.test(archive), true);
  check("a successful backup removes its staging directory", [...files].some((path) => path.includes(".clawforge-backup-")), false);
}

// A failed tar must never expose a partial archive under the name restore/rotation discovers.
{
  const { ctx, calls, files } = stubBackupCtx(false, { tarFailure: true });
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try { await createBackup(ctx, {}); } catch (error) { message = (error as Error).message; }
    },
  );
  check("a failed tar is reported", message.includes("tar failed"), true);
  check("a failed tar leaves no archive", [...files].every((path) => !path.endsWith(".tar.gz")), true);
  check("a failed tar restarts the gateway", calls.includes("start") && calls.includes("waitForHealth"), true);
}

// Publication refuses a same-name collision and leaves the existing archive untouched.
{
  const { ctx, calls, files, contents } = stubBackupCtx(false, { publishCollision: true });
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try { await createBackup(ctx, {}); } catch (error) { message = (error as Error).message; }
    },
  );
  check("a backup filename collision is reported", message.includes("backup path already exists"), true);
  check("a collision leaves one existing archive", [...files].filter((path) => path.endsWith(".tar.gz")).length, 1);
  check("a collision preserves the existing archive", [...contents.values()].filter((value) => value === "old archive").length, 1);
  check("a publication failure restarts the gateway", calls.includes("start") && calls.includes("waitForHealth"), true);
}

process.stderr.write(failed === 0 ? "all backup checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
