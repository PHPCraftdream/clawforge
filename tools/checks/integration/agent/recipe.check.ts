// Checks recipe loading and listing (tools/framework/service/recipe.ts) plus the guard rails in the
// `install` branch of tools/framework/commands/management/recipe.ts — a disabled recipe refuses to build
// without --force-disabled, and a declared variable that is not set refuses before it does.
//
// Real recipe.json files under a scratch directory, so loadRecipe/listRecipes run against
// actual disk I/O rather than a mock of node:fs. The scratch directory is removed in a
// finally block so a failed assertion does not leave litter.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import {
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
  await writeRecipe("needs-var", {
    description: "Needs a variable that is not set",
    variables: { API_KEY: "required by the upstream service" },
  });

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

  // --- listRecipes skips broken directories without aborting the scan ----------------

  const listed = await listRecipes();
  const names = listed.map((entry) => entry.name).sort();
  check(
    "listRecipes returns every loadable recipe and silently skips the broken ones",
    names,
    ["disabled", "needs-var", "plain", "with-extras"],
  );

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
} finally {
  await rm(scratch, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all recipe checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
