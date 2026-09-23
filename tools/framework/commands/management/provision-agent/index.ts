// `./clawforge provision-agent <recipe>` — wires a recipe's MCP server to a dedicated OpenClaw
// agent: an isolated agent with its own workspace prompt files, the recipe's stdio MCP
// server registered against it, and (optionally) a cron job that sends the agent a
// recurring message.
//
// Convention a recipe opts into by adding an `agent/` subdirectory next to its existing
// files:
//   recipes/<name>/agent/config.json    identifiers + optional cron schedule (see below)
//   recipes/<name>/agent/*.md           copied verbatim as the new agent's workspace files
//   recipes/<name>/agent/cron-message.txt   optional — enables the cron job if present
//   recipes/<name>/server.ts            the recipe's own stdio MCP server (unchanged)
// Everything under recipes/<name>/ except agent/ is mirrored into the agent's data mount
// so the container can spawn recipes/<name>/server.ts; agent/ itself stays host-side, read
// once to build the workspace files and cron job below.
//
// config.json shape:
//   {
//     "agentId": string,            // OpenClaw agent id to create
//     "mcpServerName": string,      // name the MCP server is registered under
//     "cronJobName"?: string,       // required only if cron-message.txt exists
//     "cronSchedule"?: string,      // 5-field cron expression, default: daily off-peak
//     "cronTimeoutSeconds"?: number // default: 900
//   }
//
// Re-runnable by design, same spirit as apply-config: workspace prompt files and the
// mirrored recipe data are declared state and get rewritten every run; the agent's own
// accumulated files under its workspace's memory/ are never touched here.
//
// Split into three files under this directory, purely organisational: declaration.ts (the
// config.json shape, path builders, argv/comparison functions) and reconcile.ts (mirroring
// files, creating/replacing/removing the agent/MCP server/cron job). This file, index.ts,
// keeps only the top-level command and re-exports everything from the other two under its
// own name — this is the most fanned-out module in the codebase for selective imports
// (install.ts, set.ts, inspect/, several checks), all of which import from
// "../management/provision-agent/index.ts" (or the equivalent relative depth).

import { log, info, die } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { safeName } from "#src/core/names.ts";
import { withLockUnlessHeld } from "#src/runtime/instance-lock.ts";
import { newOperationId } from "#src/service/operations.ts";
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

export async function provisionAgent(ctx: Context, args: string[]): Promise<void> {
  const breakLock = args.includes("--break-lock");
  const [rawName, ...rest] = args.filter((arg) => arg !== "--break-lock");
  if (rawName === undefined) die("usage: ./clawforge provision-agent <recipe>");
  if (rest.length > 0) die(`unknown argument: ${rest[0]}`);
  const recipeName = safeName("recipe", rawName);

  if (!(await ctx.runtime.isRunning())) die("the gateway is not running. Start it with ./clawforge up");

  const bundle = await loadRecipeAgentBundle(recipeName);

  // `apply` calls this as one of its steps and is already holding the lock; nested, the
  // second acquire would refuse the run its own caller started. Taken only when this is the
  // command someone invoked directly.
  await withLockUnlessHeld(ctx, `provision-agent ${recipeName}`, newOperationId("provision-agent"), { breakLock }, async () => {
    // Strict control-ledger preflight, before the first live mutation: a corrupt ownership
    // ledger must refuse the whole run while nothing has been mirrored, written or created
    // yet. The tolerant read this replaces sailed past the corruption and let the mirror,
    // prompt writes and agent creation happen, only for recordOwned()'s own strict read to
    // fail afterwards — leaving new live state no ledger could ever claim. Inside the locked
    // scope, so the check and the writes it guards are one operation, and a refusal still
    // releases the lock on the way out.
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
    reportProvisioned(ctx, bundle, recipeName, mirror, agentCreated, mcpState, cronState);
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
): void {
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
