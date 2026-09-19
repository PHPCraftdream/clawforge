// Recipes: third-party services deployed next to the managed instance.
//
// A recipe is a directory under the application's recipes/<name>/ containing:
//
//   recipe.json    metadata — description, published ports, required variables
//   compose.yml    the service definition, with restart: unless-stopped
//   prepare.ts    optional app-owned preparation/afterStart hooks around build/up
//   verify.ts     optional app-owned read-only verification hook
//   onboard.ts    optional app-owned onboarding hook
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
  /** Data-relative paths (from the data directory root) this recipe keeps its generated
   *  credentials under, e.g. ["tor-socks5"]. One declaration, three readers: archive.ts
   *  excludes these from migrate and share snapshots, verify.ts refuses archives that
   *  already carry them, and private-config.ts refuses private writes anywhere else.
   *  full deliberately still contains them — it is credential-complete by design. */
  readonly privatePaths?: string[];
  /** Absolute path of the recipe directory on our side. */
  readonly directory: string;
  /** The stack definition inside it. Part of the recipe format, so applications do not
   *  hardcode the file name. */
  readonly definitionPath: string;
  /** Optional app-owned preparation hook file, run before build and after start. */
  readonly preparePath?: string;
  readonly verifyPath?: string;
  readonly onboardPath?: string;
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

/** Validates one declared private path: non-empty, data-relative, no climbing, no absolute
 *  form — the care safeName takes with the recipe's own name, applied to a path. The
 *  declaration drives what snapshots exclude and what private-config refuses, so a sloppy
 *  entry is rejected at load rather than silently excluding nothing. */
function privatePath(recipe: string, value: string): string {
  if (value === "") throw new Error(`recipes/${recipe}/recipe.json: privatePaths entries must be non-empty`);
  const segments = value.split("/");
  if (segments[0] === "" || segments.at(-1) === "") {
    throw new Error(`recipes/${recipe}/recipe.json: privatePaths entries must be relative to the data directory: ${value}`);
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`recipes/${recipe}/recipe.json: privatePaths entries must stay inside the data directory: ${value}`);
  }
  return value;
}

function parsePrivatePaths(recipe: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`recipes/${recipe}/recipe.json: privatePaths must be an array of data-relative paths`);
  return value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`recipes/${recipe}/recipe.json: privatePaths entries must be strings`);
    return privatePath(recipe, entry);
  });
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
    privatePaths: parsePrivatePaths(name, parsed.privatePaths),
    directory,
    definitionPath: resolve(directory, "compose.yml"),
    preparePath: await access(resolve(directory, "prepare.ts")).then(() => resolve(directory, "prepare.ts"), () => undefined),
    verifyPath: await access(resolve(directory, "verify.ts")).then(() => resolve(directory, "verify.ts"), () => undefined),
    onboardPath: await access(resolve(directory, "onboard.ts")).then(() => resolve(directory, "onboard.ts"), () => undefined),
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

/** Every installed recipe's declared private paths, data-relative and deduplicated.
 *
 *  The single declaration (recipe.json privatePaths) turned into the list the snapshot
 *  rules consume: archive.ts excludes these from migrate and share, verify.ts refuses
 *  archives that already carry them. Best-effort by the same rule as listRecipes: recipes
 *  that cannot be enumerated (no deployment selected, an unreadable root) contribute
 *  nothing rather than breaking snapshotting. */
export async function installedRecipePrivatePaths(): Promise<string[]> {
  let recipes: Recipe[];
  try {
    recipes = await listRecipes();
  } catch {
    return [];
  }
  return [...new Set(recipes.flatMap((recipe) => recipe.privatePaths ?? []))];
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
