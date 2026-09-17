// Recipes: third-party services deployed next to the managed instance.
//
// A recipe is a directory under the application's recipes/<name>/ containing:
//
//   recipe.json    metadata — description, published ports, required variables
//   compose.yml    the service definition, with restart: unless-stopped
//   Dockerfile     multi-stage build: cloning and compiling happen in the build stage,
//                  so git, toolchains and sources never reach the host or the final image
//
// Each recipe is its OWN compose project (<app>-recipe-<name>), deliberately not a service
// inside the application's own definition. Three reasons:
//   - up, down and status keep operating on the managed service alone
//   - a broken recipe cannot take that service down with it
//   - state snapshots must not pick up recipe images or volumes
//
// The build runs on the target, so recipe paths are translated by the path bridge.

import { readdir, readFile, access } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import { monorepoRoot } from "../core/env.ts";
import { safeName } from "../core/names.ts";
import { recipesDir } from "../runtime/deployment.ts";

/** Default location. An application declares its own via AppDefinition.recipesDir: the
 *  mechanism is the framework's, the recipes are the application's data. */
export const defaultRecipesDir = resolve(monorepoRoot, "recipes");
let explicitRecipesDir: string | undefined;

/** Overrides the deployment recipe root for low-level callers and checks. */
export function useRecipesDir(directory: string): void {
  explicitRecipesDir = directory;
}

/** Returns recipe lookup to the deployment and set source. */
export function clearRecipesDir(): void {
  explicitRecipesDir = undefined;
}

export function recipesDirectory(): string {
  return explicitRecipesDir ?? recipesDir();
}

export interface RecipePort {
  /** Port inside the container. */
  readonly container: number;
  /** Published port on the target. */
  readonly host: number;
  /** What it serves, for the status output. */
  readonly description?: string;
}

export interface Recipe {
  /** Directory name, also the compose project suffix. */
  readonly name: string;
  readonly description: string;
  /** Upstream the Dockerfile builds from, recorded so it is visible without reading it. */
  readonly source?: string;
  readonly ports?: RecipePort[];
  /** Variables the recipe expects, with a short explanation each. */
  readonly variables?: Record<string, string>;
  /** Absolute path of the recipe directory on our side. */
  readonly directory: string;
  /** The stack definition inside it. Part of the recipe format, so applications do not
   *  hardcode the file name. */
  readonly definitionPath: string;
  /** A recipe can be kept in the repository without being installable — useful when its
   *  build is expensive and nobody needs the service yet. Defaults to enabled. */
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

/** Isolation happens per project name; the application supplies its own prefix so the
 *  framework does not hardcode anyone's brand. */
export function projectName(appName: string, recipe: string): string {
  return `${appName}-recipe-${recipe}`;
}

function assertShape(value: unknown, name: string): asserts value is Partial<Recipe> {
  if (value === null || typeof value !== "object") {
    throw new Error(`recipes/${name}/recipe.json must contain an object`);
  }
}

export async function loadRecipe(name: string): Promise<Recipe> {
  // The name arrives from the command line and becomes both a path and a compose project.
  safeName("recipe", name);
  const directory = resolve(recipesDirectory(), name);

  let raw: string;
  try {
    raw = await readFile(resolve(directory, "recipe.json"), "utf8");
  } catch {
    throw new Error(`recipe "${name}" not found — expected recipes/${name}/recipe.json`);
  }

  const parsed: unknown = JSON.parse(raw);
  assertShape(parsed, name);

  const description = typeof parsed.description === "string" ? parsed.description : "";
  if (description === "") throw new Error(`recipes/${name}/recipe.json needs a description`);

  return {
    name,
    description,
    // Absent means enabled: a recipe is installable unless it says otherwise.
    enabled: parsed.enabled !== false,
    disabledReason: typeof parsed.disabledReason === "string" ? parsed.disabledReason : undefined,
    source: typeof parsed.source === "string" ? parsed.source : undefined,
    ports: Array.isArray(parsed.ports) ? (parsed.ports as RecipePort[]) : undefined,
    variables: typeof parsed.variables === "object" && parsed.variables !== null
      ? (parsed.variables as Record<string, string>)
      : undefined,
    directory,
    definitionPath: resolve(directory, "compose.yml"),
  };
}

export async function listRecipes(): Promise<Recipe[]> {
  let entries: string[];
  try {
    entries = (await readdir(recipesDirectory(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const recipes: Recipe[] = [];
  for (const name of entries) {
    try {
      recipes.push(await loadRecipe(name));
    } catch {
      // A malformed directory should not hide the working ones; `./clawforge recipe <name>`
      // will report the specific problem.
    }
  }
  return recipes;
}

/** Directories that hold an agent/MCP bundle but no service definition: provisioned and
 *  inspected rather than installed, which is why listRecipes drops them. Named so `recipe
 *  list` can account for what it does not list instead of answering "no recipes yet" over a
 *  deployment that plainly has recipes. */
export async function listAgentBundleRecipes(): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(recipesDirectory(), { withFileTypes: true });
  } catch {
    return [];
  }

  const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
  const bundles: string[] = [];
  for (const name of entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const directory = resolve(recipesDirectory(), name);
    const [hasService, hasBundle] = await Promise.all([
      exists(resolve(directory, "recipe.json")),
      exists(resolve(directory, "agent", "config.json")),
    ]);
    if (hasBundle && !hasService) bundles.push(name);
  }
  return bundles;
}
