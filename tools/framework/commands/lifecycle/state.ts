// `./clawforge pull` and `./clawforge push` — moving an instance's whole state around.
//
// Both are thin layers over backup/restore rather than a second implementation: those
// already stop the gateway before touching sqlite and move existing data aside instead of
// deleting it.

import { log, info, warn, die } from "#src/core/log.ts";
import { randomBytes } from "node:crypto";
import type { Context } from "#src/core/context.ts";
import { parseEnv } from "#src/core/env.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { sudoFor, runMaybePrivileged, needsOwnerEscalation, secretsFileOnTarget } from "#src/runtime/datadir.ts";
import { archiveRoot, isProfile, listArchive, fileSize, parseSnapshotArchive, snapshotDeploymentNames, SHARE_ALLOWED, type Profile } from "#src/service/archive.ts";
import { installedRecipePrivatePaths } from "#src/service/recipe.ts";
import { requirements, template } from "#src/service/secrets.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { createBackup } from "./backup.ts";
import { restoreArchive } from "./restore.ts";
import { forbiddenViolations, verifySnapshot } from "./verify.ts";
import { preflightSecrets, MissingSecretsError } from "../management/secrets.ts";

const SECRETS_SUFFIX = ".secrets.env";

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

/** Quotes a path prefix while leaving the final glob active. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function snapshotGlob(directory: string): string {
  return snapshotDeploymentNames(deploymentName())
    .map((name) => `${shellQuote(`${directory}/${name}-state-`)}*.tar.gz`)
    .join(" ");
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
 *  (.template.env, and .secrets.env when a migrate pull produced one) — the same idea as
 *  backup.ts's rotate(), which snapshots never had: on a deployment pulled regularly
 *  (smoke, a cron), the snapshot directory grows without bound while backups do not.
 *
 *  Escalation is checked once for the directory, not once per file: every file in it
 *  shares the same ownership, and a large first-time backlog (months of unrotated
 *  snapshots) turning into one round trip per file per candidate would take minutes
 *  through a remote transport instead of two round trips total.
 *
 *  Exported so tools/checks/state.check.ts can drive it directly, rather than through the
 *  whole of pull() just to reach the one call site. */
