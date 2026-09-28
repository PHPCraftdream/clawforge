// `./clawforge backup` — a consistent snapshot of the data directory.
//
// The gateway is stopped for the duration by default:
// OpenClaw keeps state in SQLite databases with multi-megabyte -wal files, and a copy
// taken mid-write is not restorable. --hot skips the stop for those who accept that.
//
// Split into three files: this one keeps the creation path (BACKUP_ARGUMENTS, createBackup
// and the dispatcher below); list.ts is the read-only archive/replaced-copy inventory;
// prune-replaced.ts is the explicit, --apply-gated cleanup of `<dataDir>.replaced-*`
// copies restore leaves behind. No action (`./clawforge backup`) still creates an archive
// exactly as before — `list`/`prune-replaced` are additional first positional actions, not
// a replacement for it.

import { log, info, warn, die } from "#src/core/io/log.ts";
import type { Context } from "#src/core/context.ts";
import { parseRetention } from "#src/core/env.ts";
import { randomUUID } from "node:crypto";
import { runMaybePrivileged, sudoFor } from "#src/runtime/datadir.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import {
  archiveCarriesContent, archiveRoot, createArchive, dataDirName, excludesFor, fileSize, isProfile, backupArchiveName,
  listArchive, parseBackupArchive, privilegePrefixFor, symlinkedDataRoot, PROFILE_SHORTHAND_FLAGS, type Profile,
} from "#src/service/archive/index.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { runningRecipeStacks } from "#src/commands/management/recipe/index.ts";
import { quiesceRecipeStacks, resumeRecipeStacks } from "#src/commands/management/recipe/lifecycle.ts";
import type { Recipe } from "#src/service/recipe.ts";
import { verifySnapshot } from "#src/commands/lifecycle/verify.ts";
import type { CommandArgument, BackupPurpose } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";
import { openclawCliJson } from "#src/service/openclaw-cli.ts";
import { PROFILE_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";
import { backupList, BACKUP_LIST_ARGUMENTS } from "./list.ts";
import { backupPruneReplaced, BACKUP_PRUNE_ARGUMENTS } from "./prune-replaced.ts";

export { backupList, BACKUP_LIST_ARGUMENTS } from "./list.ts";
export { backupPruneReplaced, BACKUP_PRUNE_ARGUMENTS } from "./prune-replaced.ts";

/** The first positional token `./clawforge backup` accepts instead of creating an archive. */
export const BACKUP_ACTIONS = ["list", "prune-replaced"] as const;

/** Only `list` and a preview `prune-replaced` (no --apply) merely read the instance; a bare
 *  create and `prune-replaced --apply` both change it. One predicate for openclawCommands'
 *  readOnlyWhen/changedWhen/requiresConfirmationWhen, same reasoning as expose/watch's own
 *  <action>IsReadOnly helpers. */
export function backupActionIsReadOnly(argv: string[]): boolean {
  const action = argv[0];
  if (action === "list") return true;
  if (action === "prune-replaced") return !argv.includes("--apply");
  return false;
}

/** Drives both `./clawforge backup`'s own parser and its openclawCommands declaration (help,
 *  MCP schema) from one list, so the two cannot drift apart. Only the creation path's own
 *  flags — `list`'s and `prune-replaced`'s own are BACKUP_LIST_ARGUMENTS/BACKUP_PRUNE_ARGUMENTS. */
export const BACKUP_ARGUMENTS: CommandArgument[] = [
  PROFILE_ARGUMENT,
  { name: "hot", description: "Do not stop the service (risks a partial write)", kind: "flag" },
  { name: "native", description: "Consistent snapshot without stopping the gateway (full profile only); auth-secrets/ and anything OpenClaw's own backup omits are copied in, hot", kind: "flag" },
  { name: "share", description: "Shareable profile with verification (same as --profile share)", kind: "flag" },
  { name: "migrate", description: "Migrate profile: no provider keys (same as --profile migrate)", kind: "flag" },
  { name: "with-secrets", description: "Full profile: includes provider keys (already backup's default)", kind: "flag" },
];

/** The merged declaration for openclawCommands — one optional `action` positional ahead of
 *  every sub-action's own flags, so `./clawforge backup` with none of them still creates an
 *  archive exactly as it always has. */
export const BACKUP_ALL_ARGUMENTS: CommandArgument[] = [
  { name: "action", description: "list or prune-replaced instead of creating a backup", kind: "positional", choices: [...BACKUP_ACTIONS] },
  ...BACKUP_ARGUMENTS,
  ...BACKUP_LIST_ARGUMENTS,
  ...BACKUP_PRUNE_ARGUMENTS,
];

export interface BackupOptions {
  hot?: boolean;
  profile?: Profile;
  /** Skip the restart this would otherwise do once the archive is published. For a caller
   *  that is about to restore right back into the same data directory (smoke's round-trip
   *  check): restarting here just to have restore's own `ctx.runtime.stop()` stop it again
   *  a moment later opens exactly the window the gateway being paused is meant to close —
   *  live writes landing between this backup and that restore, silently lost when the
   *  restore replaces the tree. The caller owns starting it back up once its own
   *  transaction is done. */
  leaveStopped?: boolean;
  /** Consistent snapshot without stopping the gateway, via OpenClaw's own `backup create`
   *  in the running instance's sidecar instead of a raw tar over live state. Full profile
   *  only (see createNativeArchive). */
  native?: boolean;
  /** Why this archive is being created — see BackupPurpose. Defaults to "backup": the
   *  ordinary case, where the application's `afterBackup` (if declared) runs once the
   *  archive is published and rotated. Pass "internal" for a caller (smoke) whose archive
   *  only proves the backup/restore mechanism still works and is not a copy for a hook to
   *  act on. */
  purpose?: BackupPurpose;
}

/** Thrown when native mode cannot be attempted at all — the caller (createBackup itself for
 *  a direct `--native` request, and ./clawforge upgrade for its pre-upgrade backup) falls
 *  back to the classic stopped tar path rather than treating it as a hard failure. Any other
 *  error out of the native path is a real failure and propagates as-is. */
export class NativeBackupUnsupportedError extends Error {}

/** The pristine archive `openclaw backup create` wrote, kept inside the published archive at
 *  this name so restore can feed it back to `openclaw backup verify` before trusting the
 *  rest — see createNativeArchive and restore.ts. */
export const NATIVE_MANIFEST_NAME = ".clawforge-native-manifest.tar.gz";

// UTC, not local time: state.ts's snapshot names and restore.ts's <data>.replaced-<stamp>
// both already are, and local time would put a backup taken the same moment as a pull two
// hours apart by name on a UTC+2 host — correlating "which backup was this snapshot copied
// from" would mean doing the arithmetic by hand.
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
  const keep = parseRetention("OC_BACKUP_KEEP", ctx.settings.env.OC_BACKUP_KEEP, 10);
  if (keep <= 0) return;

  const prefix = await sudoFor(ctx, backupDir);
  // find returns success for an empty directory and a non-zero status for an unreadable one.
  // `ls glob 2>/dev/null` cannot distinguish those cases.
  const [head, ...rest] = [
    ...prefix,
    "find",
    backupDir,
    "-maxdepth",
    "1",
    "-type",
    "f",
    "-name",
    `${deploymentName()}-*.tar.gz`,
    "-printf",
    "%T@\\t%p\\n",
  ];
  const listing = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (listing.code !== 0) throw new Error(`backup rotation could not list archives (exit ${listing.code})`);
  const archives = listing.stdout
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf("\t");
      if (separator < 0) return [];
      const modified = Number(line.slice(0, separator));
      const path = line.slice(separator + 1);
      return Number.isFinite(modified) ? [{ path, modified }] : [];
    })
    .sort((left, right) => right.modified - left.modified)
    .map(({ path }) => path);

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

  // The listing is sorted newest first and each group keeps that order; restore it across
  // groups so "the oldest" below is the oldest of all of them.
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
  const removed = await ctx.transport.exec(rmHead, rmRest, { allowFailure: true });
  if (removed.code !== 0) throw new Error(`backup rotation could not remove stale archive (exit ${removed.code})`);
}

