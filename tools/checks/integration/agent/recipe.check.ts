// Checks recipe loading and listing (tools/framework/service/recipe.ts) plus the guard rails in the
// `install` branch of tools/framework/commands/management/recipe.ts — a disabled recipe refuses to build
// without --force-disabled, and a declared variable that is not set refuses before it does.
//
// Real recipe.json files under a scratch directory, so loadRecipe/listRecipes run against
// actual disk I/O rather than a mock of node:fs. The scratch directory is removed in a
// finally block so a failed assertion does not leave litter.

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe, recipeActionIsReadOnly } from "#framework/commands/management/recipe.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import {
  listAgentBundleRecipes,
  loadRecipe,
  listRecipes,
  projectName,
  recipesDirectory,
  useRecipesDir,
} from "#framework/service/recipe.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

/** Runs `fn`, returns the thrown message. Records a failure (and returns "") if it did not throw. */
async function messageOf<T>(name: string, fn: () => Promise<T>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  failed += 1;
  process.stderr.write(`  FAIL ${name}\n    expected a throw, got none\n`);
  return "";
}

/** A fresh stub `ctx` whose stack() returns spies recording build/up calls. */
function stubContext(env: Record<string, string>): { ctx: Context; calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    settings: { env },
    runtime: {
      stack() {
        return {
          async build() {
            calls.push("build");
          },
          async up() {
            calls.push("up");
          },
          async down() {},
          async status() {},
          async followLogs() {},
          async readLogs(tail: string) {
            return `stubbed log tail=${tail}\n`;
          },
          async isRunning() {
            return false;
          },
        };
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

const scratch = resolve(tmpdir(), `clawforge-recipe-check-${Date.now()}`);

async function writeRecipe(name: string, json: unknown): Promise<void> {
  const dir = resolve(scratch, name);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "recipe.json"), JSON.stringify(json), "utf8");
}

try {
  await mkdir(scratch, { recursive: true });
  useRecipesDir(scratch);
  useDeployment(resolve(scratch, "example-deployment"));

  check("recipesDirectory reflects useRecipesDir", recipesDirectory(), scratch);

  await writeRecipe("plain", { description: "A plain recipe" });
  await writeRecipe("with-extras", {
    description: "Recipe with ports and variables",
    source: "https://example.com/with-extras",
    enabled: true,
    ports: [{ container: 80, host: 8080, description: "web" }],
    variables: { FOO: "needed for the web UI" },
  });
  await writeRecipe("disabled", {
    description: "A disabled recipe",
    enabled: false,
    disabledReason: "kept ready, not built by default",
  });
  await writeRecipe("empty-description", { description: "" });
  await mkdir(resolve(scratch, "no-recipe-json"), { recursive: true });
  // A directory with an agent bundle and no service definition: inspect knows it, install
  // does not, and it is what `recipe list` used to answer "no recipes yet" over.
  await mkdir(resolve(scratch, "bundle-only", "agent"), { recursive: true });
  await writeFile(
    resolve(scratch, "bundle-only", "agent", "config.json"),
    JSON.stringify({ agentId: "bundle-agent", mcpServerName: "bundle-mcp" }),
    "utf8",
  );
  await writeRecipe("needs-var", {
    description: "Needs a variable that is not set",
    variables: { API_KEY: "required by the upstream service" },
  });
  await writeRecipe("prepared", { description: "Prepared recipe" });
  await writeFile(
    resolve(scratch, "prepared", "prepare.ts"),
    "export async function prepare(ctx) { if (ctx.settings.env.PREPARE_TEST !== \"yes\") throw new Error(\"prepare hook did not receive the context\"); }\n" +
      "export async function afterStart(ctx) { if (ctx.settings.env.PREPARE_TEST !== \"yes\") throw new Error(\"afterStart hook did not receive the context\"); }\n",
    "utf8",
  );
  await writeFile(resolve(scratch, "prepared", "verify.ts"), "export async function verify() { return { ok: true, kind: \"verify\" }; }\n", "utf8");
  await writeFile(resolve(scratch, "prepared", "onboard.ts"), "export async function onboard() { return { ok: true, kind: \"onboard\" }; }\n", "utf8");

  // --- safeName runs before any file is touched -----------------------------------

  const escapeMessage = await messageOf("loadRecipe validates the name before touching disk", () =>
    loadRecipe("../escape"),
  );
  check(
    'the error comes from name validation, not "not found"',
    escapeMessage.includes("invalid recipe name") && !escapeMessage.includes("not found"),
    true,
  );

  // --- missing recipe.json ----------------------------------------------------------

  const missingMessage = await messageOf("loadRecipe on a directory without recipe.json", () =>
    loadRecipe("no-recipe-json"),
  );
  check('missing recipe.json error mentions "not found"', missingMessage.includes("not found"), true);

  // --- missing/empty description -----------------------------------------------------

  const emptyDescMessage = await messageOf("loadRecipe with an empty description", () =>
    loadRecipe("empty-description"),
  );
  check('empty description error mentions "description"', emptyDescMessage.includes("description"), true);

  // --- enabled default and override, disabledReason carried through ------------------

  const plain = await loadRecipe("plain");
  check("enabled defaults to true when omitted", plain.enabled, true);
  check("disabledReason is undefined by default", plain.disabledReason, undefined);
  check("ports is undefined when absent", plain.ports, undefined);
  check("variables is undefined when absent", plain.variables, undefined);
  check(
    "definitionPath is <dir>/<name>/compose.yml",
    plain.definitionPath,
    resolve(scratch, "plain", "compose.yml"),
  );

  const disabled = await loadRecipe("disabled");
  check('"enabled": false is honoured', disabled.enabled, false);
  check("disabledReason is carried through", disabled.disabledReason, "kept ready, not built by default");

  // --- ports/variables pass through as-is ---------------------------------------------

  const withExtras = await loadRecipe("with-extras");
  check("ports pass through as-is", withExtras.ports, [{ container: 80, host: 8080, description: "web" }]);
  check("variables pass through as-is", withExtras.variables, { FOO: "needed for the web UI" });
  check("source passes through", withExtras.source, "https://example.com/with-extras");
  check("recipe preparation hook is discovered", (await loadRecipe("prepared")).preparePath?.endsWith("prepare.ts"), true);
  check("recipe verification hook is discovered", (await loadRecipe("prepared")).verifyPath?.endsWith("verify.ts"), true);
  check("recipe onboarding hook is discovered", (await loadRecipe("prepared")).onboardPath?.endsWith("onboard.ts"), true);

  // --- listRecipes skips broken directories without aborting the scan ----------------

  const listed = await listRecipes();
  const names = listed.map((entry) => entry.name).sort();
  check(
    "listRecipes returns every loadable recipe and silently skips the broken ones",
    names,
    ["disabled", "needs-var", "plain", "prepared", "with-extras"],
  );

  check("bundle recipes are named separately from service recipes", await listAgentBundleRecipes(), ["bundle-only"]);

  // --- recipe list accounts for what it does not install --------------------------------------

  {
    const { ctx } = stubContext({});
    let listed = "";
    await withOutputSink((chunk) => {
      listed += chunk;
    }, () => recipe(ctx, ["list"]));
    check("the list still names the service recipes", listed.includes("with-extras") && listed.includes("plain"), true);
    check("the list names agent/MCP bundle recipes too", listed.includes("bundle-only"), true);
    check("the list points at where bundles are visible", listed.includes("inspect"), true);
    check("a deployment with recipes never says it has none", listed.includes("no recipes yet"), false);
  }

  // A bundle-only recipes directory is not "no recipes yet": the bundles are named, the
  // missing kind is named, and neither is confused with the other.
  {
    const bundleScratch = resolve(tmpdir(), `clawforge-recipe-bundles-${Date.now()}`);
    try {
      await mkdir(resolve(bundleScratch, "onboarding", "agent"), { recursive: true });
      await writeFile(
        resolve(bundleScratch, "onboarding", "agent", "config.json"),
        JSON.stringify({ agentId: "onboarding", mcpServerName: "onboarding-mcp" }),
        "utf8",
      );
      useRecipesDir(bundleScratch);
      const { ctx } = stubContext({});
      let listed = "";
      await withOutputSink((chunk) => {
        listed += chunk;
      }, () => recipe(ctx, ["list"]));
      check("a bundle-only deployment does not claim to have no recipes", listed.includes("no recipes yet"), false);
      check("the bundle-only list names the bundle", listed.includes("onboarding"), true);
      check("the bundle-only list says what is missing is service recipes", listed.includes("no service recipes yet"), true);
      check("the bundle-only list points at inspect", listed.includes("inspect"), true);
    } finally {
      useRecipesDir(scratch);
      await rm(bundleScratch, { recursive: true, force: true });
    }
  }

  // --- projectName ---------------------------------------------------------------------

  check(
    "projectName composes <app>-recipe-<name>",
    projectName("openclaw", "with-extras"),
    "openclaw-recipe-with-extras",
  );

  // --- install: disabled without --force-disabled never reaches the stack ------------

  {
    const { ctx, calls } = stubContext({});
    const message = await messageOf("install a disabled recipe without --force-disabled", () =>
      withOutputSink(() => {}, () => recipe(ctx, ["install", "disabled"])),
    );
    check('the die() message mentions "disabled"', message.includes("disabled"), true);
    check('the die() message mentions "--force-disabled"', message.includes("--force-disabled"), true);
    check("build/up were never called", calls, []);
  }

  // --- install: a missing declared variable dies before stack.build() ----------------

  {
    const { ctx, calls } = stubContext({});
    const message = await messageOf("install with a missing declared variable", () =>
      withOutputSink(() => {}, () => recipe(ctx, ["install", "needs-var"])),
    );
    check('the die() message mentions "variable"', message.toLowerCase().includes("variable"), true);
    check("build was never called before the missing variable is fixed", calls, []);
  }

  // --- install: an empty declared variable is treated the same as absent -------------

  {
    const { ctx, calls } = stubContext({ API_KEY: "" });
    const message = await messageOf("install with an empty declared variable", () =>
      withOutputSink(() => {}, () => recipe(ctx, ["install", "needs-var"])),
    );
    check("an empty value dies just like an absent one", message.length > 0, true);
    check("build was never called", calls, []);
  }

  // --- install: every guard satisfied reaches build() then up() ----------------------

  {
    const { ctx, calls } = stubContext({ API_KEY: "secret" });
    await withOutputSink(() => {}, () => recipe(ctx, ["install", "needs-var"]));
    check("build then up are called once every guard is satisfied", calls, ["build", "up"]);
  }

  {
    const { ctx, calls } = stubContext({ PREPARE_TEST: "yes" });
    await withOutputSink(() => {}, () => recipe(ctx, ["install", "prepared"]));
    check("an app-owned preparation hook runs before the sidecar build", calls, ["build", "up"]);
  }

  {
    const { ctx } = stubContext({});
    let output = "";
    await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["verify", "prepared"]));
    check("recipe verify exposes the app-owned machine result", output.includes('"kind":"verify"'), true);
    output = "";
    await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["onboard", "prepared"]));
    check("recipe onboard exposes the app-owned machine result", output.includes('"kind":"onboard"'), true);
  }

  // --- diagnose: bundles isRunning + readLogs + the verify.ts result in one report --------

  {
    const { ctx } = stubContext({});
    let output = "";
    await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["diagnose", "prepared"]));
    const report = JSON.parse(output) as Record<string, unknown>;
    check("diagnose reports whether the stack is running", report.running, false);
    check("diagnose carries the verify.ts hook's own result", report.verify, { ok: true, kind: "verify" });
    check("diagnose has no verifyError when the hook succeeds", report.verifyError, undefined);
    check("diagnose defaults --tail to 50", report.logs, "stubbed log tail=50\n");
  }

  {
    const { ctx } = stubContext({});
    let output = "";
    await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["diagnose", "prepared", "--tail", "5"]));
    const report = JSON.parse(output) as Record<string, unknown>;
    check("diagnose honours --tail", report.logs, "stubbed log tail=5\n");
  }

  {
    // "plain" has no verify.ts at all — diagnose must still report the rest, not die.
    const { ctx } = stubContext({});
    let output = "";
    await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["diagnose", "plain"]));
    const report = JSON.parse(output) as Record<string, unknown>;
    check("diagnose reports a missing verify.ts as data, not a thrown error", report.verifyError, "no verify.ts hook");
    check("diagnose still reports running/logs when there is no verify.ts", report.running, false);
  }

  check(
    "diagnose is not read-only: it runs verify.ts, the same reason verify itself is not",
    recipeActionIsReadOnly(["diagnose", "prepared"]),
    false,
  );

  {
    const importedRoot = resolve(tmpdir(), `clawforge-recipe-import-${Date.now()}`);
    const importedSource = resolve(importedRoot, "source-recipe");
    try {
      await mkdir(importedSource, { recursive: true });
      await writeFile(resolve(importedSource, "recipe.json"), JSON.stringify({ description: "Imported" }), "utf8");
      await writeFile(resolve(importedSource, ".env"), "SECRET=must-not-copy\n", "utf8");
      await mkdir(resolve(importedSource, "secrets"), { recursive: true });
      await writeFile(resolve(importedSource, "secrets", "local.env"), "SECRET=must-not-copy\n", "utf8");
      useRecipesDir(resolve(importedRoot, "target-recipes"));
      await mkdir(resolve(importedRoot, "target-recipes"), { recursive: true });
      const { ctx } = stubContext({});
      await withOutputSink(() => {}, () => recipe(ctx, ["import", importedSource, "imported"]));
      check("recipe import copies an app-owned recipe", await access(resolve(importedRoot, "target-recipes", "imported", "recipe.json")).then(() => true, () => false), true);
      check("recipe import excludes .env", await access(resolve(importedRoot, "target-recipes", "imported", ".env")).then(() => false, () => true), true);
      check("recipe import excludes secrets directory", await access(resolve(importedRoot, "target-recipes", "imported", "secrets")).then(() => false, () => true), true);
      const message = await messageOf("recipe import refuses overwrite", () => recipe(ctx, ["import", importedSource, "imported"]));
      check("recipe import names the existing destination", message.includes("already exists"), true);
    } finally {
      useRecipesDir(scratch);
      await rm(importedRoot, { recursive: true, force: true });
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all recipe checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
