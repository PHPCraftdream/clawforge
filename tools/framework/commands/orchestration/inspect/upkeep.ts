// BACKUP_MISSING/BACKUP_STALE/DISK_LOW: whether this deployment could actually be
// recovered, not whether it is serving right now — a healthy instance with no restorable
// backup, or a data/backup directory one write away from full, still has a real problem
// `doctor`/`inspect` said nothing about before this file.
//
// Deliberately NOT wired into watch's own liveness machinery (LIVENESS_CODES, check.ts):
// none of these mean the instance stopped doing its job, the same reasoning that already
// keeps CONFIG_DRIFT and RECIPE_MIRROR_DRIFT out of that set. watch already has its own,
// differently-shaped DISK_LOW (health.ts: OC_WATCH_DISK_MIN_MB, data directory only,
// degraded/down) — a liveness poll on a schedule. This file's DISK_LOW is unrelated: a
// warning-only doctor/inspect finding, OC_DISK_MIN_FREE_MB, checked against the data
// directory AND the backup directory. Two mechanisms sharing a code string on purpose (same
// meaning, "low on disk"), never merged — merging them would fold a "down" liveness signal
// into a severity table that is warning-only by design (inspection.ts's own PROBLEM_CODES
// header).
//
// Reuses readers that already exist elsewhere rather than inventing new ones:
// listBackupArchives/defaultRestoreArchive are exactly what `backup list` reads, and the
// disk probe is one `df -Pk` call (never a container exec) — at most one new transport call
// beyond that reused listing, and neither runs pre-bootstrap (gather.ts's own guard).

import { problem } from "#src/service/inspection.ts";
import type { Problem } from "#src/service/inspection.ts";
import { parseDiskMinFreeMb, parseDurationThreshold } from "#src/core/env.ts";
import { listBackupArchives, defaultRestoreArchive } from "#src/service/archive/index.ts";
import { TransportUnreachableError } from "#src/runtime/transport/transport.ts";
import type { Context } from "#src/core/context.ts";

/** Both findings below are best-effort extras, never load-bearing the way CONFIG_DRIFT or
 *  SECRET_MISSING are: an unexpected answer from the backup listing or the disk probe must
 *  read as "nothing to report" here, not take the whole inspection down over a secondary
 *  finding. TransportUnreachableError is the one exception — a target genuinely unreachable
 *  is gatherInspection's own TARGET_UNREACHABLE to report, not a gap to swallow. */
async function bestEffort(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (error instanceof TransportUnreachableError) throw error;
  }
}

export const BACKUP_MAX_AGE_ENV = "OC_BACKUP_MAX_AGE";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BACKUP_MAX_AGE_MS = 2 * DAY_MS;
const DEFAULT_BACKUP_MAX_AGE_LABEL = "2d";

export const DISK_MIN_FREE_MB_ENV = "OC_DISK_MIN_FREE_MB";
const DEFAULT_DISK_MIN_FREE_MB = 1024;

/** BACKUP_MISSING/BACKUP_STALE: the same archive listing `backup list` reads
 *  (listBackupArchives) and the same "which one restore would pick" rule
 *  (defaultRestoreArchive, the newest FULL archive — migrate/share are not what a bare
 *  `restore` recovers from). A directory with only migrate/share archives reads as missing,
 *  the same as an empty one: neither is restorable on its own. */
export async function observeBackupHealth(ctx: Context, problems: Problem[]): Promise<void> {
  await bestEffort(async () => {
    const { backupDir } = ctx.settings;
    const archives = await listBackupArchives(ctx, backupDir);
    const newest = defaultRestoreArchive(archives);
    if (newest === undefined) {
      problems.push(problem("BACKUP_MISSING", `no full backup archive in ${backupDir}`));
      return;
    }

    const maxAgeMs = parseDurationThreshold(BACKUP_MAX_AGE_ENV, ctx.settings.env[BACKUP_MAX_AGE_ENV], DEFAULT_BACKUP_MAX_AGE_MS, DEFAULT_BACKUP_MAX_AGE_LABEL);
    if (maxAgeMs === 0) return;

    const ageMs = Date.now() - Date.parse(newest.modifiedAt);
    if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
      const ageDays = (ageMs / DAY_MS).toFixed(1);
      problems.push(
        problem("BACKUP_STALE", `the newest full backup ${newest.name} was created ${newest.modifiedAt} (${ageDays}d ago), older than ${BACKUP_MAX_AGE_ENV} allows`),
      );
    }
  });
}

/** `df -Pk`'s Available column (4th field), one row per surviving path — an argument df
 *  could not stat is simply absent from stdout (df reports it on stderr and keeps going),
 *  never a thrown error. */
function parseAvailableKbRows(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(1)
    .map((line) => Number(line.trim().split(/\s+/)[3]))
    .filter((value) => Number.isFinite(value) && value >= 0);
}

/** DISK_LOW: one `df -Pk` naming both the data directory and the backup directory (only one
 *  path when they coincide) — a single exec answers for both instead of two. The data
 *  directory always exists once bootstrapped and is listed first, so when df's own output
 *  has fewer rows than paths given, the missing row(s) can only be the backup directory's
 *  (nothing has ever been backed up yet, so it was never created) — a gap, read as "nothing
 *  to check there", never guessed at by position beyond that one guarantee. */
export async function observeDiskSpace(ctx: Context, problems: Problem[]): Promise<void> {
  await bestEffort(async () => {
    const thresholdMb = parseDiskMinFreeMb(DISK_MIN_FREE_MB_ENV, ctx.settings.env[DISK_MIN_FREE_MB_ENV], DEFAULT_DISK_MIN_FREE_MB);
    if (thresholdMb === 0) return;

    const { dataDir, backupDir } = ctx.settings;
    const paths = dataDir === backupDir ? [dataDir] : [dataDir, backupDir];
    const result = await ctx.transport.exec("df", ["-Pk", ...paths], { allowFailure: true });
    const rows = parseAvailableKbRows(result.stdout);

    for (let index = 0; index < rows.length; index += 1) {
      const availableMb = rows[index] / 1024;
      if (availableMb < thresholdMb) {
        problems.push(
          problem("DISK_LOW", `${paths[index]} has ${availableMb.toFixed(0)} MB free, below the ${DISK_MIN_FREE_MB_ENV} threshold of ${thresholdMb} MB`),
        );
      }
    }
  });
}