/** Runs `openclaw backup create --verify` inside the sidecar and reshapes its output into
 *  the classic archive layout (root = the data directory's own name) at `stagingArchive`, so
 *  rotate(), newestArchive() and restore's extraction need no native-specific case — the
 *  archive this publishes is, structurally, an ordinary full backup.
 *
 *  auth-secrets/ is not part of what OpenClaw's own backup covers (it lives outside
 *  $OPENCLAW_STATE_DIR, at a separate bind mount) — copied in directly from the live target,
 *  safe to do while the gateway keeps running since it is static key material, not a
 *  database. The pristine OpenClaw archive travels along too, embedded at
 *  NATIVE_MANIFEST_NAME, so restore can re-verify it with `openclaw backup verify` before
 *  trusting anything else in the archive.
 *
 *  Failures asking OpenClaw for the archive are reported as NativeBackupUnsupportedError, so
 *  createBackup (and ./clawforge upgrade) can fall back to the classic path; a failure in the
 *  reshape itself is a real bug/environment problem and propagates unchanged. */
/** Live files the set difference must never re-add: SQLite sidecars (a hot -wal/-shm/-journal
 *  beside the native point-in-time database would be replayed onto it on restore and corrupt
 *  it), Chromium profile locks, and this run's own native archive, which sits in config/
 *  while the difference is taken. */
