// Recipes: third-party services deployed next to the managed instance.
//
// A recipe is a directory under recipes/<name>/: recipe.json (metadata: ports, variables,
// privatePaths/privateFiles — see their doc comments below), compose.yml (restart:
// unless-stopped), optional app-owned prepare.ts/verify.ts/onboard.ts hooks (verify.ts
// runs under the instance lock and MCP confirms it — the framework cannot know what an
// app-owned hook touches), and an optional multi-stage Dockerfile (cloning/compiling stay
// in the build stage, never reaching the host or final image).
//
// Each recipe is its OWN compose project (<app>-recipe-<name>), not a service inside the
// application's own definition: up/down/status stay on the managed service alone, a broken
// recipe cannot take it down, and state snapshots don't pick up recipe images/volumes.
//
// The build runs on the target, so recipe paths are translated by the path bridge.

import { readdir, readFile, access } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import { monorepoRoot } from "../core/env.ts";
import { safeName } from "../core/names.ts";
import { die } from "../core/io/log.ts";
import { recipesDir, selectedDeployment } from "../runtime/deployment.ts";
import { setSourceDir } from "../set/artifacts/source.ts";
import { persistedPrivatePaths } from "../security/privacy/private-paths-ledger.ts";

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

/** The one readdir of a recipes directory (layout.check.ts greps for a second). ENOENT is no
 *  recipes; any other errno dies naming the path, never reads as "empty". Returns raw entries:
 *  each caller decides whether it wants files too. */
export async function listRecipeDirectories(root: string): Promise<Dirent[]> {
  try {
    return await readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    die(`cannot read the recipes directory at ${root}: ${code ?? (error as Error).message}`);
  }
}

export interface RecipePort {
  /** Port inside the container. */
  readonly container: number;
  /** Published port on the target. */
  readonly host: number;
  /** What it serves, for the status output. */
  readonly description?: string;
}

/** What `recipe install` must see before treating the stack as up: every named compose
 *  service running and, if it declares a healthcheck, healthy — not just "some container
 *  from this project is alive", which one surviving sidecar satisfies. Optional: without
 *  it, install does a short grace check against whatever compose reports, just without a
 *  name to hold a slow starter to. */
export interface RecipeReadiness {
  /** Compose service names that must all be running (and healthy, if they declare a
   *  healthcheck) before install proceeds to afterStart. Required and non-empty: a
   *  declaration with no services would trivially always pass. */
  readonly services: string[];
  /** How long install waits for every listed service to reach that state, in milliseconds.
   *  Absent means the caller's own default. */
  readonly timeoutMs?: number;
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
  /** Data-relative paths (from the data directory root) this recipe keeps generated
   *  credentials under, e.g. ["generated-credentials"]. One declaration, three readers:
   *  archive.ts excludes these from migrate/share snapshots, verify.ts refuses archives
   *  carrying them, private-config.ts refuses private writes elsewhere. full still
   *  contains them by design. */
  readonly privatePaths?: string[];
  /** What install waits for before calling afterStart and reporting success. See
   *  RecipeReadiness. */
  readonly readiness?: RecipeReadiness;
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
 *  form. The declaration drives what snapshots exclude and what private-config refuses, so
 *  a sloppy entry is rejected at load rather than silently excluding nothing. */
function privatePath(recipe: string, value: string): string {
  if (value === "") throw new Error(`recipes/${recipe}/recipe.json: privatePaths entries must be non-empty`);
  const segments = value.split("/");
  if (segments[0] === "" || segments.at(-1) === "") {
    throw new Error(`recipes/${recipe}/recipe.json: privatePaths entries must be relative to the data directory: ${value}`);
  }
  if (segments.some((segment) => segment === "")) {
    throw new Error(`recipes/${recipe}/recipe.json: privatePaths entries must not contain empty path segments: ${value}`);
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

function isPortNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Validates one declared port mapping: describe() (management/recipe/index.ts) renders
 *  port.host/port.container unconditionally for every entry, so a malformed element here
 *  would otherwise crash the WHOLE catalog rather than staying isolated to its own recipe.
 *  Returned as-is, not reconstructed, so a well-formed entry's key order survives. */
function parsePort(recipe: string, value: unknown, index: number): RecipePort {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`recipes/${recipe}/recipe.json: ports[${index}] must be an object`);
  }
  const { host, container, description } = value as Record<string, unknown>;
  if (!isPortNumber(host)) {
    throw new Error(`recipes/${recipe}/recipe.json: ports[${index}].host must be an integer between 1 and 65535`);
  }
  if (!isPortNumber(container)) {
    throw new Error(`recipes/${recipe}/recipe.json: ports[${index}].container must be an integer between 1 and 65535`);
  }
  if (description !== undefined && typeof description !== "string") {
    throw new Error(`recipes/${recipe}/recipe.json: ports[${index}].description must be a string`);
  }
  return value as RecipePort;
}

function parsePorts(recipe: string, value: unknown): RecipePort[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`recipes/${recipe}/recipe.json: ports must be an array`);
  return value.map((entry, index) => parsePort(recipe, entry, index));
}

