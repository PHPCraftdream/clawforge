// Declaration-only: parser and path resolution, no runtime, hooks or file probes.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRecipeActionFile, parseRecipeActions } from "#framework/set/ownership/recipe-actions.ts";
import { loadRecipe, parseRecipeDefinition, useRecipesDir, clearRecipesDir } from "#framework/service/recipe.ts";
import { readName } from "#framework/core/values/names.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const root = await mkdtemp(join(tmpdir(), "clawforge-recipe-actions-"));
const name = readName("recipe", "alpha");
const manifest = join(root, "alpha", "recipe.json");
useRecipesDir(root);

function refusal(recipe: string, value: unknown): unknown {
  try {
    parseRecipeActions(recipe, value);
  } catch (error) {
    return error;
  }
  return undefined;
}

function throwsWith(label: string, value: unknown, detail: string): void {
  const error = refusal("alpha", value);
  checkTrue(`${label} names ${detail}`, error instanceof Error && error.message.includes(detail));
}

const valid = {
  file: "actions/sync.ts",
  effect: "change",
  description: "Synchronize",
  arguments: [
    { name: "target", kind: "choice", choices: ["a", "b"], description: "Target" },
    { name: "dryRun", kind: "flag", optional: true },
  ],
};

try {
  check("absent key parses to undefined", parseRecipeActions("alpha", undefined), undefined);
  check("valid declaration round-trips", parseRecipeActions("alpha", { sync: valid })?.get("sync"), {
    file: "actions/sync.ts",
    effect: "change",
    description: "Synchronize",
    arguments: [
      { name: "target", kind: "choice", choices: ["a", "b"], description: "Target" },
      { name: "dryRun", kind: "flag", optional: true },
    ],
  });
  checkTrue("frozen declaration", Object.isFrozen(parseRecipeActions("alpha", { sync: valid })!.get("sync")));

  throwsWith("not an object", null, "actions must be an object");
  throwsWith("array", [], "actions must be an object");
  throwsWith("string", "sync", "actions must be an object");
  throwsWith(
    "17 actions",
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`a${index}`, valid])),
    "at most 16 actions",
  );
  for (const bad of ["Sync", "SYNC", "", "1sync", "-sync", "sync-", "x".repeat(41), "sync_x", "sync.x", "sync--x"]) {
    throwsWith(`bad action name ${JSON.stringify(bad)}`, { [bad]: valid }, `actions key`);
  }
  throwsWith("entry not an object", { sync: "x" }, "actions.sync must be an object");
  throwsWith("entry null", { sync: null }, "actions.sync must be an object");
  throwsWith("entry array", { sync: [] }, "actions.sync must be an object");
  throwsWith("unknown key in entry", { sync: { ...valid, extra: 1 } }, "unknown key extra");
  throwsWith("missing file", { sync: { effect: "read" } }, ".file must be a non-empty string");
  throwsWith("file not ts", { sync: { ...valid, file: "actions/sync.js" } }, ".file must end with .ts");
  throwsWith("file absolute posix", { sync: { ...valid, file: "/etc/sync.ts" } }, ".file must be a relative path");
  throwsWith("file drive letter", { sync: { ...valid, file: "C:sync.ts" } }, ".file must be a relative path");
  throwsWith("file backslash", { sync: { ...valid, file: "actions\\sync.ts" } }, ".file must be a relative path");
  throwsWith("file dotdot segment", { sync: { ...valid, file: "../sync.ts" } }, ".file must stay inside the recipe directory");
  throwsWith("file dot segment", { sync: { ...valid, file: "./sync.ts" } }, ".file must stay inside the recipe directory");
  throwsWith("file empty segment", { sync: { ...valid, file: "actions//sync.ts" } }, ".file must stay inside the recipe directory");
  throwsWith("file empty", { sync: { ...valid, file: "" } }, ".file must be a non-empty string");
  throwsWith("file 201 chars", { sync: { ...valid, file: `${"a".repeat(198)}.ts` } }, ".file must be at most 200 characters");
  throwsWith("bad effect", { sync: { ...valid, effect: "upsert" } }, ".effect must be one of read, change, destroy");
  throwsWith("missing effect", { sync: { file: "sync.ts" } }, ".effect must be one of read, change, destroy");
  throwsWith("description empty", { sync: { ...valid, description: "" } }, ".description must be a non-empty string");
  throwsWith("description 201 chars", { sync: { ...valid, description: "x".repeat(201) } }, ".description must be at most 200 characters");
  throwsWith("description not string", { sync: { ...valid, description: 3 } }, ".description must be a non-empty string");
  throwsWith("arguments not array", { sync: { ...valid, arguments: {} } }, ".arguments must be an array");
  throwsWith(
    "17 arguments",
    { sync: { ...valid, arguments: Array.from({ length: 17 }, () => ({ name: "a", kind: "text" })) } },
    ".arguments must have at most 16 entries",
  );
  throwsWith("argument not an object", { sync: { ...valid, arguments: ["x"] } }, ".arguments[0] must be an object");
  throwsWith(
    "unknown key in argument",
    { sync: { ...valid, arguments: [{ name: "a", kind: "text", extra: 1 }] } },
    "unknown key extra",
  );
  throwsWith(
    "duplicate argument name",
    { sync: { ...valid, arguments: [{ name: "a", kind: "text" }, { name: "a", kind: "flag" }] } },
    "duplicate name a",
  );
  for (const bad of ["A", "", "1a", "a-b", "a_b", "x".repeat(41)]) {
    throwsWith(`bad argument name ${JSON.stringify(bad)}`, { sync: { ...valid, arguments: [{ name: bad, kind: "text" }] } }, ".name must match");
  }
  throwsWith("missing kind", { sync: { ...valid, arguments: [{ name: "a" }] } }, ".kind must be one of");
  throwsWith("unknown kind", { sync: { ...valid, arguments: [{ name: "a", kind: "blob" }] } }, ".kind must be one of");
  throwsWith("optional not boolean", { sync: { ...valid, arguments: [{ name: "a", kind: "text", optional: "yes" }] } }, ".optional must be a boolean");
  throwsWith(
    "choices with kind text",
    { sync: { ...valid, arguments: [{ name: "a", kind: "text", choices: ["a"] }] } },
    ".choices is only allowed for kind choice",
  );
  throwsWith(
    "choices missing with kind choice",
    { sync: { ...valid, arguments: [{ name: "a", kind: "choice" }] } },
    ".choices must be a non-empty array for kind choice",
  );
  throwsWith(
    "choices empty",
    { sync: { ...valid, arguments: [{ name: "a", kind: "choice", choices: [] }] } },
    ".choices must be a non-empty array for kind choice",
  );
  throwsWith(
    "choices duplicate",
    { sync: { ...valid, arguments: [{ name: "a", kind: "choice", choices: ["a", "a"] }] } },
    "duplicate entry a",
  );
  throwsWith(
    "choices over the bound",
    { sync: { ...valid, arguments: [{ name: "a", kind: "choice", choices: Array.from({ length: 33 }, (_, index) => `c${index}`) }] } },
    ".choices must have at most 32 entries",
  );
  throwsWith(
    "choices non-string",
    { sync: { ...valid, arguments: [{ name: "a", kind: "choice", choices: [1] }] } },
    ".choices entries must be non-empty strings",
  );
  throwsWith(
    "choice entry 65 chars",
    { sync: { ...valid, arguments: [{ name: "a", kind: "choice", choices: ["x".repeat(65)] }] } },
    ".choices entries must be non-empty strings",
  );
  throwsWith(
    "argument description 201 chars",
    { sync: { ...valid, arguments: [{ name: "a", kind: "text", description: "x".repeat(201) }] } },
    ".description must be at most 200 characters",
  );

  // Through the public manifest parser and the loader, same schema.
  await mkdir(join(root, "alpha"), { recursive: true });
  await writeFile(manifest, JSON.stringify({ description: "Alpha", actions: { sync: valid } }));
  const loaded = await loadRecipe(name);
  checkTrue("loader exposes declaration", loaded.actions?.get("sync")?.effect === "change");
  const broken = JSON.stringify({ description: "Alpha", actions: { sync: { ...valid, effect: "nope" } } });
  await writeFile(manifest, broken);
  let definitionError: unknown;
  try {
    parseRecipeDefinition("alpha", broken);
  } catch (error) {
    definitionError = error;
  }
  checkTrue("definition parser refuses bad actions", definitionError instanceof Error);
  let loaderError: unknown;
  try {
    await loadRecipe(name);
  } catch (error) {
    loaderError = error;
  }
  checkTrue("loader refuses bad actions", loaderError instanceof Error);
  await writeFile(manifest, JSON.stringify({ description: "Alpha" }));
  check("loader reports absent actions as undefined", (await loadRecipe(name)).actions, undefined);

  // Containment resolution.
  const directory = join(root, "alpha");
  check("nested file resolves inside", resolveRecipeActionFile(directory, "actions/sync.ts"), join(directory, "actions", "sync.ts"));
  let escape: unknown;
  try {
    resolveRecipeActionFile(directory, "../outside.ts");
  } catch (error) {
    escape = error;
  }
  checkTrue("dotdot escape refused", escape instanceof Error);
  escape = undefined;
  try {
    resolveRecipeActionFile(directory, join("..", "sibling", "sync.ts"));
  } catch (error) {
    escape = error;
  }
  checkTrue("nested dotdot escape refused", escape instanceof Error);
  escape = undefined;
  try {
    resolveRecipeActionFile(directory, "/etc/sync.ts");
  } catch (error) {
    escape = error;
  }
  checkTrue("absolute escape refused", escape instanceof Error);
} finally {
  clearRecipesDir();
  await rm(root, { recursive: true, force: true });
}
finish("recipe-actions-manifest");
