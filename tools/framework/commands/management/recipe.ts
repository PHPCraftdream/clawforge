// `./clawforge recipe` — deploying third-party services next to the instance.
//
// Each recipe runs as its own compose project, so nothing here can disturb the gateway.
// Building happens on the target: a Rust or Go build from scratch takes minutes, and the
// output is streamed rather than swallowed — silent waiting looks like a hang.

import { cp, access } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { log, info, warn, die } from "#src/core/log.ts";
import { pathToFileURL } from "node:url";
import type { Context } from "#src/core/context.ts";
import { listAgentBundleRecipes, listRecipes, loadRecipe, projectName, recipesDirectory, type Recipe } from "#src/service/recipe.ts";
import { safeName } from "#src/core/names.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { isCaptured, shouldFollow, emit } from "#src/core/output.ts";
import { takeTail } from "../lifecycle/lifecycle.ts";

/** The action a bare `recipe` runs. */
export const RECIPE_DEFAULT_ACTION = "list";

/** Actions that only report. One definition for the dispatcher below and the MCP gate's
 *  readOnlyWhen — which is asked from built argv, where an omitted action is no longer
 *  visibly the default — so the two cannot disagree about bare `recipe` again: the gate
 *  once demanded a confirmation the console would never have asked for.
 *
 *  verify is deliberately absent, though the action is usually a probe: it runs the recipe's
 *  own verify.ts with the same Context prepare.ts gets, and prepare may mutate the target,
 *  so the framework has no way to know a given hook is read-only. Listing it here let an
 *  unconfirmed verify reach the target AND be reported as changed:false on the strength of
 *  its name alone. It gates like onboard, and its envelope only says changed:false when the
 *  hook's own JSON says so. */
const RECIPE_READ_ONLY_ACTIONS: readonly string[] = [RECIPE_DEFAULT_ACTION, "status", "logs"];

export function recipeActionIsReadOnly(argv: string[]): boolean {
  return RECIPE_READ_ONLY_ACTIONS.includes(argv[0] ?? RECIPE_DEFAULT_ACTION);
}

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

/** Loads app-owned hooks without teaching the framework what the recipe means. */
async function loadRecipeHooks(spec: Recipe): Promise<Record<string, unknown>> {
  if (spec.preparePath === undefined) return {};
  return (await import(pathToFileURL(spec.preparePath).href)) as Record<string, unknown>;
}

async function prepareRecipe(ctx: Context, spec: Recipe): Promise<Record<string, unknown>> {
  const loaded = await loadRecipeHooks(spec);
  const prepare = loaded.prepare ?? loaded.default;
  if (spec.preparePath !== undefined && typeof prepare !== "function") {
    die(`recipe "${spec.name}" prepare.ts must export prepare(ctx, recipe)`);
  }
  if (typeof prepare === "function") await prepare(ctx, spec);
  return loaded;
}

/** Loads and runs one of the recipe's own hooks, returning its JSON payload rather than
 *  printing it — the part runRecipeHook and diagnose's verify probe both need, without
 *  diagnose inheriting runRecipeHook's die()-on-failure (a broken verify.ts is itself
 *  diagnostic information, not a reason to refuse the rest of the report). */
async function loadHookResult(ctx: Context, spec: Recipe, kind: "verify" | "onboard"): Promise<unknown> {
  const path = kind === "verify" ? spec.verifyPath : spec.onboardPath;
  if (path === undefined) throw new Error(`recipe "${spec.name}" has no ${kind}.ts hook`);
  const loaded = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const hook = loaded[kind] ?? loaded.default;
  if (typeof hook !== "function") throw new Error(`recipe "${spec.name}" ${kind}.ts must export ${kind}(ctx, recipe)`);
  const result = await hook(ctx, spec);
  return result === undefined ? { ok: true } : result;
}

