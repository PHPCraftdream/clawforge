// check:exclusive — drops a scratch deployment into apps/ for the gate, which other checks that enumerate deployments must not see.
// The documented hook import — `@clawforge/framework/private-config` — loads in both kinds of
// deployment: a checkout one (no dist build; the hook loader maps the package's public exports
// onto the checkout's own framework sources) and an installed one (the recipe's own node_modules
// answers first, and the checkout mapping never shadows it).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { checkoutFrameworkSource, FRAMEWORK_EXPORT_SOURCES } from "#framework/core/env.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";
import { scratchDeployment, stubContext } from "./fixture.ts";
const { outerRecipes } = scratchDeployment();

async function verifyRevision(name: string): Promise<{ revision?: number }> {
  const { ctx } = stubContext({});
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["verify", name]));
  return JSON.parse(output) as { revision?: number };
}

// Checkout-style: the recipe has no node_modules at all, so the specifier can only come
// from the checkout's own framework sources.
{
  const root = resolve(tmpdir(), `clawforge-recipe-hook-sources-${Date.now()}`);
  try {
    await mkdir(resolve(root, "sources"), { recursive: true });
    await writeFile(resolve(root, "sources", "recipe.json"), JSON.stringify({ description: "Framework sources probe" }), "utf8");
    await writeFile(
      resolve(root, "sources", "verify.ts"),
      "import { generatePrivateSecret } from \"@clawforge/framework/private-config\";\nexport async function verify() { return { ok: true, revision: generatePrivateSecret().length }; }\n",
      "utf8",
    );
    useRecipesDir(root);
    check("sources: the documented @clawforge/framework/private-config import loads from the checkout's framework sources", Number((await verifyRevision("sources")).revision) > 0, true);
  } finally {
    useRecipesDir(outerRecipes);
    await rm(root, { recursive: true, force: true });
  }
}

// Installed-style: a real package in the recipe's own node_modules answers first.
{
  const root = resolve(tmpdir(), `clawforge-recipe-hook-installed-${Date.now()}`);
  try {
    await mkdir(resolve(root, "installed", "node_modules", "@clawforge", "framework"), { recursive: true });
    await writeFile(resolve(root, "installed", "recipe.json"), JSON.stringify({ description: "Installed package probe" }), "utf8");
    await writeFile(
      resolve(root, "installed", "node_modules", "@clawforge", "framework", "package.json"),
      JSON.stringify({ name: "@clawforge/framework", version: "0.0.0-check", type: "module", exports: { "./private-config": "./private-config.js" } }),
      "utf8",
    );
    await writeFile(
      resolve(root, "installed", "node_modules", "@clawforge", "framework", "private-config.js"),
      "export function stubRevision() { return 42; }\n",
      "utf8",
    );
    await writeFile(
      resolve(root, "installed", "verify.ts"),
      "import { stubRevision } from \"@clawforge/framework/private-config\";\nexport async function verify() { return { ok: true, revision: stubRevision() }; }\n",
      "utf8",
    );
    useRecipesDir(root);
    check("installed: the recipe's own @clawforge/framework package answers before any checkout mapping", (await verifyRevision("installed")).revision, 42);
  } finally {
    useRecipesDir(outerRecipes);
    await rm(root, { recursive: true, force: true });
  }
}

// The mapping table mirrors the package's export map: every public export resolves to the
// source file its dist target is built from, and nothing else does.
{
  const manifest = JSON.parse(await readFile(resolve(monorepoRoot, "tools", "framework", "package.json"), "utf8")) as { exports: Record<string, { default: string }> };
  for (const [key, target] of Object.entries(manifest.exports)) {
    const expected = target.default.replace("./dist/", "").replace(/\.js$/, ".ts");
    const mapped = checkoutFrameworkSource(`@clawforge/framework/${key.slice(2)}`);
    check(`export ${key} maps to its source file`, mapped !== undefined && mapped.replaceAll("\\", "/").endsWith(`/tools/framework/${expected}`), true);
  }
  check("an unknown subpath maps to nothing", checkoutFrameworkSource("@clawforge/framework/not-an-export"), undefined);
  check("a foreign package maps to nothing", checkoutFrameworkSource("json5"), undefined);
  check("the mapping table covers no more than the package's exports", Object.keys(FRAMEWORK_EXPORT_SOURCES).sort(), Object.keys(manifest.exports).sort());
}

// The gate's own resolver (a deployment's app.ts) answers with the same sources.
{
  const probe = await import("#framework/entry/delegate.ts");
  check("the gate resolver is exported for tools/clawforge.ts", typeof probe.resolveFrameworkFromSources, "function");
}

// The gate itself: a checkout deployment whose app.ts imports the public
// `@clawforge/framework/app` specifier loads only while tools/clawforge.ts registers
// resolveFrameworkFromSources() — a probe of the loader's own functions cannot tell.
{
  const name = "r31gateprobe";
  const appDir = resolve(monorepoRoot, "apps", name);
  await mkdir(appDir, { recursive: true });
  await writeFile(
    resolve(appDir, "app.ts"),
    [
      "import { defineApp } from \"@clawforge/framework/app\";",
      "export default defineApp({ name: \"r31gateprobe\", description: \"checkout gate probe\", commands: { ping: { summary: \"probe\" } } });",
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", "tools/clawforge.ts", "--app", name, "status"],
      { cwd: monorepoRoot, timeoutMs: 120_000 },
    );
    check(
      "a checkout deployment's app.ts importing @clawforge/framework/app loads through the gate",
      result.output.includes("cannot load deployment") === false && result.output.includes("Cannot find package '@clawforge/framework'") === false,
      true,
    );
    if (result.output.includes("cannot load deployment")) process.stderr.write(`    ${result.output.split("\n").filter((line) => /cannot load|Cannot find/.test(line)).join("\n    ")}\n`);
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
}

finish("recipe hook framework import");
