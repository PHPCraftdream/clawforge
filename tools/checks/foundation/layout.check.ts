import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";

const MAX_LINES = 700;

async function inspect(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const source = entries.some((entry) => entry.isFile() && /\.(?:ts|tsx|js|jsx)$/.test(entry.name));
  if (source) {
    assert.ok(
      entries.length <= 7,
      `${dir} has ${entries.length} direct entries — the limit is not raised for this; ` +
        "regroup by meaning into a subdirectory instead (see CONTRIBUTING.md, \"Source layout\")",
    );
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isFile() && /\.(?:ts|js)$/.test(entry.name)) {
      const content = await readFile(full, "utf8");
      const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      assert.ok(lines <= MAX_LINES, `${full} is ${lines} lines (limit ${MAX_LINES})`);
    }
    if (entry.isDirectory() && entry.name !== "dist" && entry.name !== "node_modules") await inspect(full);
  }
}

await inspect(resolve(monorepoRoot, "tools", "framework"));
await inspect(resolve(monorepoRoot, "tools", "checks"));

// The Windows CI job lists its checks by path; a moved check must not break it only in CI.
const workflow = await readFile(resolve(monorepoRoot, ".github", "workflows", "ci.yml"), "utf8");
const listed = [...workflow.matchAll(/^\s+(tools\/checks\/\S+\.check\.ts)\s*$/gm)].map((match) => match[1]!);
assert.ok(listed.length > 0, "ci.yml lists no check files — the pattern above no longer matches its format");
const missing: string[] = [];
for (const path of listed) {
  await readFile(resolve(monorepoRoot, path)).catch(() => missing.push(path));
}
assert.deepEqual(missing, [], "ci.yml names check files that do not exist (moved or deleted)");
process.stderr.write("source layout limits passed\n");

// service/recipe.ts's listRecipeDirectories() is the framework's one readdir of a recipes
// directory: everything else turning an unreadable root into a silent "no recipes" is the
// gap this whole file exists to close. A second direct readdir(recipesDir()) or
// readdir(recipesDirectory()) anywhere else would reopen it outside review.
const RECIPE_READDIR = /readdir\(\s*recipesDir(?:ectory)?\(\)/;
async function auditRecipeReaddirSites(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "dist" && entry.name !== "node_modules") {
      await auditRecipeReaddirSites(full);
      continue;
    }
    if (!entry.isFile() || !/\.(?:ts|js)$/.test(entry.name)) continue;
    const content = await readFile(full, "utf8");
    assert.ok(
      !RECIPE_READDIR.test(content),
      `${full} reads the recipes directory directly — route it through service/recipe.ts's listRecipeDirectories() instead`,
    );
  }
}
await auditRecipeReaddirSites(resolve(monorepoRoot, "tools", "framework"));
process.stderr.write("no second readdir of the recipes directory outside listRecipeDirectories\n");