/** Validates the variables map: a plain object (Array.isArray excluded explicitly, since
 *  typeof [] === "object") with every value a string. install reads each value as the
 *  reason it prints when the variable is unset, and as the literal env value once set — a
 *  non-string value turns the warning into "[object Object]" or worse. */
function parseVariables(recipe: string, value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`recipes/${recipe}/recipe.json: variables must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`recipes/${recipe}/recipe.json: variables.${key} must be a string`);
  }
  return value as Record<string, string>;
}

/** Validates the optional readiness declaration: read strictly, like privatePaths above — a
 *  malformed declaration must stop the load rather than quietly readiness-check nothing. */
function parseReadiness(recipe: string, value: unknown): RecipeReadiness | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`recipes/${recipe}/recipe.json: readiness must be an object`);
  }
  const services = (value as { services?: unknown }).services;
  if (!Array.isArray(services) || services.length === 0) {
    throw new Error(`recipes/${recipe}/recipe.json: readiness.services must be a non-empty array of compose service names`);
  }
  const names = services.map((entry) => {
    if (typeof entry !== "string" || entry === "") {
      throw new Error(`recipes/${recipe}/recipe.json: readiness.services entries must be non-empty strings`);
    }
    return entry;
  });
  const timeoutMs = (value as { timeoutMs?: unknown }).timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`recipes/${recipe}/recipe.json: readiness.timeoutMs must be a positive number of milliseconds`);
  }
  return { services: names, timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined };
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
    ports: parsePorts(name, parsed.ports),
    variables: parseVariables(name, parsed.variables),
    privatePaths: parsePrivatePaths(name, parsed.privatePaths),
    readiness: parseReadiness(name, parsed.readiness),
    directory,
    definitionPath: resolve(directory, "compose.yml"),
    preparePath: await access(resolve(directory, "prepare.ts")).then(() => resolve(directory, "prepare.ts"), () => undefined),
    verifyPath: await access(resolve(directory, "verify.ts")).then(() => resolve(directory, "verify.ts"), () => undefined),
    onboardPath: await access(resolve(directory, "onboard.ts")).then(() => resolve(directory, "onboard.ts"), () => undefined),
  };
}

export async function listRecipes(): Promise<Recipe[]> {
  const entries = (await listRecipeDirectories(recipesDirectory()))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const recipes: Recipe[] = [];
  for (const name of entries) {
    try {
      recipes.push(await loadRecipe(name));
    } catch {
      // The listing's rule, and only the listing's: a catalogue must not break — or hide
      // working recipes — over one broken manifest. Dropped from THIS array (a caller after
      // installable recipes has no use for a failed one); surfaced by listBrokenRecipes() below.
    }
  }
  return recipes;
}

export interface BrokenRecipe {
  readonly name: string;
  readonly error: string;
}

/** The listing's other half: every recipe directory whose recipe.json exists but fails to
 *  load, with the reason, so `recipe list` names the problem instead of the entry silently
 *  vanishing from the catalog. Directories without a recipe.json (agent/MCP bundles,
 *  unrelated dirs — accounted for by listAgentBundleRecipes) are excluded, not reported. */
export async function listBrokenRecipes(): Promise<BrokenRecipe[]> {
  const entries = (await listRecipeDirectories(recipesDirectory()))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const broken: BrokenRecipe[] = [];
  for (const name of entries) {
    const hasManifest = await access(resolve(recipesDirectory(), name, "recipe.json")).then(() => true, () => false);
    if (!hasManifest) continue;
    try {
      await loadRecipe(name);
    } catch (error) {
      broken.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return broken;
}

/** Strict enumeration behind installedRecipePrivatePaths. */
async function strictDeclaredPrivatePaths(): Promise<string[]> {
  // recipesDirectory() only throws (via recipesDir()'s deploymentDir()) when none of the three
  // overrides apply — the same "no recipes configured" answer as an absent root.
  if (explicitRecipesDir === undefined && setSourceDir() === undefined && selectedDeployment() === undefined) {
    return [];
  }
  const root = recipesDirectory();

  const entries = (await listRecipeDirectories(root)).filter((candidate) => candidate.isDirectory());

  const paths: string[] = [];
  for (const entry of entries) {
    const manifest = resolve(root, entry.name, "recipe.json");
    let raw: string;
    try {
      raw = await readFile(manifest, "utf8");
    } catch (error) {
      // A directory without a manifest is not a recipe — agent bundles live there too.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`could not read ${manifest}: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`could not parse ${manifest}: ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`${manifest} must contain an object`);
    }
    const declared = parsePrivatePaths(entry.name, (parsed as { privatePaths?: unknown }).privatePaths);
    if (declared !== undefined) paths.push(...declared);
  }
  return [...new Set(paths)];
}

/** Every private path this deployment's target may hold under the data directory,
 *  data-relative and deduplicated — the security-policy read (archive.ts excludes these
 *  from migrate/share, verify.ts refuses archives carrying them, private-config.ts refuses
 *  private writes elsewhere). Union of two sources: what CURRENT recipes declare
 *  (strictDeclaredPrivatePaths — quiet when nothing is declared, but stops on a recipe.json
 *  that exists yet fails to read/parse/validate) and what PAST private writes recorded
 *  (persistedPrivatePaths, the deployment-side ledger) — removing a recipe drops the
 *  declaration while runtime files stay on the target, so the ledger keeps the exclusion
 *  until explicit cleanup. Both halves fail closed rather than reading as "nothing to protect". */
export async function installedRecipePrivatePaths(): Promise<string[]> {
  const [declared, persisted] = await Promise.all([strictDeclaredPrivatePaths(), persistedPrivatePaths()]);
  return [...new Set([...declared, ...persisted])];
}

/** The privateFiles declaration: files/directories inside a recipe's own directory holding
 *  credentials, for `recipe import` to leave out of the copy. Adjacent to privatePaths, not
 *  the same field — privatePaths are data-relative target runtime paths (security policy),
 *  these are recipe-tree-relative source paths, read from a directory not yet part of this
 *  deployment. Read strictly: a manifest that fails to read/parse/validate throws rather
 *  than reading as "nothing declared". Entries are literal, no globs (two readers once
 *  disagreed); absent means the caller's generic policy still applies. */
export async function declaredPrivateFiles(sourceDirectory: string): Promise<string[]> {
  const manifest = resolve(sourceDirectory, "recipe.json");
  let raw: string;
  try {
    raw = await readFile(manifest, "utf8");
  } catch (error) {
    throw new Error(`could not read ${manifest}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`could not parse ${manifest}: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${manifest} must contain an object`);
  }
  const declared = (parsed as { privateFiles?: unknown }).privateFiles;
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) throw new Error(`${manifest}: privateFiles must be an array of recipe-relative paths`);
  return declared.map((entry) => {
    if (typeof entry !== "string" || entry === "") {
      throw new Error(`${manifest}: privateFiles entries must be non-empty strings`);
    }
    if (entry.includes("\\")) {
      throw new Error(`${manifest}: privateFiles entries are /-separated paths relative to the recipe directory: ${entry}`);
    }
    const segments = entry.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`${manifest}: privateFiles entries must stay inside the recipe directory: ${entry}`);
    }
    return entry;
  });
}

/** Directories with an agent/MCP bundle but no service definition — provisioned and
 *  inspected, not installed, which is why listRecipes drops them. Named so `recipe list`
 *  can account for what it doesn't list. */
export async function listAgentBundleRecipes(): Promise<string[]> {
  const names = (await listRecipeDirectories(recipesDirectory()))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
  const bundles: string[] = [];
  for (const name of names) {
    const directory = resolve(recipesDirectory(), name);
    const [hasService, hasBundle] = await Promise.all([
      exists(resolve(directory, "recipe.json")),
      exists(resolve(directory, "agent", "config.json")),
    ]);
    if (hasBundle && !hasService) bundles.push(name);
  }
  return bundles;
}
