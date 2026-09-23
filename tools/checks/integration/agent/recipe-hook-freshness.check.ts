// Hook freshness for recipe hooks, driven through the same in-process dispatcher the MCP
// calls dispatch into (audit 2026-09-22 round 3, P2-04): hook modules are cached against
// the checksum of their file, so an edit between two calls of one long-lived process —
// the MCP-session shape — takes effect on the second call instead of serving the first
// load's module forever. Split out of recipe.check.ts, which outgrew the check-file line
// limit when this landed; the end-to-end server variant that swaps the hook between two
// calls of one real stdio server lives in
// tools/checks/integration/agent/recipe-hook-freshness-server.check.ts.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe.ts";
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

process.stderr.write(failed === 0 ? "all recipe hook freshness checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
