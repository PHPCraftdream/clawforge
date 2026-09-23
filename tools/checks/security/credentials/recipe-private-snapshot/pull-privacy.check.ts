// The migrate publish path-policy wiring in pullLocked (state.ts): a staged migrate archive
// whose listing carries a recipe-declared private path is refused and deleted, never
// published; a clean listing still publishes with the same declarations present.
//
// The third scenario is P2-05 (docs/review-2026-09-22-xa-round-2.md): entries that merely
// share a string prefix with a declaration — the public sibling `vault-public` of a declared
// `vault`, the `.example` neighbor of a declared exact file — are valid content, and a
// migrate pull carrying only those must publish, not reject and delete.
//
// Real pull() is driven through the shared harness, and the stub listing is the seam —
// listing fidelity against real tar is snapshot.check.ts's job, not this file's.

import { pullScenario } from "../../../runtime/pull-harness.ts";
import { pull } from "#framework/commands/lifecycle/state.ts";
import { clearRecipesDir, recipesDirectory, useRecipesDir } from "#framework/service/recipe.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

useDeployment(resolve(monorepoRoot, "apps", "example app"));

// The migrate publish check consults installedRecipePrivatePaths(), which reads the real
// recipes root — so the declaration has to exist on disk. A one-shot root declaring
// recipe-private backs both scenarios below; the root active before is restored after.
const previousRecipesDir = (() => {
  try {
    return recipesDirectory();
  } catch {
    return undefined;
  }
})();

const recipes = await mkdtemp(join(tmpdir(), "clawforge-pp-migrate-"));
await mkdir(join(recipes, "declared"), { recursive: true });
await writeFile(join(recipes, "declared", "recipe.json"), JSON.stringify({ description: "declared", privatePaths: ["recipe-private", "vault", "config/private.env"] }), "utf8");

try {
  useRecipesDir(recipes);
  const scenario = pullScenario("private-path");
  const output: string[] = [];
  let message: string | undefined;
  try {
    await withOutputSink((chunk) => output.push(chunk), () => pull(scenario.ctx, []));
  } catch (error) {
    message = (error as Error).message;
  }
  check("the migrate refusal names the declared private path", output.join("").includes("recipe-private"), true);
  check("the migrate refusal says the snapshot was rejected and deleted", message?.includes("snapshot rejected and deleted"), true);
  check("the refused migrate pull releases its lock", scenario.lock(), false);
  check("the refused migrate snapshot is never published", [...scenario.files.keys()].filter((p) => p.includes("-state-") && p.endsWith(".tar.gz")).length, 1);

  // Over-refusal guard: the same declarations, but a listing without the declared path.
  const clean = pullScenario();
  let cleanThrew = false;
  try {
    await withOutputSink(() => {}, () => pull(clean.ctx, []));
  } catch {
    cleanThrew = true;
  }
  check(
    "a clean migrate listing still publishes with the declarations present",
    !cleanThrew && [...clean.files.keys()].filter((p) => p.includes("-state-") && p.endsWith(".tar.gz")).length === 2,
    true,
  );

  // P2-05: the auditor's scenario through the real command. The old bare-prefix matching
  // read `vault-public/notes.txt` as violating the declaration `vault`, rejected the
  // snapshot, and deleted it along with the fresh backup.
  const neighbors = pullScenario("private-neighbor");
  let neighborsThrew = false;
  try {
    await withOutputSink(() => {}, () => pull(neighbors.ctx, []));
  } catch {
    neighborsThrew = true;
  }
  check("a migrate pull with only shared-prefix public neighbors publishes", neighborsThrew, false);
  check("the neighbor snapshot is published, not deleted", [...neighbors.files.keys()].filter((p) => p.includes("-state-") && p.endsWith(".tar.gz")).length, 2);
} finally {
  if (previousRecipesDir === undefined) clearRecipesDir();
  else useRecipesDir(previousRecipesDir);
  await rm(recipes, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all recipe-private-snapshot checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