const NEVER_COPY_LIVE = [/-(wal|shm|journal)$/, /(^|\/)Singleton(Lock|Cookie|Socket)$/, /(^|\/)\.clawforge-native-[^/]*\.tar\.gz$/];

export function omittedOnPurpose(relative: string): boolean {
  return NEVER_COPY_LIVE.some((pattern) => pattern.test(relative));
}

/** Paths, relative to their own root, of every file under `liveDir` that `assembledDir` does
 *  not have — either directory may not exist yet, and that reads as an empty listing rather
 *  than an error. */
async function missingRelativeFiles(ctx: Context, liveDir: string, assembledDir: string): Promise<string[]> {
  const listing = async (dir: string): Promise<Set<string>> => {
    if (!(await ctx.transport.exists(dir))) return new Set();
    const prefix = await sudoFor(ctx, dir);
    const [head, ...rest] = [...prefix, "find", dir, "-type", "f", "-printf", "%P\\n"];
    const result = await ctx.transport.exec(head, rest, { allowFailure: true });
    if (result.code !== 0) throw new Error(`could not list ${dir} (exit ${result.code})`);
    return new Set(result.stdout.split("\n").filter((line) => line !== ""));
  };
  const [live, assembled] = await Promise.all([listing(liveDir), listing(assembledDir)]);
  return [...live].filter((relative) => !assembled.has(relative) && !omittedOnPurpose(relative));
}

/** Copies whatever `openclaw backup create` left out of its own payload — in the pinned
 *  image (2026.6.34), verified against a real archive, that is every session transcript
 *  under `agents/<id>/sessions/` (the directory itself is listed, the `.jsonl`/`.log` files
 *  in it are not; upstream docs confirm `.log` there is excluded by design). Computed
 *  generically as the set difference between the live tree and what the native archive
 *  actually carries, never a hardcoded name, so a future image excluding something else is
 *  still covered and one that stops excluding sessions copies nothing extra.
 *
 *  These are live, append-only logs, copied while the gateway keeps writing them — a
 *  trailing partial line in the newest one is possible. That risk does not extend to the
 *  instance's SQLite state: that part of the archive came from OpenClaw's own point-in-time
 *  mechanism, not from this copy. Returns how many files were added, for the caller to
 *  report. */
async function copyOmittedLiveFiles(ctx: Context, liveDir: string, assembledDir: string): Promise<number> {
  const missing = await missingRelativeFiles(ctx, liveDir, assembledDir);
  for (const relative of missing) {
    const destination = `${assembledDir}/${relative}`;
    const destinationDir = destination.slice(0, destination.lastIndexOf("/"));
    await runMaybePrivileged(ctx, destinationDir, "mkdir", ["-p", destinationDir]);
    await runMaybePrivileged(ctx, destination, "cp", ["-p", "--", `${liveDir}/${relative}`, destination]);
  }
  return missing.length;
}

