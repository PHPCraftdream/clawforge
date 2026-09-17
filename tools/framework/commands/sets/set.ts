// `./clawforge set` — the group dispatcher: build, validate, diff, receipts, try, forget.
//
// Split into three files, purely organisational: set-secrets-guard.ts (the value scan a
// build must pass before writing anything) and set-manifest.ts (collectManifest/
// writeArtifact/buildSet — the gatherer that turns a working tree into a manifest). This
// file keeps validateAction/forgetAction/the set() dispatcher and re-exports everything
// from the other two under its own name, so every external importer (checks, the
// interface command group) keeps importing from "./set.ts" unchanged.
//
// The group owns the set lifecycle commands; it fails explicitly on anything else
// rather than pretending it is there.

import { die, log, info, warn } from "#src/core/log.ts";
import { emit, isCaptured } from "#src/core/output.ts";
import { spawnLocal } from "#src/runtime/transport.ts";
import type { Context } from "#src/core/context.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { validateSet } from "#src/set/ownership/validate.ts";
import { removeOwnedObject } from "../management/provision-agent/index.ts";
import { withLockUnlessHeld } from "#src/runtime/instance-lock.ts";
import { newOperationId } from "#src/service/operations.ts";
import { setTry } from "./set-try.ts";
import { setDiff } from "./set-diff.ts";
import { setReceipts } from "./set-receipts.ts";
import { withUnpackedArtifact } from "#src/set/artifacts/install.ts";
import { withSetSource } from "#src/set/artifacts/source.ts";
import type { SetManifest } from "#src/set/artifacts/model.ts";
import { buildSet, collectManifest, defaultSetName } from "./set-manifest.ts";

export * from "./set-secrets-guard.ts";
export * from "./set-manifest.ts";

/** The manifest inside an artifact, without unpacking the rest of it.
 *
 *  `--force-local` on Windows for the same reason writeArtifact needs it, and it is worth
 *  saying twice: GNU tar reads the `D:` in an absolute path as a remote host and tries to
 *  connect. Writing already handled that; reading is a separate call and would have failed
 *  the same way — which is exactly how a platform quirk gets fixed on one side only. */
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

/** `./clawforge set validate` — the same manifest `build` would produce, or one read back out of an
 *  artifact, put through every check that needs no gateway.
 *
 *  Validating the working tree also checks the files are there; validating an artifact does
 *  not, and must not: an artifact carries its content as checksums, and looking for those
 *  paths on whichever machine happens to be reading it would report a perfectly good set as
 *  broken everywhere except where it was built. */
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
    : (await collectManifest(ctx, options.name ?? defaultSetName(deploymentName()))).manifest;

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

/** `./clawforge set forget --kind <kind> --name <name>` — removes an object this framework created
 *  and stops tracking it. The same operation `./clawforge apply` runs on its own for an orphaned MCP
 *  server or cron job; exposed by hand for the case `apply` never performs on its own — an
 *  orphaned agent, whose removal prunes a workspace and its memory, which stays a decision
 *  for whoever runs this rather than something a plan carries out automatically. */
async function forgetAction(ctx: Context, kindRaw: string | undefined, name: string | undefined, breakLock: boolean): Promise<void> {
  if (kindRaw === undefined || name === undefined) die("usage: ./clawforge set forget --kind <agent|mcp-server|cron-job> --name <name>");
  if (kindRaw !== "agent" && kindRaw !== "mcp-server" && kindRaw !== "cron-job") {
    die(`unknown kind "${kindRaw}" (expected agent, mcp-server, or cron-job)`);
  }
  if (!(await ctx.runtime.isRunning())) die("the gateway is not running. Start it with ./clawforge up");

  // `apply` calls this indirectly while already holding the lock; nested, the second acquire
  // would refuse the run its own caller started. Taken only when this is invoked directly.
  await withLockUnlessHeld(ctx, `set forget ${kindRaw} ${name}`, newOperationId("set-forget"), { breakLock }, async () => {
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
  if (action === undefined) die("usage: ./clawforge set <build|validate|diff|receipts|try|forget> [options]");
  if (action !== "build" && action !== "validate" && action !== "try" && action !== "forget") {
    die(`unknown action: ${action} (expected build, validate, diff, receipts, try, or forget)`);
  }

  // try has its own argument shape (--with-model, --keep) that the flags shared by the
  // other actions below do not carry — parsed there, not folded into the loop that follows.
  if (action === "try") {
    await setTry(ctx, rest);
    return;
  }

  let name: string | undefined;
  let kind: string | undefined;
  let artifact: string | undefined;
  let jsonOnly = false;
  let breakLock = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--name") {
      name = rest[index + 1] ?? die("--name needs a value");
      index += 1;
    } else if (arg === "--kind") {
      kind = rest[index + 1] ?? die("--kind needs a value");
      index += 1;
    } else if (arg === "--set") {
      artifact = rest[index + 1] ?? die("--set needs an artifact path");
      index += 1;
    } else if (arg === "--break-lock") {
      breakLock = true;
    } else if (arg === "--json") {
      jsonOnly = true;
    } else {
      die(`unknown argument: ${arg}`);
    }
  }

  if (action === "forget") {
    await forgetAction(ctx, kind, name, breakLock);
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
