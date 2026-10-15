// Declaration-only: disposable manifests, no runtime, transport, hooks or endpoint probes.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readName } from "#framework/core/values/names.ts";
import {
  clearRecipesDir, loadRecipe, parseRecipeDefinition, recipeEndpointOwners, useRecipesDir,
} from "#framework/service/recipe.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

async function refusal(body: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    return await body();
  } catch (error) {
    return error;
  }
}

const root = await mkdtemp(join(tmpdir(), "clawwright-recipe-endpoints-"));
const name = readName("recipe", "alpha");
const directory = join(root, "alpha");
const manifest = join(directory, "recipe.json");
const endpoint = { configPath: "plugins.entries.search.baseUrl", service: "search-api" };
async function save(value: unknown): Promise<string> {
  const raw = JSON.stringify(value);
  await writeFile(manifest, raw);
  return raw;
}

useRecipesDir(root);
try {
  check("empty configured catalog", await recipeEndpointOwners(), []);
  await mkdir(directory);
  check("absent non-recipe manifest is skipped", await recipeEndpointOwners(), []);

  const absent = { description: "Legacy", ports: [{ host: 8123, container: 80 }] };
  check("public parser accepts absent declaration", parseRecipeDefinition("alpha", await save(absent)), absent);
  check("loader preserves absent declaration", (await loadRecipe(name)).consumerEndpoints, undefined);
  check("ports never infer endpoint ownership", await recipeEndpointOwners(), []);

  const present = '{ "description": "Declared", "consumerEndpoints": [{ "configPath": "plugins.entries.search.baseUrl", "service": "search-api" }] }\n';
  await writeFile(manifest, present);
  const presentDigest = createHash("sha256").update(await readFile(manifest)).digest("hex");
  check("public parser preserves original declaration shape", parseRecipeDefinition("alpha", present), {
    description: "Declared", consumerEndpoints: [{ configPath: "plugins.entries.search.baseUrl", service: "search-api" }],
  });
  check("loader accepts exact declaration", (await loadRecipe(name)).consumerEndpoints, [endpoint]);
  check("catalog returns explicit ownership only", await recipeEndpointOwners(), [
    { recipe: "alpha", service: "search-api", configPath: "plugins.entries.search.baseUrl" },
  ]);
  check("declaration bytes unchanged", createHash("sha256").update(await readFile(manifest)).digest("hex"), presentDigest);
  check("catalog leaves root unchanged", await readdir(root), ["alpha"]);
  check("catalog leaves recipe directory unchanged", await readdir(directory), ["recipe.json"]);
  await save({ description: "Empty", consumerEndpoints: [] });
  check("explicit empty array is accepted", (await loadRecipe(name)).consumerEndpoints, []);

  const malformed: [string, unknown][] = [
    ["null array", null], ["object array", {}], ["string array", "search"],
    ["null entry", [null]], ["array entry", [[]]], ["string entry", ["search"]],
    ["missing service", [{ configPath: "search.url" }]],
    ["missing path", [{ service: "search" }]],
    ["extra URL", [{ ...endpoint, url: "http://localhost:8123" }]],
    ["extra protocol", [{ ...endpoint, protocol: "http" }]],
    ["extra probe", [{ ...endpoint, probe: true }]],
    ["extra timeout", [{ ...endpoint, timeoutMs: 100 }]],
    ["non-string path", [{ ...endpoint, configPath: 1 }]],
    ["non-string service", [{ ...endpoint, service: 1 }]],
    ["duplicate entry", [endpoint, endpoint]],
    ["duplicate path different service", [endpoint, { ...endpoint, service: "other" }]],
  ];
  for (const configPath of ["", " ", ".search", "search.", "search..url", "../search", "search/url",
    "search\\url", "search[0].url", "search url", "search\nurl", "search.__proto__.url",
    "constructor.url", "search.prototype.url", "https://host", "$search.url"]) {
    malformed.push([`unsafe path ${JSON.stringify(configPath)}`, [{ ...endpoint, configPath }]]);
  }
  for (const service of ["", " ", "../search", "search/api", "search\\api", "search.api", "-search",
    "search;id", "search\napi", "__proto__", "prototype", "constructor"]) {
    malformed.push([`unsafe service ${JSON.stringify(service)}`, [{ ...endpoint, service }]]);
  }
  for (const [label, consumerEndpoints] of malformed) {
    const raw = await save({ description: "Invalid", consumerEndpoints });
    checkTrue(`parser rejects ${label}`, (await refusal(() => parseRecipeDefinition("alpha", raw))) instanceof Error);
    checkTrue(`loader rejects ${label}`, (await refusal(() => loadRecipe(name))) instanceof Error);
    checkTrue(`catalog rejects ${label}`, (await refusal(() => recipeEndpointOwners())) instanceof Error);
    check(`invalid declaration bytes unchanged for ${label}`, await readFile(manifest, "utf8"), raw);
    check(`invalid catalog leaves recipe directory unchanged for ${label}`, await readdir(directory), ["recipe.json"]);
  }

  await writeFile(manifest, present);
  await mkdir(join(root, "beta"));
  const second = join(root, "beta", "recipe.json");
  for (const service of ["search-api", "different-api"]) {
    const raw = JSON.stringify({ description: "Conflict", consumerEndpoints: [{ ...endpoint, service }] });
    await writeFile(second, raw);
    checkTrue(`cross-recipe ambiguity rejects ${service}`, (await refusal(() => recipeEndpointOwners())) instanceof Error);
    check(`conflict leaves first manifest unchanged ${service}`, createHash("sha256").update(await readFile(manifest)).digest("hex"), presentDigest);
    check(`conflict leaves second manifest unchanged ${service}`, await readFile(second, "utf8"), raw);
    check(`conflict leaves root unchanged ${service}`, await readdir(root), ["alpha", "beta"]);
    check(`conflict leaves second directory unchanged ${service}`, await readdir(join(root, "beta")), ["recipe.json"]);
  }
  await writeFile(second, JSON.stringify({ description: "Independent", consumerEndpoints: [{ configPath: "models.remote.url", service: "models" }] }));
  check("distinct paths retain deterministic recipe order", await recipeEndpointOwners(), [
    { recipe: "alpha", service: "search-api", configPath: "plugins.entries.search.baseUrl" },
    { recipe: "beta", service: "models", configPath: "models.remote.url" },
  ]);
  await rm(join(root, "beta"), { recursive: true });

  for (const raw of ["{broken", "null", "{}", JSON.stringify({ description: "Broken port", ports: [{}] })]) {
    await writeFile(manifest, raw);
    checkTrue(`broken manifest throws rather than empty catalog: ${raw}`, (await refusal(() => recipeEndpointOwners())) instanceof Error);
    check("broken manifest bytes unchanged", await readFile(manifest, "utf8"), raw);
    check("broken catalog leaves recipe directory unchanged", await readdir(directory), ["recipe.json"]);
  }
  // A directory in place of the file deterministically exercises a read error without
  // chmod/root/Windows ACL assumptions or a capability skip.
  await rm(manifest);
  await mkdir(manifest);
  checkTrue("unreadable manifest loader refuses", (await refusal(() => loadRecipe(name))) instanceof Error);
  checkTrue("unreadable manifest catalog refuses", (await refusal(() => recipeEndpointOwners())) instanceof Error);
  checkTrue("unreadable manifest remains a directory", (await stat(manifest)).isDirectory());
  check("unreadable manifest directory remains empty", await readdir(manifest), []);
  check("unreadable catalog leaves recipe directory unchanged", await readdir(directory), ["recipe.json"]);
} finally {
  clearRecipesDir();
  await rm(root, { recursive: true, force: true });
}
finish("recipe-consumer-endpoints");
