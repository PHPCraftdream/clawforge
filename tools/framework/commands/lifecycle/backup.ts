// `./clawforge backup` — a consistent snapshot of the data directory.
//
// The gateway is stopped for the duration by default:
// OpenClaw keeps state in SQLite databases with multi-megabyte -wal files, and a copy
// taken mid-write is not restorable. --hot skips the stop for those who accept that.

import { log, info, warn, die } from "../../core/log.ts";
import type { Context } from "../../core/context.ts";
import { sudoFor } from "../../runtime/datadir.ts";
import { deploymentName } from "../../runtime/deployment.ts";
import { createArchive, fileSize, isProfile, type Profile } from "../../service/archive.ts";
import { guarded } from "../../runtime/instance-lock.ts";

export interface BackupOptions {
  hot?: boolean;
  profile?: Profile;
}

// UTC, not local time: state.ts's snapshot names and restore.ts's <data>.replaced-<stamp>
// both already are, and a backup taken the same moment as a pull used to land two hours
// apart by name on a UTC+2 host — correlating "which backup was this snapshot copied from"
// meant doing the arithmetic by hand.
function timestamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/** Deletes the single oldest archive beyond the configured retention count, if any.
 *  Exported for testing. */
export async function rotate(ctx: Context, backupDir: string): Promise<void> {
  const keep = Number.parseInt(ctx.settings.env.OC_BACKUP_KEEP ?? "10", 10);
  if (!Number.isFinite(keep) || keep <= 0) return;

  const prefix = await sudoFor(ctx, backupDir);
  // Only this deployment's own archives: several may share one backup directory.
  const [head, ...rest] = [
    ...prefix,
    "sh",
    "-c",
    `ls -1t ${backupDir}/${deploymentName()}-*.tar.gz 2>/dev/null`,
  ];
  const listing = await ctx.transport.exec(head, rest, { allowFailure: true });
  const archives = listing.stdout.split("\n").filter((line) => line.trim() !== "");

  const stale = archives.slice(keep);
  if (stale.length === 0) return;

  // Only the single oldest excess archive is removed per run, not the whole backlog at
  // once — however a backlog beyond keep got there (a lowered OC_BACKUP_KEEP, archives
  // merged in from elsewhere), it drains one backup at a time instead of vanishing here in
  // one rotation.
  const path = stale[stale.length - 1].trim();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const remaining = stale.length - 1;
  log(`removing 1 archive beyond the last ${keep}${remaining > 0 ? ` (${remaining} more still beyond it)` : ""}:`);
  info(name);
  const removePrefix = await sudoFor(ctx, path);
  const [rmHead, ...rmRest] = [...removePrefix, "rm", "-f", path];
  await ctx.transport.exec(rmHead, rmRest);
}

/** Creates a backup and returns the archive path on the target.
 *
 *  Guarded like every other mutating command: it stops the gateway, archives the data
 *  directory, and starts it again, all of which race against apply/restore/rollback doing
 *  the same instance's work at once if nothing serializes them. guarded() is nesting-safe,
 *  so pull() and smoke() calling this while already holding the lock for their own
 *  operation cost nothing extra here. */
export async function createBackup(ctx: Context, options: BackupOptions = {}): Promise<string> {
  return guarded(ctx, "backup", [], () => createBackupLocked(ctx, options));
}

async function createBackupLocked(ctx: Context, options: BackupOptions): Promise<string> {
  const profile: Profile = options.profile ?? "full";
  const { dataDir, backupDir } = ctx.settings;

  if (!(await ctx.transport.exists(dataDir))) die(`data directory ${dataDir} does not exist`);

  const mkdirPrefix = await sudoFor(ctx, backupDir);
  const [mkHead, ...mkRest] = [...mkdirPrefix, "mkdir", "-p", backupDir];
  await ctx.transport.exec(mkHead, mkRest);

  const archive = `${backupDir}/${deploymentName()}-${timestamp()}.tar.gz`;
  const wasRunning = await ctx.runtime.isRunning();

  if (options.hot === true) {
    warn("hot backup: the gateway keeps writing, the archive may catch a partial sqlite write");
  } else if (wasRunning) {
    log("stopping the gateway for a consistent snapshot");
    await ctx.runtime.pause();
  }

  try {
    log(`writing ${archive}`);
    await createArchive(ctx, { archive, profile });

    const chmodPrefix = await sudoFor(ctx, archive);
    const [chHead, ...chRest] = [...chmodPrefix, "chmod", "600", archive];
    await ctx.transport.exec(chHead, chRest);
  } finally {
    // Bring the gateway back even if tar failed. Waited for, not just started: up(),
    // push() and restore() all confirm health before returning — this used to be the one
    // command that handed control back while the container was still merely "Starting",
    // and a caller doing something right after that assumed the gateway was already
    // answering could lose that race.
    if (options.hot !== true && wasRunning) {
      log("starting the gateway again");
      await ctx.runtime.start();
      await ctx.runtime.waitForHealth();
      log("gateway is healthy");
    }
  }

  log(`backup done: ${archive} (${await fileSize(ctx, archive)}, profile: ${profile})`);
  await rotate(ctx, backupDir);
  return archive;
}

export async function backup(ctx: Context, args: string[]): Promise<void> {
  const options: BackupOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--hot") {
      options.hot = true;
    } else if (arg === "--profile") {
      const value = args[index + 1];
      if (value === undefined || !isProfile(value)) die("--profile needs one of: full, migrate, share");
      options.profile = value;
      index += 1;
    } else {
      die(`unknown argument: ${arg}`);
    }
  }

  // Not repeated here: createBackup() already announced the path in "backup done: <path>".
  await createBackup(ctx, options);
}
