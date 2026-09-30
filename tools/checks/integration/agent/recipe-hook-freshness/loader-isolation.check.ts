// How recipe hooks are loaded: a bare package import resolved from the recipe's own
// node_modules, a relative-import cycle evaluated (and bounded), no shared hook cache to adopt
// from, and a hook that never settles failing with a clear timeout.

import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { scratchDeployment, stubContext } from "./fixture.ts";
const { outerRecipes } = scratchDeployment();
// Bare imports: the documented hook shape imports
// `@clawforge/framework/private-config`, a package specifier resolved from the recipe's
// own node_modules. The loader this replaces executed rewritten copies from a scratch
// cache directory whose package scope had no node_modules, so even an unmodified first
// run broke every hook importing a dependency; hooks now execute from their real path,
// where normal resolution applies — on the first load and again after an edit re-imports
// the hook.
{
  const bareRoot = resolve(tmpdir(), `clawforge-recipe-hook-bare-${Date.now()}`);
  try {
    await mkdir(resolve(bareRoot, "bare", "node_modules", "@clawforge", "framework"), { recursive: true });
    await writeFile(resolve(bareRoot, "bare", "recipe.json"), JSON.stringify({ description: "Bare import probe" }), "utf8");
    await writeFile(
      resolve(bareRoot, "bare", "node_modules", "@clawforge", "framework", "package.json"),
      JSON.stringify({ name: "@clawforge/framework", version: "0.0.0-check", type: "module", exports: { "./private-config": "./private-config.js" } }),
      "utf8",
    );
    await writeFile(
      resolve(bareRoot, "bare", "node_modules", "@clawforge", "framework", "private-config.js"),
      "export function stubRevision() { return 42; }\n",
      "utf8",
    );
    await writeFile(
      resolve(bareRoot, "bare", "verify.ts"),
      "import { stubRevision } from \"@clawforge/framework/private-config\";\nexport async function verify() { return { ok: true, revision: stubRevision() }; }\n",
      "utf8",
    );
    useRecipesDir(bareRoot);
    const { ctx } = stubContext({});
    const verifyOnce = async (): Promise<{ revision?: number }> => {
      let output = "";
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["verify", "bare"]));
      return JSON.parse(output) as { revision?: number };
    };

    check("bare: a hook importing @clawforge/framework/private-config resolves it from the recipe's own node_modules", (await verifyOnce()).revision, 42);
    await writeFile(
      resolve(bareRoot, "bare", "verify.ts"),
      "import { stubRevision } from \"@clawforge/framework/private-config\";\nexport async function verify() { return { ok: true, revision: stubRevision() + 8 }; }\n",
      "utf8",
    );
    check("bare: the package import still resolves after an edit re-imports the hook", (await verifyOnce()).revision, 50);
  } finally {
    useRecipesDir(outerRecipes);
    await rm(bareRoot, { recursive: true, force: true });
  }
}

// Relative-import cycles: a genuine A→B→A cycle
// between files with exported functions must evaluate to the composed result — once
// every module executes from its real URL, ESM handles the cycle itself — and must keep
// doing so after an edit inside the cycle. The copy machinery this replaces deadlocked
// here, each side awaiting the other's half-finished promise while the instance lock
// stayed held. The outer race is the check's own bounded wait: a loader regression may
// not hang the shared runner process this file runs in.
{
  const cycleRoot = resolve(tmpdir(), `clawforge-recipe-hook-cycle-${Date.now()}`);
  try {
    await mkdir(resolve(cycleRoot, "cycle"), { recursive: true });
    await writeFile(resolve(cycleRoot, "cycle", "recipe.json"), JSON.stringify({ description: "Cycle probe" }), "utf8");
    await writeFile(
      resolve(cycleRoot, "cycle", "cycle-a.ts"),
      "import { cycleB } from \"./cycle-b.ts\";\nexport function bump(n: number) { return n + 1; }\nexport function cycleA(n: number) { return cycleB(n) * 10; }\n",
      "utf8",
    );
    await writeFile(
      resolve(cycleRoot, "cycle", "cycle-b.ts"),
      "import { bump } from \"./cycle-a.ts\";\nexport function cycleB(n: number) { return bump(n) + 1; }\n",
      "utf8",
    );
    await writeFile(
      resolve(cycleRoot, "cycle", "verify.ts"),
      "import { cycleA } from \"./cycle-a.ts\";\nexport async function verify() { return { ok: true, revision: cycleA(1) }; }\n",
      "utf8",
    );
    useRecipesDir(cycleRoot);
    const { ctx } = stubContext({});
    const verifyBounded = async (): Promise<{ revision?: number }> => {
      let output = "";
      const run = withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["verify", "cycle"])).then(
        () => JSON.parse(output) as { revision?: number },
      );
      return await Promise.race([
        run,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("recipe verify hung past the check's own 15s bound")), 15_000).unref(),
        ),
      ]);
    };

    check("cycle: an A→B→A cycle of exported functions evaluates to the composed result", (await verifyBounded()).revision, 30);
    await writeFile(
      resolve(cycleRoot, "cycle", "cycle-b.ts"),
      "import { bump } from \"./cycle-a.ts\";\nexport function cycleB(n: number) { return bump(n) + 5; }\n",
      "utf8",
    );
    check("cycle: an edit inside the cycle is picked up on the next call of the same process", (await verifyBounded()).revision, 70);
  } finally {
    useRecipesDir(outerRecipes);
    await rm(cycleRoot, { recursive: true, force: true });
  }
}

