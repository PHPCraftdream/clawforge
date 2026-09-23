// Hook freshness for recipe hooks, driven through the same in-process dispatcher the MCP
// calls dispatch into (audit 2026-09-22 round 3, P2-04): hook modules are cached against
// the checksum of their file, so an edit between two calls of one long-lived process —
// the MCP-session shape — takes effect on the second call instead of serving the first
// load's module forever. Split out of recipe.check.ts, which outgrew the check-file line
// limit when this landed; the end-to-end server variant that swaps the hook between two
// calls of one real stdio server lives in
// tools/checks/integration/agent/recipe-hook-freshness-server.check.ts.

import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink } from "#framework/core/output.ts";
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

/** A fresh stub `ctx` whose stack() returns spies recording build/up calls, and whose transport is
 *  an in-memory filesystem with just enough shell for the instance lock: plain `mkdir` of an
 *  existing directory fails, which is the entire acquisition mechanism — `mkdir -p` and `mkdir -m`
 *  only prepare directories, `rmdir` refuses a non-empty one, and `test -d` reads it back. Copied
 *  in reduced form from recipe.check.ts's rather than imported: check files run for their side
 *  effects, and a shared fixture would make this one's passing depend on another file's. */
function stubContext(env: Record<string, string>): { ctx: Context; calls: string[] } {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const ctx = {
    settings: { env, dataDir: "/srv/clawforge-recipe-hook-freshness-check" },
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
        // The instance lock's takeover/release CAS (round 6, P2-03) moves its own
        // generation-marker directory with `mv`, then removes it with `rm -rf` — both must
        // be tracked here or the marker never leaves `dirs` and the lock root never empties.
        if (command === "mv") {
          const source = args[args.length - 2];
          const destination = args[args.length - 1];
          if (source === undefined || destination === undefined || !dirs.has(source)) {
            return { code: 1, stdout: "", stderr: "No such file or directory" };
          }
          dirs.delete(source);
          dirs.add(destination);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rm") {
          const target = args[args.length - 1];
          for (const dir of dirs) {
            if (dir === target || dir.startsWith(`${target}/`)) dirs.delete(dir);
          }
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
          async status() {},
          async followLogs() {},
          async readLogs(tail: string) {
            return `stubbed log tail=${tail}\n`;
          },
          async isRunning() {
            return false;
          },
          // No fixture here declares `readiness`, so install's readiness check falls back to
          // whatever compose reports for the project — one running service clears it.
          async serviceStates() {
            return { app: { running: true } };
          },
        };
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

const freshRoot = resolve(tmpdir(), `clawforge-recipe-hook-fresh-${Date.now()}`);
// The recipes dir this file puts back when it is done: a stable directory of its own, so the
// shared runner process that imports every check file into one process is never left
// pointing at the scratch root this file deletes from under it.
const outerRecipes = resolve(freshRoot, "outer-recipes");

// deploymentName() backs every stack name the dispatcher builds, so it must resolve
// whatever ran before this file in the shared runner process — this file cannot rely on
// another check file having selected a deployment for it. Hoisted above both probe blocks:
// whichever runs first needs it.
useDeployment(resolve(freshRoot, "deployment"));

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

// Helper-file freshness (audit 2026-09-23 round 4, P2-06): editing a relative import the
// hook pulls in — never verify.ts/prepare.ts itself — must be visible on the very next call
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
      "import { REVISION } from \"./shared.ts\";\nexport async function verify() { return { ok: true, revision: REVISION }; }\n",
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
  } finally {
    useRecipesDir(outerRecipes);
    await rm(helperRoot, { recursive: true, force: true });
  }
}

// Bare imports (audit 2026-09-23 round 6, P2-01): the documented hook shape imports
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

// Relative-import cycles (audit 2026-09-23 round 6, P2-02): a genuine A→B→A cycle
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

// No shared hook cache to adopt from (audit 2026-09-23 round 6, P1-08): the loader this
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

// The bounded deadline behind cycle handling (audit 2026-09-23 round 6, P2-02): a hook
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

process.stderr.write(failed === 0 ? "all recipe hook freshness checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
