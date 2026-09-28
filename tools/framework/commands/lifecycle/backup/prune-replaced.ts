// `./clawforge backup prune-replaced` — deletes `<dataDir>.replaced-*` copies restore leaves
// next to the data directory once it has moved the previous data aside. Preview by default;
// only --apply deletes, mirroring `watch install --apply`/`expose tailscale --apply`.
//
// Archive pruning is already handled by backup's own rotation (rotate(), in index.ts) — this
// never touches an archive, only replaced-data siblings, and refuses any path that is not
// exactly one of those: strict name validation, symlinks refused, the data directory itself
// refused, re-checked immediately before each deletion rather than trusted from the listing
// that chose it.

import { log, info, warn, die } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { runMaybePrivileged, sudoFor, needsOwnerEscalation, OWNER, answeredProbe } from "#src/runtime/datadir.ts";
import {
  listReplacedCopies, dataDirName, dataDirParent, parseReplacedCopyName, type ReplacedCopyInfo,
} from "#src/service/archive/index.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";
import { JSON_ARGUMENT } from "./list.ts";

/** The declared, help/MCP-visible shape — `--json` is declared once, in list.ts, and
 *  reused here (not redeclared) so the merged `backup` command never lists it twice. */
export const BACKUP_PRUNE_ARGUMENTS: CommandArgument[] = [
  { name: "apply", description: "Actually delete; without it, only previews what would be removed", kind: "flag" },
  { name: "keep", description: "Keep this many newest copies instead of deleting all of them", kind: "option" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

/** What this command's own parser actually accepts — BACKUP_PRUNE_ARGUMENTS plus the shared
 *  --json, kept out of the declared array above so openclawCommands' merged list has it once. */
const PRUNE_PARSE_ARGUMENTS: CommandArgument[] = [...BACKUP_PRUNE_ARGUMENTS, JSON_ARGUMENT];

function parseKeep(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const keep = Number.parseInt(raw, 10);
  if (!Number.isFinite(keep) || keep < 0 || String(keep) !== raw.trim()) die("--keep needs a non-negative integer");
  return keep;
}

function summary(entry: ReplacedCopyInfo): { name: string; path: string; sizeBytes: number | null; modifiedAt: string } {
  return { name: entry.name, path: entry.path, sizeBytes: entry.sizeBytes ?? null, modifiedAt: entry.modifiedAt };
}

/** Re-checked immediately before deletion, never trusted from the listing that chose it —
 *  the listing and the delete are not the same moment. Refuses anything that is not exactly
 *  a `<dataDir>.replaced-<stamp>` sibling, a symlink, or the data directory itself.
 *
 *  Exported for testing: this is the invariant worth pinning directly, not only reachable
 *  through whatever listReplacedCopies happened to filter first. */
export async function verifyPruneCandidate(ctx: Context, dataDir: string, path: string): Promise<void> {
  if (path === dataDir) die(`refusing to remove the data directory itself: ${path}`);
  if (dataDirParent(path) !== dataDirParent(dataDir)) die(`refusing ${path}: not a direct sibling of ${dataDir}`);
  if (parseReplacedCopyName(dataDirName(path), dataDirName(dataDir)) === undefined) {
    die(`refusing ${path}: name does not match <dataDir>.replaced-<stamp>`);
  }

  const prefix = await sudoFor(ctx, path);
  const [linkHead, ...linkRest] = [...prefix, "test", "-L", path];
  if ((await answeredProbe(ctx, linkHead, linkRest, [0, 1])).code === 0) die(`refusing ${path}: it is a symlink, not an ordinary directory`);

  const [dirHead, ...dirRest] = [...prefix, "test", "-d", path];
  if ((await answeredProbe(ctx, dirHead, dirRest, [0, 1])).code !== 0) die(`${path} is no longer an ordinary directory — refusing to remove it`);
}

async function deleteReplacedCopy(ctx: Context, dataDir: string, path: string): Promise<void> {
  await verifyPruneCandidate(ctx, dataDir, path);
  await runMaybePrivileged(ctx, path, "rm", ["-rf", "--", path], { force: await needsOwnerEscalation(ctx, OWNER) });
}

export async function backupPruneReplaced(ctx: Context, args: string[]): Promise<void> {
  const parsed = parseDeclaredArgs(PRUNE_PARSE_ARGUMENTS, args);
  const apply = parsed.apply === true;
  const jsonOnly = parsed.json === true;
  const keep = parseKeep(parsed.keep as string | undefined);

  const { dataDir } = ctx.settings;
  // newest first, from listReplacedCopies — the newest `keep` are retained, everything
  // beyond them is a candidate.
  const copies = await listReplacedCopies(ctx, dataDir);
  const toKeep = copies.slice(0, keep);
  const toDelete = copies.slice(keep);

  if (!apply) {
    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify({ apply: false, keep, candidates: toDelete.map(summary), keeping: toKeep.map(summary) }, null, 2)}\n`);
      return;
    }
    log(`<data>.replaced-* copies next to ${dataDir}`);
    if (copies.length === 0) {
      info("none found — nothing to prune");
      return;
    }
    for (const entry of toDelete) info(`would remove  ${entry.name}`);
    for (const entry of toKeep) info(`would keep    ${entry.name}  (within --keep ${keep})`);
    info(toDelete.length === 0 ? "nothing beyond --keep — pass a smaller --keep to remove any" : `pass --apply to remove ${toDelete.length} of them`);
    return;
  }

  if (toDelete.length === 0) {
    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify({ apply: true, keep, deleted: [], failed: [], keeping: toKeep.map(summary) }, null, 2)}\n`);
    } else {
      info(copies.length === 0 ? "none found — nothing to prune" : `nothing beyond --keep ${keep} — kept ${toKeep.length}`);
    }
    return;
  }

  // The one mutating path here, so the one that takes the instance lock — deleting a
  // replaced copy while a restore is mid-move of a NEW one into that same name is exactly
  // the race guarded() exists to serialize against.
  await guarded(ctx, "backup prune-replaced", args, async () => {
    const deleted: ReplacedCopyInfo[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const entry of toDelete) {
      try {
        await deleteReplacedCopy(ctx, dataDir, entry.path);
        deleted.push(entry);
        log(`removed ${entry.name}`);
      } catch (error) {
        failed.push({ path: entry.path, error: (error as Error).message });
        warn(`could not remove ${entry.name}: ${(error as Error).message}`);
      }
    }

    if (jsonOnly || isCaptured()) {
      emit(
        `${JSON.stringify(
          { apply: true, keep, deleted: deleted.map((entry) => entry.name), failed, keeping: toKeep.map(summary) },
          null,
          2,
        )}\n`,
      );
    } else {
      info(`removed ${deleted.length} of ${toDelete.length} candidate(s); kept ${toKeep.length}`);
    }
    if (failed.length > 0) die(`prune-replaced completed with ${failed.length} failure(s)`);
  });
}