// No shared hook cache to adopt from: the loader this
// replaces wrote content-addressed copies into a predictable `clawforge-hook-cache`
// directory under the system temp dir and imported whatever file was already sitting at
// the expected name — a local attacker who won that race got their code executed with
// the operator's privileges. Hooks now execute from their real path, so a hook run
// creates no cache directory at all, and a foreign module planted at the old location
// is never imported: the answer comes from the recipe's own edited file.
{
  const adoptedRoot = resolve(tmpdir(), `clawforge-recipe-hook-adopt-${Date.now()}`);
  const oldCacheDir = resolve(tmpdir(), "clawforge-hook-cache");
  const poisonDir = resolve(oldCacheDir, "poisoned");
  let cacheDirExisted = false;
  try {
    await mkdir(resolve(adoptedRoot, "adopted"), { recursive: true });
    await writeFile(resolve(adoptedRoot, "adopted", "recipe.json"), JSON.stringify({ description: "Adoption probe" }), "utf8");
    await writeFile(resolve(adoptedRoot, "adopted", "verify.ts"), "export async function verify() { return { ok: true, revision: 1 }; }\n", "utf8");
    useRecipesDir(adoptedRoot);
    const { ctx } = stubContext({});
    const verifyOnce = async (): Promise<{ revision?: number }> => {
      let output = "";
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["verify", "adopted"]));
      return JSON.parse(output) as { revision?: number };
    };

    // The loader this replaces is gone from this tree, so nothing here writes to that
    // path anymore — but the machine may still be carrying the directory older builds
    // left behind (a dev box, a parallel worktree on the old code). Snapshot its
    // entries instead of deleting anything: the assertion below is a fact about the
    // run this check is about to make, and the shared directory is left exactly as
    // the check found it.
    const cacheEntriesBefore = await readdir(oldCacheDir).catch(() => [] as string[]);
    cacheDirExisted = await access(oldCacheDir).then(
      () => true,
      () => false,
    );

    await verifyOnce();
    const cacheEntriesAfter = await readdir(oldCacheDir).catch(() => [] as string[]);
    check(
      "cache: a hook run writes nothing into clawforge-hook-cache under the system temp dir",
      JSON.stringify(cacheEntriesAfter),
      JSON.stringify(cacheEntriesBefore),
    );

    await mkdir(poisonDir, { recursive: true });
    await writeFile(resolve(poisonDir, "verify.ts"), "export async function verify() { return { ok: true, revision: 666 }; }\n", "utf8");
    await writeFile(resolve(adoptedRoot, "adopted", "verify.ts"), "export async function verify() { return { ok: true, revision: 2 }; }\n", "utf8");
    check("cache: a foreign file planted at the old cache location is never imported — the recipe's own edited hook answers", (await verifyOnce()).revision, 2);
  } finally {
    useRecipesDir(outerRecipes);
    await rm(adoptedRoot, { recursive: true, force: true });
    await rm(poisonDir, { recursive: true, force: true });
    if (!cacheDirExisted) await rm(oldCacheDir, { recursive: true, force: true });
  }
}

// The bounded deadline behind cycle handling: a hook
// whose evaluation never settles must fail with a clear timeout error instead of a hung
// call holding the instance lock. CLAWFORGE_HOOK_IMPORT_TIMEOUT_MS exists so this path
// is testable in seconds; the stub recipe's verify never resolves its top-level await.
// The abandoned evaluation must not surface as an unhandled rejection — this block (and
// the whole runner process) finishing cleanly is part of the assertion.
{
  const hangRoot = resolve(tmpdir(), `clawforge-recipe-hook-hang-${Date.now()}`);
  try {
    await mkdir(resolve(hangRoot, "hang"), { recursive: true });
    await writeFile(resolve(hangRoot, "hang", "recipe.json"), JSON.stringify({ description: "Hang probe" }), "utf8");
    await writeFile(
      resolve(hangRoot, "hang", "verify.ts"),
      "await new Promise(() => {});\nexport async function verify() { return { ok: true, revision: 1 }; }\n",
      "utf8",
    );
    useRecipesDir(hangRoot);
    const { ctx } = stubContext({});
    process.env.CLAWFORGE_HOOK_IMPORT_TIMEOUT_MS = "1000";
    let failure = "";
    try {
      let output = "";
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["verify", "hang"]));
      failure = `verify completed instead of timing out: ${output}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      delete process.env.CLAWFORGE_HOOK_IMPORT_TIMEOUT_MS;
    }
    check("deadline: a hook whose evaluation never settles fails with a clear timeout error, not a hang", /did not settle within/.test(failure), true);
  } finally {
    useRecipesDir(outerRecipes);
    await rm(hangRoot, { recursive: true, force: true });
  }
}

finish("recipe hook freshness loader isolation");
