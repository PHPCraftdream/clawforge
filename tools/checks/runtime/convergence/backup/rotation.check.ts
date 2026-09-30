// Backup rotation: one archive removed per run (the oldest), retention counted per profile,
// and a sibling deployment's archives never touched.

import { resolve } from "node:path";
import { rotate } from "#framework/commands/lifecycle/backup/index.ts";
import { useDeployment, deploymentName, useComposeProjectOverride } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";
useDeployment(resolve(monorepoRoot, "apps", "example app"));
useComposeProjectOverride("example-app");
{
  const name = deploymentName();
  const backupDir = "/srv/openclaw/backups";

  // 12 backups, newest first — as rotation orders `find` output — with OC_BACKUP_KEEP=10, so
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
        if (command === "find" && args.includes("-printf")) {
          return { code: 0, stdout: listing.map((path, index) => `${listing.length - index}\t${path}`).join("\n") + "\n", stderr: "" };
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

// --- retention counts each profile on its own -----------------------------------------------
//
// `pull` writes migrate and share archives into the same directory `backup` writes full ones
// into. Counted together against OC_BACKUP_KEEP, a week of pulls rotated away every full
// backup the instance had — the archives an operator would actually restore from.

function rotationContext(
  listing: string[],
  keep: string,
): { ctx: Context; execCalls: { command: string; args: string[] }[] } {
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
        if (command === "find" && args.includes("-printf")) {
          return { code: 0, stdout: listing.map((path, index) => `${listing.length - index}\t${path}`).join("\n") + "\n", stderr: "" };
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

// OC_BACKUP_KEEP parsing (typo/empty/negative/zero values) has its own file, right beside
// this one: backup-retention.check.ts.

finish("backup rotation");