async function createNativeArchive(
  ctx: Context,
  stagingDir: string,
  stagingArchive: string,
  name: string,
  compensationErrors: unknown[],
): Promise<void> {
  const { dataDir } = ctx.settings;
  const nativeTarget = `${dataDir}/config/.clawforge-native-${randomUUID()}.tar.gz`;
  let containerOutput: string;
  try {
    containerOutput = ctx.paths.toContainer(nativeTarget);
  } catch (error) {
    throw new NativeBackupUnsupportedError(`${ctx.runtime.description} cannot address ${nativeTarget} inside the sidecar: ${(error as Error).message}`);
  }

  let outcome: { verified?: boolean; archivePath?: string };
  try {
    outcome = await openclawCliJson(ctx, ["backup", "create", "--verify", "--json", "--output", containerOutput]);
  } catch (error) {
    throw new NativeBackupUnsupportedError((error as Error).message);
  }
  if (outcome.verified !== true) throw new Error("openclaw backup create did not report a verified archive");
  const nativeArchive = outcome.archivePath === undefined ? nativeTarget : ctx.paths.fromContainer(outcome.archivePath);

  // Until the mv into staging, a full archive (credentials included) sits in the live data
  // directory; any failure below must not leave it there.
  let movedIntoStaging = false;
  try {
    const nativeEntries = await listArchive(ctx, nativeArchive);
    const nativeRoot = archiveRoot(nativeEntries);
    const nativeWorkdir = `${stagingDir}/native`;
    const payload = `${nativeWorkdir}/${nativeRoot}/payload/posix/home/node/.openclaw`;
    const assembled = `${stagingDir}/${name}`;

    await runMaybePrivileged(ctx, nativeWorkdir, "mkdir", ["-p", nativeWorkdir]);
    const extractPrefix = await sudoFor(ctx, nativeArchive);
    const [exHead, ...exRest] = [...extractPrefix, "tar", "--numeric-owner", "-xzf", nativeArchive, "-C", nativeWorkdir];
    await ctx.transport.exec(exHead, exRest);
    if (!(await ctx.transport.exists(payload))) {
      throw new Error(`native archive ${nativeArchive} carries no ${nativeRoot}/payload/posix/home/node/.openclaw`);
    }

    await runMaybePrivileged(ctx, assembled, "mkdir", ["-p", assembled]);
    await runMaybePrivileged(ctx, assembled, "mv", [payload, `${assembled}/config`]);
    const nestedWorkspace = `${assembled}/config/workspace`;
    if (await ctx.transport.exists(nestedWorkspace)) {
      await runMaybePrivileged(ctx, assembled, "mv", [nestedWorkspace, `${assembled}/workspace`]);
    }

    const omitted = await copyOmittedLiveFiles(ctx, `${dataDir}/config`, `${assembled}/config`)
      + await copyOmittedLiveFiles(ctx, `${dataDir}/workspace`, `${assembled}/workspace`);
    if (omitted > 0) {
      log(`copied ${omitted} file(s) present live but left out of openclaw's own backup (e.g. session transcripts)`);
    }

    if (await ctx.transport.exists(`${dataDir}/auth-secrets`)) {
      await runMaybePrivileged(ctx, assembled, "cp", ["-a", `${dataDir}/auth-secrets`, `${assembled}/auth-secrets`]);
    }
    await runMaybePrivileged(ctx, assembled, "mv", [nativeArchive, `${assembled}/${NATIVE_MANIFEST_NAME}`]);
    movedIntoStaging = true;

    const excludeArgs = excludesFor("full", name).map((pattern) => `--exclude=${pattern}`);
    const packPrefix = await privilegePrefixFor(ctx, [`${assembled}/auth-secrets`, assembled], stagingArchive);
    const [head, ...rest] = [...packPrefix, "tar", "--numeric-owner", ...excludeArgs, "-czf", stagingArchive, "-C", stagingDir, name];
    await ctx.transport.exec(head, rest);
  } finally {
    // A removal failure is reported alongside the error in flight, never instead of it.
    if (!movedIntoStaging) {
      try {
        if (await ctx.transport.exists(nativeArchive)) {
          await runMaybePrivileged(ctx, nativeArchive, "rm", ["-f", "--", nativeArchive]);
        }
      } catch (error) {
        compensationErrors.push(new Error(`could not remove native archive left in the live data directory: ${nativeArchive}`, { cause: error }));
      }
    }
  }
}

