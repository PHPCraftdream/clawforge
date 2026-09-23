// `./clawforge backup` — a consistent snapshot of the data directory.
//
// The gateway is stopped for the duration by default:
// OpenClaw keeps state in SQLite databases with multi-megabyte -wal files, and a copy
// taken mid-write is not restorable. --hot skips the stop for those who accept that.

import { log, info, warn, die } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { randomUUID } from "node:crypto";
import { runMaybePrivileged, sudoFor } from "#src/runtime/datadir.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { archiveCarriesContent, createArchive, fileSize, isProfile, backupArchiveName, listArchive, parseBackupArchive, symlinkedDataRoot, type Profile } from "#src/service/archive.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { SshTransport } from "#src/runtime/transport.ts";
import { runningRecipeStacks } from "../management/recipe.ts";

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
    `ls -1t ${SshTransport.quote(`${backupDir}/${deploymentName()}-`)}*.tar.gz 2>/dev/null`,
  ];
  const listing = await ctx.transport.exec(head, rest, { allowFailure: true });
  const archives = listing.stdout.split("\n").filter((line) => line.trim() !== "");

  // Retention is counted per profile, and anything the glob caught that is not one of this
  // deployment's own archives is dropped here. Both for the same reason: `keep` means "how
  // many backups of this instance I can still restore from", and neither a share snapshot
  // `pull` left behind nor a sibling deployment's archive is one of those. Counted together,
  // a week of `pull` runs rotated away every full backup the instance had.
  const byProfile = new Map<Profile, string[]>();
  for (const line of archives) {
    const path = line.trim();
    const parsed = parseBackupArchive(path.slice(path.lastIndexOf("/") + 1), deploymentName());
    if (parsed === undefined) continue;
    byProfile.set(parsed.profile, [...(byProfile.get(parsed.profile) ?? []), path]);
  }

  // `ls -1t` ordered the listing, and grouping preserved it: each group is newest first.
  // Put the stale ones back in that order, so "the oldest" below still means the oldest of
  // all of them rather than the oldest of whichever group happened to be last.
  const staleSet = new Set([...byProfile.values()].flatMap((group) => group.slice(keep)));
  const stale = archives.map((line) => line.trim()).filter((path) => staleSet.has(path));
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

  // tar is handed the data directory's name relative to its parent, so a symlinked root
  // is archived as the link itself — one entry, no data, and a "successful" backup that
  // cannot be restored anywhere (audit 2026-09-22 round 2, P2-02). Refused before the
  // gateway is stopped: there is no consistent snapshot of this layout to take.
  const linkTarget = await symlinkedDataRoot(ctx);
  if (linkTarget !== undefined) {
    die(
      `data directory ${dataDir} is a symlink to ${linkTarget}: a backup would archive the link itself, not the data behind it — ` +
        `point the data directory setting at a real directory (the link's target is one) and run the backup again`,
    );
  }

  // Recipes are their own Compose projects, so stopping the gateway stops none of
  // them: a sidecar bind-mounting a file under the data directory keeps writing
  // straight through the snapshot, outside the lock this command holds. Until a
  // lifecycle-participant mechanism exists to quiesce them, the guarantee is
  // explicitly bounded to the main service, and the stacks left outside it are named
  // rather than silently uncovered (audit 2026-09-22 round 2, P2-04).
  const sidecars = await runningRecipeStacks(ctx);
  if (sidecars.length > 0) {
    warn(
      `recipe stack(s) still running, not quiesced for this backup: ${sidecars.map((recipe) => recipe.name).join(", ")} — ` +
        `the snapshot's consistency guarantee covers the gateway only; what these stacks write under ${dataDir} ` +
        "can be caught mid-write and is not guaranteed consistent in the archive",
    );
  }

  const mkdirPrefix = await sudoFor(ctx, backupDir);
  const [mkHead, ...mkRest] = [...mkdirPrefix, "mkdir", "-p", backupDir];
  await ctx.transport.exec(mkHead, mkRest);

  const archive = `${backupDir}/${backupArchiveName(deploymentName(), timestamp(), profile)}`;
  // Keep the archive in a private directory until it is complete. The final name must only
  // appear after tar and chmod succeed, so a failed tar cannot become the newest backup.
  const stagingDir = `${backupDir}/.clawforge-backup-${randomUUID()}`;
  const stagingArchive = `${stagingDir}/archive.tar.gz`;
  const wasRunning = await ctx.runtime.isRunning();

  if (options.hot === true) {
    warn("hot backup: the gateway keeps writing, the archive may catch a partial sqlite write");
  } else if (wasRunning) {
    log("stopping the gateway for a consistent snapshot");
    await ctx.runtime.pause();
  }

  let stagingCreated = false;
  try {
    log(`writing ${archive}`);
    const mkdirStagePrefix = await sudoFor(ctx, backupDir);
    const [mkdirStageHead, ...mkdirStageRest] = [
      ...mkdirStagePrefix,
      "mkdir",
      "-m",
      "700",
      "--",
      stagingDir,
    ];
    await ctx.transport.exec(mkdirStageHead, mkdirStageRest);
    stagingCreated = true;

    await createArchive(ctx, { archive: stagingArchive, profile });
    // tar exiting 0 and the file landing are not evidence the data is inside: an archive
    // that holds nothing beneath its root — what a symlinked root used to produce —
    // restores nothing anywhere. Checked on the staging archive, before it can become
    // the newest backup (audit 2026-09-22 round 2, P2-02).
    if (!archiveCarriesContent(await listArchive(ctx, stagingArchive))) {
      throw new Error(`the fresh archive of ${dataDir} carries no data beneath its root — refusing to publish it as a backup`);
    }

    const chmodPrefix = await sudoFor(ctx, stagingArchive);
    const [chHead, ...chRest] = [...chmodPrefix, "chmod", "600", stagingArchive];
    await ctx.transport.exec(chHead, chRest);

    const movePrefix = await sudoFor(ctx, archive);
    const [moveHead, ...moveRest] = [...movePrefix, "mv", "-nT", "--", stagingArchive, archive];
    const moved = await ctx.transport.exec(moveHead, moveRest, { allowFailure: true });
    if (moved.code !== 0) {
      throw new Error(`could not publish ${archive}: ${moved.stderr.trim() || `mv exited ${moved.code}`}`);
    }

    const remaining = await targetExists(ctx, stagingArchive);
    if (remaining) throw new Error(`backup path already exists: ${archive}`);
    if (!(await targetExists(ctx, archive))) {
      throw new Error(`could not confirm publication of ${archive}`);
    }
  } finally {
    if (stagingCreated) {
      try {
        await runMaybePrivileged(ctx, stagingDir, "rm", ["-rf", "--", stagingDir]);
      } catch {
        warn(`could not remove backup staging directory ${stagingDir}`);
      }
    }
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

/** Checks a target path with the privileges used for the backup operation. */
async function targetExists(ctx: Context, path: string): Promise<boolean> {
  const prefix = await sudoFor(ctx, path);
  const [head, ...rest] = [...prefix, "test", "-e", path];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`could not check backup path ${path} (exit ${result.code})`);
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
