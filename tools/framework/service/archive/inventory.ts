// Archive and replaced-copy inventory: listing what `backup` has published in the backup
// directory, and what `restore` has moved aside next to the data directory — the read side
// `backup list`/`backup prune-replaced` need. No tar invocation and no deletion here; both
// read the target through ctx.transport, never the local filesystem.

import type { Context } from "../../core/context.ts";
import { answeredProbe } from "../../runtime/datadir.ts";
import { deploymentName } from "../../runtime/deployment.ts";
import { parseBackupArchive, parseReplacedCopyName, type Profile } from "./profile.ts";
import { dataDirName, dataDirParent } from "./pack.ts";

export interface BackupArchiveInfo {
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly profile: Profile;
  readonly stamp: string;
}

export interface ReplacedCopyInfo {
  readonly name: string;
  readonly path: string;
  /** undefined when `du` could not size it (permissions, or it vanished mid-listing) —
   *  never guessed at. */
  readonly sizeBytes: number | undefined;
  readonly modifiedAt: string;
  readonly stamp: string;
}

function toIso(epochSecondsField: string): string {
  const ms = Number(epochSecondsField) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The prefix needed to READ `dir`, or undefined when it does not exist (nothing to list).
 *  sudoFor answers the write question and refuses outright without passwordless sudo — a
 *  listing needs neither: a readable directory needs no escalation, and an unreadable one
 *  uses `sudo -n` only when that works without a password. */
async function readPrefix(ctx: Context, dir: string): Promise<string[] | undefined> {
  if ((await answeredProbe(ctx, "test", ["-d", dir], [0, 1])).code !== 0) return undefined;
  const readable = await answeredProbe(ctx, "sh", ["-c", 'test -r "$1" && test -x "$1"', "sh", dir], [0, 1]);
  if (readable.code === 0) return [];
  const sudo = await ctx.transport.exec("sudo", ["-n", "true"], { allowFailure: true });
  return sudo.code === 0 ? ["sudo", "-n"] : [];
}

/** Every archive of THIS deployment in `backupDir`, newest first. A sibling deployment's
 *  archive sharing the directory, or a file `pull` left there, is excluded the same way
 *  rotate() and restore's newestArchive() already filter — parseBackupArchive says so. */
export async function listBackupArchives(ctx: Context, backupDir: string): Promise<BackupArchiveInfo[]> {
  const deployment = deploymentName();
  const prefix = await readPrefix(ctx, backupDir);
  if (prefix === undefined) return [];
  const [head, ...rest] = [
    ...prefix, "find", backupDir, "-maxdepth", "1", "-type", "f",
    "-name", `${deployment}-*.tar.gz`, "-printf", "%s\t%T@\t%p\n",
  ];
  // find returns success for an empty directory and non-zero for an unreadable one —
  // reported as no archives rather than surfaced as a hard error, same as rotate()'s
  // comment on its own identical listing explains.
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (result.code !== 0) return [];

  const entries: BackupArchiveInfo[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [sizeField, mtimeField, path] = line.split("\t");
    const name = basenameOf(path);
    const parsed = parseBackupArchive(name, deployment);
    if (parsed === undefined) continue;
    entries.push({
      name,
      path,
      sizeBytes: Number(sizeField),
      modifiedAt: toIso(mtimeField),
      profile: parsed.profile,
      stamp: parsed.stamp,
    });
  }
  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return entries;
}

/** Which archive a bare `./clawforge restore` (no argument) would pick — restore.ts's
 *  newestArchive() applies the same rule over its own listing; kept as a separate, tiny
 *  reimplementation so `backup list` (service layer) never depends on a command module. A
 *  change to the rule itself has to be made in both places. */
export function defaultRestoreArchive(archives: readonly BackupArchiveInfo[]): BackupArchiveInfo | undefined {
  return archives.find((entry) => entry.profile === "full");
}

/** Every `<dataDir>.replaced-<stamp>` sibling restore left next to the data directory,
 *  newest first — what restore keeps instead of deleting, until `backup prune-replaced`.
 *  Sized with a second, batched `du -sb` pass: each is a directory tree, not a single file
 *  `find -printf %s` (used above for archives) could size. */
export async function listReplacedCopies(ctx: Context, dataDir: string): Promise<ReplacedCopyInfo[]> {
  const name = dataDirName(dataDir);
  const parent = dataDirParent(dataDir);
  const prefix = await readPrefix(ctx, parent);
  if (prefix === undefined) return [];
  const [head, ...rest] = [
    ...prefix, "find", parent, "-maxdepth", "1", "-type", "d",
    "-name", `${name}.replaced-*`, "-printf", "%T@\t%p\n",
  ];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (result.code !== 0) return [];

  const candidates: { path: string; modifiedAt: string; stamp: string }[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [mtimeField, path] = line.split("\t");
    // The glob above is a coarse filter; parseReplacedCopyName is the strict one — the
    // same two-tier check listBackupArchives applies with parseBackupArchive.
    const parsed = parseReplacedCopyName(basenameOf(path), name);
    if (parsed === undefined) continue;
    candidates.push({ path, modifiedAt: toIso(mtimeField), stamp: parsed.stamp });
  }
  if (candidates.length === 0) return [];

  const [duHead, ...duRest] = [...prefix, "du", "-sb", "--", ...candidates.map((c) => c.path)];
  const sized = await ctx.transport.exec(duHead, duRest, { allowFailure: true });
  const sizeByPath = new Map<string, number>();
  if (sized.code === 0) {
    for (const line of sized.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const bytes = Number(line.slice(0, tab));
      if (Number.isFinite(bytes)) sizeByPath.set(line.slice(tab + 1), bytes);
    }
  }

  const entries = candidates.map((c) => ({
    name: basenameOf(c.path),
    path: c.path,
    sizeBytes: sizeByPath.get(c.path),
    modifiedAt: c.modifiedAt,
    stamp: c.stamp,
  }));
  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return entries;
}
