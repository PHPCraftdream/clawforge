// `clawforge apply-config` — applies config/desired-state.json to the instance.
//
// The declaration in the repository is the source of
// truth: editing openclaw.json on a host makes that host diverge, re-applying brings it
// back. The file is a native `openclaw config set --batch-file` payload.

import { access, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit } from "#src/core/io/output.ts";
import { desiredStateFile } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { readLiveConfigOrThrow, valueAt } from "./inspect/helpers.ts";
import type { ArgumentSpec, ParsedCall } from "#src/core/command/spec.ts";
import { commandBody, parseCall, specShape } from "#src/core/command/index.ts";
import { BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";

export const APPLY_CONFIG_ARGUMENTS = [
  { name: "dry-run", summary: "Validate the apply without writing", description: "Validate the apply without writing; refused together with --dump", kind: "flag" },
  { name: "dump", summary: "Reconstruct desired-state.json from the live instance's config", description: "Reconstruct desired-state.json from the live instance's config", kind: "flag" },
  { name: "force", summary: "Overwrite an existing desired-state.json; refused without it", description: "Overwrite an existing desired-state.json (with --dump); refused without it", kind: "flag" },
  { name: "break-lock", summary: "Take over a held instance lock", description: "Take over the instance lock held by another operation (real apply only)", kind: "flag" },
  BREAK_FOREIGN_LOCK_ARGUMENT,
  { name: "json", description: "Emit the outcome as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];



/** Name of the copy staged inside the data directory. The CLI runs in the container and
 *  only sees the mounted data directory, so the payload has to travel there.
 *
 *  A real run stages under this shared name, only while holding the instance lock. A dry
 *  run gets its own name: it deliberately takes no lock, and the shared file without one
 *  could replace the payload a concurrent real apply was about to read. */
const stagedName = "clawforge-desired.json";

export function stagedFileName(dryRun: boolean): string {
  return dryRun ? `clawforge-desired.dry-${randomBytes(4).toString("hex")}.json` : stagedName;
}

export function declarationExistsRefusal(path: string): string {
  return `${path} already exists — pass --force to overwrite it with recovered values`;
}

export function missingLiveConfigRefusal(dataDir: string): string {
  return `${dataDir}/config/openclaw.json not found on the target — nothing to recover from`;
}

export const RECOVERED_VALUES_NOTE =
  "recovered values are what the live config holds now, not the original declaration — a value OpenClaw defaults to is indistinguishable from a declared one once the declaration is gone";

/** The headline for a real (non-dry) apply. Exported so checks can pin the wording without
 *  a live instance. bootstrap.ts/set-try.ts/apply.ts pass `restartAdvice: false` since each
 *  starts or restarts the gateway itself moments later. */
/** The advice a headline carries when the caller does not restart the gateway itself. */
export const RESTART_ADVICE = "restart to pick it up";

export function appliedHeadline(restartAdvice: boolean): string {
  return restartAdvice
    // Not `clawforge up`: a healthy container already converges on `up`, reporting success
    // while leaving the old settings live.
    ? `desired state applied — ${RESTART_ADVICE}: ${commandLine("restart")}`
    : "desired state applied";
}

/** Which flags mean anything is decided from the mode here, not branch order: order alone
 *  would let --dry-run --dump --force reach the dump branch with the dry run never
 *  consulted, replacing a declaration with the recovered file's RECOVERABLE_PATHS subset.
 *  These refusals depend on the arguments alone, so they run in the prepare stage — before
 *  any contact with the target, on every host. */
function applyConfigPlan(call: ParsedCall<Record<string, unknown>>): ConfigPlan {
  const values = call.values as {
    "dry-run"?: boolean; dump?: boolean; force?: boolean;
    "break-lock"?: boolean; "break-foreign-lock"?: string; json?: boolean;
  };
  const dryRun = values["dry-run"] === true;
  const dump = values.dump === true;
  const force = values.force === true;
  const breakLock = values["break-lock"] === true;
  const breakForeignLockHost = values["break-foreign-lock"];
  const jsonOnly = values.json === true;

  if (dump && dryRun) die("--dry-run cannot be combined with --dump — a dump has no dry-run form: it writes the recovered declaration or it does nothing");
  if (dump && breakLock) die("--break-lock cannot be combined with --dump — a dump takes no instance lock, so there is no lock to break");
  if (dump && breakForeignLockHost !== undefined) die("--break-foreign-lock cannot be combined with --dump — a dump takes no instance lock, so there is no lock to break");
  if (!dump && dryRun && breakLock) die("--break-lock cannot be combined with --dry-run — a dry run takes no instance lock, so there is no lock to break");
  if (!dump && dryRun && breakForeignLockHost !== undefined) die("--break-foreign-lock cannot be combined with --dry-run — a dry run takes no instance lock, so there is no lock to break");
  if (!dump && force) die("--force only applies to --dump — a real apply overwrites the instance config regardless, and its preview is --dry-run");

  return { dryRun, dump, force, jsonOnly, takeover: { breakLock, breakForeignLockHost } };
}

interface ConfigPlan {
  readonly dryRun: boolean;
  readonly dump: boolean;
  readonly force: boolean;
  readonly jsonOnly: boolean;
  readonly takeover: { readonly breakLock: boolean; readonly breakForeignLockHost?: string };
}

export const APPLY_CONFIG = commandBody({
  effect: "change",
  arguments: APPLY_CONFIG_ARGUMENTS,
  prepare: (call) => applyConfigPlan(call),
  run: (ctx, plan) => runApplyConfig(ctx, plan, true),
});

/** The full-context entry for callers inside other groups (bootstrap, smoke, set try, the
 *  apply step): the same declaration, parsed and run on a context they already hold. */
export async function applyConfig(
  ctx: Context,
  args: string[],
  options: { restartAdvice?: boolean } = {},
): Promise<void> {
  const call = parseCall(specShape(APPLY_CONFIG), args, "apply-config");
  return runApplyConfig(ctx, applyConfigPlan(call), options.restartAdvice ?? true);
}

async function runApplyConfig(ctx: Context, plan: ConfigPlan, restartAdvice: boolean): Promise<void> {
  const { dryRun, dump, force, jsonOnly, takeover } = plan;

  await requireBootstrapped(ctx);

  if (dump) {
    // Read-only against the target and the running container — the only write is the local
    // declaration file, so there is nothing for the instance lock to serialize.
    await dumpDesiredState(ctx, force, jsonOnly);
    return;
  }

  // A dry run changes no applied config, so it needs no lock. Its isolated staging file
  // is removed after the container reads it.
  if (dryRun) return writeDesiredState(ctx, true, restartAdvice, jsonOnly);
  if (jsonOnly) {
    let caught: unknown;
    try {
      await guardedWith(ctx, "apply-config", takeover, () => writeDesiredState(ctx, false, restartAdvice, false));
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
  return guardedWith(ctx, "apply-config", takeover, () => writeDesiredState(ctx, false, restartAdvice, false));
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
  // The path the CLI sees is the container's, not the target's — asked of the bridge
  // rather than written out by hand.
  const stagedInContainer = ctx.paths.toContainer(stagedOnTarget);

  const runArgs = ["config", "set", "--batch-file", stagedInContainer];
  if (dryRun) runArgs.push("--dry-run");

  try {
    log(`staging ${fileName} on the target`);
    await ctx.transport.writeFile(stagedOnTarget, payload);
    log(dryRun ? "applying desired state (dry run)" : "applying desired state");
    await ctx.runtime.runOneOff("gateway", ["dist/index.js", ...runArgs], {
      noDeps: true,
      entrypoint: "node",
    });
  } finally {
    // In a finally: the run that leaves this file behind is the one that failed. Cleaning
    // up only on success meant a rejected dry-run payload leaked into a later archive.
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

/** The paths a dump attempts to recover: a fixed, small set this framework treats as
 *  commonly declared. The live config can't say which values were declared vs. OpenClaw's
 *  own defaults, so anything outside this list is not attempted. First two are what a
 *  fresh deployment's scaffold seeds; the third is the model default a declaration usually
 *  carries. */
const RECOVERABLE_PATHS = [
  "gateway.mode",
  "gateway.bind",
  "agents.defaults.model.primary",
];

/** The reverse of the real apply: reconstructs config/desired-state.json from a live
 *  instance's own openclaw.json, for when the operator's copy was lost while the instance
 *  kept running.
 *
 *  Explicit limit, reported not hidden: the live config shows the OUTCOME of applying the
 *  declaration, not the declaration itself, so only RECOVERABLE_PATHS is attempted; a path
 *  the live config never set is omitted rather than guessed, and recipes aren't attempted
 *  since desired-state.json has no way to declare a recipe list.
 *
 *  readLiveConfigOrThrow(), not a degrade-to-undefined read: this is about to WRITE the
 *  recovered declaration, so a failed-but-existing live config must abort rather than
 *  silently produce an empty one — same reasoning secrets --apply uses through this helper. */
async function dumpDesiredState(ctx: Context, force: boolean, jsonOnly = false): Promise<void> {
  const path = desiredStateFile();

  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists && !force) {
    die(declarationExistsRefusal(path));
  }

  const live = await readLiveConfigOrThrow(ctx);
  if (live === undefined) {
    die(missingLiveConfigRefusal(ctx.settings.dataDir));
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
  info(RECOVERED_VALUES_NOTE);
  info("recipes are not part of desired-state.json (it is a config set --batch-file payload), so there is nothing to recover them into");
}