export async function rotateSnapshots(ctx: Context, snapshotDir: string): Promise<void> {
  const keep = Number.parseInt(ctx.settings.env.OC_SNAPSHOT_KEEP ?? "10", 10);
  if (!Number.isFinite(keep) || keep <= 0) return;

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

/** Creates a new file whose contents are private from the first byte, with an exclusive
 *  umask-077 write for transports without the capability (the shape verify.ts uses for
 *  its scan files). */
async function writePrivate(ctx: Context, path: string, content: string): Promise<void> {
  if (typeof ctx.transport.writePrivateFile === "function") {
    await ctx.transport.writePrivateFile(path, content);
    return;
  }
  const quoted = `'${path.replaceAll("'", `'\\''`)}'`;
  await ctx.transport.exec("sh", ["-c", `umask 077; set -C; cat > ${quoted}`], { input: content });
}

/** Installs provider keys on the target with mode 600 and owner 1000:1000 — OpenClaw runs
 *  as uid 1000 and refuses to read a root-owned env file.
 *
 *  The keys are staged beside their final path and published with one rename, never
 *  written in place: an in-place write exists at the process umask until the chmod lands,
 *  and one interrupted mid-flight leaves the half file as the only copy of the keys.
 *  Beside the final path means the same filesystem, so the rename is atomic and replaces
 *  the previous file wholesale — a failed update cannot touch it. The chown is forced
 *  because owning the staging file is not the right to hand it to a different uid, so the
 *  target owner is compared against the current identity first, exactly like datadir.ts's
 *  own chowns. */
export async function loadSecrets(ctx: Context, content: string): Promise<void> {
  if (content.trim() === "") die("refusing to install an empty secrets file");
  const path = secretsFileOnTarget(ctx);
  // A random suffix, not a fixed staging name: set -C refuses to create over a staging
  // file a previous crash left behind, which would break every later install until
  // someone removed it by hand.
  const staging = `${path}.clawforge-${randomBytes(8).toString("hex")}`;
  try {
    await writePrivate(ctx, staging, content);
    // Owner before publication: the gateway user must be able to read the keys the moment
    // they appear at the final path, not after a follow-up chown gets around to it.
    await runMaybePrivileged(ctx, staging, "chown", ["1000:1000", staging], { force: await needsOwnerEscalation(ctx, "1000:1000") });
    // Probed against the staging path so sudoFor asks about the directory the rename
    // actually needs, not the file being replaced.
    await runMaybePrivileged(ctx, staging, "mv", ["-fT", "--", staging, path]);
  } catch (error) {
    // Best effort: a staging file that cannot be removed is a cosmetic leak next to the
    // intact keys the rename never touched.
    await runMaybePrivileged(ctx, staging, "rm", ["-f", "--", staging]).catch(() => {});
    throw error;
  }
  const count = content.split("\n").filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).length;
  log(`installed ${path} (${count} variable(s))`);
}

// --- pull ---------------------------------------------------------------------

/** Not part of the CLI surface: a caller already holding the instance lock across a larger
 *  transaction (smoke's round-trip check) that must not let the gateway come back up
 *  between this pull and the restore that follows it. Ordinary callers never pass this. */
export interface PullTransactionOptions {
  leaveStopped?: boolean;
}

export async function pull(ctx: Context, args: string[], transaction: PullTransactionOptions = {}): Promise<void> {
  let profile: Profile = "migrate";
  let hot = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--hot") hot = true;
    else if (arg === "--with-secrets") profile = "full";
    else if (arg === "--share") profile = "share";
    else if (arg === "--profile") {
      const value = args[index + 1];
      if (value === undefined || !isProfile(value)) die("--profile needs one of: full, migrate, share");
      profile = value;
      index += 1;
    } else die(`unknown argument: ${arg}`);
  }

  // Validate argv before creating the lock or touching the target.
  return guarded(ctx, "pull", args, () => pullLocked(ctx, profile, hot, transaction.leaveStopped === true));
}

/** Captures the archive and sidecars under one instance lock. */
async function pullLocked(ctx: Context, profile: Profile, hot: boolean, leaveStopped: boolean): Promise<void> {
  const snapshotDir = await ensureSnapshotDir(ctx);
  const archive = await createBackup(ctx, { profile, hot, leaveStopped });
  const snapshot = `${snapshotDir}/${deploymentName()}-state-${stamp()}.tar.gz`;
  const snapshotTemplate = `${snapshot}.template.env`;
  const snapshotSecrets = `${snapshot}${SECRETS_SUFFIX}`;
  const staging = `${snapshotDir}/.clawforge-pull-${randomBytes(8).toString("hex")}`;
  const staged = `${staging}/${snapshot.slice(snapshot.lastIndexOf("/") + 1)}`;
  const stagedTemplate = `${staged}.template.env`;
  const stagedSecrets = `${staged}${SECRETS_SUFFIX}`;
  const publishedSidecars: string[] = [];
  const uncertainSidecars: string[] = [];
  let hasStagedSecrets = false;
  let publishedArchive = false;
  let archivePublicationUncertain = false;
  let stagingCreated = false;

  if (await snapshotExists(ctx, snapshot) || await snapshotExists(ctx, snapshotTemplate) || await snapshotExists(ctx, snapshotSecrets)) {
    die(`snapshot name already exists: ${snapshot}`);
  }

  try {
    // Build the complete pair in a private directory. The final archive is moved last.
    await runMaybePrivileged(ctx, snapshotDir, "mkdir", ["-m", "700", staging]);
    stagingCreated = true;
    log(`preparing snapshot in ${snapshotDir}`);
    await runMaybePrivileged(ctx, staging, "cp", [archive, staged]);
    await runMaybePrivileged(ctx, staged, "chmod", ["600", staged]);

    if (profile === "share") {
      let passed: boolean;
      try {
        passed = await verifySnapshot(ctx, staged, "share");
      } catch (error) {
        try {
          await removeSnapshotFiles(ctx, [staged, archive]);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "share snapshot verification and cleanup failed");
        }
        throw error;
      }
      if (!passed) {
        await removeSnapshotFiles(ctx, [staged, archive]);
        die(`snapshot rejected and deleted, along with ${archive}`);
      }
    }

    // Sidecars are prepared and checked before any final path becomes visible.
    const needed = await requirements(ctx);
    const manifest = template(needed);
    await writeSnapshotSidecar(ctx, stagedTemplate, manifest);
    if (profile === "migrate") {
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
      } else {
        await writeSnapshotSidecar(ctx, stagedSecrets, secrets, "600");
        hasStagedSecrets = true;
      }
    }

    const entries = await listArchive(ctx, staged);
    const size = await fileSize(ctx, staged);

    // Share verifies by unpacking and searching; migrate published without leaning on the
    // verifier at all. The exclusion is a promise about paths, and the listing is already in
    // hand, so before anything is published it is checked against the same rules verify
    // enforces — one parse of output already fetched, not a second unpack.
    if (profile === "migrate") {
      const root = archiveRoot(entries);
      const relative = entries.map((entry) => entry.replace(/^\.\//, "").slice(root.length + 1));
      const violations = forbiddenViolations("migrate", await installedRecipePrivatePaths(), relative);
      if (violations.length > 0) {
        for (const path of violations) warn(`snapshot contains ${path}, which the migrate profile must exclude`);
        await removeSnapshotFiles(ctx, [staged, archive]);
        die(`snapshot rejected and deleted, along with ${archive}`);
      }
    }

    // Refuse collisions without replacing a previous complete snapshot.
    try {
      await moveSnapshotFile(ctx, stagedTemplate, snapshotTemplate);
    } catch (error) {
      if (error instanceof SnapshotMoveUncertainError && error.sourceAbsent === true) uncertainSidecars.push(snapshotTemplate);
      throw error;
    }
    publishedSidecars.push(snapshotTemplate);
    if (hasStagedSecrets) {
      try {
        await moveSnapshotFile(ctx, stagedSecrets, snapshotSecrets);
      } catch (error) {
        if (error instanceof SnapshotMoveUncertainError && error.sourceAbsent === true) uncertainSidecars.push(snapshotSecrets);
        throw error;
      }
      publishedSidecars.push(snapshotSecrets);
    }
    try {
      await moveSnapshotFile(ctx, staged, snapshot);
    } catch (error) {
      // The archive is the commit point. If its move succeeded but the confirmation
      // failed, retain both sidecars: deleting them could expose an incomplete archive.
      archivePublicationUncertain = error instanceof SnapshotMoveUncertainError;
      throw error;
    }
    publishedArchive = true;

    log(`pulled ${entries.length} entries (${size}), profile: ${profile}`);
    info(`required variables: ${snapshotTemplate}`);
    if (hasStagedSecrets) info(`keys: ${snapshotSecrets}`);
    info(snapshot);
    if (profile === "full") warn("FULL archive — contains provider keys and the operator token. Never share it.");
    if (profile === "migrate") info("no provider keys inside; still private (transcripts, identity tokens)");
    if (profile === "share") info(`shareable profile: ${SHARE_ALLOWED.join(", ")}`);
    await rotateSnapshots(ctx, snapshotDir);
  } catch (error) {
    // A failure before archive publication must not leave a discoverable partial snapshot.
    if (!publishedArchive && !archivePublicationUncertain) {
      await removeSnapshotFiles(ctx, [...publishedSidecars, ...uncertainSidecars]);
    }
    throw error;
  } finally {
    if (stagingCreated) await runMaybePrivileged(ctx, staging, "rm", ["-rf", staging]);
  }
}

// --- push ---------------------------------------------------------------------

export async function push(ctx: Context, args: string[]): Promise<void> {
  return guarded(ctx, "push", args, () => restoreFromSnapshot(ctx, args));
}

async function restoreFromSnapshot(ctx: Context, args: string[]): Promise<void> {
  let archive: string | undefined;
  let force = false;
  let freshIdentity = false;

  for (const arg of args) {
    if (arg === "--force") force = true;
    else if (arg === "--fresh-identity") freshIdentity = true;
    else if (arg === "--break-lock") continue;
    else if (arg.startsWith("-")) die(`unknown argument: ${arg}`);
    else archive = arg;
  }

  const snapshotDir = ctx.settings.snapshotDir;

  if (archive !== undefined && !archive.startsWith("/")) {
    archive = `${snapshotDir}/${archive}`;
  }

  if (archive === undefined) {
    const prefix = await sudoFor(ctx, snapshotDir);
    const [head, ...rest] = [...prefix, "sh", "-c", `ls -1t ${snapshotGlob(snapshotDir)} 2>/dev/null`];
    const listing = await ctx.transport.exec(head, rest, { allowFailure: true });
    archive = selectSnapshotPaths(listing.stdout, deploymentName())[0];
    if (archive === undefined) die(`no snapshots in ${snapshotDir} — run ./clawforge pull first`);
    log(`using the newest snapshot: ${archive}`);
  }

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
    return;
  }

  log("starting the gateway");
  await ctx.runtime.start();
  await ctx.runtime.waitForHealth();
  log("gateway is healthy");

  log("state pushed");
}
