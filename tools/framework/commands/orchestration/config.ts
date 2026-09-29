// `./clawforge apply-config` — applies config/desired-state.json to the instance.
//
// The declaration in the repository is the source of
// truth: editing openclaw.json on a host makes that host diverge, re-applying brings it
// back. The file is a native `openclaw config set --batch-file` payload.

import { access, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { emit } from "#src/core/io/output.ts";
import { desiredStateFile } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import { guarded, parseBreakForeignLockHost } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { readLiveConfigOrThrow, valueAt } from "./inspect/helpers.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";
import { BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";

/** Drives both apply-config's own parser and its openclawCommands declaration. */
export const APPLY_CONFIG_ARGUMENTS: CommandArgument[] = [
  { name: "dry-run", description: "Validate the apply without writing; refused together with --dump", kind: "flag" },
  { name: "dump", description: "Reconstruct desired-state.json from the live instance's config", kind: "flag" },
  { name: "force", description: "Overwrite an existing desired-state.json (with --dump); refused without it", kind: "flag" },
  { name: "break-lock", description: "Take over the instance lock held by another operation (real apply only)", kind: "flag" },
  BREAK_FOREIGN_LOCK_ARGUMENT,
  { name: "json", description: "Emit the outcome as JSON", kind: "flag" },
];



/** Name of the copy staged inside the data directory. The CLI runs in the container and
 *  only sees the mounted data directory, so the payload has to travel there.
 *
 *  A real run stages under this shared name, and only ever while holding the instance lock.
 *  A dry run gets a name of its own: it deliberately takes no lock — locking would make
 *  inspecting a busy instance fail for no reason — and writing the shared file without one
 *  meant a dry run could replace the payload a concurrent real apply was about to read. */
const stagedName = "clawforge-desired.json";

export function stagedFileName(dryRun: boolean): string {
  return dryRun ? `clawforge-desired.dry-${randomBytes(4).toString("hex")}.json` : stagedName;
}

/** The headline for a real (non-dry) apply. Exported so the checks can pin the wording
 *  without a live instance — see bootstrap.ts's/set-try.ts's/apply.ts's own calls, all of
 *  which pass `restartAdvice: false` because each starts or restarts the gateway itself a
 *  few lines later: printing "restart to pick it up" right before doing exactly that read as
 *  the command contradicting itself. */
export function appliedHeadline(restartAdvice: boolean): string {
  return restartAdvice
    // Deliberately not ./clawforge up: a healthy container is already what `up` converges
    // on, so it would report success and leave the old settings live.
    ? "desired state applied — restart to pick it up: ./clawforge restart"
    : "desired state applied";
}

export async function applyConfig(
  ctx: Context,
  args: string[],
  options: { restartAdvice?: boolean } = {},
): Promise<void> {
  const parsed = parseDeclaredArgs(APPLY_CONFIG_ARGUMENTS, args);
  const dryRun = parsed["dry-run"] === true;
  const dump = parsed.dump === true;
  const force = parsed.force === true;
  const breakLock = parsed["break-lock"] === true;
  const breakForeignLockHost = parseBreakForeignLockHost(args);
  const jsonOnly = parsed.json === true;

  // Which flags mean anything is decided from the mode here, not left to branch order:
  // branch order alone would let --dry-run --dump --force reach the dump branch with the
  // dry run never consulted — and the recovered file, which holds only RECOVERABLE_PATHS,
  // would replace a declaration that names settings no dump ever attempts. A preview must
  // not be able to destroy what it previews.
  if (dump && dryRun) die("--dry-run cannot be combined with --dump — a dump has no dry-run form: it writes the recovered declaration or it does nothing");
  if (dump && breakLock) die("--break-lock cannot be combined with --dump — a dump takes no instance lock, so there is no lock to break");
  if (dump && breakForeignLockHost !== undefined) die("--break-foreign-lock cannot be combined with --dump — a dump takes no instance lock, so there is no lock to break");
  if (!dump && dryRun && breakLock) die("--break-lock cannot be combined with --dry-run — a dry run takes no instance lock, so there is no lock to break");
  if (!dump && dryRun && breakForeignLockHost !== undefined) die("--break-foreign-lock cannot be combined with --dry-run — a dry run takes no instance lock, so there is no lock to break");
  if (!dump && force) die("--force only applies to --dump — a real apply overwrites the instance config regardless, and its preview is --dry-run");

  await requireBootstrapped(ctx);

  if (dump) {
    // Read-only against the target and the running container — the only write is the local
    // declaration file itself, and nothing here mutates the instance, so there is nothing
    // for the lock to serialize. The same reading secrets --dump already established for
    // its own store write.
    await dumpDesiredState(ctx, force, jsonOnly);
    return;
  }

  // A dry run writes nothing, so it needs no lock — and taking one would make an inspection
  // of a busy instance fail for no reason.
  if (dryRun) return writeDesiredState(ctx, true, options.restartAdvice, jsonOnly);
  if (jsonOnly) {
    let caught: unknown;
    try {
      await guarded(ctx, "apply-config", args, () => writeDesiredState(ctx, false, options.restartAdvice, false));
    } catch (error) {
      caught = error;
    }
    if (caught !== undefined) {
      const message = caught instanceof Error ? caught.message : String(caught);
      emit(`${JSON.stringify({ ok: false, changed: false, source: desiredStateFile(), problems: [message] }, null, 2)}\n`);
      throw caught;
    }
    emit(`${JSON.stringify({ ok: true, changed: true, source: desiredStateFile() }, null, 2)}\n`);
    return;
  }
  return guarded(ctx, "apply-config", args, () => writeDesiredState(ctx, false, options.restartAdvice, false));
}

async function writeDesiredState(ctx: Context, dryRun: boolean, restartAdvice = true, jsonOnly = false): Promise<void> {

  let payload: string;
  try {
    payload = await readFile(desiredStateFile(), "utf8");
  } catch {
    die(`${desiredStateFile()} not found`);
  }

  // Fail here rather than inside the container with a less helpful message.
  try {
    JSON.parse(payload);
  } catch (error) {
    die(`${desiredStateFile()} is not valid JSON: ${(error as Error).message}`);
  }

  const fileName = stagedFileName(dryRun);
  const stagedOnTarget = `${ctx.settings.dataDir}/config/${fileName}`;
  log(`staging ${fileName} on the target`);
  await ctx.transport.writeFile(stagedOnTarget, payload);

  // The path the CLI sees is the container's, not the target's — asked of the bridge
  // rather than written out by hand.
  const stagedInContainer = ctx.paths.toContainer(stagedOnTarget);

  const runArgs = ["config", "set", "--batch-file", stagedInContainer];
  if (dryRun) runArgs.push("--dry-run");

  log(dryRun ? "applying desired state (dry run)" : "applying desired state");
  try {
    await ctx.runtime.runOneOff("gateway", ["dist/index.js", ...runArgs], {
      noDeps: true,
      entrypoint: "node",
    });
  } finally {
    // Its own file, so its own clean-up — and in a finally, because the run that leaves one
    // behind is the one that failed. Cleaning up only on success meant every rejected
    // payload left an clawforge-desired.dry-<hex>.json in the config directory, which then
    // travelled into an archive and got the snapshot refused by the share allow-list: the
    // same failure the operation journal caused, arriving by a different route.
    if (dryRun) await ctx.transport.remove(stagedOnTarget);
  }

  if (jsonOnly) {
    emit(`${JSON.stringify({ ok: true, changed: !dryRun, dryRun, source: desiredStateFile() }, null, 2)}\n`);
    return;
  }
  if (dryRun) {
    log("dry run only — nothing was written");
  } else {
    log(appliedHeadline(restartAdvice));
    info(`source: ${desiredStateFile()}`);
  }
}

/** The paths a dump attempts to recover: the fixed, small set this framework itself treats
 *  as commonly declared. The live config cannot say which of its values were once declared
 *  and which are OpenClaw's own defaults — that distinction lived in the file being
 *  recovered — so anything outside this list is not attempted rather than guessed. The
 *  first two are what a fresh deployment's own scaffold seeds (integration/init.ts); the
 *  third is the model default a real declaration usually carries. */
const RECOVERABLE_PATHS = [
  "gateway.mode",
  "gateway.bind",
  "agents.defaults.model.primary",
];

/** The reverse of the real apply: reconstructs config/desired-state.json from a live
 *  instance's own openclaw.json, for when the operator's copy of the declaration was lost
 *  while the instance kept running.
 *
 *  Explicit limit, reported rather than hidden: the live config shows the OUTCOME of
 *  applying the declaration, not the declaration itself — a value OpenClaw defaults to is
 *  indistinguishable from one the operator declared once the declaration is gone. So only
 *  RECOVERABLE_PATHS is attempted, a path the live config never set is omitted rather than
 *  emitted with a guessed value, and recipes are not attempted at all: desired-state.json
 *  is a `config set --batch-file` payload of {path, value} operations, so it has no way to
 *  declare a recipe list to recover into.
 *
 *  readLiveConfigOrThrow(), not a degrade-to-undefined read: this is about to WRITE the
 *  recovered declaration, so a live config that genuinely exists but failed to read must
 *  abort the whole operation rather than silently produce an empty one — the same reasoning
 *  secrets --apply applies through this same helper. */
async function dumpDesiredState(ctx: Context, force: boolean, jsonOnly = false): Promise<void> {
  const path = desiredStateFile();

  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists && !force) {
    die(`${path} already exists — pass --force to overwrite it with recovered values`);
  }

  const live = await readLiveConfigOrThrow(ctx);
  if (live === undefined) {
    die(`${ctx.settings.dataDir}/config/openclaw.json not found on the target — nothing to recover from`);
  }

  const recovered: { path: string; value: unknown }[] = [];
  const omitted: string[] = [];
  for (const declaredPath of RECOVERABLE_PATHS) {
    const value = valueAt(live, declaredPath);
    if (value === undefined) omitted.push(declaredPath);
    else recovered.push({ path: declaredPath, value });
  }

  await writeFile(path, `${JSON.stringify(recovered, null, 2)}\n`, "utf8");

  if (jsonOnly) {
    emit(`${JSON.stringify({ ok: true, changed: true, path, recovered: recovered.map((entry) => entry.path), omitted }, null, 2)}\n`);
    return;
  }
  log(`recovered ${recovered.length} of ${RECOVERABLE_PATHS.length} known path(s) into ${path}`);
  for (const declaredPath of omitted) info(`${declaredPath} has no value in the live config — omitted, not guessed`);
  if (recovered.length === 0) warn("nothing was recoverable — the file was written as an empty declaration");
  info("recovered values are what the live config holds now, not the original declaration — a value OpenClaw defaults to is indistinguishable from a declared one once the declaration is gone");
  info("recipes are not part of desired-state.json (it is a config set --batch-file payload), so there is nothing to recover them into");
}
