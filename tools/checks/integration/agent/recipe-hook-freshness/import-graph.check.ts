// Hook freshness through the import graph: an edit to a relative import or to a
// package.json `imports` target (or the map itself) is visible on the next call of the same
// process, and anything the graph cannot safely track is refused before the hook executes.

import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";
import { scratchDeployment, stubContext } from "./fixture.ts";

/** Creates a symlink, answering false instead of throwing — Windows without developer mode
 *  (or elevated privileges) refuses link creation, and the symlink-escape probe must skip
 *  there, not fail (same degrade as recipe-portable-content.check.ts's trySymlink). */
async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "file");
    return true;
  } catch {
    return false;
  }
}
const { outerRecipes } = scratchDeployment();
// Helper-file freshness: editing a relative import the
// of the same process. Before the fix the versioned checksum covered only the hook file
// itself; shared.ts stayed at an unversioned URL and kept serving its first-loaded content
// forever, so a long-lived MCP session and a freshly started CLI process disagreed after the
// same edit to shared.ts, with the hook file untouched. dependencyGraphChecksum folds every
// relative import the hook transitively reaches into the versioned URL, so this reproduces
// the bug's exact shape: only the helper changes between two calls of one process.
{
  const helperRoot = resolve(tmpdir(), `clawforge-recipe-hook-helper-${Date.now()}`);
  try {
    await mkdir(resolve(helperRoot, "helper"), { recursive: true });
    await writeFile(resolve(helperRoot, "helper", "recipe.json"), JSON.stringify({ description: "Helper freshness probe" }), "utf8");
    await writeFile(resolve(helperRoot, "helper", "shared.ts"), "export const REVISION = 1;\n", "utf8");
    await writeFile(
      resolve(helperRoot, "helper", "verify.ts"),
      "const importPattern = /import\\\\(computed\\\\)/.source;\nexport async function verify() { const { REVISION } = await import /* dynamic import comment */ ( /* specifier comment */ \"./shared.ts?variant=1\"); return { ok: true, revision: REVISION }; }\n",
      "utf8",
    );
    useRecipesDir(helperRoot);
    const { ctx } = stubContext({});
    const verifyOnce = async (): Promise<{ revision?: number }> => {
      let output = "";
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["verify", "helper"]));
      return JSON.parse(output) as { revision?: number };
    };

    check("helper: the first verify answers shared.ts's first revision", (await verifyOnce()).revision, 1);
    await writeFile(resolve(helperRoot, "helper", "shared.ts"), "export const REVISION = 2;\n", "utf8");
    check(
      "helper: a second verify in the same process, after only shared.ts (not verify.ts) changed, answers the edited helper",
      (await verifyOnce()).revision,
      2,
    );
    check("helper: with nothing further changed the fresh module keeps serving", (await verifyOnce()).revision, 2);

    await writeFile(
      resolve(helperRoot, "helper", "verify.ts"),
      "import { REVISION } /* import comment */ from /* specifier comment */ \"./shared.ts\";\nexport async function verify() { return { ok: true, revision: REVISION }; }\n",
      "utf8",
    );
    check("helper: comments around a static from import load and include the helper", (await verifyOnce()).revision, 2);
    await writeFile(resolve(helperRoot, "helper", "shared.ts"), "export const REVISION = 3;\n", "utf8");
    check("helper: a static helper edit is visible in the same process", (await verifyOnce()).revision, 3);

    await writeFile(
      resolve(helperRoot, "helper", "verify.ts"),
      "export async function verify() { const { REVISION } = await import /* comment */ (\"./shared.ts\"); return { ok: true, revision: REVISION }; }\n",
      "utf8",
    );
    check("helper: comments between import and its call do not break dynamic imports", (await verifyOnce()).revision, 3);
    await writeFile(resolve(helperRoot, "helper", "shared.ts"), "export const REVISION = 4;\n", "utf8");
    check("helper: a commented dynamic helper edit is visible in the same process", (await verifyOnce()).revision, 4);

    await writeFile(
      resolve(helperRoot, "helper", "verify.ts"),
      "const helper = \"./shared.ts\";\nexport async function verify() { const { REVISION } = await import /* comment */ (helper); return { ok: true, revision: REVISION }; }\n",
      "utf8",
    );
    let computedImportError = "";
    try {
      await verifyOnce();
    } catch (error) {
      computedImportError = error instanceof Error ? error.message : String(error);
    }
    check("helper: computed dynamic imports fail clearly instead of escaping freshness tracking", computedImportError.includes("computed dynamic import"), true);

    await writeFile(resolve(helperRoot, "helper", "deep.ts"), "export const REVISION = 10;\n", "utf8");
    await writeFile(resolve(helperRoot, "helper", "nested.ts"), "export { REVISION } from \"./deep.ts\";\n", "utf8");
    await writeFile(resolve(helperRoot, "helper", "bridge.ts"), "export { REVISION } from \"./nested.ts\";\n", "utf8");
    await writeFile(
      resolve(helperRoot, "helper", "verify.ts"),
      "import { REVISION } from \"./bridge.ts?variant=1\";\nexport async function verify() { return { ok: true, revision: REVISION }; }\n",
      "utf8",
    );
    check("helper: a query-bearing relative import starts a versioned nested graph", (await verifyOnce()).revision, 10);
    await writeFile(resolve(helperRoot, "helper", "deep.ts"), "export const REVISION = 11;\n", "utf8");
    check("helper: nested edits behind a query-bearing relative import are fresh", (await verifyOnce()).revision, 11);
  } finally {
    useRecipesDir(outerRecipes);
    await rm(helperRoot, { recursive: true, force: true });
  }
}

