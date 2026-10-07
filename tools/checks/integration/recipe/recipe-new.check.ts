// `./clawforge recipe new <name>` (U11b): scaffolds recipes/<name>/ with a minimal valid
// recipe.json and a compose.yml skeleton, no hooks by default — repository-side, like
// import: no target, no instance lock, refuses an existing directory. --with-hooks adds
// commented prepare.ts/verify.ts stubs that still parse and export real (no-op) hooks.

import { access, mkdir, readFile, rm } from "node:fs/promises";
import { readName } from "#framework/core/values/names.ts";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { loadRecipe, listRecipes, listBrokenRecipes, useRecipesDir } from "#framework/service/recipe.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function messageOf<T>(name: string, fn: () => Promise<T>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  check(name, "did not throw", "threw");
  return "";
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

// `new` never reaches transport or runtime, same as import — an empty stub is enough.
const ctx = { settings: { env: {} } } as unknown as Context;

const scratch = resolve(tmpdir(), `clawforge-recipe-new-check-${Date.now()}`);

try {
  useDeployment(resolve(scratch, "example-deployment"));
  const recipesRoot = resolve(scratch, "recipes");
  useRecipesDir(recipesRoot);
  await mkdir(recipesRoot, { recursive: true });

  // --- a plain `new` writes recipe.json + compose.yml, nothing else ---------------------------
  let out = "";
  await withOutputSink((chunk) => { out += chunk; }, () => recipe(ctx, ["new", "plain-service"]));
  const plainDir = resolve(recipesRoot, "plain-service");
  check("recipe.json was written", await exists(resolve(plainDir, "recipe.json")), true);
  check("compose.yml was written", await exists(resolve(plainDir, "compose.yml")), true);
  check("no prepare.ts without --with-hooks", await exists(resolve(plainDir, "prepare.ts")), false);
  check("no verify.ts without --with-hooks", await exists(resolve(plainDir, "verify.ts")), false);
  check("the report names the directory", out.includes(plainDir), true);

  const composeText = await readFile(resolve(plainDir, "compose.yml"), "utf8");
  check("the compose skeleton declares a service", composeText.includes("services:"), true);
  check("the compose skeleton keeps the restart policy docs/guide/recipes.md describes", composeText.includes("restart: unless-stopped"), true);

  // --- the framework's own validator accepts it: loadRecipe succeeds, and `recipe list` -------
  // would show it as a working recipe, never under listBrokenRecipes() ("a broken-manifest
  // note") — the exact promise U11b makes.
  const loaded = await loadRecipe(readName("recipe", "plain-service"));
  check("the scaffolded recipe has a non-empty description", loaded.description.length > 0, true);
  const [recipes, broken] = await Promise.all([listRecipes(), listBrokenRecipes()]);
  check("recipe list carries it as a working recipe", recipes.some((entry) => entry.name === "plain-service"), true);
  check("recipe list never carries it as broken", broken.some((entry) => entry.name === "plain-service"), false);

  // --- refuses an existing directory, never overwrites -----------------------------------------
  const overwriteMessage = await messageOf("recipe new refuses an existing directory", () =>
    withOutputSink(() => {}, () => recipe(ctx, ["new", "plain-service"])),
  );
  check("the refusal names the directory", overwriteMessage.includes(plainDir), true);
  check("the original recipe.json survives untouched", (await readFile(resolve(plainDir, "recipe.json"), "utf8")).includes("plain-service"), true);

  // --- the same safeName rules `import`/every other recipe name uses ---------------------------
  const badNameMessage = await messageOf("recipe new validates the name like every other recipe action", () =>
    withOutputSink(() => {}, () => recipe(ctx, ["new", "Not Safe"])),
  );
  check("the refusal names the invalid name", badNameMessage.includes("Not Safe"), true);
  check("nothing was created for the invalid name", await exists(resolve(recipesRoot, "Not Safe")), false);

  // --- an undeclared flag/positional is refused, same grammar every other action gets ----------
  const bogusFlagMessage = await messageOf("recipe new refuses an undeclared flag", () =>
    withOutputSink(() => {}, () => recipe(ctx, ["new", "another-one", "--bogus"])),
  );
  check("the refusal names the flag", bogusFlagMessage.includes("--bogus"), true);
  check("nothing was created", await exists(resolve(recipesRoot, "another-one")), false);

  // --- --with-hooks adds commented prepare.ts/verify.ts that still parse and export real hooks -
  await withOutputSink(() => {}, () => recipe(ctx, ["new", "hooked-service", "--with-hooks"]));
  const hookedDir = resolve(recipesRoot, "hooked-service");
  check("prepare.ts was written", await exists(resolve(hookedDir, "prepare.ts")), true);
  check("verify.ts was written", await exists(resolve(hookedDir, "verify.ts")), true);

  const prepareText = await readFile(resolve(hookedDir, "prepare.ts"), "utf8");
  const verifyText = await readFile(resolve(hookedDir, "verify.ts"), "utf8");
  check(
    "prepare.ts's commented example imports from the published private-config entry point",
    prepareText.includes('from "@clawforge/framework/private-config"'),
    true,
  );
  check("prepare.ts states hooks run with the operator's rights", prepareText.includes("the operator's rights"), true);
  check("verify.ts states hooks run with the operator's rights", verifyText.includes("the operator's rights"), true);

  // Parsed and executed by the same node --experimental-strip-types runner every check file
  // already runs under — the cheapest real proof the stub is not just well-formed comments.
  const preparedModule = (await import(pathToFileURL(resolve(hookedDir, "prepare.ts")).href)) as { prepare?: unknown };
  const verifyModule = (await import(pathToFileURL(resolve(hookedDir, "verify.ts")).href)) as { verify?: unknown };
  check("prepare.ts exports a callable prepare", typeof preparedModule.prepare, "function");
  check("verify.ts exports a callable verify", typeof verifyModule.verify, "function");
  check(
    "the default verify stub answers ok",
    await (verifyModule.verify as () => Promise<{ ok: boolean }>)(),
    { ok: true },
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

finish("recipe new");
