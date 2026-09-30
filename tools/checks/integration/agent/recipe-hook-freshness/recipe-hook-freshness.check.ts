// Hook freshness for recipe hooks, driven through the same in-process dispatcher the MCP
// calls dispatch into: hook modules are cached against
// the checksum of their file, so an edit between two calls of one long-lived process —
// the MCP-session shape — takes effect on the second call instead of serving the first
// load's module forever. Split out of recipe.check.ts, which outgrew the check-file line
// limit when this landed; the end-to-end server variant that swaps the hook between two
// calls of one real stdio server lives in
// tools/checks/integration/agent/recipe-hook-freshness-server.check.ts. The import-graph and
// loader scenarios are import-graph.check.ts and loader-isolation.check.ts.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { scratchDeployment, stubContext } from "./fixture.ts";
const { freshRoot, outerRecipes } = scratchDeployment();
// Cross-recipe independence: the cache is keyed by hook file path, so two recipes' hooks —
// both imported into one long-lived process, the normal shape of an MCP session serving
// several recipes — must each keep answering their own module: never recipe B's cached
// module for recipe A (cache poisoning), neither on first load, nor after the other
// recipe's hook ran, nor after only one of the two hooks is edited on disk.
{
  const crossRoot = resolve(tmpdir(), `clawforge-recipe-hook-cross-${Date.now()}`);
  try {
    await mkdir(crossRoot, { recursive: true });
    await mkdir(resolve(crossRoot, "fresh-a"), { recursive: true });
    await mkdir(resolve(crossRoot, "fresh-b"), { recursive: true });
    await writeFile(resolve(crossRoot, "fresh-a", "recipe.json"), JSON.stringify({ description: "Cross probe A" }), "utf8");
    await writeFile(resolve(crossRoot, "fresh-b", "recipe.json"), JSON.stringify({ description: "Cross probe B" }), "utf8");
    await writeFile(resolve(crossRoot, "fresh-a", "verify.ts"), "export async function verify() { return { ok: true, revision: 100 }; }\n", "utf8");
    await writeFile(resolve(crossRoot, "fresh-b", "verify.ts"), "export async function verify() { return { ok: true, revision: 200 }; }\n", "utf8");
    useRecipesDir(crossRoot);
    const { ctx } = stubContext({});
    const verifyOnce = async (name: string): Promise<{ revision?: number }> => {
      let output = "";
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["verify", name]));
      return JSON.parse(output) as { revision?: number };
    };

    check("cross: the first verify of recipe A answers its own revision", (await verifyOnce("fresh-a")).revision, 100);
    check("cross: recipe B's first verify answers B's revision, not A's cached module", (await verifyOnce("fresh-b")).revision, 200);
    check("cross: recipe A asked again after B still answers its own revision", (await verifyOnce("fresh-a")).revision, 100);

    await writeFile(resolve(crossRoot, "fresh-a", "verify.ts"), "export async function verify() { return { ok: true, revision: 300 }; }\n", "utf8");
    check("cross: an edit to A's hook on disk is picked up", (await verifyOnce("fresh-a")).revision, 300);
    check("cross: B's hook still answers B's own untouched value", (await verifyOnce("fresh-b")).revision, 200);
  } finally {
    useRecipesDir(outerRecipes);
    await rm(crossRoot, { recursive: true, force: true });
  }
}

try {
  await mkdir(outerRecipes, { recursive: true });
  useRecipesDir(outerRecipes);

  await mkdir(resolve(freshRoot, "fresh"), { recursive: true });
  await writeFile(resolve(freshRoot, "fresh", "recipe.json"), JSON.stringify({ description: "Freshness probe" }), "utf8");
  await writeFile(resolve(freshRoot, "fresh", "verify.ts"), "export async function verify() { return { ok: true, revision: 1 }; }\n", "utf8");
  useRecipesDir(freshRoot);
  const { ctx } = stubContext({});
  const verifyOnce = async (): Promise<{ revision?: number }> => {
    let output = "";
    await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["verify", "fresh"]));
    return JSON.parse(output) as { revision?: number };
  };

  check("the first verify answers hook A's payload", (await verifyOnce()).revision, 1);
  await writeFile(resolve(freshRoot, "fresh", "verify.ts"), "export async function verify() { return { ok: true, revision: 2 }; }\n", "utf8");
  check("a second verify in the same process answers the edited hook, not the first load's cached module", (await verifyOnce()).revision, 2);
  check("with the file unchanged the fresh module keeps serving", (await verifyOnce()).revision, 2);

  // The same contract for prepare.ts, which install runs before the build: swap the
  // hook, and the next install in this process runs the new one.
  const markerPath = resolve(freshRoot, "markers.txt");
  const writePrepare = (marker: string): Promise<void> =>
    writeFile(
      resolve(freshRoot, "fresh", "prepare.ts"),
      "import { appendFile } from \"node:fs/promises\";\n" +
        `export async function prepare() { await appendFile(${JSON.stringify(markerPath)}, ${JSON.stringify(marker)}, "utf8"); }\n`,
      "utf8",
    );
  await writePrepare("A\n");
  const { ctx: installCtx, calls } = stubContext({});
  await withOutputSink(() => {}, () => recipe(installCtx, ["install", "fresh"]));
  check("the first install ran prepare hook A and built the stack", calls, ["build", "up"]);
  check("hook A wrote its marker", await readFile(markerPath, "utf8"), "A\n");
  await writePrepare("B\n");
  await withOutputSink(() => {}, () => recipe(installCtx, ["install", "fresh"]));
  check("a second install in the same process ran the edited hook B", await readFile(markerPath, "utf8"), "A\nB\n");
} finally {
  useRecipesDir(outerRecipes);
  await rm(freshRoot, { recursive: true, force: true });
}

finish("recipe hook freshness");
