// Recipe manifests and action guards run against isolated files and a modeled locked target.

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe, recipeActionIsReadOnly } from "#framework/commands/management/recipe/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { guarded, lockPath, readLockHolder, takeLock, withInstanceLock } from "#framework/runtime/instance-lock.ts";
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

/** Models exclusive directory claims and stack calls. */
function stubContext(env: Record<string, string>): { ctx: Context; calls: string[]; files: Map<string, string>; dirs: Set<string> } {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const ctx = {
    settings: { env, dataDir: "/srv/clawforge-recipe-check" },
    transport: {
      description: "stub",
      async exec(command: string, args: string[]) {
        if (command === "mkdir" && args[0] !== "-p" && args[0] !== "-m") {
          const target = args[args.length - 1];
          if (dirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
          dirs.add(target);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mkdir") {
          dirs.add(args[args.length - 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rmdir") {
          const target = args[args.length - 1];
          const hasFile = [...files.keys()].some((entry) => entry.startsWith(`${target}/`));
          const hasChild = [...dirs].some((entry) => entry.startsWith(`${target}/`));
          if (hasFile || hasChild) return { code: 1, stdout: "", stderr: "Directory not empty" };
          dirs.delete(target);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") {
          return { code: dirs.has(args[1]) ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "mv") {
          const [source, dest] = args; // atomic move: fails once the source is gone, like real `rename`
          if (!dirs.has(source)) return { code: 1, stdout: "", stderr: "No such file or directory" };
          for (const d of [...dirs].filter((e) => e === source || e.startsWith(`${source}/`))) { dirs.delete(d); dirs.add(dest + d.slice(source.length)); }
          for (const [k, v] of [...files].filter(([k]) => k === source || k.startsWith(`${source}/`))) { files.delete(k); files.set(dest + k.slice(source.length), v); }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "ln") {
          const [source, dest] = args;
          if (source === undefined || dest === undefined || !files.has(source) || files.has(dest) || dirs.has(dest)) {
            return { code: 1, stdout: "", stderr: "File exists" };
          }
          files.set(dest, files.get(source)!);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rm") {
          const target = args[args.length - 1];
          for (const d of [...dirs].filter((e) => e === target || e.startsWith(`${target}/`))) dirs.delete(d);
          for (const k of [...files.keys()].filter((e) => e === target || e.startsWith(`${target}/`))) files.delete(k);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
      },
      async remove(path: string): Promise<void> {
        files.delete(path);
        dirs.delete(path);
        for (const key of files.keys()) {
          if (key.startsWith(`${path}/`)) files.delete(key);
        }
        for (const key of dirs) {
          if (key.startsWith(`${path}/`)) dirs.delete(key);
        }
      },
      async listFiles(path: string): Promise<string[]> {
        const prefix = `${path}/`;
        return [...files.keys()].filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
      },
    },
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
          async serviceStates() {
            return { app: { running: true } };
          },
        };
      },
    },
  } as unknown as Context;
  return { ctx, calls, files, dirs };
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

  // --- mutating actions share apply's lock; nested actions reuse it --------------------

  {
    const { ctx, calls, files, dirs } = stubContext({});
    const held = await takeLock(ctx, "backup", "op-backup");
    const holderBefore = files.get(`${lockPath(ctx)}/holder.json`);
    const message = await messageOf("install while another operation holds the lock", () =>
      withOutputSink(() => {}, () => recipe(ctx, ["install", "plain"])),
    );
    check('the refusal names the conflict', message.includes("another operation is changing this instance"), true);
    check("the refusal names what the holder is doing", message.includes("backup"), true);
    check("nothing was built or started under someone else's lock", calls, []);
    check("the holder file is untouched by the refusal", files.get(`${lockPath(ctx)}/holder.json`), holderBefore);
    check("the lock directory still exists after the refusal", dirs.has(lockPath(ctx)), true);
    await held.release();
  }

  {
    const { ctx, calls } = stubContext({});
    await writeRecipe("marker", { description: "Writes a marker in prepare" });
    const markerPath = resolve(scratch, "marker-writes.txt");
    await writeFile(
      resolve(scratch, "marker", "prepare.ts"),
      "import { appendFile } from \"node:fs/promises\";\n" +
        `export async function prepare() { await appendFile(${JSON.stringify(markerPath)}, "hook ran\\n", "utf8"); }\n`,
      "utf8",
    );
    const held = await takeLock(ctx, "backup", "op-backup");
    await messageOf("install of a hook-writing recipe while another operation holds the lock", () =>
      withOutputSink(() => {}, () => recipe(ctx, ["install", "marker"])),
    );
    check(
      "the refusal happens before any hook code runs",
      await access(markerPath).then(() => true, () => false),
      false,
    );
    await held.release();
    await withOutputSink(() => {}, () => recipe(ctx, ["install", "marker"]));
    check("once the lock is free, install runs the hook and the stack", calls, ["build", "up"]);
    check("the prepare hook wrote its marker inside that install", await access(markerPath).then(() => true, () => false), true);
  }

  {
    const { ctx, calls } = stubContext({ PREPARE_TEST: "yes" });
    const originalExec = ctx.transport.exec;
    let lockClaims = 0;
    ctx.transport.exec = async (command: string, args: string[]) => {
      if (command === "mkdir" && args[0] === lockPath(ctx)) lockClaims += 1;
      return originalExec(command, args);
    };
    await withOutputSink(() => {}, () =>
      withInstanceLock(ctx, "apply", "op-outer", {}, async () => {
        await recipe(ctx, ["install", "prepared"]);
      }),
    );
    check("a recipe install nested in a locked operation still builds and starts", calls, ["build", "up"]);
    check("the nested install rode the outer operation's lock", lockClaims, 1);
    check("the lock went away with the outer operation, not kept by the step", await readLockHolder(ctx), undefined);
  }

  {
    const { ctx, calls } = stubContext({ PREPARE_TEST: "yes" });
    const originalExec = ctx.transport.exec;
    let lockClaims = 0;
    ctx.transport.exec = async (command: string, args: string[]) => {
      if (command === "mkdir" && args[0] === lockPath(ctx)) lockClaims += 1;
      return originalExec(command, args);
    };
    let verifyOut = "";
    await guarded(ctx, "apply", [], async () => {
      await withOutputSink((chunk) => {
        verifyOut += chunk;
      }, () => recipe(ctx, ["verify", "prepared"]));
    });
    check("a guarded outer lets the verify hook run as a nested step", verifyOut.includes('"kind":"verify"'), true);
    check("the nested verify rode that same single lock claim", lockClaims, 1);
    check("a nested verify builds and starts nothing", calls, []);
    check("and the lock is released with the outer guard", await readLockHolder(ctx), undefined);
  }

  {
    const { ctx, files } = stubContext({});
    const held = await takeLock(ctx, "backup", "op-backup");
    let statusOut = "";
    await withOutputSink((chunk) => {
      statusOut += chunk;
    }, () => recipe(ctx, ["status", "plain"]));
    let logsOut = "";
    await withOutputSink((chunk) => {
      logsOut += chunk;
    }, () => recipe(ctx, ["logs", "plain"]));
    check("status runs while another operation holds the lock", statusOut.includes("not running"), true);
    check("logs runs while another operation holds the lock", logsOut.includes("stubbed log tail=100"), true);
    check("read-only actions took no lock and refused nothing", (await readLockHolder(ctx))?.operationId, "op-backup");
    check("the foreign lock's own record is untouched", files.has(`${lockPath(ctx)}/holder.json`), true);

    // import is the one action that never gates: it copies into the repository's recipes/
    // directory and must go through while another operation is changing the target.
    const importRoot = resolve(tmpdir(), `clawforge-recipe-import-${Date.now()}`);
    const importedSource = resolve(importRoot, "source-recipe");
    try {
      await mkdir(importedSource, { recursive: true });
      await writeFile(resolve(importedSource, "recipe.json"), JSON.stringify({ description: "Imported under a lock" }), "utf8");
      await withOutputSink(() => {}, () => recipe(ctx, ["import", importedSource, "imported-under-lock"]));
      check(
        "import succeeds under a foreign lock: it copies into the repository and never touches the target",
        await access(resolve(scratch, "imported-under-lock", "recipe.json")).then(() => true, () => false),
        true,
      );
      check("import took no lock of its own: the holder is still op-backup", (await readLockHolder(ctx))?.operationId, "op-backup");
    } finally {
      await rm(importRoot, { recursive: true, force: true });
    }
    await held.release();
  }

  {
    const { ctx } = stubContext({});
    const held = await takeLock(ctx, "backup", "op-backup");
    for (const action of ["verify", "onboard", "diagnose"] as const) {
      const message = await messageOf(`${action} while another operation holds the lock`, () =>
        withOutputSink(() => {}, () => recipe(ctx, [action, "prepared"])),
      );
      check(`${action} refuses like install does`, message.includes("another operation is changing this instance"), true);
    }
    const removeMessage = await messageOf("remove while another operation holds the lock", () =>
      withOutputSink(() => {}, () => recipe(ctx, ["remove", "plain"])),
    );
    check("remove refuses like install does", removeMessage.includes("another operation is changing this instance"), true);
    await held.release();
  }

  {
    const { ctx, calls } = stubContext({});
    const held = await takeLock(ctx, "backup", "op-backup");
    await withOutputSink(() => {}, () => recipe(ctx, ["install", "plain", "--break-lock"]));
    check("--break-lock installs through a foreign lock", calls, ["build", "up"]);
    check("the install held the lock only for its own run", await readLockHolder(ctx), undefined);
    await held.release();
    check("the old owner's late release is a harmless no-op", await readLockHolder(ctx), undefined);
  }

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

  // The exclusion contract: the framework's generic policy covers its own conventions; the
  // application's own credential files are excluded because the source's recipe.json
  // declares them under privateFiles — the two names the dispatcher used to hardcode
  // included, so no name the old hardcoded blacklist excluded is copied now.
  {
    const policyRoot = resolve(tmpdir(), `clawforge-recipe-import-policy-${Date.now()}`);
    const source = resolve(policyRoot, "source-recipe");
    try {
      await mkdir(resolve(source, "secrets"), { recursive: true });
      await mkdir(resolve(source, "nested", "keys"), { recursive: true });
      await writeFile(
        resolve(source, "recipe.json"),
        JSON.stringify({ description: "Policy fixture", privateFiles: ["proxy-credentials.env", "registry.users.ktav", "nested/keys"] }),
        "utf8",
      );
      const excluded = [".env", ".env.local", "secrets/local.env", "gateway.token", "db.secrets.env", "proxy-credentials.env", "registry.users.ktav", "nested/keys/credentials.env"];
      for (const name of excluded) await writeFile(resolve(source, name), "FIXTURE-CREDENTIAL\n", "utf8");
      await writeFile(resolve(source, "compose.yml"), "services: {}\n", "utf8");
      useRecipesDir(resolve(policyRoot, "recipes"));
      await mkdir(resolve(policyRoot, "recipes"), { recursive: true });
      const { ctx } = stubContext({});
      await withOutputSink(() => {}, () => recipe(ctx, ["import", source, "policy"]));
      for (const name of excluded) {
        check(
          `import still excludes ${name}`,
          await access(resolve(policyRoot, "recipes", "policy", name)).then(() => true, () => false),
          false,
        );
      }
      check("a non-credential file is copied whole", await access(resolve(policyRoot, "recipes", "policy", "compose.yml")).then(() => true, () => false), true);
      check("the manifest itself is copied", await access(resolve(policyRoot, "recipes", "policy", "recipe.json")).then(() => true, () => false), true);
    } finally {
      useRecipesDir(scratch);
      await rm(policyRoot, { recursive: true, force: true });
    }
  }

  // The honest default when the declaration is absent: the generic policy still excludes the
  // framework's own conventions — and exactly those: an application file nobody declared is
  // copied, because silently covering it would be the framework pretending to know.
  {
    const defaultRoot = resolve(tmpdir(), `clawforge-recipe-import-default-${Date.now()}`);
    const source = resolve(defaultRoot, "source-recipe");
    try {
      await mkdir(resolve(source, "secrets"), { recursive: true });
      await writeFile(resolve(source, "recipe.json"), JSON.stringify({ description: "No declaration" }), "utf8");
      const generic = [".env", "secrets/store.env", "gateway.token", "db.secrets.env"];
      for (const name of generic) await writeFile(resolve(source, name), "FIXTURE-CREDENTIAL\n", "utf8");
      await writeFile(resolve(source, "proxy-credentials.env"), "FIXTURE-CREDENTIAL\n", "utf8");
      useRecipesDir(resolve(defaultRoot, "recipes"));
      await mkdir(resolve(defaultRoot, "recipes"), { recursive: true });
      const { ctx } = stubContext({});
      await withOutputSink(() => {}, () => recipe(ctx, ["import", source, "default"]));
      for (const name of generic) {
        check(
          `without a declaration the generic policy still excludes ${name}`,
          await access(resolve(defaultRoot, "recipes", "default", name)).then(() => true, () => false),
          false,
        );
      }
      check(
        "an undeclared application file is copied — exclusion is declared, not guessed",
        await access(resolve(defaultRoot, "recipes", "default", "proxy-credentials.env")).then(() => true, () => false),
        true,
      );
    } finally {
      useRecipesDir(scratch);
      await rm(defaultRoot, { recursive: true, force: true });
    }
  }

  // A source manifest that exists but cannot be read stops the import instead of reading as
  // "nothing declared" — the quiet-empty failure that once walked a private file into a
  // share archive — and a declaration trying to climb out of the recipe directory is
  // refused, the same strictness the target-side privatePaths policy gets.
  {
    const brokenRoot = resolve(tmpdir(), `clawforge-recipe-import-broken-${Date.now()}`);
    const source = resolve(brokenRoot, "source-recipe");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(resolve(source, "recipe.json"), "{ broken", "utf8");
      useRecipesDir(resolve(brokenRoot, "recipes"));
      await mkdir(resolve(brokenRoot, "recipes"), { recursive: true });
      const { ctx } = stubContext({});
      const parseMessage = await messageOf("a broken source manifest stops the import", () =>
        withOutputSink(() => {}, () => recipe(ctx, ["import", source, "broken"])),
      );
      check("the refusal names the unreadable manifest", parseMessage.includes("could not parse"), true);
      await writeFile(resolve(source, "recipe.json"), JSON.stringify({ description: "Escaping declaration", privateFiles: ["../outside"] }), "utf8");
      const escapeMessage = await messageOf("a privateFiles entry that leaves the recipe directory is refused", () =>
        withOutputSink(() => {}, () => recipe(ctx, ["import", source, "escaping"])),
      );
      check("the refusal names the boundary", escapeMessage.includes("must stay inside the recipe directory"), true);
      check(
        "nothing was copied by either refusal",
        await access(resolve(brokenRoot, "recipes", "broken")).then(() => true, () => false),
        false,
      );
    } finally {
      useRecipesDir(scratch);
      await rm(brokenRoot, { recursive: true, force: true });
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all recipe checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
