// `./clawforge set` — the group dispatcher: build, validate, diff, receipts, try, forget.
//
// Split for organisation only: set-secrets-guard.ts (value scan before a build writes
// anything), set-manifest.ts (collectManifest/writeArtifact/buildSet). This file keeps
// validateAction/forgetAction/the dispatcher and re-exports the other two, so every
// external importer keeps using "./set.ts".

import { die, log, info } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { validateSet } from "#src/set/ownership/validate.ts";
import { printProblem } from "#src/commands/orchestration/inspect/gather.ts";
import type { Problem } from "#src/service/inspection.ts";
import { removeOwnedObject } from "#src/commands/management/provision-agent/index.ts";
import { withLockUnlessHeld, parseBreakForeignLockHost } from "#src/runtime/lock/instance-lock.ts";
import { newOperationId } from "#src/service/operations.ts";
import { BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";
import { setTry } from "./set-try.ts";
import { setDiff } from "./set-diff.ts";
import { setReceipts } from "./set-receipts.ts";
import { withArtifactInspected } from "#src/set/artifacts/install.ts";
import { withSetSource } from "#src/set/artifacts/source.ts";
import type { SetManifest } from "#src/set/artifacts/model.ts";
import { buildSet, collectManifest, defaultSetName } from "./set-manifest.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs, dieUnknownAction, scopeByAction, type ActionScope } from "#src/core/arguments.ts";
import { SET_DIFF_ARGUMENTS } from "./set-diff.ts";
import { SET_RECEIPTS_ARGUMENTS } from "./set-receipts.ts";
import { SET_TRY_ARGUMENTS } from "./set-try.ts";

/** The action words `set`'s dispatcher accepts, in the order its usage messages name them. */
const SET_ACTIONS = ["build", "validate", "diff", "receipts", "try", "forget"] as const;

/** Each action's own slice — the parser below takes it from this table, and the merged
 *  declaration (openclawCommands.sets.ts, derived via scopeByAction) from the same one, so
 *  completion/--help/MCP cannot offer a flag the chosen action refuses. */
export const SET_BUILD_ARGUMENTS: CommandArgument[] = [
  { name: "name", description: "Set name (default: the deployment's name)", kind: "option", valueName: "name" },
  { name: "json", description: "Emit the manifest and its id as JSON", kind: "flag" },
];

export const SET_VALIDATE_ARGUMENTS: CommandArgument[] = [
  { name: "name", description: "Set name (default: the deployment's name)", kind: "option", valueName: "name" },
  { name: "set", description: "Artifact instead of the working tree", kind: "option", valueName: "artifact" },
  { name: "json", description: "Emit the findings as JSON", kind: "flag" },
];

export const SET_FORGET_ARGUMENTS: CommandArgument[] = [
  { name: "kind", description: "agent, mcp-server, or cron-job", kind: "option", valueName: "kind", choices: ["agent", "mcp-server", "cron-job"] },
  { name: "name", description: "Object name", kind: "option", valueName: "name" },
  { name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" },
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

export const SET_ACTION_ARGUMENTS: Readonly<Record<string, readonly CommandArgument[]>> = {
  build: SET_BUILD_ARGUMENTS,
  validate: SET_VALIDATE_ARGUMENTS,
  diff: SET_DIFF_ARGUMENTS,
  receipts: SET_RECEIPTS_ARGUMENTS,
  try: SET_TRY_ARGUMENTS,
  forget: SET_FORGET_ARGUMENTS,
};

export * from "./set-secrets-guard.ts";
export * from "./set-manifest.ts";

/** `./clawforge set validate` — the same manifest `build` would produce, or one read back
 *  from an artifact, put through every check that needs no gateway.
 *
 *  Validating the working tree also checks the files are there; validating an artifact runs
 *  the same checks against the staging directory it was unpacked into, so the artifact is
 *  held to exactly what the tree it came from would have been — an incomplete recipe is
 *  refused here (by the unpack verification), not waved through as "coherent". */
async function validateAction(
  ctx: Context,
  options: { name?: string; artifact?: string; jsonOnly: boolean },
): Promise<void> {
  // Both sources answer through one report, so the artifact path cannot drift from the
  // tree path: blocking findings print as blocking (doctor's verb, not warning:), the
  // summary names each failing code once, and non-zero exit comes from the blockers alone.
  const report = async (manifest: SetManifest, source: string, problems: readonly Problem[], coherentNote = "", id?: string): Promise<void> => {
    const blocking = problems.filter((entry) => entry.severity === "blocking");
    if (options.jsonOnly || isCaptured()) {
      emit(
        `${JSON.stringify(
          {
            set: manifest.name,
            // The artifact's content id, as the JSON always carried for an artifact.
            ...(id === undefined ? {} : { id }),
            source,
            valid: blocking.length === 0,
            problems,
            nextActions: [...new Set(problems.map((entry) => entry.nextAction))],
          },
          null,
          2,
        )}\n`,
      );
    } else if (problems.length === 0) {
      log(`set ${manifest.name} is coherent${coherentNote}`);
      info(`${Object.keys(manifest.recipes).length} recipe(s), ${manifest.secrets.length} secret name(s)`);
      info("checked without a gateway; whether the pinned image supports what the recipes use is settled at install");
    } else {
      log(`set ${manifest.name}: ${blocking.length} blocking, ${problems.length - blocking.length} warning(s)`);
      for (const entry of problems) printProblem(entry);
    }
    if (blocking.length > 0) {
      throw new Error(`${blocking.length} blocking finding(s): ${[...new Set(blocking.map((entry) => entry.code))].join(", ")}`);
    }
  };

  if (options.artifact !== undefined) {
    const artifact = options.artifact;
    log(`checking ${artifact}`);
    // Read-only: the unpack gate's integrity checks still refuse a corrupt archive, but
    // blocking semantic findings come back and go through the same report as the tree —
    // blocking: lines, the JSON document, MCP problems — instead of dying as one bare
    // error string before anything was printed (R32-05).
    return withArtifactInspected(artifact, (staging, verified, problems) => withSetSource(staging, async () => {
      await report(verified.manifest, artifact, problems, " and its artifact contents match", verified.id);
    }));
  }
  // The tag is kept in requires.image rather than dying here: validate reports the gap
  // itself (SET_IMAGE_UNPINNED) together with everything else it found.
  const manifest = (await collectManifest(ctx, options.name ?? defaultSetName(deploymentName()), { tolerateUnpinnedImage: true })).manifest;
  await report(manifest, "working tree", await validateSet(manifest, { checkFiles: true }));
}

/** `./clawforge set forget --kind <kind> --name <name>` — removes an object this framework
 *  created and stops tracking it. `apply` does this on its own for an orphaned MCP server
 *  or cron job; exposed by hand for an orphaned agent, whose removal prunes a workspace and
 *  memory — a decision for whoever runs this, not something a plan does automatically. */
async function forgetAction(
  ctx: Context,
  kindRaw: string | undefined,
  name: string | undefined,
  breakLock: boolean,
  breakForeignLockHost: string | undefined,
): Promise<void> {
  if (kindRaw === undefined || name === undefined) die("usage: ./clawforge set forget --kind <agent|mcp-server|cron-job> --name <name>");
  if (kindRaw !== "agent" && kindRaw !== "mcp-server" && kindRaw !== "cron-job") {
    die(`unknown kind "${kindRaw}" (expected agent, mcp-server, or cron-job)`);
  }
  if (!(await ctx.runtime.isRunning())) die("the gateway is not running. Start it with ./clawforge up");

  // `apply` calls this indirectly while already holding the lock; nested, the second acquire
  // would refuse the run its own caller started. Taken only when this is invoked directly.
  await withLockUnlessHeld(ctx, `set forget ${kindRaw} ${name}`, newOperationId("set-forget"), { breakLock, breakForeignLockHost }, async () => {
    await removeOwnedObject(ctx, kindRaw, name);
  });
  log(`${kindRaw} "${name}" removed and no longer tracked as owned`);
}

export async function set(ctx: Context, args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === undefined) die(`usage: ./clawforge set <${SET_ACTIONS.join("|")}> [options] (see ./clawforge set --help)`);
  if (action !== "build" && action !== "validate" && action !== "diff" && action !== "receipts" && action !== "try" && action !== "forget") {
    dieUnknownAction(action, `unknown action: ${action} (expected build, validate, diff, receipts, try, or forget)`, SET_ACTIONS);
  }

  // The merged declaration as scope, for every action: a flag belonging to another action is
  // refused naming that action, not "unknown" (try/diff/receipts parse their own slices, but
  // with the same scope — R31-03).
  const scope: ActionScope = { action, siblings: scopeByAction(SET_ACTION_ARGUMENTS) };

  if (action === "diff") return setDiff(ctx, rest, scope);
  if (action === "receipts") return setReceipts(ctx, rest, scope);

  // try has its own argument shape (--with-model, --keep) that the flags shared by the
  // other actions below do not carry — parsed there, not folded into the loop that follows.
  if (action === "try") {
    await setTry(ctx, rest, {}, scope);
    return;
  }

  // Each action parses its own slice of the declaration (openclawCommands.sets.ts's table,
  // the same one completion/--help/MCP derive from).
  const parsed = parseDeclaredArgs(SET_ACTION_ARGUMENTS[action], rest, scope);

  if (action === "forget") {
    const kind = parsed.kind === "" ? die("--kind needs a value") : parsed.kind as string | undefined;
    const name = parsed.name === "" ? die("--name needs a value") : parsed.name as string | undefined;
    await forgetAction(ctx, kind, name, parsed["break-lock"] === true, parseBreakForeignLockHost(rest));
    return;
  }

  const name = parsed.name === "" ? die("--name needs a value") : parsed.name as string | undefined;
  const jsonOnly = parsed.json === true;

  if (action === "validate") {
    const artifact = parsed.set === "" ? die("--set needs an artifact path") : parsed.set as string | undefined;
    await validateAction(ctx, { name, artifact, jsonOnly });
    return;
  }

  const built = await buildSet(ctx, name ?? defaultSetName(deploymentName()));

  // Same split as lock: --json or a captured caller gets the machine-readable answer;
  // a terminal gets the inventory, because an artifact whose contents can only be
  // discovered by unpacking it is one nobody will trust.
  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify({ name: built.name, id: built.id, artifact: built.artifact, manifest: built.manifest }, null, 2)}\n`,
    );
    return;
  }

  log(`built set ${built.name} (${Object.keys(built.manifest.files).length} file(s))`);
  info(`id        ${built.id}`);
  info(`artifact  ${built.artifact}`);
  info(`requires  framework ${built.manifest.requires.framework}, image ${built.manifest.requires.image}`);

  const names = Object.keys(built.manifest.recipes);
  info(`recipes   ${names.length === 0 ? "(none)" : names.join(", ")}`);
  for (const [recipe, entry] of Object.entries(built.manifest.recipes)) {
    info(
      `${recipe.padEnd(16)} ${Object.keys(entry.files).length} file(s) served, ` +
        `${Object.keys(entry.agentFiles ?? {}).length} in the agent bundle`,
    );
    const agent = entry.agent;
    if (agent !== undefined) {
      const cron = agent.cronJobName === undefined ? "no cron job" : `cron ${agent.cronJobName} at ${agent.cronSchedule}`;
      info(`${"".padEnd(16)} agent ${agent.agentId} (mcp server ${agent.mcpServerName}), ${cron}`);
    }
    const checks = built.manifest.acceptance[recipe];
    if (checks !== undefined) info(`${"".padEnd(16)} ${checks.length} acceptance check(s)`);
  }

  info(`secrets   ${built.manifest.secrets.length === 0 ? "(none)" : built.manifest.secrets.join(", ")}`);
  info("names only — values stay on the machine that has them");
}
