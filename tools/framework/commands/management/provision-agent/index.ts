// `./clawforge provision-agent <recipe>` — wires a recipe's MCP server to a dedicated OpenClaw
// agent: isolated agent, own workspace prompt files, the recipe's stdio MCP server, and
// (optionally) a cron job that sends the agent a recurring message.
//
// Recipe opts in via an `agent/` subdirectory:
//   recipes/<name>/agent/config.json        agentId, mcpServerName, optional cron fields
//   recipes/<name>/agent/*.md               copied verbatim as workspace files
//   recipes/<name>/agent/cron-message.txt   optional — enables the cron job if present
// Everything under recipes/<name>/ except agent/ is mirrored into the agent's data mount
// (container spawns recipes/<name>/server.ts from there); agent/ stays host-side.
//
// Re-runnable: workspace prompt files and mirrored recipe data are declared state,
// rewritten every run. The agent's own files under workspace/memory/ are never touched.
//
// Split for organisation only: declaration.ts (config shape, paths, argv), reconcile.ts
// (mirroring, agent/MCP server/cron job create-replace-remove), this file (command +
// re-exports — the single import point other modules use).

import { log, info, die } from "#src/core/io/log.ts";
import { emit } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";
import { safeName } from "#src/core/names.ts";
import { withLockUnlessHeld, parseBreakForeignLockHost } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { newOperationId } from "#src/service/operations.ts";
import { BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";
import { readLedgerStrict, recordOwned, ownerOf, updateOwnedPromptFiles } from "#src/set/ownership/ledger.ts";
import {
  loadRecipeAgentBundle,
  agentWorkspaceTargetDir,
  recipeMirrorTargetDir,
} from "./declaration.ts";
import type { RecipeAgentBundle } from "./declaration.ts";
import {
  syncRecipeFiles,
  writeWorkspacePromptFiles,
  ensureAgent,
  ensureMcpServer,
  ensureCronJob,
  assertObjectNamesAvailable,
  activeSetId,
} from "./reconcile.ts";

export * from "./declaration.ts";
export * from "./reconcile.ts";

/** Drives both provision-agent's own parser and its openclawCommands declaration. */
export const PROVISION_AGENT_ARGUMENTS: CommandArgument[] = [
  { name: "recipe", description: "Recipe name under recipes/", kind: "positional", required: true },
  { name: "break-lock", description: "Take over the instance lock held by another operation", kind: "flag" },
  BREAK_FOREIGN_LOCK_ARGUMENT,
  { name: "json", description: "Emit the outcome as JSON", kind: "flag" },
];

export async function provisionAgent(ctx: Context, args: string[]): Promise<void> {
  const parsed = parseDeclaredArgs(PROVISION_AGENT_ARGUMENTS, args);
  const breakLock = parsed["break-lock"] === true;
  const breakForeignLockHost = parseBreakForeignLockHost(args);
  const jsonOnly = parsed.json === true;
  const rawName = parsed.recipe as string | undefined;
  if (rawName === undefined) die("usage: ./clawforge provision-agent <recipe>");
  const recipeName = safeName("recipe", rawName);

  await requireBootstrapped(ctx);
  if (!(await ctx.runtime.isRunning())) die("the gateway is not running. Start it with ./clawforge up");

  const bundle = await loadRecipeAgentBundle(recipeName);

  // `apply` calls this as one of its steps and is already holding the lock; nested, the
  // second acquire would refuse the run its own caller started. Taken only when this is the
  // command someone invoked directly.
  await withLockUnlessHeld(ctx, `provision-agent ${recipeName}`, newOperationId("provision-agent"), { breakLock, breakForeignLockHost }, async () => {
    // Strict ledger read before any mutation: a corrupt ledger must refuse the whole run,
    // not fail partway through after files/agent/MCP server are already created.
    const ledger = await readLedgerStrict(ctx);
    const setId = await activeSetId(ctx);
    await assertObjectNamesAvailable(ctx, recipeName, bundle, ledger);
    const mirror = await syncRecipeFiles(ctx, recipeName, bundle.recipeDir);
    const previousOwner = ownerOf(ledger, "agent", bundle.config.agentId);
    await writeWorkspacePromptFiles(ctx, bundle.config, bundle.promptFiles, previousOwner?.promptFiles ?? []);

    const agentCreated = await ensureAgent(ctx, bundle.config);
    if (agentCreated) {
      await recordOwned(ctx, {
        kind: "agent",
        name: bundle.config.agentId,
        recipe: recipeName,
        setId,
        promptFiles: Object.keys(bundle.promptFiles),
      });
    } else {
      await updateOwnedPromptFiles(ctx, bundle.config.agentId, Object.keys(bundle.promptFiles));
    }
    const mcpState = await ensureMcpServer(ctx, bundle.config, recipeName);
    if (mcpState !== "unchanged") await recordOwned(ctx, { kind: "mcp-server", name: bundle.config.mcpServerName, recipe: recipeName, setId });
    const cronState = bundle.cronMessage === undefined
      ? undefined
      : await ensureCronJob(ctx, bundle.config, bundle.cronMessage, {
        allowUpdate: ownerOf(ledger, "cron-job", bundle.config.cronJobName!) !== undefined,
      });
    if (cronState === "created") {
      await recordOwned(ctx, { kind: "cron-job", name: bundle.config.cronJobName!, recipe: recipeName, setId });
    }
    reportProvisioned(ctx, bundle, recipeName, mirror, agentCreated, mcpState, cronState, jsonOnly);
  });
}

function reportProvisioned(
  ctx: Context,
  bundle: RecipeAgentBundle,
  recipeName: string,
  mirror: { written: number; removed: string[] },
  agentCreated: boolean,
  mcpState: "created" | "replaced" | "unchanged",
  cronState: "created" | "updated" | "unchanged" | undefined,
  jsonOnly: boolean,
): void {
  if (jsonOnly) {
    emit(
      `${JSON.stringify(
        {
          ok: true,
          changed: true,
          agentId: bundle.config.agentId,
          agentCreated,
          mcpServer: bundle.config.mcpServerName,
          mcpState,
          cronJob: bundle.config.cronJobName ?? null,
          cronState: cronState ?? null,
          recipeFiles: { written: mirror.written, removed: mirror.removed },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  log(`agent "${bundle.config.agentId}" provisioned from recipe "${recipeName}"`);
  info(`  agent  ${bundle.config.agentId}          ${agentCreated ? "created" : "already present"}`);
  info(`  mcp    ${bundle.config.mcpServerName}  ${mcpState}`);
  if (cronState !== undefined) {
    info(`  cron   ${bundle.config.cronJobName}    ${cronState} (${bundle.config.cronSchedule})`);
  }
  info(`workspace prompt files refreshed at ${agentWorkspaceTargetDir(ctx.settings.dataDir, bundle.config.agentId)}`);
  info(
    `recipe files mirrored to ${recipeMirrorTargetDir(ctx.settings.dataDir, recipeName)} ` +
      `(${mirror.written} file(s)${mirror.removed.length === 0 ? "" : `, ${mirror.removed.length} removed`})`,
  );
  for (const rel of mirror.removed) info(`  removed  ${rel}`);
  info(`try it: ./clawforge cli agent --agent ${bundle.config.agentId} -m "hello"`);
}
