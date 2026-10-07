// `clawforge recipe` — deploying third-party services next to the instance.
//
// Each recipe runs as its own compose project, so nothing here can disturb the gateway.
// Building happens on the target: a Rust or Go build from scratch takes minutes, and the
// output is streamed rather than swallowed — silent waiting looks like a hang.
//
// The body lives here; the action runs live in actions.ts. Actions are declared in
// RECIPE_ACTION_GRAMMAR's order (list first, the default), so the word's choices read the
// same order the usage message always named.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import * as kinds from "#src/core/values/kinds.ts";
import {
  defineAction,
  multiActionBody,
  runOnContext,
} from "#src/core/command/index.ts";
import type { ArgumentSpec } from "#src/core/command/index.ts";
import type { Context } from "#src/core/context.ts";
import { log, info, warn } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
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
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import {
  runDiagnoseAction,
  runImportAction,
  runInstallAction,
  runInstallDryRun,
  runLogsAction,
  runNewAction,
  runOnboardAction,
  runRemoveAction,
  runRemoveDryRun,
  runStatusAction,
  runVerifyAction,
} from "./actions.ts";
import { INVALID_MANIFEST } from "./lifecycle.ts";
import { createName, readName } from "#src/core/values/names.ts";
import { importNameOf } from "./actions.ts";

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

/** `recipe list` (also the default action): the catalog of service recipes, agent/MCP
 *  bundles and broken manifests, as text or --json. */
async function runRecipeList(ctx: Context, jsonOnly: boolean): Promise<void> {
  const recipes = await listRecipes();
  // A recipe directory can also be an agent/MCP bundle — no recipe.json, so listRecipes
  // drops it; shown here so "no recipes yet" doesn't contradict what inspect reports.
  const bundles = await listAgentBundleRecipes();
  // A recipe.json that exists but fails to load. listRecipes() drops these so one broken
  // manifest can't take the working recipes down; this gives it a visible catalog entry.
  const broken = await listBrokenRecipes();

  if (jsonOnly || isCaptured()) {
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
    info(`install with: ${commandLine(["recipe", "install", "<name>"])}`);
  }
  for (const name of bundles) {
    info(`${name.padEnd(16)} agent/MCP bundle — not installable; visible with ${commandLine("inspect")}, provisioned with ${commandLine("provision-agent")}`);
  }
  for (const entry of broken) {
    warn(`${entry.name.padEnd(16)} broken recipe.json: ${entry.error}`);
  }
}


export { importHookModule } from "./hook-runtime.ts";

/** The action a bare `recipe` runs. */
const RECIPE_DEFAULT_ACTION = "list";

const NAME_ARGUMENT = {
  summary: "recipe",
  name: "name",
  description: "Recipe name",
  kind: "positional",
  required: true,
  value: kinds.recipeRef(),
} as const satisfies ArgumentSpec;

const NEW_NAME_ARGUMENT = {
  ...NAME_ARGUMENT,
  value: kinds.name("recipe", "create"),
} as const satisfies ArgumentSpec;

/** new mints the name it will create: the creator grammar (Windows device names included),
 *  refused at parse. Every other action addresses an existing recipe — the reader grammar. */
const RECIPE_LOCK_ARGUMENTS = LOCK_TAKEOVER_ARGUMENTS.map((argument) => ({ ...argument, summary: argument.name === "break-lock" ? "Take lock" : "Orphan host" }));

/** import copies a source directory, not a recipe name: any path is the source, and only the
 * name it lands under (new-name, else the last segment of the source) is held to the grammar. */
const SOURCE_ARGUMENT = {
  summary: "directory to copy the recipe from",
  name: "name",
  description: "Directory to copy the recipe from",
  kind: "positional",
  required: true,
  value: kinds.localDirectory("directory to copy the recipe from", "recipes/local"),
} as const satisfies ArgumentSpec;


const TAIL_ARGUMENT = {
  name: "tail",
  summary: "lines to return per service",
  description: "With logs/diagnose: lines to return per service",
  kind: "option",
  valueName: "n",
  value: kinds.count("a number of lines"),
} as const satisfies ArgumentSpec;

const DRY_RUN_ARGUMENT = {
  name: "dry-run",
  summary: "show what would happen",
  description: "With install/remove: show what would happen",
  kind: "flag",
  effect: "read",
} as const satisfies ArgumentSpec;

