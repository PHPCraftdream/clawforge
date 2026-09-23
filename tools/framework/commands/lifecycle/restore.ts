// `./clawforge restore` — puts an archive back onto the instance.
//
// Two properties matter and are preserved:
//   - the current data is moved aside, never deleted, so a wrong restore is recoverable
//   - the archive is validated BEFORE anything is stopped or overwritten

import { createInterface } from "node:readline/promises";
import { log, info, warn, die } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { DATA_SUBDIRS, OWNER, ensureDataDirs, sudoFor, runMaybePrivileged, needsOwnerEscalation } from "#src/runtime/datadir.ts";
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
import { SshTransport } from "#src/runtime/transport.ts";
import { preflightSecrets, MissingSecretsError } from "../management/secrets.ts";
import {
  importRestoredPrivatePathsHistory,
  mutatePrivatePathsLedgerState,
  persistedPrivatePaths,
  privatePathsHistoryFile,
  privatePathsLedgerFile,
  privatePathsLedgerState,
  removePrivatePathsLedger,
  type PrivatePathsLedgerState,
} from "#src/security/private-paths-ledger.ts";
import { runningRecipeStacks } from "../management/recipe/index.ts";

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
    `ls -1t ${SshTransport.quote(`${directory}/${deploymentName()}-`)}*.tar.gz 2>/dev/null`,
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

/** Checks the restored tree physically, before anything acts through it.
 *
 *  inspectArchive reasons about what the archive records; this reasons about the
 *  filesystem tar actually created. The root must be an ordinary directory — an archive
 *  can ship its root as a link, and everything below would then be reached through it.
 *  Each mandatory layout path that exists must resolve inside the root: a link to
 *  elsewhere would carry the fresh-identity deletion and the standard-directory
 *  preparation (mkdir, chown, chmod 700 auth-secrets) out of the promised data
 *  directory. A path that is not there at all is fine — ensureDataDirs creates it
 *  inside the verified root — and a link resolving within the tree stays tolerated. A
 *  link whose target does not resolve is refused too: readlink cannot canonicalize it,
 *  and mkdir -p would follow it and create its target outside.
 *
 *  The probes run under the same privilege decision as the extraction and the actions they
 *  guard: extraction unpacks through sudoFor() and keeps the archive's numeric ownership,
 *  and ensureDataDirs/fresh-identity write with whatever escalation those need — a check
 *  that looks with fewer rights than the writes is how a write lands through a path the
 *  check never saw. "Absent" is only trusted when both probes answer a clean 1 AND those
 *  same privileges can search the path's parent: `test` reports an untraversable parent
 *  exactly like a missing path, so an answer that cannot be known is refused rather than
 *  skipped as absent (audit 2026-09-22 round 3, P1-04). */
async function verifyRestoredLayout(ctx: Context, dataDir: string): Promise<void> {
  const prefix = await sudoFor(ctx, dataDir);
  if (await isLink(ctx, prefix, dataDir)) {
    die(`refusing the restored root ${dataDir}: it is a symlink, not an ordinary directory`);
  }
  const root = await physicalPath(ctx, prefix, dataDir);
  for (const sub of DATA_SUBDIRS) {
    const path = `${dataDir}/${sub}`;
    if (!(await presenceOf(ctx, prefix, path))) continue;
    const physical = await physicalPath(ctx, prefix, path);
    // Exact-boundary comparison, not a bare string prefix — a sibling like `…/dataEVIL` must be refused too.
    if (physical !== root && !physical.startsWith(`${root}/`)) {
      die(`refusing ${path}: it resolves to ${physical}, outside the restored tree ${root}`);
    }
  }
}

async function isLink(ctx: Context, prefix: string[], path: string): Promise<boolean> {
  const [head, ...rest] = [...prefix, "test", "-L", path];
  return (await ctx.transport.exec(head, rest, { allowFailure: true })).code === 0;
}

/** Present as anything — a dangling symlink counts, because creating "through" it lands
 *  in its target. A clean 1 from both probes is only believed when the same privileges
 *  can search the path's parent: `test` answers an untraversable directory exactly like
 *  a missing one, and skipping a mandatory path the check could not actually see is what
 *  lets a privileged act travel it (audit 2026-09-22 round 3, P1-04). */
async function presenceOf(ctx: Context, prefix: string[], path: string): Promise<boolean> {
  for (const flag of ["-e", "-L"] as const) {
    const [head, ...rest] = [...prefix, "test", flag, path];
    const result = await ctx.transport.exec(head, rest, { allowFailure: true });
    if (result.code === 0) return true;
    if (result.code !== 1) {
      die(`cannot determine whether ${path} exists on the target: ${result.stderr.trim() || `test ${flag} exited ${result.code}`}`);
    }
  }
  // The same idiom sudoFor() computes a probe path with: the deepest existing ancestor,
  // so the answer is about the directory actually gating this one.
  const parent = path.slice(0, Math.max(path.lastIndexOf("/"), 1));
  const [head, ...rest] = [...prefix, "test", "-x", parent];
  const searchable = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (searchable.code !== 0) {
    die(
      `cannot verify ${path}: it answers as absent, but ${parent} cannot be searched with this run's privileges — ` +
        "restore would act through a path its checks could not see",
    );
  }
  return false;
}

