// `./clawforge set` — the group dispatcher: build, validate, diff, receipts, try, forget.
//
// Split for organisation only: set-secrets-guard.ts (value scan before a build writes
// anything), set-manifest.ts (collectManifest/writeArtifact/buildSet). This file keeps
// validateAction/forgetAction/the dispatcher and re-exports the other two, so every
// external importer keeps using "./set.ts".

import { die, log, info, warn } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { spawnLocal } from "#src/runtime/transport/transport.ts";
import type { Context } from "#src/core/context.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { validateSet } from "#src/set/ownership/validate.ts";
import { removeOwnedObject } from "#src/commands/management/provision-agent/index.ts";
import { withLockUnlessHeld, parseBreakForeignLockHost } from "#src/runtime/lock/instance-lock.ts";
import { newOperationId } from "#src/service/operations.ts";
import { BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";
import { setTry } from "./set-try.ts";
import { setDiff } from "./set-diff.ts";
import { setReceipts } from "./set-receipts.ts";
import { withUnpackedArtifact } from "#src/set/artifacts/install.ts";
import { withSetSource } from "#src/set/artifacts/source.ts";
import type { SetManifest } from "#src/set/artifacts/model.ts";
import { buildSet, collectManifest, defaultSetName } from "./set-manifest.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs, dieUnknownAction } from "#src/core/arguments.ts";

/** The action words `set`'s dispatcher accepts, in the order its usage messages name them. */
const SET_ACTIONS = ["build", "validate", "diff", "receipts", "try", "forget"] as const;

/** The slice of `set`'s declaration build/validate/forget share — `try` parses its own
 *  (set-try.ts), `diff`/`receipts` parse theirs (set-diff.ts/set-receipts.ts). */
export const SET_MAIN_ARGUMENTS: CommandArgument[] = [
  { name: "name", description: "Set name (default: the deployment's name); with forget, the object's name", kind: "option", valueName: "name" },
  { name: "set", description: "Artifact instead of the working tree", kind: "option", valueName: "artifact" },
  { name: "kind", description: "With forget: agent, mcp-server, or cron-job", kind: "option", valueName: "kind", choices: ["agent", "mcp-server", "cron-job"] },
  { name: "break-lock", description: "With forget: take over the instance lock held by another operation", kind: "flag" },
  BREAK_FOREIGN_LOCK_ARGUMENT,
  { name: "json", description: "Emit the manifest and its id, or the findings, as JSON", kind: "flag" },
];

export * from "./set-secrets-guard.ts";
export * from "./set-manifest.ts";

/** The manifest inside an artifact, without unpacking the rest of it.
 *
 *  `--force-local` on Windows, same reason as writeArtifact: GNU tar reads the drive
 *  letter in an absolute path as a remote host spec. */
export async function readManifestFromArtifact(artifact: string): Promise<SetManifest> {
  const forceLocal = process.platform === "win32" ? ["--force-local"] : [];
  let result = await spawnLocal("tar", [...forceLocal, "-xzOf", artifact, "./set.json"], { allowFailure: true });
  if (result.code !== 0) {
    result = await spawnLocal("tar", ["-xzOf", artifact, "./set.json"], { allowFailure: true });
  }
  if (result.code !== 0) {
    die(`could not read a set manifest from ${artifact}: ${(result.stderr || result.stdout).trim()}`);
  }

  try {
    return JSON.parse(result.stdout) as SetManifest;
  } catch {
    die(`${artifact} contains a set.json that is not JSON — it is not an artifact this framework wrote`);
  }
}

/** `./clawforge set validate` — the same manifest `build` would produce, or one read back
 *  from an artifact, put through every check that needs no gateway.
 *
 *  Validating the working tree also checks the files are there; validating an artifact must
 *  not — its content is checksums, and looking for those paths on the reading machine would
 *  report a good set as broken everywhere except where it was built. */
async function validateAction(
  ctx: Context,
  options: { name?: string; artifact?: string; jsonOnly: boolean },
): Promise<void> {
  const fromArtifact = options.artifact !== undefined;
  if (fromArtifact) {
    return withUnpackedArtifact(options.artifact!, (staging, verified) => withSetSource(staging, async () => {
      if (options.jsonOnly || isCaptured()) {
        emit(`${JSON.stringify({set:verified.manifest.name,id:verified.id,source:options.artifact,valid:true,problems:[],nextActions:[]},null,2)}\n`);
      } else {
        log(`set ${verified.manifest.name} (${verified.id}) is coherent and its artifact contents match`);
      }
    }));
  }
  const manifest = fromArtifact
    ? await readManifestFromArtifact(options.artifact!)
    // The tag is kept in requires.image rather than dying here: validate reports the gap
    // itself (SET_IMAGE_UNPINNED) together with everything else it found.
    : (await collectManifest(ctx, options.name ?? defaultSetName(deploymentName()), { tolerateUnpinnedImage: true })).manifest;

  const problems = await validateSet(manifest, { checkFiles: !fromArtifact });
  const blocking = problems.filter((entry) => entry.severity === "blocking");

  if (options.jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          set: manifest.name,
          source: fromArtifact ? options.artifact : "working tree",
          valid: blocking.length === 0,
          problems,
          nextActions: [...new Set(problems.map((entry) => entry.nextAction))],
        },
        null,
        2,
      )}\n`,
    );
  } else if (problems.length === 0) {
    log(`set ${manifest.name} is coherent`);
    info(`${Object.keys(manifest.recipes).length} recipe(s), ${manifest.secrets.length} secret name(s)`);
    info("checked without a gateway; whether the pinned image supports what the recipes use is settled at install");
  } else {
    log(`set ${manifest.name}: ${blocking.length} blocking, ${problems.length - blocking.length} warning(s)`);
    for (const entry of problems) {
      warn(`${entry.code}  ${entry.detail}`);
      info(`  → ${entry.nextAction}`);
    }
  }

  if (blocking.length > 0) {
    throw new Error(`${blocking.length} blocking finding(s): ${blocking.map((entry) => entry.code).join(", ")}`);
  }
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
  if (action === "diff") return setDiff(ctx, rest);
  if (action === "receipts") return setReceipts(ctx, rest);

  // No default action, and no pretending: with one subcommand, an unknown one fails naming
  // what exists rather than hinting at a surface that is not there yet.
  if (action === undefined) die(`usage: ./clawforge set <${SET_ACTIONS.join("|")}> [options] (see ./clawforge set --help)`);
  if (action !== "build" && action !== "validate" && action !== "try" && action !== "forget") {
    dieUnknownAction(action, `unknown action: ${action} (expected build, validate, diff, receipts, try, or forget)`, SET_ACTIONS);
  }

  // try has its own argument shape (--with-model, --keep) that the flags shared by the
  // other actions below do not carry — parsed there, not folded into the loop that follows.
  if (action === "try") {
    await setTry(ctx, rest);
    return;
  }

  const parsed = parseDeclaredArgs(SET_MAIN_ARGUMENTS, rest);
  const name = parsed.name === "" ? die("--name needs a value") : parsed.name as string | undefined;
  const kind = parsed.kind === "" ? die("--kind needs a value") : parsed.kind as string | undefined;
  const artifact = parsed.set === "" ? die("--set needs an artifact path") : parsed.set as string | undefined;
  const breakLock = parsed["break-lock"] === true;
  const breakForeignLockHost = parseBreakForeignLockHost(rest);
  const jsonOnly = parsed.json === true;

  if (action === "forget") {
    await forgetAction(ctx, kind, name, breakLock, breakForeignLockHost);
    return;
  }

  if (action === "validate") {
    await validateAction(ctx, { name, artifact, jsonOnly });
    return;
  }
  if (artifact !== undefined) die("--set validates an existing artifact; it has no meaning for build");

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