/** The command body; recipe(ctx, args) stays for callers that already hold a Context. */
export const RECIPE = multiActionBody({
  effect: "destroy",
  action: { description: "What to do with the recipe" },
  defaultAction: RECIPE_DEFAULT_ACTION,
  actions: {
    list: defineAction({
      summary: "List recipes, bundles and broken manifests",
      effect: "read",
      arguments: [
        {
          name: "json",
          summary: "emit the catalog as JSON",
          description: "With list: emit the catalog (recipes, agent/MCP bundles, broken manifests) as JSON",
          kind: "flag",
        },
      ],
      run: (ctx, values) => runRecipeList(ctx, values.json === true),
    }),
    import: defineAction({
      summary: "Copy a recipe directory into recipes/",
      arguments: [SOURCE_ARGUMENT, {
        name: "new-name",
        summary: "Use this name instead of the source name",
        description: "With import: import under this name instead of the source directory's own name",
        kind: "positional",
        value: kinds.name("recipe", "create"),
      }],
      // Repository-side only: no target, no lock — either works before bootstrap has
      // prepared the lock home.
      localFacts: [{ argument: "name", fact: "recipe-source" }],
      prepare: ({ values }) => {
        // The name it lands under is minted: refused here, before any context is built,
        // instead of mid-copy — the same words the run's own check keeps.
        createName("recipe", importNameOf(values.name, values["new-name"]));
        return values;
      },
      run: (_ctx, values) => runImportAction(values.name, values["new-name"]),
    }),
    new: defineAction({
      summary: "Scaffold a recipes/<name>/ skeleton",
      arguments: [NEW_NAME_ARGUMENT, {
        name: "with-hooks",
        summary: "add commented prepare.ts/verify.ts stubs",
        description: "With new: add commented prepare.ts/verify.ts stubs",
        kind: "flag",
      }],
      // Repository-side only, like import.
      run: (_ctx, values) => runNewAction(values.name, values["with-hooks"] === true),
    }),
    verify: defineAction({
      summary: "Run the recipe's verify.ts hook",
      localFacts: [{ argument: "name", fact: "recipe" }],
      arguments: [NAME_ARGUMENT, ...RECIPE_LOCK_ARGUMENTS],
      run: (ctx, values) => runLocked(ctx, "verify", values, () => runVerifyAction(ctx, values.name)),
    }),
    onboard: defineAction({
      summary: "Run the recipe's onboard.ts hook",
      localFacts: [{ argument: "name", fact: "recipe" }],
      arguments: [NAME_ARGUMENT, ...RECIPE_LOCK_ARGUMENTS],
      run: (ctx, values) => runLocked(ctx, "onboard", values, () => runOnboardAction(ctx, values.name)),
    }),
    diagnose: defineAction({
      summary: "Bundle stack, logs and verify hook into a report",
      localFacts: [{ argument: "name", fact: "recipe" }],
      arguments: [NAME_ARGUMENT, TAIL_ARGUMENT, ...RECIPE_LOCK_ARGUMENTS],
      run: (ctx, values) => runLocked(ctx, "diagnose", values, () => runDiagnoseAction(ctx, values.name, values.tail)),
    }),
    install: defineAction({
      summary: "Build a recipe from source and start it",
      localFacts: [{ argument: "name", fact: "recipe" }],
      arguments: [NAME_ARGUMENT, {
        name: "force-disabled",
        summary: "build a recipe marked disabled",
        description: "With install: build a recipe marked disabled",
        kind: "flag",
      }, DRY_RUN_ARGUMENT, ...RECIPE_LOCK_ARGUMENTS,],
      run: (ctx, values) => runLocked(ctx, "install", values, () => {
        const name = values.name;
        return values["dry-run"] === true
          ? runInstallDryRun(ctx, name, values["force-disabled"] === true)
          : runInstallAction(ctx, name, values["force-disabled"] === true);
      }, values["dry-run"] !== true),
    }),
    remove: defineAction({
      summary: "Stop and remove a recipe's stack",
      localFacts: [{ argument: "name", fact: "recipe" }],
      arguments: [NAME_ARGUMENT, {
        name: "volumes",
        summary: "delete its volumes too",
        description: "With remove: delete its volumes too",
        kind: "flag",
      }, DRY_RUN_ARGUMENT, ...RECIPE_LOCK_ARGUMENTS,],
      run: (ctx, values) => runLocked(ctx, "remove", values, () => {
        const name = values.name;
        return values["dry-run"] === true
          ? runRemoveDryRun(ctx, name, values.volumes === true)
          : runRemoveAction(ctx, name, values.volumes === true);
      }, values["dry-run"] !== true),
    }),
    status: defineAction({
      summary: "Show the recipe stack's compose status",
      localFacts: [{ argument: "name", fact: "recipe" }],
      effect: "read",
      arguments: [NAME_ARGUMENT],
      run: (ctx, values) => runStatusAction(ctx, values.name),
    }),
    logs: defineAction({
      summary: "Read a recipe stack's logs",
      localFacts: [{ argument: "name", fact: "recipe" }],
      effect: "read",
      arguments: [NAME_ARGUMENT, TAIL_ARGUMENT],
      run: (ctx, values) => runLogsAction(ctx, values.name, values.tail),
    }),
  },
});

/** install/remove --dry-run touch nothing on the target, reading as read-only the same way
 *  restore/deploy's own --dry-run does — so they skip the instance lock, exactly as the
 *  old readOnlyWhen said. Every other lifecycle action takes it. */
async function runLocked(
  ctx: Context,
  action: string,
  values: { readonly name: string } & Parameters<typeof takeoverOf>[0],
  body: () => Promise<void>,
  gate = true,
): Promise<void> {
  const name = values.name;
  // R32-08 class: resolve the recipe purely locally before the lock or any transport call,
  // so a typo dies here instead of as a lock failure or an unreachable-target error.
  await loadRecipe(readName("recipe", name));
  if (!gate) return body();
  await guardedWith(ctx, `recipe ${action} ${name}`, takeoverOf(values), body);
}

export async function recipe(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(RECIPE, ctx, args);
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
      recipe = await loadRecipe(readName("recipe", entry.name));
    } catch (error) {
      // A broken declaration can't supply hooks, but its directory still names the compose
      // project — fail closed before backup archives it unsafely if that project is live.
      const stack = recipeStack(ctx, entry.name, resolve(directory, "compose.yml"));
      if (await stack.isRunning()) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`running recipe "${entry.name}" ${INVALID_MANIFEST}; backup cannot confirm it is quiesced: ${detail}`);
      }
      continue;
    }

    const stack = recipeStack(ctx, recipe.name, recipe.definitionPath);
    if (await stack.isRunning()) running.push(recipe);
  }
  return running;
}