async function physicalPath(ctx: Context, prefix: string[], path: string): Promise<string> {
  const [head, ...rest] = [...prefix, "readlink", "-f", path];
  const resolved = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (resolved.code !== 0) {
    die(`cannot resolve ${path} on the target: ${resolved.stderr.trim() || "the path does not resolve"}`);
  }
  return resolved.stdout.trim();
}

/** Refuses a data root whose existing ancestry is redirected before restore moves or
 * creates anything. Re-run this at each destructive boundary to catch changed parents. */
async function verifyDataDirAncestry(ctx: Context, dataDir: string): Promise<void> {
  let probe = dataDir;
  while (!(await ctx.transport.exists(probe))) {
    const parent = probe.slice(0, Math.max(probe.lastIndexOf("/"), 1));
    if (parent === probe) break;
    probe = parent;
  }
  const prefix = await sudoFor(ctx, probe);
  const resolved = await physicalPath(ctx, prefix, probe);
  if (resolved !== probe) {
    die(`refusing restore: ${probe} resolves to ${resolved}; data directory ancestry must not pass through a symlink`);
  }
}

/** Brings the archive's privacy history back to the deployment-side ledger, before anything
 *  acts on the restored data (audit 2026-09-22 round 3, P1-02).
 *
 *  The ledger describes the target but lives in the operator-side deployment directory, so
 *  restoring through a different one — a new folder, a lost one — used to arrive with the
 *  data and none of its history, and the next migrate/share built its exclusions from an
 *  empty record. A full backup therefore carries a copy inside the data root; when this
 *  archive has one, it is imported (union) here, inside the try whose catch puts the
 *  previous data back: a copy that exists but cannot be read or parsed fails the restore,
 *  never reading as "nothing to protect". An archive without one predates history
 *  travelling with backups; what that means is said, and it differs by what this
 *  deployment still records of its own. */
