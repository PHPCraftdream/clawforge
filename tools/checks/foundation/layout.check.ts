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

// ci.yml's Windows job runs plain `npm run check` (capability probing — see
// tools/checks/kit/capabilities/ — skips what the host lacks), not a hand-maintained list of
// check paths: a moved or renamed check must not silently drop out of Windows CI again.
const workflow = await readFile(resolve(monorepoRoot, ".github", "workflows", "ci.yml"), "utf8");
assert.ok(!workflow.includes("tools/checks/"), "ci.yml names a tools/checks/ path — the hand-maintained check list must not come back");
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

// shellQuote (core/io/shell.ts) and regexEscape (core/io/log.ts) each guard an invariant —
// POSIX argument safety, a literal-only regex match — that a second, independently
// maintained copy could silently drift from. Counting every `function <name>(` site keeps
// each one singular without trusting callers to remember to import rather than reimplement.
const SINGLE_DEFINITION: Record<string, RegExp> = {
  shellQuote: /(?:export )?function shellQuote\(/g,
  regexEscape: /(?:export )?function regexEscape\(/g,
};
async function auditSingleDefinitionSites(dir: string, counts: Map<string, string[]>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "dist" && entry.name !== "node_modules") {
      await auditSingleDefinitionSites(full, counts);
      continue;
    }
    if (!entry.isFile() || !/\.(?:ts|js)$/.test(entry.name)) continue;
    const content = await readFile(full, "utf8");
    for (const [name, pattern] of Object.entries(SINGLE_DEFINITION)) {
      if (content.match(pattern) !== null) counts.get(name)!.push(full);
    }
  }
}
const definitionSites = new Map<string, string[]>(Object.keys(SINGLE_DEFINITION).map((name) => [name, []]));
await auditSingleDefinitionSites(resolve(monorepoRoot, "tools", "framework"), definitionSites);
for (const [name, sites] of definitionSites) {
  assert.equal(
    sites.length,
    1,
    `expected exactly one definition of ${name} in tools/framework, found ${sites.length}: ${sites.join(", ")}`,
  );
}
process.stderr.write("shellQuote and regexEscape each have exactly one definition\n");
