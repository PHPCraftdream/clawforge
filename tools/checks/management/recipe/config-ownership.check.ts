// Declaration-only: ownership manifests, catalog walks and pure lookups. No runtime,
// transport, hooks or endpoint probes.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readName } from "#framework/core/values/names.ts";
import {
  clearRecipesDir, loadRecipe, parseRecipeDefinition, recipeEndpointOwners, useRecipesDir,
} from "#framework/service/recipe.ts";
import { ownerOfConfigPath, recipePathOwners, type RecipePathOwner } from "#framework/set/ownership/recipe-paths.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

async function refusal(body: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    return await body();
  } catch (error) {
    return error;
  }
}

const root = await mkdtemp(join(tmpdir(), "clawforge-recipe-ownership-"));
useRecipesDir(root);
try {
  const alphaDirectory = join(root, "alpha");
  const alphaManifest = join(alphaDirectory, "recipe.json");
  const betaDirectory = join(root, "beta");
  const betaManifest = join(betaDirectory, "recipe.json");
  await mkdir(alphaDirectory);
  await mkdir(betaDirectory);
  async function write(manifest: string, value: unknown): Promise<string> {
    const raw = JSON.stringify(value);
    await writeFile(manifest, raw);
    return raw;
  }
  async function digest(manifest: string): Promise<string> {
    return createHash("sha256").update(await readFile(manifest)).digest("hex");
  }

  check("empty configured catalog", await recipePathOwners(), []);
  check("empty endpoint catalog stays empty", await recipeEndpointOwners(), []);

  // Loader acceptance and shape preservation.
  const valid = {
    description: "Owns",
    owns: [
      { path: "section.allowList", mode: "list-member" },
      { path: "search", mode: "value", prefix: true },
    ],
  };
  const raw = await write(alphaManifest, valid);
  check("parser preserves owns shape", parseRecipeDefinition("alpha", raw), valid);
  const loaded = await loadRecipe(readName("recipe", "alpha"));
  check("loader accepts value, list-member and prefix entries", loaded.owns, [
    { path: "section.allowList", mode: "list-member", prefix: false },
    { path: "search", mode: "value", prefix: true },
  ]);
  check("loader catalog returns owns entries", await recipePathOwners(), [
    { recipe: "alpha", path: "section.allowList", mode: "list-member", prefix: false },
    { recipe: "alpha", path: "search", mode: "value", prefix: true },
  ]);

  const entry = { path: "section.allowList", mode: "list-member" };
  const malformed: [string, unknown][] = [
    ["string owns", "section"],
    ["object owns", { path: "section" }],
    ["null entry", [null]],
    ["array entry", [[]]],
    ["string entry", ["section.allowList"]],
    ["unknown key", [{ ...entry, note: "why" }]],
    ["missing path", [{ mode: "value" }]],
    ["missing mode", [{ path: "section.allowList" }]],
    ["non-string path", [{ path: 1, mode: "value" }]],
    ["empty path", [{ path: "", mode: "value" }]],
    ["proto path", [{ path: "a.__proto__.b", mode: "value" }]],
    ["prototype path", [{ path: "a.prototype.b", mode: "value" }]],
    ["leading dot path", [{ path: ".a.b", mode: "value" }]],
    ["empty segment path", [{ path: "a..b", mode: "value" }]],
    ["url path", [{ path: "https://host/a", mode: "value" }]],
    ["bad mode", [{ path: "section.allowList", mode: "write" }]],
    ["missing mode value", [{ path: "section.allowList", mode: undefined }]],
    ["string prefix", [{ path: "section", mode: "value", prefix: "yes" }]],
    ["number prefix", [{ path: "section", mode: "value", prefix: 1 }]],
    ["list-member prefix", [{ path: "section", mode: "list-member", prefix: true }]],
    ["duplicate path", [entry, entry]],
    ["duplicate path different mode", [entry, { ...entry, mode: "value" }]],
  ];
  for (const [label, owns] of malformed) {
    const invalid = await write(alphaManifest, { description: "Invalid", owns });
    checkTrue(`parser rejects ${label}`, (await refusal(() => parseRecipeDefinition("alpha", invalid))) instanceof Error);
    checkTrue(`loader rejects ${label}`, (await refusal(() => loadRecipe(readName("recipe", "alpha")))) instanceof Error);
    checkTrue(`catalog rejects ${label}`, (await refusal(() => recipePathOwners())) instanceof Error);
    check(`invalid owns bytes unchanged for ${label}`, await readFile(alphaManifest, "utf8"), invalid);
  }

  // Disabled recipes participate in the catalog, exactly like endpoints.
  await write(alphaManifest, { description: "Off", enabled: false, owns: [{ path: "x.y", mode: "value" }] });
  check("disabled recipe still owns its paths", await recipePathOwners(), [
    { recipe: "alpha", path: "x.y", mode: "value", prefix: false },
  ]);
  await write(betaManifest, { description: "Conflict", owns: [{ path: "x.y", mode: "value" }] });
  const crossRaw = await readFile(betaManifest, "utf8");
  const crossDigest = await digest(alphaManifest);
  checkTrue("disabled exact duplicate across recipes refuses", (await refusal(() => recipePathOwners())) instanceof Error);
  check("cross-recipe refusal leaves first manifest unchanged", await digest(alphaManifest), crossDigest);
  check("cross-recipe refusal leaves second manifest unchanged", await readFile(betaManifest, "utf8"), crossRaw);

  // Exact path under another recipe's prefix.
  await write(alphaManifest, { description: "Wide", owns: [{ path: "a", mode: "value", prefix: true }] });
  await write(betaManifest, { description: "Narrow", owns: [{ path: "a.b", mode: "value" }] });
  const overlap = await refusal(() => recipePathOwners());
  checkTrue("exact under other recipe's prefix refuses", overlap instanceof Error);
  checkTrue("overlap refusal names both recipes", overlap instanceof Error
    && (overlap as Error).message.includes("alpha") && (overlap as Error).message.includes("beta"));
  checkTrue("overlap refusal names both paths", overlap instanceof Error
    && (overlap as Error).message.includes("a") && (overlap as Error).message.includes("a.b"));

  // Prefix covering another prefix.
  await write(betaManifest, { description: "Wider", owns: [{ path: "a.b", mode: "value", prefix: true }] });
  checkTrue("prefix covering another recipe's prefix refuses", (await refusal(() => recipePathOwners())) instanceof Error);

  // Segment-wise prefixes do not conflict textually.
  await write(alphaManifest, { description: "Segment", owns: [{ path: "a.b", mode: "value", prefix: true }] });
  await write(betaManifest, { description: "Sibling", owns: [{ path: "a.bc", mode: "value" }] });
  check("a.b prefix does not conflict with a.bc exact", await recipePathOwners(), [
    { recipe: "alpha", path: "a.b", mode: "value", prefix: true },
    { recipe: "beta", path: "a.bc", mode: "value", prefix: false },
  ]);

  // consumerEndpoints participates in the same catalog.
  await rm(betaDirectory, { recursive: true, force: true });
  await write(alphaManifest, {
    description: "Endpoint",
    consumerEndpoints: [{ configPath: "p.q", service: "search-api" }],
  });
  check("endpoint entries appear in the joined catalog", await recipePathOwners(), [
    { recipe: "alpha", path: "p.q", mode: "value", prefix: false },
  ]);
  check("endpoint catalog still serves its own view", await recipeEndpointOwners(), [
    { recipe: "alpha", service: "search-api", configPath: "p.q" },
  ]);
  await mkdir(betaDirectory);
  await write(betaManifest, { description: "Clash", owns: [{ path: "p.q", mode: "value" }] });
  checkTrue("endpoint and owns of the same path across recipes refuse", (await refusal(() => recipePathOwners())) instanceof Error);
  await rm(betaDirectory, { recursive: true, force: true });
  await write(alphaManifest, {
    description: "Nested",
    owns: [
      { path: "z", mode: "value", prefix: true },
      { path: "z.w", mode: "value" },
    ],
  });
  check("own exact path inside own prefix is accepted", await recipePathOwners(), [
    { recipe: "alpha", path: "z", mode: "value", prefix: true },
    { recipe: "alpha", path: "z.w", mode: "value", prefix: false },
  ]);

  // Pure lookup, independent of the filesystem.
  const owners: RecipePathOwner[] = [
    { recipe: "wide", path: "a", mode: "value", prefix: true },
    { recipe: "deep", path: "a.b", mode: "value", prefix: true },
    { recipe: "exact", path: "a.b.c", mode: "value", prefix: false },
    { recipe: "other", path: "q", mode: "list-member", prefix: false },
  ];
  check("exact match wins over prefix", ownerOfConfigPath(owners, "a.b.c"), owners[2]);
  check("deepest prefix wins", ownerOfConfigPath(owners, "a.b.z"), owners[1]);
  check("shallow prefix serves the rest", ownerOfConfigPath(owners, "a.z"), owners[0]);
  check("no owner returns undefined", ownerOfConfigPath(owners, "b.c"), undefined);
  check("prefix is segment-wise", ownerOfConfigPath(owners, "ab.c"), undefined);
  check("prefix owns its own segments", ownerOfConfigPath(owners, "a.b.c.d"), owners[1]);
} finally {
  clearRecipesDir();
  await rm(root, { recursive: true, force: true });
}
finish("recipe-config-ownership");
