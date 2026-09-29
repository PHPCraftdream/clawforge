// `./clawforge recipe` — deploying third-party services next to the instance.
//
// Each recipe runs as its own compose project, so nothing here can disturb the gateway.
// Building happens on the target: a Rust or Go build from scratch takes minutes, and the
// output is streamed rather than swallowed — silent waiting looks like a hang.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { dieUnknownAction } from "#src/core/arguments.ts";
import type { Context } from "#src/core/context.ts";
import {
  listAgentBundleRecipes,
  listBrokenRecipes,
  listRecipeDirectories,
  listRecipes,
  loadRecipe,
  projectName,
  recipesDirectory,
  type Recipe,
} from "#src/service/recipe.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { guarded } from "#src/runtime/lock/instance-lock.ts";
import { isCaptured, emit } from "#src/core/io/output.ts";
import { validateRecipeArgs } from "./arguments.ts";
import { runRecipeAction, RECIPE_ACTIONS } from "./actions.ts";

export { RECIPE_FLAG_ARGUMENTS } from "./arguments.ts";
export { importHookModule } from "./hook-runtime.ts";

/** The action a bare `recipe` runs. */
export const RECIPE_DEFAULT_ACTION = "list";

/** Actions that only report. One definition for the dispatcher below and the MCP gate's
 *  readOnlyWhen — which is asked from built argv, where an omitted action is not visibly
 *  the default — so the two cannot disagree about bare `recipe`: divergence here would let
 *  the gate demand a confirmation the console would never ask for.
 *
 *  verify is deliberately absent, though the action is usually a probe: it runs the recipe's
 *  own verify.ts with the same Context prepare.ts gets, and prepare may mutate the target,
 *  so the framework has no way to know a given hook is read-only. Listing it here would let
 *  an unconfirmed verify reach the target AND be reported as changed:false on the strength of
 *  its name alone. It gates like onboard, and its envelope only says changed:false when the
 *  hook's own JSON says so. The instance-lock gate in recipe() reads this same set, so the
 *  MCP gate and the lock cannot disagree about a future action. */
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

/** Installed recipes whose Compose stacks are currently running. A failed runtime probe
 *  propagates because backup and restore cannot claim consistency without its answer. A
 *  broken manifest is tolerated only when its directory's stack is proven stopped; a live
 *  stack must not disappear from the quiesce decision. */
export async function runningRecipeStacks(ctx: Context): Promise<Recipe[]> {
  const running: Recipe[] = [];
  const entries = (await listRecipeDirectories(recipesDirectory())).filter((candidate) => candidate.isDirectory());

  for (const entry of entries) {
    const directory = resolve(recipesDirectory(), entry.name);
    try {
      await access(resolve(directory, "recipe.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    let recipe: Recipe;
    try {
      recipe = await loadRecipe(entry.name);
    } catch (error) {
      // A broken declaration cannot supply hooks, but its directory still names the compose
      // project. If that project is live, fail closed before backup can archive it unsafely.
      const stack = ctx.runtime.stack(
        projectName(deploymentName(), entry.name),
        resolve(directory, "compose.yml"),
      );
      if (await stack.isRunning()) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`running recipe "${entry.name}" has an invalid manifest; backup cannot confirm it is quiesced: ${detail}`);
      }
      continue;
    }

    const stack = ctx.runtime.stack(projectName(deploymentName(), recipe.name), recipe.definitionPath);
    if (await stack.isRunning()) running.push(recipe);
  }
  return running;
}

export async function recipe(ctx: Context, args: string[]): Promise<void> {
  const [action, name, ...rest] = args;

  // Checked before anything else runs: an unknown action is a typo, not a lock failure or a
  // missing name, and a token the resolved action does not use (an undeclared flag, an
  // extra positional) dies here too instead of being silently ignored — see arguments.ts.
  if (action !== undefined && action !== RECIPE_DEFAULT_ACTION && !RECIPE_ACTIONS.includes(action)) {
    dieUnknownAction(action, `unknown action: ${action} (expected ${RECIPE_ACTIONS.join(", ")})`, RECIPE_ACTIONS);
  }
  validateRecipeArgs(action ?? RECIPE_DEFAULT_ACTION, args.slice(1));

  if (action === undefined || action === RECIPE_DEFAULT_ACTION) {
    const recipes = await listRecipes();
    // A recipe directory can also be an agent/MCP bundle — no recipe.json, so listRecipes
    // drops it and inspect reports it. Answering "no recipes yet" over one sent an operator
    // reading code to explain a discrepancy their own deployment showed.
    const bundles = await listAgentBundleRecipes();
    // A recipe.json that exists but fails to load (bad shape, invalid ports/variables).
    // listRecipes() drops these so one broken manifest cannot take the working
    // recipes down with it; this is the other half — the same manifest still gets a named,
    // visible entry in the catalog instead of quietly not existing.
    const broken = await listBrokenRecipes();

    // validateRecipeArgs above already refused anything but --json here.
    if (args.slice(1).includes("--json") || isCaptured()) {
      emit(
        `${JSON.stringify(
          {
            recipes: recipes.map((entry) => ({
              name: entry.name,
              description: entry.description,
              enabled: entry.enabled,
              disabledReason: entry.disabledReason ?? null,
              source: entry.source ?? null,
              ports: (entry.ports ?? []).map((port) => ({
                host: port.host,
                container: port.container,
                description: port.description ?? null,
              })),
            })),
            bundles,
            broken: broken.map((entry) => ({ name: entry.name, error: entry.error })),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    if (recipes.length === 0 && bundles.length === 0 && broken.length === 0) {
      info("no recipes yet — add one under recipes/<name>/");
      return;
    }
    if (recipes.length === 0 && broken.length === 0) {
      info("no service recipes yet — `recipe install` needs a recipes/<name>/recipe.json");
    } else if (recipes.length > 0) {
      log("available recipes");
      for (const entry of recipes) describe(entry);
      info("");
      info("install with: ./clawforge recipe install <name>");
    }
    for (const name of bundles) {
      info(`${name.padEnd(16)} agent/MCP bundle — not installable; visible with ./clawforge inspect, provisioned with ./clawforge provision-agent`);
    }
    for (const entry of broken) {
      warn(`${entry.name.padEnd(16)} broken recipe.json: ${entry.error}`);
    }
    return;
  }

  if (name === undefined) die(`usage: ./clawforge recipe ${action} <name>`);

  // One classification for MCP's confirmation gate and for the instance lock, so a future
  // action cannot be mutating for one and read-only for the other. The exceptions are
  // `import` and `new`: both write only the repository's recipes/ directory, never touch
  // the target, and taking a lock would make either the one recipe action that cannot run
  // before bootstrap has prepared the lock home. install holds the lock across the whole
  // from-source build — minutes, on purpose: a build finishing while restore is moving the
  // tree is the interleaving the lock exists to prevent. A caller that already holds the
  // lock (an orchestration step running this as its own) rides it instead of refusing —
  // guarded() is the nesting-safe shape every other mutating command uses (instance-lock.ts).
  if (action !== "import" && action !== "new" && !recipeActionIsReadOnly([action])) {
    return guarded(ctx, `recipe ${action} ${name}`, args, () => runRecipeAction(ctx, action, name, rest));
  }
  return runRecipeAction(ctx, action, name, rest);
}