async function runRecipeHook(ctx: Context, spec: Recipe, kind: "verify" | "onboard"): Promise<void> {
  let payload: unknown;
  try {
    payload = await loadHookResult(ctx, spec, kind);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  if (isCaptured()) emit(`${JSON.stringify(payload)}\n`);
  else log(`${spec.name} ${kind}: ${JSON.stringify(payload)}`);
}

export async function recipe(ctx: Context, args: string[]): Promise<void> {
  const [action, name, ...rest] = args;

  if (action === undefined || action === RECIPE_DEFAULT_ACTION) {
    const recipes = await listRecipes();
    // A recipe directory can also be an agent/MCP bundle — no recipe.json, so listRecipes
    // drops it and inspect reports it. Answering "no recipes yet" over one sent an operator
    // reading code to explain a discrepancy their own deployment showed.
    const bundles = await listAgentBundleRecipes();
    if (recipes.length === 0 && bundles.length === 0) {
      info("no recipes yet — add one under recipes/<name>/");
      return;
    }
    if (recipes.length === 0) {
      info("no service recipes yet — `recipe install` needs a recipes/<name>/recipe.json");
    } else {
      log("available recipes");
      for (const entry of recipes) describe(entry);
      info("");
      info("install with: ./clawforge recipe install <name>");
    }
    for (const name of bundles) {
      info(`${name.padEnd(16)} agent/MCP bundle — not installable; visible with ./clawforge inspect, provisioned with ./clawforge provision-agent`);
    }
    return;
  }

  if (name === undefined) die(`usage: ./clawforge recipe ${action} <name>`);

  switch (action) {
    case "import": {
      const source = resolve(name);
      const importedName = rest[0] ?? basename(source);
      if (rest.length > 1) die(`unknown argument: ${rest[1]}`);
      safeName("recipe", importedName);
      try { await access(resolve(source, "recipe.json")); } catch { die(`recipe source has no recipe.json: ${source}`); }
      const destination = resolve(recipesDirectory(), importedName);
      try {
        await access(destination);
        die(`recipe "${importedName}" already exists at ${destination}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const sensitive = /(^|[\\/])(?:\.env(?:\..*)?|secrets(?:[\\/]|$)|.*\.token$|.*\.secrets\.env$|proxy-credentials\.env$|.*\.users\.ktav$)/i;
      await cp(source, destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (entry) => !sensitive.test(relative(source, entry).replaceAll("\\", "/")),
      });
      log(`imported recipe "${importedName}"`);
      info(`source: ${source}`);
      info(`destination: ${destination}`);
      return;
    }

    case "verify": {
      const { recipe: spec } = await stackFor(ctx, name);
      await runRecipeHook(ctx, spec, "verify");
      return;
    }

    case "onboard": {
      const { recipe: spec } = await stackFor(ctx, name);
      await runRecipeHook(ctx, spec, "onboard");
      return;
    }

    // Not in RECIPE_READ_ONLY_ACTIONS, for the same reason "verify" itself is not: it runs
    // the recipe's own verify.ts, which the framework cannot know is actually read-only.
    case "diagnose": {
      const { recipe: spec, stack } = await stackFor(ctx, name);
      const running = await stack.isRunning();
      // Every service in the recipe's own compose project, not just one — a multi-container
      // recipe (a sidecar in front of another sidecar, say) needs all of them in one place to
      // correlate a failure that spans the two, the way cross-referencing separate `docker
      // logs` calls by hand does today.
      const logs = await stack.readLogs(takeTail(rest).tail ?? "50");

      let verify: unknown;
      let verifyError: string | undefined;
      if (spec.verifyPath === undefined) {
        verifyError = "no verify.ts hook";
      } else {
        try {
          verify = await loadHookResult(ctx, spec, "verify");
        } catch (error) {
          verifyError = error instanceof Error ? error.message : String(error);
        }
      }

      const report = { recipe: name, enabled: spec.enabled, running, verify, verifyError, logs };
      if (isCaptured()) {
        emit(`${JSON.stringify(report)}\n`);
        return;
      }
      log(`${name} diagnose`);
      info(`enabled: ${spec.enabled}`);
      info(`running: ${running}`);
      if (verifyError !== undefined) warn(`verify: ${verifyError}`);
      else info(`verify: ${JSON.stringify(verify)}`);
      info("recent logs (every service in the recipe's own stack):");
      info(logs);
      return;
    }

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

      const hooks = await prepareRecipe(ctx, spec);

      log(`building ${spec.name} (this compiles from source and can take minutes)`);
      await stack.build();
      log(`starting ${spec.name}`);
      await stack.up();
      if (typeof hooks.afterStart === "function") await hooks.afterStart(ctx, spec);
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
      // Following runs until interrupted, which nothing but an attended terminal can do:
      // an MCP tool call owes its client one result, and a script or agent shell tool has
      // nothing to interrupt it either. See output.ts's shouldFollow() and lifecycle.ts's
      // logs, which makes the same choice.
      if (!shouldFollow()) {
        emit(await stack.readLogs(takeTail(rest).tail ?? "100"));
        return;
      }
      await stack.followLogs();
      return;
    }

    default:
      die(`unknown action: ${action} (expected list, import, verify, onboard, diagnose, install, remove, status or logs)`);
  }
}
