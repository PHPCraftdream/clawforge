// Ownership is a consumer safety boundary, including read-only and malformed-manifest probes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { buildStack } from "#framework/runtime/docker/side-stack.ts";
import { LocalPathBridge } from "#framework/core/paths.ts";
import { toSettings } from "#framework/core/env.ts";
import { useDeployment, useComposeProjectOverride, composeProjectOverride, selectedDeployment } from "#framework/runtime/deployment.ts";
import { recipeStack, clearRecipesDir, useRecipesDir } from "#framework/service/recipe.ts";
import { runningRecipeStacks } from "#framework/commands/management/recipe/index.ts";
import type { Context } from "#framework/core/context.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { check, finish } from "#checks/kit/harness.ts";

const root = await mkdtemp(resolve(tmpdir(), "recipe-identity-check-"));
const previousRoot = selectedDeployment();
const previousOverride = composeProjectOverride();
const fileA = resolve(root, "a", "deployment", "recipes", "cache", "compose.yml").replaceAll("\\", "/");
const fileB = resolve(root, "b", "deployment", "recipes", "cache", "compose.yml").replaceAll("\\", "/");
const records = new Map<string, { id: string; file: string; running: boolean }>();
let mutations = 0;
const transport = {
  async exec(_command: string, args: string[]) {
    let stdout = "";
    if (args[0] === "ps") {
      const project = args.find((arg) => arg.startsWith("label="))?.split("=").at(-1) ?? "";
      const record = records.get(project);
      if (record && (args.includes("--all") || record.running)) stdout = record.id;
    } else if (args[0] === "inspect") {
      stdout = JSON.stringify([...records].filter(([, value]) => args.includes(value.id)).map(([project, value]) => ({
        Config: { Labels: {
          "com.docker.compose.project": project,
          "com.docker.compose.project.working_dir": dirname(value.file).replaceAll("\\", "/"),
          "com.docker.compose.project.config_files": value.file,
        } },
      })));
    } else if (args[0] === "compose") {
      const project = args[args.indexOf("--project-name") + 1]!;
      if (args.includes("down")) { records.delete(project); mutations += 1; }
      else if (args.includes("logs")) stdout = records.get(project)?.id ?? "";
      else if (args.includes("up") || args.includes("build")) mutations += 1;
    } else throw new Error(`unexpected command ${args[0]}`);
    return { code: 0, stdout, stderr: "" };
  },
} as unknown as Transport;
const settings = toSettings({ OC_DATA_DIR: "/tmp/recipe-identity-check-data" });
const ctx = { runtime: {
  stack(project: string, definition: string, ownership?: { verifyOwnership: boolean; legacyProject?: string }) {
    return buildStack(transport, new LocalPathBridge([]), () => settings, (action) => action("/tmp/check.env"), project, definition, ownership);
  },
} } as unknown as Context;
try {
  useDeployment(resolve(root, "a", "deployment"));
  useComposeProjectOverride("team-a");
  records.set("team-a-recipe-cache", { id: "container-A", file: fileA, running: true });
  records.set("team-b-recipe-cache", { id: "container-B", file: fileB, running: true });
  assert.equal(await recipeStack(ctx, "cache", fileA).readLogs("10"), "container-A");
  useDeployment(resolve(root, "b", "deployment"));
  useComposeProjectOverride("team-b");
  assert.equal(await recipeStack(ctx, "cache", fileB).readLogs("10"), "container-B");

  // A malformed A declaration is not made live by B's container.
  useDeployment(resolve(root, "a", "deployment"));
  useComposeProjectOverride("team-a");
  records.delete("team-a-recipe-cache");
  const recipeDir = dirname(fileA);
  await mkdir(recipeDir, { recursive: true });
  await writeFile(resolve(recipeDir, "recipe.json"), "{broken");
  useRecipesDir(dirname(recipeDir));
  assert.deepEqual(await runningRecipeStacks(ctx), []);
  records.set("team-a-recipe-cache", { id: "container-A", file: fileA, running: true });
  await assert.rejects(() => runningRecipeStacks(ctx), /invalid manifest/);

  // Neither reads nor destructive operations can adopt a container from another root.
  records.set("team-a-recipe-cache", { id: "foreign", file: fileB, running: false });
  const foreign = recipeStack(ctx, "cache", fileA);
  for (const operation of [() => foreign.isRunning(), () => foreign.readLogs("10"), () => foreign.down(true), () => foreign.up(), () => foreign.serviceStates()]) {
    await assert.rejects(operation, /not verifiably linked/);
  }
  assert.equal(mutations, 0);
  assert.equal(records.get("team-a-recipe-cache")?.id, "foreign");

  // A stopped legacy container also blocks independent install and backup discovery.
  records.delete("team-a-recipe-cache");
  records.set("deployment-recipe-cache", { id: "legacy", file: fileB, running: false });
  await assert.rejects(() => recipeStack(ctx, "cache", fileA).build(), /cutover required/);
  await assert.rejects(() => runningRecipeStacks(ctx), /cutover required/);
  assert.equal(mutations, 0);
  assert.equal(records.get("deployment-recipe-cache")?.id, "legacy");

  // Unchanged default project: verifiably linked existing stacks remain operable.
  records.set("deployment-recipe-cache", { id: "default", file: fileA, running: true });
  useComposeProjectOverride(undefined);
  const single = recipeStack(ctx, "cache", fileA);
  assert.equal(await single.isRunning(), true);
  await single.down(true);
  assert.equal(records.has("deployment-recipe-cache"), false);
  assert.equal(records.get("team-b-recipe-cache")?.id, "container-B");
  check("isolated logs, broken discovery, ownership refusal and default removal", true, true);
} finally {
  clearRecipesDir();
  useComposeProjectOverride(previousOverride);
  if (previousRoot !== undefined) useDeployment(previousRoot);
  await rm(root, { recursive: true, force: true });
}
finish("recipe-identity");
