// `./clawforge pull` and `./clawforge push` — moving an instance's whole state around.
//
// Both are thin layers over backup/restore rather than a second implementation: those
// already stop the gateway before touching sqlite and move existing data aside instead of
// deleting it.

import { log, info, warn, die } from "#src/core/io/log.ts";
import { emit, withOutputSink } from "#src/core/io/output.ts";
import { randomBytes } from "node:crypto";
import type { Context } from "#src/core/context.ts";
import { parseEnv, parseRetention } from "#src/core/env.ts";
import { guarded } from "#src/runtime/lock/instance-lock.ts";
import { sudoFor, runMaybePrivileged, secretsFileOnTarget } from "#src/runtime/datadir.ts";
import { publishPrivateTargetFile } from "#src/security/privacy/private-target-file.ts";
import { archiveRoot, isProfile, listArchive, listSnapshotArchives, fileSize, parseSnapshotArchive, snapshotDeploymentNames, SHARE_ALLOWED, PROFILE_SHORTHAND_FLAGS, type Profile } from "#src/service/archive/index.ts";
import { installedRecipePrivatePaths } from "#src/service/recipe.ts";
import { requirements, template } from "#src/service/secrets.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { createBackup } from "./backup/index.ts";
import { restoreArchive, prepareRestore } from "./restore/index.ts";
import type { RestoreOptions } from "./restore/index.ts";
import { buildRestorePlan, printRestorePlan } from "./restore/plan.ts";
import { forbiddenViolations, verifySnapshot } from "./verify.ts";
import { preflightSecrets, MissingSecretsError } from "#src/commands/management/secrets.ts";
import type { CommandArgument, BackupPurpose } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";
import { PROFILE_ARGUMENT, FORCE_ARGUMENT, BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";

const SECRETS_SUFFIX = ".secrets.env";

/** Drives both pull's own parser and its openclawCommands declaration. */
export const PULL_ARGUMENTS: CommandArgument[] = [
  PROFILE_ARGUMENT,
  { name: "share", description: "Shareable profile with verification", kind: "flag" },
  { name: "with-secrets", description: "Full profile: includes provider keys", kind: "flag" },
  { name: "migrate", description: "Migrate profile (already pull's default) — accepted so backup and pull share the same flag vocabulary", kind: "flag" },
  { name: "hot", description: "Do not stop the service (risks a partial write)", kind: "flag" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
  { name: "json", description: "Emit the outcome as JSON", kind: "flag" },
];

/** Drives both push's own parser and its openclawCommands declaration. */
export const PUSH_ARGUMENTS: CommandArgument[] = [
  { name: "archive", description: "Snapshot to push; newest if omitted", kind: "positional" },
  FORCE_ARGUMENT,
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
  { name: "fresh-identity", description: "Drop identity and paired devices (cloning, not moving)", kind: "flag" },
  { name: "dry-run", description: "Show what would happen without touching the target", kind: "flag" },
  { name: "json", description: "Emit the outcome as JSON", kind: "flag" },
];

/** Whether argv requests --dry-run — same shape as restore's own isRestoreDryRun. */
export function isPushDryRun(args: readonly string[]): boolean {
  return parseDeclaredArgs(PUSH_ARGUMENTS, args)["dry-run"] === true;
}

async function ensureSnapshotDir(ctx: Context): Promise<string> {
  const directory = ctx.settings.snapshotDir;
  if (directory.startsWith("/mnt/")) {
    warn(`snapshot directory ${directory} is on a Windows mount — chmod 600 will not apply there`);
  }
  if (!(await ctx.transport.exists(directory))) {
    await runMaybePrivileged(ctx, directory, "mkdir", ["-p", directory]);
    await runMaybePrivileged(ctx, directory, "chown", ["1000:1000", directory]);
  }
  return directory;
}

function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
}

/** Writes a staged sidecar, escalating when its directory requires it. */
async function writeSnapshotSidecar(ctx: Context, path: string, content: string, mode?: string): Promise<void> {
  const prefix = await sudoFor(ctx, path);
  if (prefix.length === 0) {
    await ctx.transport.writeFile(path, content, mode);
    return;
  }
  const [head, ...rest] = [...prefix, "tee", path];
  await ctx.transport.exec(head, rest, { input: content });
  if (mode !== undefined) {
    const [chmodHead, ...chmodRest] = [...prefix, "chmod", mode, path];
    await ctx.transport.exec(chmodHead, chmodRest);
  }
  const uid = (await ctx.transport.exec("id", ["-u"])).stdout.trim();
  const gid = (await ctx.transport.exec("id", ["-g"])).stdout.trim();
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid)) throw new Error("could not determine snapshot sidecar owner");
  const [ownerHead, ...ownerRest] = [...prefix, "chown", `${uid}:${gid}`, path];
  await ctx.transport.exec(ownerHead, ownerRest);
}

