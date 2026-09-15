// `./clawforge restore` — puts an archive back onto the instance.
//
// Two properties matter and are preserved:
//   - the current data is moved aside, never deleted, so a wrong restore is recoverable
//   - the archive is validated BEFORE anything is stopped or overwritten

import { createInterface } from "node:readline/promises";
import { log, info, warn, die } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { ensureDataDirs, sudoFor, runMaybePrivileged } from "#src/runtime/datadir.ts";
import {
  archiveRoot,
  inspectArchive,
  dataDirName,
  dataDirParent,
  extractArchive,
  listArchive,
  listArchiveLinks,
  parseBackupArchive,
} from "#src/service/archive.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { preflightSecrets, MissingSecretsError } from "../management/secrets.ts";

export interface RestoreOptions {
  force?: boolean;
  freshIdentity?: boolean;
  /** Leave the gateway stopped. Needed when credentials still have to be installed: the
   *  restored config references env variables, and the gateway refuses to start without
   *  them — it crash-loops on SecretRefResolutionError instead. */
  noStart?: boolean;
}

/** The newest FULL archive of this deployment, and what was skipped to find it.
 *
 *  "Newest archive in the backup directory" was the whole rule, and `pull` writes migrate and
 *  share archives into that same directory. Restoring one of those over a live instance is
 *  not a restore: a migrate archive has no config/.env, a share archive has neither identity
 *  nor devices, so the data directory is replaced by something that cannot start while the
 *  real data survives only as `<data>.replaced-<stamp>`. Named explicitly, any archive is
 *  still restorable — the operator asking for that one has said which one they mean.
 *
 *  Exported for testing: which archive `./clawforge restore` picks is the decision worth
 *  pinning, and it needs a listing rather than a data directory to exercise. */
export async function newestArchive(
  ctx: Context,
  directory: string,
): Promise<{ archive?: string; skipped: string[] }> {
  const prefix = await sudoFor(ctx, directory);
  const [head, ...rest] = [
    ...prefix,
    "sh",
    "-c",
    `ls -1t ${directory}/${deploymentName()}-*.tar.gz 2>/dev/null`,
  ];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });

  const skipped: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const path = line.trim();
    if (path === "") continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const parsed = parseBackupArchive(name, deploymentName());
    // Not this deployment's archive at all (a sibling sharing the directory, or a file
    // someone else put there): not a candidate, and not worth reporting either.
    if (parsed === undefined) continue;
    if (parsed.profile === "full") return { archive: path, skipped };
    skipped.push(`${name} (profile: ${parsed.profile})`);
  }
  return { skipped };
}

async function confirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    die("refusing to overwrite without confirmation; pass --force when running non-interactively");
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return answer.trim() === "yes";
  } finally {
    rl.close();
  }
}

