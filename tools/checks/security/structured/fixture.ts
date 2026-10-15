import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "#framework/core/context.ts";
import { clearRecipesDir, recipesDirectory, useRecipesDir } from "#framework/service/recipe.ts";
import { lockPath, runOwning, type HeldLock } from "#framework/runtime/lock/instance-lock.ts";
import type { ExecOptions } from "#framework/runtime/transport/exec.ts";

export async function fixture() {
  let previous: string | undefined;
  try { previous = recipesDirectory(); } catch {}
  const root = await mkdtemp(join(tmpdir(), "private-u5-"));
  await mkdir(join(root, "recipes", "declared"), { recursive: true });
  await writeFile(join(root, "recipes", "declared", "recipe.json"), JSON.stringify({ description: "fixture", privatePaths: ["vault", "exact/state.json"] }));
  useRecipesDir(join(root, "recipes"));
  return { root, async dispose() {
    if (previous === undefined) clearRecipesDir(); else useRecipesDir(previous);
    await rm(root, { recursive: true, force: true });
  } };
}

export function recording() {
  const files = new Map<string, string>();
  const events: Array<{ command: string; args: string[]; options?: ExecOptions }> = [];
  const control = { readCode: 0, timedOut: false, failPublish: false, failReadPath: "" };
  const ctx = { settings: { dataDir: "/fixture/data", env: {} }, transport: {
    description: "u5-recording",
    async exec(command: string, args: string[], options?: ExecOptions) {
      events.push({ command, args, options });
      if (command === "sh" && args[0] === "-c" && args[1].startsWith("p=$1")) {
        const path = args[3];
        const code = path === control.failReadPath ? 43 : control.readCode;
        return { code: code || (files.has(path) ? 0 : 42), stdout: code ? "" : (files.get(path) ?? "").slice(0, Number(args[4])), stderr: "", timedOut: control.timedOut };
      }
      if (command === "mv") {
        if (control.failPublish) throw Error("publication failure");
        files.set(args.at(-1)!, files.get(args.at(-2)!)!);
        files.delete(args.at(-2)!);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    async writePrivateFile(path: string, text: string) { files.set(path, text); },
    async remove(path: string) { files.delete(path); },
  } } as unknown as Context;
  const held = { resource: `${ctx.transport.description}\0${lockPath(ctx)}` } as HeldLock;
  return { ctx, files, events, control, owning: <T>(body: () => Promise<T>) => runOwning(held, body) };
}