// Package-internal `#imports`: resolved through the recipe's own nearest
// package.json `imports` map — a supported string or node/import/default target inside the
// recipe directory is folded into the freshness graph (package.json AND its resolved
// target), so editing the helper OR repointing the import map is picked up on the very next
// call of the same process, exactly like a plain relative import. Anything the graph cannot
// safely track — a bare package target, an absolute path, an escape via `..` or a symlink,
// an unsupported condition — is refused before the hook ever executes, instead of always
// failing closed regardless of shape.
{
  const aliasRoot = resolve(tmpdir(), `clawforge-recipe-hook-alias-${Date.now()}`);
  try {
    await mkdir(resolve(aliasRoot, "alias"), { recursive: true });
    await writeFile(resolve(aliasRoot, "alias", "recipe.json"), JSON.stringify({ description: "Package alias freshness probe" }), "utf8");
    await writeFile(
      resolve(aliasRoot, "alias", "package.json"),
      JSON.stringify({ type: "module", imports: { "#helper": "./helper.ts" } }),
      "utf8",
    );
    await writeFile(resolve(aliasRoot, "alias", "helper.ts"), "export const REVISION = 1;\n", "utf8");
    await writeFile(
      resolve(aliasRoot, "alias", "verify.ts"),
      "import { REVISION } from \"#helper\";\nexport async function verify() { return { ok: true, revision: REVISION }; }\n",
      "utf8",
    );
    useRecipesDir(aliasRoot);
    const { ctx } = stubContext({});
    const verifyOnce = async (): Promise<{ revision?: number }> => {
      let output = "";
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["verify", "alias"]));
      return JSON.parse(output) as { revision?: number };
    };

    check("package imports: #helper resolves through the recipe's own package.json imports map", (await verifyOnce()).revision, 1);

    await writeFile(resolve(aliasRoot, "alias", "helper.ts"), "export const REVISION = 2;\n", "utf8");
    check("package imports: an edit to the #helper target is picked up in the same process", (await verifyOnce()).revision, 2);

    await writeFile(resolve(aliasRoot, "alias", "helper-two.ts"), "export const REVISION = 3;\n", "utf8");
    await writeFile(
      resolve(aliasRoot, "alias", "package.json"),
      JSON.stringify({ type: "module", imports: { "#helper": "./helper-two.ts" } }),
      "utf8",
    );
    check("package imports: repointing the import map itself is picked up in the same process", (await verifyOnce()).revision, 3);

    // Nested `#` from a helper: helper-two.ts itself imports through a second alias.
    await writeFile(resolve(aliasRoot, "alias", "nested.ts"), "export const REVISION = 10;\n", "utf8");
    await writeFile(resolve(aliasRoot, "alias", "helper-two.ts"), "export { REVISION } from \"#nested\";\n", "utf8");
    await writeFile(
      resolve(aliasRoot, "alias", "package.json"),
      JSON.stringify({ type: "module", imports: { "#helper": "./helper-two.ts", "#nested": "./nested.ts" } }),
      "utf8",
    );
    check("package imports: a #specifier reached from another helper resolves too", (await verifyOnce()).revision, 10);
    await writeFile(resolve(aliasRoot, "alias", "nested.ts"), "export const REVISION = 11;\n", "utf8");
    check("package imports: an edit behind a nested #specifier is picked up in the same process", (await verifyOnce()).revision, 11);

    // node/import/default conditions: the first key present wins, matching Node's own
    // resolver for a plain ESM hook running under Node with no custom --conditions.
    await writeFile(resolve(aliasRoot, "alias", "helper-node.ts"), "export const REVISION = 20;\n", "utf8");
    await writeFile(resolve(aliasRoot, "alias", "helper-default.ts"), "export const REVISION = 21;\n", "utf8");
    await writeFile(
      resolve(aliasRoot, "alias", "package.json"),
      JSON.stringify({ type: "module", imports: { "#helper": { node: "./helper-node.ts", default: "./helper-default.ts" } } }),
      "utf8",
    );
    check("package imports: a {node,default} conditional target resolves through the node condition", (await verifyOnce()).revision, 20);
    await writeFile(resolve(aliasRoot, "alias", "helper-node.ts"), "export const REVISION = 22;\n", "utf8");
    check("package imports: an edit behind a conditional target is picked up in the same process", (await verifyOnce()).revision, 22);

    // Unsupported condition: rejected explicitly rather than guessed at.
    await writeFile(
      resolve(aliasRoot, "alias", "package.json"),
      JSON.stringify({ type: "module", imports: { "#helper": { browser: "./helper-node.ts", default: "./helper-default.ts" } } }),
      "utf8",
    );
    let unsupportedConditionError = "";
    try {
      await verifyOnce();
    } catch (error) {
      unsupportedConditionError = error instanceof Error ? error.message : String(error);
    }
    check(
      "package imports: an unsupported condition (e.g. browser) is rejected with a clear message",
      unsupportedConditionError.includes("unsupported condition"),
      true,
    );

    // Escape attempts: each rejected explicitly, and never evaluated.
    const escapeMarker = resolve(aliasRoot, "escape-evaluated.txt");
    await writeFile(
      resolve(aliasRoot, "outside.ts"),
      `import { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(escapeMarker)}, "ran");\nexport const REVISION = 666;\n`,
      "utf8",
    );
    const rejects = async (importsMap: Record<string, unknown>): Promise<string> => {
      await writeFile(resolve(aliasRoot, "alias", "package.json"), JSON.stringify({ type: "module", imports: importsMap }), "utf8");
      try {
        await verifyOnce();
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    check(
      "package imports: a target escaping via .. is rejected",
      (await rejects({ "#helper": "../outside.ts" })).includes("escapes the recipe directory"),
      true,
    );
    let escapeEvaluated = true;
    try {
      await access(escapeMarker);
    } catch {
      escapeEvaluated = false;
    }
    check("package imports: the rejected .. escape target was never evaluated", escapeEvaluated, false);

    const absoluteTarget = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd";
    check(
      "package imports: an absolute path target is rejected",
      (await rejects({ "#helper": absoluteTarget })).includes("absolute path"),
      true,
    );

    check(
      "package imports: a bare package target is rejected",
      (await rejects({ "#helper": "some-installed-package" })).includes("bare package specifier"),
      true,
    );

    // Symlink escape: skipped where the platform/privileges refuse symlink creation
    // (Windows without developer mode) — declared as the symlink capability, with the
    // same degrade-not-fail pattern as recipe-portable-content.check.ts's trySymlink.
    const linkPath = resolve(aliasRoot, "alias", "escape-link.ts");
    await requires("symlink", "package imports: a target resolving through a symlink out of the recipe directory is rejected", async () => {
    const linked = await trySymlink(resolve(aliasRoot, "outside.ts"), linkPath);
    if (linked) {
      check(
        "package imports: a target resolving through a symlink out of the recipe directory is rejected",
        (await rejects({ "#helper": "./escape-link.ts" })).includes("symlink"),
        true,
      );
    }
    });
  } finally {
    useRecipesDir(outerRecipes);
    await rm(aliasRoot, { recursive: true, force: true });
  }
}

finish("recipe hook freshness import graph");
