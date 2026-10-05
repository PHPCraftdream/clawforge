// Ownership is a consumer safety boundary, including read-only and malformed-manifest probes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { buildStack } from "#framework/runtime/docker/side-stack.ts";
import { LocalPathBridge } from "#framework/core/paths.ts";
import { toSettings } from "#framework/core/env.ts";
import { useDeployment, useComposeProjectOverride, composeProjectOverride, selectedDeployment } from "#framework/runtime/deployment.ts";
import { recipeProjectName, recipeStack, clearRecipesDir, useRecipesDir } from "#framework/service/recipe.ts";
import { runningRecipeStacks } from "#framework/commands/management/recipe/index.ts";
import type { Context } from "#framework/core/context.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { finish } from "#checks/kit/harness.ts";

const root = await mkdtemp(resolve(tmpdir(), "recipe-identity-check-"));
const previousRoot = selectedDeployment();
const previousOverride = composeProjectOverride();
const fileA = resolve(root, "a", "deployment", "recipes", "cache", "compose.yml");
const fileB = resolve(root, "b", "deployment", "recipes", "cache", "compose.yml");
// Local manifests remain Windows-readable; Docker labels use the real POSIX target seam.
const targetFile = (file: string) => `/tmp/recipe-identity/${file.slice(root.length).replaceAll("\\", "/").replace(/^\//, "")}`;
const records = new Map<string, { id: string; file: string; running: boolean }>();
const volumes = new Set<string>();
const targetFiles = new Map<string, string>();
const targetDirectories = new Set<string>();
let mutations = 0;
const transport: Transport = {
  description: "fixture:POSIX-Docker",
  async readFile(path) {
    const content = targetFiles.get(path);
    if (content === undefined) throw new Error(`missing target file ${path}`);
    return content;
  },
  async writeFile(path, content) { targetFiles.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8")); },
  async exists(path) { return targetFiles.has(path) || targetDirectories.has(path); },
  async mkdirp(path) { targetDirectories.add(path); },
  async remove(path) {
    for (const name of targetFiles.keys()) if (name === path || name.startsWith(`${path}/`)) targetFiles.delete(name);
    for (const name of targetDirectories) if (name === path || name.startsWith(`${path}/`)) targetDirectories.delete(name);
  },
  async listFiles(directory) {
    return [...targetFiles.keys()].filter((name) => name.startsWith(`${directory}/`)).map((name) => name.slice(directory.length + 1));
  },
  clientInvocation(entryPath, args) { return { command: "node", args: [entryPath, ...args] }; },
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
          "com.docker.compose.project.working_dir": value.file.slice(0, value.file.lastIndexOf("/")),
          "com.docker.compose.project.config_files": value.file,
        } },
      })));
    } else if (args[0] === "compose") {
      const project = args[args.indexOf("--project-name") + 1]!;
      if (args.includes("down")) {
        records.delete(project);
        if (args.includes("--volumes")) volumes.delete(project);
        mutations += 1;
      } else if (args.includes("logs")) stdout = records.get(project)?.id ?? "";
      else if (args.includes("up")) {
        records.set(project, { id: `container-${args[args.indexOf("--file") + 1]}`, file: args[args.indexOf("--file") + 1]!, running: true });
        volumes.add(project);
        mutations += 1;
      } else if (args.includes("build")) mutations += 1;
    } else throw new Error(`unexpected command ${args[0]}`);
    return { code: 0, stdout, stderr: "" };
  },
};
const settings = toSettings({ OC_DATA_DIR: "/tmp/recipe-identity-check-data" });
const paths = new LocalPathBridge([]);
paths.toTarget = async (path: string) => targetFile(path);
const ctx = { runtime: {
  stack(project: string, definition: string, ownership?: { verifyOwnership: boolean; legacyProjects?: readonly string[] }) {
    return buildStack(transport, paths, () => settings, (action) => action("/tmp/check.env"), project, definition, ownership);
  },
} } as unknown as Context;
try {
  useDeployment(resolve(root, "a", "deployment"));
  useComposeProjectOverride("team-a");
  const projectA = recipeProjectName("cache");
  records.set(projectA, { id: "container-A", file: targetFile(fileA), running: true });
  assert.equal(await recipeStack(ctx, "cache", fileA).readLogs("10"), "container-A");
  useDeployment(resolve(root, "b", "deployment"));
  useComposeProjectOverride("team-b");
  const projectB = recipeProjectName("cache");
  records.set(projectB, { id: "container-B", file: targetFile(fileB), running: true });
  assert.equal(await recipeStack(ctx, "cache", fileB).readLogs("10"), "container-B");

  useDeployment(resolve(root, "a", "deployment"));
  useComposeProjectOverride("team-a");
  records.delete(projectA);
  const recipeDir = dirname(fileA);
  await mkdir(recipeDir, { recursive: true });
  await writeFile(resolve(recipeDir, "recipe.json"), "{broken");
  useRecipesDir(dirname(recipeDir));
  assert.deepEqual(await runningRecipeStacks(ctx), []);
  records.set(projectA, { id: "container-A", file: targetFile(fileA), running: true });
  await assert.rejects(() => runningRecipeStacks(ctx), /invalid manifest/);

  records.set(projectA, { id: "foreign", file: targetFile(fileB), running: false });
  const foreign = recipeStack(ctx, "cache", fileA);
  for (const operation of [() => foreign.isRunning(), () => foreign.readLogs("10"), () => foreign.down(true), () => foreign.up(), () => foreign.serviceStates()]) {
    await assert.rejects(operation, /not verifiably linked/);
  }
  assert.equal(mutations, 0);
  assert.equal(records.get(projectA)?.id, "foreign");
  records.delete(projectA);

  // Both stopped predecessor schemes refuse all adoption, including default deployments.
  for (const legacy of ["team-a-recipe-cache", "deployment-recipe-cache"]) {
    records.set(legacy, { id: "legacy", file: targetFile(fileB), running: false });
    await assert.rejects(() => recipeStack(ctx, "cache", fileA).build(), /cutover required/);
    await assert.rejects(() => runningRecipeStacks(ctx), /cutover required/);
    assert.equal(mutations, 0);
    assert.equal(records.get(legacy)?.id, "legacy");
    records.delete(legacy); // Explicit operator cutover, not a framework alias.
  }
  useComposeProjectOverride(undefined);
  const defaultProject = recipeProjectName("cache");
  records.set(defaultProject, { id: "default", file: targetFile(fileA), running: true });
  const single = recipeStack(ctx, "cache", fileA);
  assert.equal(await single.isRunning(), true);
  await single.down(true);
  assert.equal(records.has(defaultProject), false);
  assert.equal(records.get(projectB)?.id, "container-B");

  // Report pair: exercise two real stack objects through creation, logs, reinstall and removal.
  useDeployment(resolve(root, "app-a"));
  useComposeProjectOverride("team");
  const pairA = recipeStack(ctx, "cache-recipe-worker", fileA);
  const keyA = recipeProjectName("cache-recipe-worker");
  await pairA.up();
  useDeployment(resolve(root, "app-b"));
  useComposeProjectOverride("team-recipe-cache");
  const pairB = recipeStack(ctx, "worker", fileB);
  const keyB = recipeProjectName("worker");
  await pairB.up();
  assert.equal(await pairA.readLogs("10"), `container-${targetFile(fileA)}`);
  assert.equal(await pairB.readLogs("10"), `container-${targetFile(fileB)}`);
  await pairB.up();
  await pairA.down(true);
  assert.equal(records.has(keyA), false);
  assert.equal(volumes.has(keyA), false);
  assert.equal(volumes.has(keyB), true);
  assert.equal(await pairB.isRunning(), true);
  assert.equal(await pairB.readLogs("10"), `container-${targetFile(fileB)}`);

} finally {
  clearRecipesDir();
  useComposeProjectOverride(previousOverride);
  if (previousRoot !== undefined) useDeployment(previousRoot);
  await rm(root, { recursive: true, force: true });
}
finish("recipe-identity");