export async function restoreArchive(
  ctx: Context,
  archive: string,
  options: RestoreOptions = {},
): Promise<void> {
  const { dataDir } = ctx.settings;
  const name = dataDirName(dataDir);
  const parent = dataDirParent(dataDir);

  if (!(await ctx.transport.exists(archive))) die(`archive not found: ${archive}`);

  log("verifying the archive");
  const entries = await listArchive(ctx, archive);
  if (entries.length === 0) die(`archive is empty or unreadable: ${archive}`);

  // Every entry, not just the first: one absolute path or one .. among thousands is enough
  // to write outside the data directory, and this runs before anything is stopped.
  const problems = inspectArchive(entries, await listArchiveLinks(ctx, archive));
  for (const problem of problems.filter((entry) => !entry.fatal)) warn(problem.message);
  const fatal = problems.filter((problem) => problem.fatal);
  if (fatal.length > 0) {
    for (const problem of fatal) warn(problem.message);
    die(`refusing to unpack ${archive}: it would write outside ${dataDir}`);
  }

  const root = archiveRoot(entries);
  if (root !== name) {
    die(`archive holds '${root}/' but the data directory is '${name}/' — restoring it would misplace every file`);
  }

  if (options.force !== true) {
    warn(`this will replace the contents of ${dataDir}`);
    info(`the current directory is kept as ${dataDir}.replaced-<timestamp>`);
    if (!(await confirm("Type 'yes' to continue: "))) die("aborted");
  }

  log("stopping containers");
  await ctx.runtime.stop();

  let aside: string | undefined;
  if (await ctx.transport.exists(dataDir)) {
    aside = `${dataDir}.replaced-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
    log(`moving current data aside: ${aside}`);
    await runMaybePrivileged(ctx, parent, "mv", [dataDir, aside]);
  }

  log(`unpacking into ${parent}`);
  await runMaybePrivileged(ctx, parent, "mkdir", ["-p", parent]);
  try {
    await extractArchive(ctx, archive, parent);
  } catch (error) {
    // A half-unpacked directory is worse than the old one: put the instance back the way
    // it was and let the caller see why the archive failed.
    if (aside !== undefined) {
      warn("unpacking failed — restoring the previous data");
      await runMaybePrivileged(ctx, parent, "rm", ["-rf", dataDir]);
      await runMaybePrivileged(ctx, parent, "mv", [aside, dataDir]);
    }
    throw error;
  }

  // Cloning rather than moving: two instances must not share one identity, or both will
  // claim the same device and paired-device records.
  if (options.freshIdentity === true) {
    log("dropping identity and paired devices (--fresh-identity)");
    await runMaybePrivileged(ctx, `${dataDir}/config`, "rm", [
      "-rf",
      `${dataDir}/config/identity`,
      `${dataDir}/config/devices`,
    ]);
  }

  await ensureDataDirs(ctx);

  if (options.noStart === true) {
    log(`restore complete from ${archive} (gateway not started)`);
    if (aside !== undefined) info(`previous data kept at ${aside}`);
    return;
  }

  // The restored config can reference variables nothing on this instance has yet — push()
  // works around this by always restoring with noStart and doing its own preflight after
  // installing keys, but a direct `./clawforge restore` has no such second step. Without this, an
  // archive missing its secrets starts straight into a SecretRefResolutionError crash-loop.
  try {
    await preflightSecrets(ctx);
  } catch (error) {
    if (!(error instanceof MissingSecretsError)) throw error;
    warn(error.message);
    info(`restore complete from ${archive} (gateway left stopped)`);
    info("supply the keys with: ./clawforge secrets --apply --store <name>, then ./clawforge up");
    if (aside !== undefined) info(`previous data kept at ${aside}`);
    return;
  }

  log("starting the gateway");
  await ctx.runtime.start();
  await ctx.runtime.waitForHealth();
  log(`restore complete from ${archive}`);
  if (aside !== undefined) info(`previous data kept at ${aside}`);
}

export async function restore(ctx: Context, args: string[]): Promise<void> {
  const options: RestoreOptions = {};
  let archive: string | undefined;

  for (const arg of args) {
    if (arg === "--force") options.force = true;
    else if (arg === "--fresh-identity") options.freshIdentity = true;
    else if (arg === "--no-start") options.noStart = true;
    else if (arg === "--break-lock") continue;
    else if (arg.startsWith("-")) die(`unknown argument: ${arg}`);
    else archive = arg;
  }

  if (archive === undefined) {
    const { archive: newest, skipped } = await newestArchive(ctx, ctx.settings.backupDir);
    if (newest === undefined) {
      if (skipped.length > 0) {
        die(
          `no full archives in ${ctx.settings.backupDir} — the ${skipped.length} archive(s) there are profile-limited ` +
            `(${skipped[0]}) and restoring one replaces this instance with something that cannot start. ` +
            "Run ./clawforge backup first, or pass the archive explicitly if that is really what you want.",
        );
      }
      die(`no archives found in ${ctx.settings.backupDir} — pass one explicitly`);
    }
    archive = newest;
    // Said rather than done quietly: the operator who just ran `pull --share` and then
    // `restore` is entitled to know why the newest file in that directory was not used.
    for (const entry of skipped) info(`skipping ${entry} — not a full backup`);
    log(`using the newest archive: ${archive}`);
  }

  // The most destructive command here, and until now the only mutating one taking no lock:
  // it replaces the entire data directory while anything else may be writing into it.
  // Nested under push, which already holds it, this is a no-op.
  await guarded(ctx, "restore", args, () => restoreArchive(ctx, archive!, options));
}
