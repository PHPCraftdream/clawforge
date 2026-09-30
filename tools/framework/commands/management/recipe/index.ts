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
  recipeStack,
  recipesDirectory,
  type Recipe,
} from "#src/service/recipe.ts";
import { guarded } from "#src/runtime/lock/instance-lock.ts";
import { isCaptured, emit } from "#src/core/io/output.ts";
import { validateRecipeArgs } from "./arguments.ts";
import { runRecipeAction, RECIPE_ACTIONS } from "./actions.ts";

export { RECIPE_FLAG_ARGUMENTS } from "./arguments.ts";
export { importHookModule } from "./hook-runtime.ts";

/** The action a bare `recipe` runs. */
export const RECIPE_DEFAULT_ACTION = "list";

/** Actions that only report. One definition for the dispatcher below and the MCP gate's
 *  readOnlyWhen, so the two cannot disagree about bare `recipe`.
 *
 *  verify is deliberately absent, though usually a probe: it runs with the same Context
 *  prepare.ts gets, which may mutate the target, so the framework can't know a given hook
 *  is read-only. It gates like onboard; its envelope only says changed:false when the
 *  hook's own JSON says so. */
const RECIPE_READ_ONLY_ACTIONS: readonly string[] = [RECIPE_DEFAULT_ACTION, "status", "logs"];

/** install/remove --dry-run touches nothing on the target, reading as read-only the same
 *  way restore/rollback/deploy's own --dry-run does. */
const RECIPE_DRY_RUNNABLE_ACTIONS: readonly string[] = ["install", "remove"];

export function recipeActionIsReadOnly(argv: string[]): boolean {
  const action = argv[0] ?? RECIPE_DEFAULT_ACTION;
  if (RECIPE_READ_ONLY_ACTIONS.includes(action)) return true;
  return RECIPE_DRY_RUNNABLE_ACTIONS.includes(action) && argv.includes("--dry-run");
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
 *  propagates, since backup/restore can't claim consistency without its answer. A broken
 *  manifest is tolerated only when its stack is proven stopped. */
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
      // A broken declaration can't supply hooks, but its directory still names the compose
      // project — fail closed before backup archives it unsafely if that project is live.
      const stack = recipeStack(ctx, entry.name, resolve(directory, "compose.yml"));
      if (await stack.isRunning()) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`running recipe "${entry.name}" has an invalid manifest; backup cannot confirm it is quiesced: ${detail}`);
      }
      continue;
    }

    const stack = recipeStack(ctx, recipe.name, recipe.definitionPath);
    if (await stack.isRunning()) running.push(recipe);
  }
  return running;
}

export async function recipe(ctx: Context, args: string[]): Promise<void> {
  const [action, name, ...rest] = args;

  // Checked before anything else runs: an unknown action is a typo, not a lock failure or a
  // missing name, and an unused token dies here too instead of being silently ignored.
  if (action !== undefined && action !== RECIPE_DEFAULT_ACTION && !RECIPE_ACTIONS.includes(action)) {
    dieUnknownAction(action, `unknown action: ${action} (expected ${RECIPE_ACTIONS.join(", ")})`, RECIPE_ACTIONS);
  }
  validateRecipeArgs(action ?? RECIPE_DEFAULT_ACTION, args.slice(1));

  if (action === undefined || action === RECIPE_DEFAULT_ACTION) {
    const recipes = await listRecipes();
    // A recipe directory can also be an agent/MCP bundle — no recipe.json, so listRecipes
    // drops it; shown here so "no recipes yet" doesn't contradict what inspect reports.
    const bundles = await listAgentBundleRecipes();
    // A recipe.json that exists but fails to load. listRecipes() drops these so one broken
    // manifest can't take the working recipes down; this gives it a visible catalog entry.
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

  // One classification for MCP's confirmation gate and the instance lock, so an action
  // can't be mutating for one and read-only for the other. Exceptions: `import`/`new` only
  // write the repository's recipes/ directory, never touch the target, so a lock would
  // make either the one action runnable before bootstrap has prepared the lock home.
  // install holds the lock across the whole from-source build, minutes, on purpose. guarded()
  // is the nesting-safe shape every mutating command uses.
  if (action !== "import" && action !== "new" && !recipeActionIsReadOnly(args)) {
    return guarded(ctx, `recipe ${action} ${name}`, args, () => runRecipeAction(ctx, action, name, rest));
  }
  return runRecipeAction(ctx, action, name, rest);
}