/** Creates a backup and returns the archive path on the target.
 *
 *  Guarded like every other mutating command: it stops the gateway, archives the data
 *  directory, and starts it again, all of which race against apply/restore/rollback doing
 *  the same instance's work at once if nothing serializes them. guarded() is nesting-safe,
 *  so pull() and smoke() calling this while already holding the lock for their own
 *  operation cost nothing extra here. */
export async function createBackup(ctx: Context, options: BackupOptions = {}): Promise<string> {
  await requireBootstrapped(ctx);
  // No --break-lock support: its own parser (backup() below) rejects it, so a refusal here
  // must not offer a flag it will then reject as unknown.
  return guarded(ctx, "backup", [], () => createBackupLocked(ctx, options), { breakLockSupported: false });
}

async function createBackupLocked(ctx: Context, options: BackupOptions): Promise<string> {
  const profile: Profile = options.profile ?? "full";
  const { dataDir, backupDir } = ctx.settings;

  if (options.native === true && profile !== "full") {
    die("--native only supports the full profile — migrate/share stay on the framework's own tar path");
  }

  if (!(await ctx.transport.exists(dataDir))) die(`data directory ${dataDir} does not exist`);

  // tar is handed the data directory's name relative to its parent, so a symlinked root
  // is archived as the link itself — one entry, no data, and a "successful" backup that
  // cannot be restored anywhere. Refused before the
  // gateway is stopped: there is no consistent snapshot of this layout to take.
  const linkTarget = await symlinkedDataRoot(ctx);
  if (linkTarget !== undefined) {
    die(
      `data directory ${dataDir} is a symlink to ${linkTarget}: a backup would archive the link itself, not the data behind it — ` +
        `point the data directory setting at a real directory (the link's target is one) and run the backup again`,
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

  const quiesced: Recipe[] = [];
  let stagingCreated = false;
  let resultError: unknown;
  // Shared with createNativeArchive, whose cleanup failures are compensations too.
  const compensationErrors: unknown[] = [];

  try {
    if (options.native === true) {
      log("native backup: OpenClaw's own point-in-time mechanism — the gateway keeps running throughout");
    } else if (options.hot === true) {
      warn("hot backup: the gateway keeps writing, the archive may catch a partial sqlite write");
    } else if (wasRunning) {
      log("stopping the gateway for a consistent snapshot");
      await ctx.runtime.pause();
    }

    // Every operation after pause, including sidecar discovery, belongs to this
    // compensation scope: discovery and hook loading can both fail. Native never pauses in
    // the first place, so quiescing recipe stacks buys it nothing either — same reasoning
    // --hot already applies below.
    const sidecars = await runningRecipeStacks(ctx);
    if (options.hot !== true && options.native !== true && options.leaveStopped !== true && sidecars.length > 0) {
      const outcome = await quiesceRecipeStacks(ctx, sidecars);
      quiesced.push(...outcome.quiesced);
      if (outcome.unquiesced.length > 0) {
        throw new Error(
          `backup refused because recipe stack(s) could not be quiesced: ${outcome.unquiesced.map((recipe) => recipe.name).join(", ")}`,
        );
      }
    } else if (sidecars.length > 0) {
      warn(`recipe stack(s) remain running during this transaction: ${sidecars.map((recipe) => recipe.name).join(", ")}`);
    }

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

    if (options.native === true) {
      await createNativeArchive(ctx, stagingDir, stagingArchive, dataDirName(dataDir), compensationErrors);
    } else {
      await createArchive(ctx, { archive: stagingArchive, profile });
    }
    // tar exiting 0 and the file landing are not evidence the data is inside: a symlinked
    // root can produce an archive that holds nothing beneath its root, which restores
    // nothing anywhere. Checked on the staging archive, before it can become the newest
    // backup.
    if (!archiveCarriesContent(await listArchive(ctx, stagingArchive))) {
      throw new Error(`the fresh archive of ${dataDir} carries no data beneath its root — refusing to publish it as a backup`);
    }
    if (profile !== "full" && !(await verifySnapshot(ctx, stagingArchive, profile))) {
      throw new Error(`the fresh '${profile}' backup failed its privacy check — refusing to publish it`);
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
  } catch (error) {
    resultError = error;
  }

  if (stagingCreated) {
    try {
      await runMaybePrivileged(ctx, stagingDir, "rm", ["-rf", "--", stagingDir]);
    } catch (error) {
      compensationErrors.push(new Error(`could not remove backup staging directory ${stagingDir}`, { cause: error }));
    }
  }
  if (options.hot !== true && options.native !== true && wasRunning && options.leaveStopped !== true) {
    try {
      log("starting the gateway again");
      await ctx.runtime.start();
      await ctx.runtime.waitForHealth();
      log("gateway is healthy");
    } catch (error) {
      compensationErrors.push(new Error("backup could not restore the gateway to its running state", { cause: error }));
    }
  } else if (options.leaveStopped === true && wasRunning) {
    info("leaving the gateway stopped — the caller restarts it once its own transaction is done");
  }
  if (quiesced.length > 0) compensationErrors.push(...await resumeRecipeStacks(ctx, quiesced));

  if (resultError !== undefined && compensationErrors.length > 0) {
    throw new AggregateError([resultError, ...compensationErrors], "backup failed and compensation also failed");
  }
  if (resultError !== undefined) throw resultError;
  if (compensationErrors.length > 0) throw new AggregateError(compensationErrors, "backup completed but compensation failed");

  log(`backup done: ${archive} (${await fileSize(ctx, archive)}, profile: ${profile})`);
  await rotate(ctx, backupDir);

  // Runs after the archive is fully published and rotated — never before, so a hook never
  // sees a path that could still turn out to be staging. A hook failure must not read as
  // the backup itself failing: the archive stays exactly where it landed, and the caller
  // gets a distinct, actionable error instead of a deleted or hidden backup.
  const purpose = options.purpose ?? "backup";
  if (purpose !== "internal" && ctx.applicationAfterBackup !== undefined) {
    try {
      await ctx.applicationAfterBackup({ archive, profile, purpose });
    } catch (error) {
      die(`backup published at ${archive}, afterBackup hook failed: ${(error as Error).message}`);
    }
  }
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
  const [first, ...rest] = args;
  // Positional and unambiguous: every creation flag is `--something`, so a bare `list` or
  // `prune-replaced` token can never collide with one. Anything else (including undefined)
  // falls through to creation unchanged — its own parser below rejects a genuinely unknown
  // bare token exactly as it always has.
  if (first === "list") return backupList(ctx, rest);
  if (first === "prune-replaced") return backupPruneReplaced(ctx, rest);

  const options: BackupOptions = {};
  const parsed = parseDeclaredArgs(BACKUP_ARGUMENTS, args);

  if (parsed.hot === true) options.hot = true;
  if (parsed.native === true) options.native = true;

  // --share, --with-secrets, --migrate (the same shorthand vocabulary `pull` accepts) and
  // --profile all set the same field, so whichever was typed LAST decides it — scanned over
  // the raw argv, not the declaration-keyed `parsed` above, because that ordering is exactly
  // what the hand-written loop this replaces gave: one pass, later flag wins regardless of
  // which of the two forms it was.
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const shorthand = PROFILE_SHORTHAND_FLAGS.get(arg);
    if (shorthand !== undefined) {
      options.profile = shorthand;
    } else if (arg === "--profile") {
      const value = args[index + 1];
      if (value === undefined || !isProfile(value)) die("--profile needs one of: full, migrate, share");
      options.profile = value;
      index += 1;
    }
  }

  // Not repeated here: createBackup() already announced the path in "backup done: <path>".
  await createBackup(ctx, options);
}
