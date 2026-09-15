// `./clawforge recipe` — deploying third-party services next to the instance.
//
// Each recipe runs as its own compose project, so nothing here can disturb the gateway.
// Building happens on the target: a Rust or Go build from scratch takes minutes, and the
// output is streamed rather than swallowed — silent waiting looks like a hang.

import { log, info, warn, die } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { listRecipes, loadRecipe, projectName, type Recipe } from "#src/service/recipe.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { isCaptured, emit } from "#src/core/output.ts";
import { takeTail } from "../lifecycle/lifecycle.ts";

function describe(recipe: Recipe): void {
  const state = recipe.enabled ? "" : "  [disabled]";
  info(`${recipe.name.padEnd(16)} ${recipe.description}${state}`);
  if (!recipe.enabled && recipe.disabledReason !== undefined) {
    info(`${"".padEnd(16)} ${recipe.disabledReason}`);
  }
  if (recipe.source !== undefined) info(`${"".padEnd(16)} source: ${recipe.source}`);
  for (const port of recipe.ports ?? []) {
    const suffix = port.description === undefined ? "" : ` (${port.description})`;
    info(`${"".padEnd(16)} port ${port.host} -> ${port.container}${suffix}`);
  }
}

async function stackFor(ctx: Context, name: string) {
  const recipe = await loadRecipe(name);
  return { recipe, stack: ctx.runtime.stack(projectName(deploymentName(), name), recipe.definitionPath) };
}

export async function recipe(ctx: Context, args: string[]): Promise<void> {
  const [action, name, ...rest] = args;

  if (action === undefined || action === "list") {
    const recipes = await listRecipes();
    if (recipes.length === 0) {
      info("no recipes yet — add one under recipes/<name>/");
      return;
    }
    log("available recipes");
    for (const entry of recipes) describe(entry);
    info("");
    info("install with: ./clawforge recipe install <name>");
    return;
  }

  if (name === undefined) die(`usage: ./clawforge recipe ${action} <name>`);

  switch (action) {
    case "install": {
      const { recipe: spec, stack } = await stackFor(ctx, name);

      // Kept in the repository but switched off: refuse rather than start an expensive
      // build nobody asked for. --force-disabled is the deliberate override.
      if (!spec.enabled && !rest.includes("--force-disabled")) {
        warn(`recipe ${spec.name} is disabled`);
        if (spec.disabledReason !== undefined) info(spec.disabledReason);
        die(`install it anyway with: ./clawforge recipe install ${spec.name} --force-disabled`);
      }

      // Variables the recipe declares must exist before the service starts, for the same
      // reason the gateway checks its own: a container that starts and then fails to
      // configure itself is harder to diagnose than a refusal.
      const declared = Object.keys(spec.variables ?? {});
      const absent = declared.filter((variable) => (ctx.settings.env[variable] ?? "") === "");
      if (absent.length > 0) {
        for (const variable of absent) {
          warn(`${variable} is not set — ${spec.variables?.[variable] ?? "required by the recipe"}`);
        }
        die(`add the missing variable(s) to .env, then run this again`);
      }

      log(`building ${spec.name} (this compiles from source and can take minutes)`);
      await stack.build();
      log(`starting ${spec.name}`);
      await stack.up();
      log(`${spec.name} is running`);
      for (const port of spec.ports ?? []) {
        info(`port ${port.host} -> ${port.container}${port.description ? ` (${port.description})` : ""}`);
      }
      info("it restarts automatically: restart policy unless-stopped");
      return;
    }

    case "remove": {
      const { stack } = await stackFor(ctx, name);
      const removeVolumes = rest.includes("--volumes");
      await stack.down(removeVolumes);
      log(`${name} removed${removeVolumes ? " (including volumes)" : ""}`);
      return;
    }

    case "status": {
      const { stack } = await stackFor(ctx, name);
      await stack.status();
      info((await stack.isRunning()) ? "running" : "not running");
      return;
    }

    case "logs": {
      const { stack } = await stackFor(ctx, name);
      // Following runs until interrupted, which a tool call cannot do: it owes its client
      // one result. Same capability either way — a terminal watches the stream, a captured
      // caller gets a bounded tail. See lifecycle.ts's logs, which makes the same choice.
      if (isCaptured()) {
        emit(await stack.readLogs(takeTail(rest).tail ?? "100"));
        return;
      }
      await stack.followLogs();
      return;
    }

    default:
      die(`unknown action: ${action} (expected list, install, remove, status or logs)`);
  }
}
