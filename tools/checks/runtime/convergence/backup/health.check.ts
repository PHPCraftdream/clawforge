// BACKUP_MISSING/BACKUP_STALE/DISK_LOW (upkeep.ts): no archive at all, a stale one, a fresh
// one, the staleness threshold disabled, a garbage threshold value, and low free space.

import { resolve } from "node:path";
import { observeBackupHealth, observeDiskSpace } from "#framework/commands/orchestration/inspect/upkeep.ts";
import { backupArchiveName } from "#framework/service/archive/index.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Problem } from "#framework/service/inspection.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));

const DATA_DIR = "/srv/openclaw/data";
const BACKUP_DIR = "/srv/openclaw/backups";
const DAY_MS = 24 * 60 * 60 * 1000;

interface ArchiveFixture {
  readonly name: string;
  readonly ageMs: number;
  readonly sizeBytes?: number;
}

/** A stub Context whose `find` answers backup listing calls with `archives` and whose `df`
 *  answers disk probes with `availableMbByPath` — everything else (the readability probes
 *  `listBackupArchives` makes first) answers as an ordinary readable directory. */
function stubContext(options: {
  archives?: readonly ArchiveFixture[];
  env?: Record<string, string>;
  availableMbByPath?: Record<string, number>;
}): Context {
  const archives = options.archives ?? [];
  const now = Date.now();
  return {
    settings: { dataDir: DATA_DIR, backupDir: BACKUP_DIR, env: options.env ?? {} },
    transport: {
      description: "stub",
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "test" && args[0] === "-d") return { code: 0, stdout: "", stderr: "" };
        if (command === "sh") return { code: 0, stdout: "", stderr: "" };
        if (command === "find") {
          const lines = archives.map((entry) => {
            const mtimeEpoch = (now - entry.ageMs) / 1000;
            return `${entry.sizeBytes ?? 1024}\t${mtimeEpoch}\t${BACKUP_DIR}/${entry.name}`;
          });
          return { code: 0, stdout: lines.length === 0 ? "" : `${lines.join("\n")}\n`, stderr: "" };
        }
        if (command === "df") {
          const paths = args.slice(1);
          const header = "Filesystem     1024-blocks      Used Available Capacity Mounted on";
          const rows = paths
            .filter((path) => options.availableMbByPath?.[path] !== undefined)
            .map((path) => {
              const availableKb = Math.round((options.availableMbByPath?.[path] ?? 0) * 1024);
              return `stub                 1000000    500000 ${availableKb}       50% ${path}`;
            });
          return { code: rows.length === paths.length ? 0 : 1, stdout: [header, ...rows].join("\n"), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

function codes(problems: readonly Problem[]): string[] {
  return problems.map((entry) => entry.code);
}

// --- no archives -> BACKUP_MISSING -----------------------------------------------------------

{
  const ctx = stubContext({ archives: [] });
  const problems: Problem[] = [];
  await observeBackupHealth(ctx, problems);
  check("no archives at all reports BACKUP_MISSING", codes(problems), ["BACKUP_MISSING"]);
  check("BACKUP_MISSING is a warning", problems[0]?.severity, "warning");
  check("BACKUP_MISSING names the backup directory", problems[0]?.detail.includes(BACKUP_DIR), true);
}

{
  const name = backupArchiveName(deploymentName(), "20260101-000000", "migrate");
  const ctx = stubContext({ archives: [{ name, ageMs: DAY_MS }] });
  const problems: Problem[] = [];
  await observeBackupHealth(ctx, problems);
  check("a migrate-only archive still reports BACKUP_MISSING (not restorable by a bare restore)", codes(problems), ["BACKUP_MISSING"]);
}

// --- a stale full archive -> BACKUP_STALE ------------------------------------------------------

{
  const name = backupArchiveName(deploymentName(), "20260101-000000", "full");
  const ctx = stubContext({ archives: [{ name, ageMs: 5 * DAY_MS }] });
  const problems: Problem[] = [];
  await observeBackupHealth(ctx, problems);
  check("an archive older than the 2d default reports BACKUP_STALE", codes(problems), ["BACKUP_STALE"]);
  check("BACKUP_STALE is a warning", problems[0]?.severity, "warning");
  check("BACKUP_STALE names the archive", problems[0]?.detail.includes(name), true);
}

// --- a fresh full archive -> nothing ------------------------------------------------------------

{
  const name = backupArchiveName(deploymentName(), "20260101-000000", "full");
  const ctx = stubContext({ archives: [{ name, ageMs: DAY_MS }] });
  const problems: Problem[] = [];
  await observeBackupHealth(ctx, problems);
  check("an archive within the 2d default reports nothing", problems, []);
}

// --- OC_BACKUP_MAX_AGE=0/off disables staleness, never BACKUP_MISSING -------------------------

{
  const name = backupArchiveName(deploymentName(), "20260101-000000", "full");
  const ctx = stubContext({ archives: [{ name, ageMs: 30 * DAY_MS }], env: { OC_BACKUP_MAX_AGE: "0" } });
  const problems: Problem[] = [];
  await observeBackupHealth(ctx, problems);
  check("OC_BACKUP_MAX_AGE=0 disables BACKUP_STALE even for a very old archive", problems, []);
}

// --- a garbage OC_BACKUP_MAX_AGE warns and falls back to the 2d default ------------------------

{
  const name = backupArchiveName(deploymentName(), "20260101-000000", "full");
  const ctx = stubContext({ archives: [{ name, ageMs: 5 * DAY_MS }], env: { OC_BACKUP_MAX_AGE: "banana" } });
  const problems: Problem[] = [];
  let output = "";
  await withOutputSink((line) => { output += line; }, () => observeBackupHealth(ctx, problems));
  check("a garbage OC_BACKUP_MAX_AGE still reports BACKUP_STALE using the 2d default", codes(problems), ["BACKUP_STALE"]);
  check("a garbage OC_BACKUP_MAX_AGE warns naming the variable and value", output.includes("OC_BACKUP_MAX_AGE") && output.includes("banana"), true);
}

// --- low disk at the data directory -> DISK_LOW -------------------------------------------------

{
  const ctx = stubContext({ availableMbByPath: { [DATA_DIR]: 200, [BACKUP_DIR]: 5000 } });
  const problems: Problem[] = [];
  await observeDiskSpace(ctx, problems);
  check("low free space at the data directory reports DISK_LOW", codes(problems), ["DISK_LOW"]);
  check("DISK_LOW is a warning", problems[0]?.severity, "warning");
  check("DISK_LOW names the low directory", problems[0]?.detail.includes(DATA_DIR), true);
}

{
  const ctx = stubContext({ availableMbByPath: { [DATA_DIR]: 5000, [BACKUP_DIR]: 5000 } });
  const problems: Problem[] = [];
  await observeDiskSpace(ctx, problems);
  check("ample free space at both directories reports nothing", problems, []);
}

// --- OC_DISK_MIN_FREE_MB=0 disables the check ---------------------------------------------------

{
  const ctx = stubContext({ availableMbByPath: { [DATA_DIR]: 1, [BACKUP_DIR]: 1 }, env: { OC_DISK_MIN_FREE_MB: "0" } });
  const problems: Problem[] = [];
  await observeDiskSpace(ctx, problems);
  check("OC_DISK_MIN_FREE_MB=0 disables DISK_LOW even when nearly full", problems, []);
}

// --- a garbage OC_DISK_MIN_FREE_MB warns and falls back to the 1024 MB default ------------------

{
  const ctx = stubContext({ availableMbByPath: { [DATA_DIR]: 200, [BACKUP_DIR]: 5000 }, env: { OC_DISK_MIN_FREE_MB: "lots" } });
  const problems: Problem[] = [];
  let output = "";
  await withOutputSink((line) => { output += line; }, () => observeDiskSpace(ctx, problems));
  check("a garbage OC_DISK_MIN_FREE_MB still reports DISK_LOW using the 1024 MB default", codes(problems), ["DISK_LOW"]);
  check("a garbage OC_DISK_MIN_FREE_MB warns naming the variable and value", output.includes("OC_DISK_MIN_FREE_MB") && output.includes("lots"), true);
}

// --- a backup directory that was never created (df has no row for it) reports nothing for it ----

{
  const ctx = stubContext({ availableMbByPath: { [DATA_DIR]: 5000 } });
  const problems: Problem[] = [];
  await observeDiskSpace(ctx, problems);
  check("a backup directory df could not stat is a gap, not a finding", problems, []);
}

finish("backup/disk upkeep");
