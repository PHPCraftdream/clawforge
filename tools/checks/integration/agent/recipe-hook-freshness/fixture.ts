// Shared by the recipe-hook-freshness checks: the stub `ctx` the in-process recipe dispatcher
// runs against, and the scratch deployment/recipes-dir pair each file puts back when it is done.

import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { useDeployment } from "#framework/runtime/deployment.ts";
import type { Context } from "#framework/core/context.ts";

/** Selects a deployment under a scratch root of this process's own and names the recipes dir
 *  each check puts back when it is done: a stable directory of its own, so a shared runner
 *  process importing every check file is never left pointing at a scratch root deleted from
 *  under it. */
export function scratchDeployment(): { freshRoot: string; outerRecipes: string } {
  const freshRoot = resolve(tmpdir(), `clawforge-recipe-hook-fresh-${process.pid}-${Date.now()}`);
  const outerRecipes = resolve(freshRoot, "outer-recipes");
  useDeployment(resolve(freshRoot, "deployment"));
  return { freshRoot, outerRecipes };
}
/** A fresh stub `ctx` whose stack() returns spies recording build/up calls, and whose transport is
 *  an in-memory filesystem with just enough shell for the instance lock: plain `mkdir` of an
 *  existing directory fails, which is the entire acquisition mechanism — `mkdir -p` and `mkdir -m`
 *  only prepare directories, `rmdir` refuses a non-empty one, and `test -d` reads it back. Copied
 *  in reduced form from recipe.check.ts's rather than imported: check files run for their side
 *  effects, and a shared fixture would make this one's passing depend on another file's. */
export function stubContext(env: Record<string, string>): { ctx: Context; calls: string[] } {
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
        // The instance lock's takeover/release CAS moves its own
        // generation-marker directory with `mv`, then removes it with `rm -rf` — both must
        // be tracked here or the marker never leaves `dirs` and the lock root never empties.
        if (command === "mv") {
          const source = args[args.length - 2];
          const destination = args[args.length - 1];
          if (source === undefined || destination === undefined) {
            return { code: 1, stdout: "", stderr: "No such file or directory" };
          }
          if (files.has(source)) {
            if (files.has(destination)) return { code: 1, stdout: "", stderr: "File exists" };
            const content = files.get(source)!;
            files.delete(source);
            files.set(destination, content);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (!dirs.has(source)) return { code: 1, stdout: "", stderr: "No such file or directory" };
          dirs.delete(source);
          dirs.add(destination);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "ln") {
          const [source, destination] = args;
          if (source === undefined || destination === undefined || !files.has(source)) {
            return { code: 1, stdout: "", stderr: "No such file or directory" };
          }
          if (files.has(destination) || dirs.has(destination)) return { code: 1, stdout: "", stderr: "File exists" };
          files.set(destination, files.get(source)!);
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