/** Checks a snapshot path with the same privileges used to publish it. */
async function snapshotExists(ctx: Context, path: string): Promise<boolean> {
  const prefix = await sudoFor(ctx, path);
  const [head, ...rest] = [...prefix, "test", "-e", path];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`could not check snapshot path ${path} (exit ${result.code})`);
}

/** A move whose final state could not be observed safely. */
class SnapshotMoveUncertainError extends Error {
  readonly sourceAbsent: boolean | undefined;

  constructor(destination: string, cause: unknown, sourceAbsent: boolean | undefined) {
    super(`could not confirm publication of ${destination}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SnapshotMoveUncertainError";
    this.sourceAbsent = sourceAbsent;
  }
}

/** Publishes one file without replacing an existing path. */
async function moveSnapshotFile(ctx: Context, source: string, destination: string): Promise<void> {
  const prefix = await sudoFor(ctx, destination);
  const [head, ...rest] = [...prefix, "mv", "-nT", "--", source, destination];
  let result: Awaited<ReturnType<Context["transport"]["exec"]>>;
  try {
    result = await ctx.transport.exec(head, rest, { allowFailure: true });
  } catch (error) {
    let sourceAbsent: boolean | undefined;
    try {
      sourceAbsent = !(await snapshotExists(ctx, source));
    } catch {
      // The move and its acknowledgement are both unavailable; preserve any final
      // sidecar because removing a possible publication could destroy prior data.
    }
    if (sourceAbsent !== false) throw new SnapshotMoveUncertainError(destination, error, sourceAbsent);
    throw error;
  }
  if (result.code !== 0) {
    const failure = new Error(`could not publish ${destination}: ${result.stderr.trim() || `mv exited ${result.code}`}`);
    let sourceAbsent: boolean | undefined;
    try {
      sourceAbsent = !(await snapshotExists(ctx, source));
    } catch {
      // A failed probe leaves the move outcome unknown, so the caller must retain
      // sidecars until it can establish whether the archive was committed.
    }
    if (sourceAbsent !== false) throw new SnapshotMoveUncertainError(destination, failure, sourceAbsent);
    throw failure;
  }
  let sourcePresent: boolean;
  try {
    sourcePresent = await snapshotExists(ctx, source);
  } catch (error) {
    throw new SnapshotMoveUncertainError(destination, error, undefined);
  }
  if (sourcePresent) {
    throw new Error(`snapshot path already exists: ${destination}`);
  }
  let destinationPresent: boolean;
  try {
    destinationPresent = await snapshotExists(ctx, destination);
  } catch (error) {
    throw new SnapshotMoveUncertainError(destination, error, true);
  }
  if (!destinationPresent) {
    throw new SnapshotMoveUncertainError(destination, new Error("mv did not create the destination"), true);
  }
}

/** Removes owned pull artifacts, attempting every path before reporting failure. */
async function removeSnapshotFiles(ctx: Context, paths: string[]): Promise<void> {
  const failures: unknown[] = [];
  for (const path of paths) {
    try {
      await runMaybePrivileged(ctx, path, "rm", ["-f", path]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "could not remove all pull artifacts");
}

/** Filters a newest-first listing to snapshots owned by this deployment. */
export function selectSnapshotPaths(listing: string, deployment: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((path) => path !== "")
    .filter((path) => parseSnapshotArchive(path.slice(path.lastIndexOf("/") + 1), deployment) !== undefined);
}

/** Deletes snapshots beyond the configured retention count, each with its sidecar files
 *  (.template.env, and .secrets.env when a migrate pull produced one) — snapshot's own
 *  version of backup.ts's rotate(), needed since a deployment pulled regularly (smoke, a
 *  cron) grows the snapshot directory without bound.
 *
 *  Escalation is checked once for the directory, not per file, so a large unrotated backlog
 *  costs two round trips total, not one per file. Exported for tools/checks/state.check.ts. */
export async function rotateSnapshots(ctx: Context, snapshotDir: string): Promise<void> {
  const keep = parseRetention("OC_SNAPSHOT_KEEP", ctx.settings.env.OC_SNAPSHOT_KEEP, 10);
  if (keep <= 0) return;

  const prefix = await sudoFor(ctx, snapshotDir);

  // Select only owned base archives; sidecars and sibling deployments are excluded.
  const names = snapshotDeploymentNames(deploymentName());
  const findArgs = [
    ...prefix,
    "find",
    snapshotDir,
    "-maxdepth",
    "1",
    "-type",
    "f",
    "(",
    ...names.flatMap((name, index) => [...(index === 0 ? [] : ["-o"]), "-name", `${name}-state-*.tar.gz`]),
    ")",
    "-printf",
    "%T@\\t%p\\n",
  ];
  const [findHead, ...findRest] = findArgs;
  const listing = await ctx.transport.exec(findHead, findRest, { allowFailure: true });
  if (listing.code !== 0) {
    throw new Error(`snapshot rotation could not list archives (exit ${listing.code})`);
  }
  const snapshots = listing.stdout
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf("\t");
      if (separator < 0) return [];
      const modified = Number(line.slice(0, separator));
      const path = line.slice(separator + 1);
      return Number.isFinite(modified) && selectSnapshotPaths(path, deploymentName()).length === 1
        ? [{ path, modified }]
        : [];
    })
    .sort((left, right) => right.modified - left.modified)
    .map(({ path }) => path);

  const stale = snapshots.slice(keep);
  if (stale.length === 0) return;

  log(`removing ${stale.length} snapshot(s) beyond the last ${keep}:`);
  const targets: string[] = [];
  for (const old of stale) {
    const path = old.trim();
    info(path.slice(path.lastIndexOf("/") + 1));
    // A share snapshot has no .secrets.env; rm -f on a sidecar that was never written is
    // not an error, just a no-op.
    targets.push(path, `${path}.template.env`, `${path}${SECRETS_SUFFIX}`);
  }
  const [rmHead, ...rmRest] = [...prefix, "rm", "-f", ...targets];
  const removal = await ctx.transport.exec(rmHead, rmRest, { allowFailure: true });
  if (removal.code !== 0) {
    throw new Error(`snapshot rotation could not remove stale archives (exit ${removal.code})`);
  }
}

// --- secrets ------------------------------------------------------------------

/** Reads the target's provider keys. */
export async function dumpSecrets(ctx: Context): Promise<string | undefined> {
  const path = secretsFileOnTarget(ctx);
  if (!(await ctx.transport.exists(path))) return undefined;
  return ctx.transport.readFile(path);
}

/** Installs provider keys on the target with mode 600, owner 1000:1000 — OpenClaw refuses
 *  to read a root-owned env file.
 *
 *  Staged beside the final path and published with one rename, never written in place (an
 *  in-place write sits at process umask until chmod, and an interrupted one leaves the half
 *  file as the only copy). The chown is forced but only after comparing the target owner
 *  against the current identity — owning the staging file is not the right to hand it to a
 *  different uid. */
export async function loadSecrets(ctx: Context, content: string): Promise<void> {
  if (content.trim() === "") die("refusing to install an empty secrets file");
  const path = secretsFileOnTarget(ctx);
  await publishPrivateTargetFile(ctx, path, content);
  const count = content.split("\n").filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).length;
  log(`installed ${path} (${count} variable(s))`);
}

// --- pull ---------------------------------------------------------------------

/** Not part of the CLI surface: a caller already holding the instance lock across a larger
 *  transaction (smoke's round-trip check) that must not let the gateway come back up
 *  between this pull and the restore that follows it. Ordinary callers never pass this. */
export interface PullTransactionOptions {
  leaveStopped?: boolean;
  /** Passed straight through to createBackup's own purpose (default "pull") — smoke's
   *  internal share check sets this to "internal" so afterBackup does not fire for a
   *  backup that exists only to prove pull's own privacy check still works. */
  purpose?: BackupPurpose;
}

export async function pull(ctx: Context, args: string[], transaction: PullTransactionOptions = {}): Promise<void> {
  const jsonOnly = parseDeclaredArgs(PULL_ARGUMENTS, args).json === true;
  let profile: Profile = "migrate";
  let hot = false;

  // --share, --with-secrets, --migrate (the same shorthand vocabulary `backup` accepts) and
  // --profile all set the same field, so whichever was typed LAST wins — scanned over the
  // raw argv, in order, so the true typed order decides it.
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const shorthand = PROFILE_SHORTHAND_FLAGS.get(arg);
    if (arg === "--hot") hot = true;
    else if (shorthand !== undefined) profile = shorthand;
    else if (arg === "--profile" || arg.startsWith("--profile=")) {
      const value = arg === "--profile" ? args[index + 1] : arg.slice("--profile=".length);
      if (value === undefined || !isProfile(value)) die("--profile needs one of: full, migrate, share");
      profile = value;
      if (arg === "--profile") index += 1;
    }
  }

  // Validate argv before creating the lock or touching the target.
  if (jsonOnly) {
    let result: PullPaths | undefined;
    let caught: unknown;
    await withOutputSink(() => {}, async () => {
      try {
        result = await guarded(ctx, "pull", args, () => pullLocked(ctx, profile, hot, transaction.leaveStopped === true, transaction.purpose ?? "pull"));
      } catch (error) {
        caught = error;
      }
    });
    if (caught !== undefined) {
      const message = caught instanceof Error ? caught.message : String(caught);
      emit(`${JSON.stringify({ ok: false, changed: true, profile, problems: [message] }, null, 2)}\n`);
      throw caught;
    }
    const paths = result!;
    emit(`${JSON.stringify({ ok: true, changed: true, profile, snapshot: paths.snapshot, template: paths.snapshotTemplate }, null, 2)}\n`);
    return;
  }
  await guarded(ctx, "pull", args, () => pullLocked(ctx, profile, hot, transaction.leaveStopped === true, transaction.purpose ?? "pull"));
}



/** The full set of paths one pull writes — the staging copies and their final destinations. */
interface PullPaths {
  readonly snapshotDir: string;
  readonly snapshot: string;
  readonly snapshotTemplate: string;
  readonly snapshotSecrets: string;
  readonly staging: string;
  readonly staged: string;
  readonly stagedTemplate: string;
  readonly stagedSecrets: string;
}

function computePullPaths(snapshotDir: string): PullPaths {
  const snapshot = `${snapshotDir}/${deploymentName()}-state-${stamp()}.tar.gz`;
  const staging = `${snapshotDir}/.clawforge-pull-${randomBytes(8).toString("hex")}`;
  const staged = `${staging}/${snapshot.slice(snapshot.lastIndexOf("/") + 1)}`;
  return {
    snapshotDir,
    snapshot,
    snapshotTemplate: `${snapshot}.template.env`,
    snapshotSecrets: `${snapshot}${SECRETS_SUFFIX}`,
    staging,
    staged,
    stagedTemplate: `${staged}.template.env`,
    stagedSecrets: `${staged}${SECRETS_SUFFIX}`,
  };
}

async function refuseExistingSnapshot(ctx: Context, paths: PullPaths): Promise<void> {
  if (await snapshotExists(ctx, paths.snapshot) || await snapshotExists(ctx, paths.snapshotTemplate) || await snapshotExists(ctx, paths.snapshotSecrets)) {
    die(`snapshot name already exists: ${paths.snapshot}`);
  }
}

/** What one pull tracks across its staging steps, for the catch block's cleanup decision. */
interface PullPublicationState {
  publishedSidecars: string[];
  uncertainSidecars: string[];
  hasStagedSecrets: boolean;
  publishedArchive: boolean;
  archivePublicationUncertain: boolean;
}

/** Copies the archive into staging and, for the share profile, verifies it — deleting both
 *  the staged copy and the source archive on a failed or rejected verification. */
async function stageArchiveForPull(ctx: Context, paths: PullPaths, archive: string, profile: Profile): Promise<void> {
  log(`preparing snapshot in ${paths.snapshotDir}`);
  await runMaybePrivileged(ctx, paths.staging, "cp", [archive, paths.staged]);
  await runMaybePrivileged(ctx, paths.staged, "chmod", ["600", paths.staged]);

  if (profile !== "share") return;
  let passed: boolean;
  try {
    passed = await verifySnapshot(ctx, paths.staged, "share");
  } catch (error) {
    try {
      await removeSnapshotFiles(ctx, [paths.staged, archive]);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "share snapshot verification and cleanup failed");
    }
    throw error;
  }
  if (!passed) {
    await removeSnapshotFiles(ctx, [paths.staged, archive]);
    die(`snapshot rejected and deleted, along with ${archive}`);
  }
}

/** Writes the template sidecar always, and the migrate-profile secrets sidecar when the
 *  target has any to dump — refusing first if a required value is missing target-side. */
async function stageSnapshotSidecars(ctx: Context, paths: PullPaths, profile: Profile, state: PullPublicationState): Promise<void> {
  const needed = await requirements(ctx);
  await writeSnapshotSidecar(ctx, paths.stagedTemplate, template(needed));
  if (profile !== "migrate") return;

  const secrets = await dumpSecrets(ctx);
  const requiredTarget = needed.filter((entry) => entry.location === "target-env" && entry.required);
  const values = secrets === undefined ? {} : parseEnv(secrets);
  const absent = requiredTarget.filter((entry) => values[entry.name] === undefined || values[entry.name]?.trim() === "");
  if (absent.length > 0) {
    for (const entry of absent) warn(`${secretsFileOnTarget(ctx)} has no value for ${entry.name} (${entry.usedBy})`);
    die(`cannot publish a migrate snapshot: ${absent.length} required value(s) are missing`);
  }
  if (secrets === undefined || secrets.trim() === "") {
    warn("the target has no config/.env — no keys were dumped");
    return;
  }
  await writeSnapshotSidecar(ctx, paths.stagedSecrets, secrets, "600");
  state.hasStagedSecrets = true;
}

/** The exclusion is a promise about paths, checked against the listing already in hand —
 *  one parse of output already fetched, not a second unpack. Migrate-only. */
async function refuseForbiddenMigrateContent(ctx: Context, paths: PullPaths, archive: string, profile: Profile, entries: string[]): Promise<void> {
  if (profile !== "migrate") return;
  const root = archiveRoot(entries);
  const relativeEntries = entries.map((entry) => entry.replace(/^\.\//, "").slice(root.length + 1));
  const violations = forbiddenViolations("migrate", await installedRecipePrivatePaths(), relativeEntries);
  if (violations.length > 0) {
    for (const path of violations) warn(`snapshot contains ${path}, which the migrate profile must exclude`);
    await removeSnapshotFiles(ctx, [paths.staged, archive]);
    die(`snapshot rejected and deleted, along with ${archive}`);
  }
}

/** Moves sidecars then the archive into place — the archive last, since it is the commit
 *  point: sidecars published before it are retraced from state.publishedSidecars if a later
 *  step in this sequence fails. */
async function publishSnapshotFiles(ctx: Context, paths: PullPaths, state: PullPublicationState): Promise<void> {
  try {
    await moveSnapshotFile(ctx, paths.stagedTemplate, paths.snapshotTemplate);
  } catch (error) {
    if (error instanceof SnapshotMoveUncertainError && error.sourceAbsent === true) state.uncertainSidecars.push(paths.snapshotTemplate);
    throw error;
  }
  state.publishedSidecars.push(paths.snapshotTemplate);
  if (state.hasStagedSecrets) {
    try {
      await moveSnapshotFile(ctx, paths.stagedSecrets, paths.snapshotSecrets);
    } catch (error) {
      if (error instanceof SnapshotMoveUncertainError && error.sourceAbsent === true) state.uncertainSidecars.push(paths.snapshotSecrets);
      throw error;
    }
    state.publishedSidecars.push(paths.snapshotSecrets);
  }
  try {
    await moveSnapshotFile(ctx, paths.staged, paths.snapshot);
  } catch (error) {
    // The archive is the commit point. If its move succeeded but the confirmation
    // failed, retain both sidecars: deleting them could expose an incomplete archive.
    state.archivePublicationUncertain = error instanceof SnapshotMoveUncertainError;
    throw error;
  }
  state.publishedArchive = true;
}

function reportPulledSnapshot(paths: PullPaths, profile: Profile, entries: string[], size: string, state: PullPublicationState): void {
  log(`pulled ${entries.length} entries (${size}), profile: ${profile}`);
  info(`required variables: ${paths.snapshotTemplate}`);
  if (state.hasStagedSecrets) info(`keys: ${paths.snapshotSecrets}`);
  info(paths.snapshot);
  if (profile === "full") warn("FULL archive — contains provider keys and the operator token. Never share it.");
  if (profile === "migrate") info("no provider keys inside; still private (transcripts, identity tokens)");
  if (profile === "share") info(`shareable profile: ${SHARE_ALLOWED.join(", ")}`);
}

/** Captures the archive and sidecars under one instance lock. Returns the published paths,
 *  for pull()'s own --json summary. */
async function pullLocked(ctx: Context, profile: Profile, hot: boolean, leaveStopped: boolean, purpose: BackupPurpose): Promise<PullPaths> {
  const snapshotDir = await ensureSnapshotDir(ctx);
  const archive = await createBackup(ctx, { profile, hot, leaveStopped, purpose });
  const paths = computePullPaths(snapshotDir);
  await refuseExistingSnapshot(ctx, paths);

  const state: PullPublicationState = {
    publishedSidecars: [],
    uncertainSidecars: [],
    hasStagedSecrets: false,
    publishedArchive: false,
    archivePublicationUncertain: false,
  };
  let stagingCreated = false;

  try {
    // Build the complete pair in a private directory. The final archive is moved last.
    await runMaybePrivileged(ctx, snapshotDir, "mkdir", ["-m", "700", paths.staging]);
    stagingCreated = true;
    await stageArchiveForPull(ctx, paths, archive, profile);

    // Sidecars are prepared and checked before any final path becomes visible.
    await stageSnapshotSidecars(ctx, paths, profile, state);

    const entries = await listArchive(ctx, paths.staged);
    const size = await fileSize(ctx, paths.staged);

    // Share verifies by unpacking and searching; migrate published without leaning on the
    // verifier at all.
    await refuseForbiddenMigrateContent(ctx, paths, archive, profile, entries);

    // Refuse collisions without replacing a previous complete snapshot.
    await publishSnapshotFiles(ctx, paths, state);

    reportPulledSnapshot(paths, profile, entries, size, state);
    await rotateSnapshots(ctx, snapshotDir);
    return paths;
  } catch (error) {
    // A failure before archive publication must not leave a discoverable partial snapshot.
    if (!state.publishedArchive && !state.archivePublicationUncertain) {
      await removeSnapshotFiles(ctx, [...state.publishedSidecars, ...state.uncertainSidecars]);
    }
    throw error;
  } finally {
    if (stagingCreated) await runMaybePrivileged(ctx, paths.staging, "rm", ["-rf", paths.staging]);
  }
}

// --- push ---------------------------------------------------------------------

/** The snapshot a bare `push` (no `<archive>`) would pick: newest first, resolved the same
 *  way whether the run is real or --dry-run. Read-only — no lock needed to compute this. */
export async function resolvePushArchive(ctx: Context, archiveArg: string | undefined): Promise<string> {
  const snapshotDir = ctx.settings.snapshotDir;
  let archive = archiveArg;
  if (archive !== undefined && !archive.startsWith("/")) archive = `${snapshotDir}/${archive}`;
  if (archive !== undefined) return archive;

  const found = (await listSnapshotArchives(ctx, snapshotDir))[0];
  if (found === undefined) die(`no snapshots in ${snapshotDir} — run ./clawforge pull first`);
  return found;
}

/** `--dry-run`: shares restore's read-only preview, then reports the secrets sidecar. */
async function pushDryRun(ctx: Context, archive: string, options: RestoreOptions, jsonOnly: boolean): Promise<void> {
  const prepared = await prepareRestore(ctx, archive, options, "preview");
  const plan = await buildRestorePlan(ctx, prepared, options);
  const secretsPath = `${archive}${SECRETS_SUFFIX}`;
  const hasSecrets = await ctx.transport.exists(secretsPath);

  if (jsonOnly) {
    emit(`${JSON.stringify({ ok: true, changed: false, dryRun: true, ...plan, secretsToInstall: hasSecrets ? secretsPath : null }, null, 2)}\n`);
    return;
  }
  log(`push --dry-run: would restore ${plan.dataDir} from ${plan.archiveName}, then install keys and start`);
  printRestorePlan(plan);
  info(hasSecrets ? `would install provider keys from ${secretsPath}` : `no ${SECRETS_SUFFIX} beside the archive — provider keys would not be installed`);
  info("does not cover: whether the restored config's required secrets are actually satisfied — a real push checks that before starting");
}

export async function push(ctx: Context, args: string[]): Promise<void> {
  // Dies before the lock is ever taken, same as up/restart/down: guarded() reads
  // --break-(foreign-)lock straight from argv, ahead of restoreFromSnapshot's own parse — a
  // bogus flag must be refused before a takeover, not after one already happened.
  const parsed = parseDeclaredArgs(PUSH_ARGUMENTS, args);
  const jsonOnly = parsed.json === true;

  if (parsed["dry-run"] === true) {
    const archive = await resolvePushArchive(ctx, parsed.archive as string | undefined);
    const options: RestoreOptions = { force: parsed.force === true, freshIdentity: parsed["fresh-identity"] === true, noStart: true };
    return pushDryRun(ctx, archive, options, jsonOnly);
  }

  if (jsonOnly) {
    let outcome: { archive: string; secretsInstalled: boolean; started: boolean } | undefined;
    let caught: unknown;
    await withOutputSink(() => {}, async () => {
      try {
        outcome = await guarded(ctx, "push", args, () => restoreFromSnapshot(ctx, args));
      } catch (error) {
        caught = error;
      }
    });
    if (caught !== undefined) {
      const message = caught instanceof Error ? caught.message : String(caught);
      emit(`${JSON.stringify({ ok: false, changed: true, problems: [message] }, null, 2)}\n`);
      throw caught;
    }
    emit(`${JSON.stringify({ ok: true, changed: true, ...outcome }, null, 2)}\n`);
    return;
  }

  await guarded(ctx, "push", args, () => restoreFromSnapshot(ctx, args));
}

async function restoreFromSnapshot(ctx: Context, args: string[]): Promise<{ archive: string; secretsInstalled: boolean; started: boolean }> {
  const parsed = parseDeclaredArgs(PUSH_ARGUMENTS, args);
  const force = parsed.force === true;
  const freshIdentity = parsed["fresh-identity"] === true;

  const archive = await resolvePushArchive(ctx, parsed.archive as string | undefined);
  if (parsed.archive === undefined) log(`using the newest snapshot: ${archive}`);

  const secretsPath = `${archive}${SECRETS_SUFFIX}`;
  const hasSecrets = await ctx.transport.exists(secretsPath);

  // Never started by restore: the restored config references environment variables, and
  // starting before they are in place is a crash-loop on SecretRefResolutionError with the
  // reason buried in the gateway's own log.
  await restoreArchive(ctx, archive, { force, freshIdentity, noStart: true });

  if (hasSecrets) {
    log("installing provider keys from the snapshot");
    await loadSecrets(ctx, await ctx.transport.readFile(secretsPath));
  } else {
    info(`no ${SECRETS_SUFFIX} beside the archive — provider keys were not installed`);
  }

  // Whatever the keys came from, the restored config decides what is actually required.
  try {
    await preflightSecrets(ctx);
  } catch (error) {
    if (!(error instanceof MissingSecretsError)) throw error;
    warn(error.message);
    info("the instance is restored but left stopped");
    info("supply the keys with: ./clawforge secrets --apply --store <name>, then ./clawforge up");
    return { archive, secretsInstalled: hasSecrets, started: false };
  }

  log("starting the gateway");
  await ctx.runtime.start();
  await ctx.runtime.waitForHealth();
  log("gateway is healthy");

  log("state pushed");
  return { archive, secretsInstalled: hasSecrets, started: true };
}
