// `./clawforge backup list` — read-only inventory: every backup archive in
// ctx.settings.backupDir, and every `<dataDir>.replaced-*` copy restore left next to the
// data directory, both from the target through ctx.transport. Marks which archive a bare
// `./clawforge restore` would pick by default.
//
// What is not shown: WHY an archive was created (backup/pull/upgrade — BackupPurpose,
// core/app.ts). That is a runtime option passed to createBackup for the afterBackup hook;
// it is never written into the archive's name or anywhere else retrievable afterwards, so
// there is nothing here to read it back from — omitted rather than guessed.

import { log, info, die } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { TransportUnreachableError } from "#src/runtime/transport/transport.ts";
import { unreachableProblem } from "#src/service/inspection.ts";
import type { Context } from "#src/core/context.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs, type ActionScope } from "#src/core/arguments.ts";
import {
  listBackupArchives, listReplacedCopies, defaultRestoreArchive,
  type BackupArchiveInfo, type ReplacedCopyInfo,
} from "#src/service/archive/index.ts";

export const JSON_ARGUMENT: CommandArgument = { name: "json", description: "Emit archives and replaced copies as JSON instead of text", kind: "flag" };

export const BACKUP_LIST_ARGUMENTS: CommandArgument[] = [JSON_ARGUMENT];

/** Exported for restore's --dry-run plan, which reports an archive's size the same way. */
export function humanSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`;
}

function archiveLine(entry: BackupArchiveInfo, isDefault: boolean): string {
  return `${entry.name}  ${humanSize(entry.sizeBytes)}  ${entry.modifiedAt}  ${entry.profile}${isDefault ? "  (default for restore)" : ""}`;
}

function replacedLine(entry: ReplacedCopyInfo): string {
  return `${entry.name}  ${humanSize(entry.sizeBytes)}  ${entry.modifiedAt}`;
}

export async function backupList(ctx: Context, args: string[], scope?: ActionScope): Promise<void> {
  const jsonOnly = parseDeclaredArgs(BACKUP_LIST_ARGUMENTS, args, scope).json === true;

  const { backupDir, dataDir } = ctx.settings;
  let archives: BackupArchiveInfo[];
  let replaced: ReplacedCopyInfo[];
  try {
    [archives, replaced] = await Promise.all([
      listBackupArchives(ctx, backupDir),
      listReplacedCopies(ctx, dataDir),
    ]);
  } catch (error) {
    if (!(error instanceof TransportUnreachableError)) throw error;
    const found = unreachableProblem(error);
    die(`${found.code}  ${found.detail}\n    → ${found.nextAction}`);
  }
  const picked = defaultRestoreArchive(archives);

  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          backupDir,
          archives: archives.map((entry) => ({
            name: entry.name,
            path: entry.path,
            sizeBytes: entry.sizeBytes,
            modifiedAt: entry.modifiedAt,
            profile: entry.profile,
            default: picked !== undefined && entry.path === picked.path,
          })),
          dataDir,
          replacedCopies: replaced.map((entry) => ({
            name: entry.name,
            path: entry.path,
            sizeBytes: entry.sizeBytes ?? null,
            modifiedAt: entry.modifiedAt,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  log(`backup archives in ${backupDir}`);
  if (archives.length === 0) {
    info("none found");
  } else {
    for (const entry of archives) info(archiveLine(entry, picked !== undefined && entry.path === picked.path));
  }

  log(`<data>.replaced-* copies next to ${dataDir}`);
  if (replaced.length === 0) {
    info("none found");
  } else {
    for (const entry of replaced) info(replacedLine(entry));
    info("remove with: ./clawforge backup prune-replaced --apply");
  }
}