async function importRestoredHistory(ctx: Context, name: string, entries: readonly string[], dataDir: string): Promise<void> {
  const historyEntry = `${name}/config/clawforge-private-paths.json`;
  if (entries.some((entry) => entry.replace(/^\.\//, "") === historyEntry)) {
    const added = await importRestoredPrivatePathsHistory(ctx, privatePathsHistoryFile(dataDir));
    if (added.length > 0) info(`privacy history restored with the data: ${added.length} path(s) stay protected`);
    return;
  }
  if ((await persistedPrivatePaths()).length > 0) {
    info(
      "this archive carries no privacy history (a backup made before clawforge copied it into backups) — " +
        "this deployment's own ledger still protects its recorded paths",
    );
    return;
  }
  warn(
    "this archive carries no privacy history and this deployment has none recorded: private files that recipe " +
      "hooks wrote before clawforge kept records cannot be classified from what is here — declare the paths " +
      "(recipes' privatePaths) or record them with a private write before trusting migrate/share with this data",
  );
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

  await verifyDataDirAncestry(ctx, dataDir);

  if (options.force !== true) {
    warn(`this will replace the contents of ${dataDir}`);
    info(`the current directory is kept as ${dataDir}.replaced-<timestamp>`);
    if (!(await confirm("Type 'yes' to continue: "))) die("aborted");
  }

  const wasRunning = await ctx.runtime.isRunning();
  log("stopping containers");
  let aside: string | undefined;
  let oldDataMoved = false;
  let restoreMayHaveWritten = false;
  let historyImported = false;
  let ledgerBefore: PrivatePathsLedgerState | undefined;
  try {
    await ctx.runtime.stop();
    await verifyDataDirAncestry(ctx, dataDir);
    if (await ctx.transport.exists(dataDir)) {
      aside = `${dataDir}.replaced-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
      log(`moving current data aside: ${aside}`);
      await verifyDataDirAncestry(ctx, dataDir);
      await runMaybePrivileged(ctx, parent, "mv", [dataDir, aside]);
      oldDataMoved = true;
    }

    log(`unpacking into ${parent}`);
    await verifyDataDirAncestry(ctx, dataDir);
    await runMaybePrivileged(ctx, parent, "mkdir", ["-p", parent]);
    await verifyDataDirAncestry(ctx, dataDir);
    restoreMayHaveWritten = true;
    await extractArchive(ctx, archive, parent);

    // Between unpack and the first action through the restored tree. inspectArchive
    // could only reason about what the archive records; what tar actually created is
    // checked here, physically, because both steps below follow paths without looking:
    // --fresh-identity deletes through config/, and ensureDataDirs creates the standard
    // subdirectories and chmods auth-secrets wherever those paths resolve to.
    log("verifying the restored layout");
    await verifyRestoredLayout(ctx, dataDir);

    // The ledger state this restore's history import may change, taken right before
    // that import runs: fresh-identity and ensureDataDirs run AFTER the import, so a
    // failure there must undo the import along with the data tree, or the old instance
    // keeps policy boundaries from an archive that was never actually accepted (audit
    // 2026-09-23 round 4, P2-02). Inside the try, so a snapshot read that itself fails
    // (an unreadable existing ledger) is handled by the same data-tree rollback below —
    // historyImported stays false, so no ledger write is attempted on the way out.
    ledgerBefore = await privatePathsLedgerState();

    // Before the fresh-identity deletion and ensureDataDirs' writes, and inside the try
    // whose catch puts the previous data back: the import is part of "the archive is good".
    await importRestoredHistory(ctx, name, entries, dataDir);
    historyImported = true;

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

    // trustExisting: this tree was just extracted from an archive verifyRestoredLayout has
    // already proven contained, not found lying around — it must not read as an unrelated
    // pre-existing directory this run merely stumbled onto.
    await ensureDataDirs(ctx, { trustExisting: true });
  } catch (error) {
    // A half-unpacked or rejected directory is worse than nothing: this operation's own
    // staging root must never survive its own failure, whether or not there was previous
    // data to put back in its place — a clean target left with a failed extraction's
    // leftovers reads as existing state to the next bootstrap/restore (audit 2026-09-23
    // round 4, P2-02).
    warn(oldDataMoved ? "restore failed — restoring the previous data" : "restore failed — removing the unpacked tree");
    const compensationErrors: unknown[] = [];
    if (restoreMayHaveWritten) {
      try {
        await verifyDataDirAncestry(ctx, dataDir);
        await runMaybePrivileged(ctx, dataDir, "rm", ["-rf", dataDir], { force: await needsOwnerEscalation(ctx, OWNER) });
      } catch (rollbackError) { compensationErrors.push(rollbackError); }
    }
    if (oldDataMoved && aside !== undefined) {
      try {
        await verifyDataDirAncestry(ctx, dataDir);
        await runMaybePrivileged(ctx, parent, "mv", [aside, dataDir]);
      } catch (rollbackError) { compensationErrors.push(rollbackError); }
    }
    // The import already landed in the operator-side ledger before this failure: put it back
    // to exactly what it held before this restore touched it, not just "whatever the merge
    // added" — a concurrent change during the same held lock is not expected, and this is the
    // rollback of THIS restore's own effect, nothing else's. The rollback restores that state
    // FAITHFULLY, absence included: writing an empty ledger when none existed before used to
    // fabricate a forget-shaped file — a witness to a forget this operator never asked for
    // (audit 2026-09-23 XXA round 6, P1-04).
    if (historyImported) {
      warn("restore failed after privacy history was imported — reverting the ledger");
      const snapshot = ledgerBefore;
      // historyImported is only ever true after the snapshot succeeded, so the undefined case
      // is unreachable today; it stays a plain no-op rather than a non-null assertion.
      if (snapshot !== undefined) {
        if (snapshot.existed) {
          try {
            await mutatePrivatePathsLedgerState(privatePathsLedgerFile(), () => ({
              next: { paths: snapshot.paths, forgotten: snapshot.forgotten },
              value: undefined,
            }));
          } catch (rollbackError) { compensationErrors.push(rollbackError); }
        } else {
          try { await removePrivatePathsLedger(privatePathsLedgerFile()); }
          catch (rollbackError) { compensationErrors.push(rollbackError); }
        }
      }
    }
    if (wasRunning) {
      try {
        if (!(await ctx.runtime.isRunning())) {
          await ctx.runtime.start();
          await ctx.runtime.waitForHealth();
        }
      } catch (rollbackError) { compensationErrors.push(rollbackError); }
    }
    if (compensationErrors.length > 0) {
      for (const compensationError of compensationErrors) warn(`restore compensation failed: ${(compensationError as Error).message}`);
      throw new AggregateError([error, ...compensationErrors], "restore failed and one or more compensations also failed");
    }
    throw error;
  }

  // The gateway was stopped; recipe stacks are not and cannot be — they are separate
  // Compose projects, and re-resolving another project's bind mounts is not this
  // command's to do. A sidecar mounting a file or directory under the data directory
  // therefore still holds the previous data: the moved-aside tree when one was moved,
  // the replaced file's old content otherwise. Named here so the gap is the operator's
  // decision, not a silent one (audit 2026-09-22 round 2, P2-04).
  const sidecars = await runningRecipeStacks(ctx);
  if (sidecars.length > 0) {
    warn(
      `recipe stack(s) still running, not recreated after this restore: ${sidecars.map((recipe) => recipe.name).join(", ")} — ` +
        "their containers may still bind-mount the previous data rather than the restored tree" +
        (aside !== undefined ? ` (kept at ${aside})` : ""),
    );
    for (const recipe of sidecars) {
      info(`to point ${recipe.name} at the restored tree: ./clawforge recipe remove ${recipe.name} && ./clawforge recipe install ${recipe.name}`);
    }
  }

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
