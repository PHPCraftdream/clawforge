// `./clawforge pull` and `./clawforge push` — moving an instance's whole state around.
//
// Both are thin layers over backup/restore rather than a second implementation: those
// already stop the gateway before touching sqlite and move existing data aside instead of
// deleting it.

import { log, info, warn, die } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { sudoFor, runMaybePrivileged, secretsFileOnTarget } from "#src/runtime/datadir.ts";
import { isProfile, listArchive, fileSize, parseSnapshotArchive, SHARE_ALLOWED, type Profile } from "#src/service/archive.ts";
import { requirements, template } from "#src/service/secrets.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { createBackup } from "./backup.ts";
import { restoreArchive } from "./restore.ts";
import { verifySnapshot } from "./verify.ts";
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
  return `${shellQuote(`${directory}/${deploymentName()}-state-`)}*.tar.gz`;
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

  // The base archive only — sidecar files never end in plain .tar.gz. The parser below is
  // still required: a glob prefix can match a sibling deployment sharing this directory.
  const [lsHead, ...lsRest] = [
    ...prefix,
    "sh",
    "-c",
    `ls -1t ${snapshotGlob(snapshotDir)} 2>/dev/null`,
  ];
  const listing = await ctx.transport.exec(lsHead, lsRest, { allowFailure: true });
  const snapshots = selectSnapshotPaths(listing.stdout, deploymentName());

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
  await ctx.transport.exec(rmHead, rmRest, { allowFailure: true });
}

// --- secrets ------------------------------------------------------------------

/** Reads the target's provider keys. */
export async function dumpSecrets(ctx: Context): Promise<string | undefined> {
  const path = secretsFileOnTarget(ctx);
  if (!(await ctx.transport.exists(path))) return undefined;
  return ctx.transport.readFile(path);
}

/** Installs provider keys on the target with mode 600 and owner 1000:1000 — OpenClaw runs
 *  as uid 1000 and refuses to read a root-owned env file. */
export async function loadSecrets(ctx: Context, content: string): Promise<void> {
  if (content.trim() === "") die("refusing to install an empty secrets file");
  const path = secretsFileOnTarget(ctx);
  await ctx.transport.writeFile(path, content, "600");
  await runMaybePrivileged(ctx, path, "chown", ["1000:1000", path]);
  const count = content.split("\n").filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).length;
  log(`installed ${path} (${count} variable(s))`);
}

// --- pull ---------------------------------------------------------------------

export async function pull(ctx: Context, args: string[]): Promise<void> {
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

  const snapshotDir = await ensureSnapshotDir(ctx);
  const archive = await createBackup(ctx, { profile, hot });
  const snapshot = `${snapshotDir}/${deploymentName()}-state-${stamp()}.tar.gz`;

  log(`copying into ${snapshotDir}`);
  await runMaybePrivileged(ctx, snapshotDir, "cp", [archive, snapshot]);
  await runMaybePrivileged(ctx, snapshot, "chmod", ["600", snapshot]);

  // A share snapshot is meant to leave the machine, so it only exists if the check passes.
  // Both copies go: the backup this was made from holds exactly the same bytes, and leaving
  // it behind under a name that looks routine is how a rejected archive gets shared anyway.
  //
  // The check itself can throw rather than return false — a scan failure in verifySnapshot
  // is reported that way — and an exception must clean up exactly like a rejection does:
  // an unverified share copy left on disk because the verifier itself failed is worse than
  // one left because it failed cleanly.
  if (profile === "share") {
    let passed: boolean;
    try {
      passed = await verifySnapshot(ctx, snapshot, "share");
    } catch (error) {
      await runMaybePrivileged(ctx, snapshot, "rm", ["-f", snapshot]);
      await runMaybePrivileged(ctx, archive, "rm", ["-f", archive]);
      throw error;
    }
    if (!passed) {
      await runMaybePrivileged(ctx, snapshot, "rm", ["-f", snapshot]);
      await runMaybePrivileged(ctx, archive, "rm", ["-f", archive]);
      die(`snapshot rejected and deleted, along with ${archive}`);
    }
  }

  // Every snapshot ships a template of the variables the receiving side must fill in.
  // It carries names and purpose, never values, so it is safe to hand over with a share
  // archive as well.
  const manifest = template(await requirements(ctx));
  await ctx.transport.writeFile(`${snapshot}.template.env`, manifest);
  info(`required variables: ${snapshot}.template.env`);

  // In migrate mode the keys travel beside the archive, not inside it.
  if (profile === "migrate") {
    const secrets = await dumpSecrets(ctx);
    if (secrets === undefined || secrets.trim() === "") {
      warn("the target has no config/.env — no keys were dumped");
    } else {
      const secretsPath = `${snapshot}${SECRETS_SUFFIX}`;
      await ctx.transport.writeFile(secretsPath, secrets, "600");
      info(`keys: ${secretsPath}`);
    }
  }

  const entries = await listArchive(ctx, snapshot);
  log(`pulled ${entries.length} entries (${await fileSize(ctx, snapshot)}), profile: ${profile}`);
  info(snapshot);

  if (profile === "full") warn("FULL archive — contains provider keys and the operator token. Never share it.");
  if (profile === "migrate") info("no provider keys inside; still private (transcripts, identity tokens)");
  if (profile === "share") info(`shareable profile: ${SHARE_ALLOWED.join(", ")}`);

  await rotateSnapshots(ctx, snapshotDir);
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
