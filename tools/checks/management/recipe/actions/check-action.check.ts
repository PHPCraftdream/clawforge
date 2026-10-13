// Fixtures stay inside this worktree; no transport, Docker or dependency installation.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareRecipeCheck, recipeCheckEnvironment, runCheckAction } from "#framework/commands/management/recipe/recovery/checks/check.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { readName } from "#framework/core/values/names.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "clawforge-recipe-check-")));
const fixture = await createDeploymentFixture({ root });
const app = { name: "recipe-check-fixture", description: "fixture", commands: { recipe: openclawCommands.recipe } };
const directory = join(root, "recipes", "local");
const name = readName("recipe", "local");
async function put(path: string, content: string): Promise<void> {
  const file = join(directory, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}
async function capture(body: () => Promise<unknown>): Promise<string> {
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, body);
  return output;
}
async function refused(body: () => Promise<unknown>): Promise<boolean> {
  try { await body(); return false; } catch { return true; }
}
try {
  // Select recipes through the real pipeline before calling the action seam.
  const empty = await executeCommand(app, "recipe", { kind: "argv", argv: ["check", "local", "--dry-run"] }, { surface: "terminal" });
  check("empty recipe refuses during prepare", empty.stage, "prepare");
  const emptyWords = empty.error instanceof Error ? empty.error.message.split(/\s+/) : [];
  check("empty refusal identifies recursive file convention", emptyWords.filter((word) => ["no", "checks", "found", "*.check.ts", "recursively"].includes(word)), ["no", "checks", "found", "*.check.ts", "recursively"]);
  const absent = await executeCommand(app, "recipe", { kind: "argv", argv: ["check", "absent", "--dry-run"] }, { surface: "terminal" });
  check("unknown recipe refuses during prepare", absent.stage, "prepare");
  checkTrue("unknown recipe has error", absent.error instanceof Error);
  await put("recipe.json", "{");
  checkTrue("broken manifest refuses", await refused(() => prepareRecipeCheck(name, true)));
  await put("recipe.json", JSON.stringify({ description: "fixture", privateFiles: ["private"] }));
  await put("z.check.ts", 'console.error("failure-evidence"); process.exitCode = 7;\n');
  await put("nested/a.check.ts", `import { basename } from "node:path";
const value: number = 1;
if (value !== 1 || basename(process.cwd()) !== "local") process.exit(2);
for (const key of ["NODE_OPTIONS", "OPENCLAW_GATEWAY_TOKEN", "RECIPE_TEST_SECRET", "HOME"]) {
  if (process.env[key] !== undefined) process.exit(3);
}
console.log("PASS_SENTINEL");
`);
  await put("nested/node_modules/skip.check.ts", 'throw new Error("DEPENDENCY_EXECUTED");\n');
  await put("node_modules/skip.check.ts", 'throw new Error("DEPENDENCY_EXECUTED");\n');
  await put("private/skip.check.ts", 'throw new Error("PRIVATE_EXECUTED");\n');
  await put("secrets/skip.check.ts", 'throw new Error("SENSITIVE_EXECUTED");\n');
  await put("prepare.ts", 'throw new Error("must not import hooks");\n');
  const plan = await prepareRecipeCheck(name, false);
  check("recursive stable discovery prunes dependencies and private content", plan.files, ["nested/a.check.ts", "z.check.ts"]);
  check("minimal environment drops secrets and node injection", recipeCheckEnvironment({ Path: "safe-path", SystemRoot: "safe-root", NODE_OPTIONS: "bad", OPENCLAW_GATEWAY_TOKEN: "secret", HOME: "private" }), { PATH: "safe-path", SystemRoot: "safe-root" });
  const oldSecret = process.env.RECIPE_TEST_SECRET;
  process.env.RECIPE_TEST_SECRET = "do-not-inject";
  try {
    let code = -1;
    const output = await capture(async () => { code = await runCheckAction(plan); });
    check("failing checks return nonzero", code, 1);
    const rows = output.split(/\r?\n/).map((line) => line.trim().split(/\s+/));
    check("passing file reports ok", rows.find((row) => row[1] === "nested/a.check.ts"), ["ok", "nested/a.check.ts"]);
    check("failing file reports FAIL and child exit", rows.find((row) => row[1] === "z.check.ts"), ["FAIL", "z.check.ts", "(exit", "7)"]);
    checkTrue("failing output retained", output.includes("failure-evidence"));
    checkTrue("passing output hidden", !output.includes("PASS_SENTINEL"));
    check("mixed summary counts outcomes", rows.at(-2)?.filter((word) => /^\d+$/.test(word)), ["1", "1"]);
  } finally {
    if (oldSecret === undefined) delete process.env.RECIPE_TEST_SECRET;
    else process.env.RECIPE_TEST_SECRET = oldSecret;
  }
  await put("z.check.ts", "process.exit(0);\n");
  let passed = -1;
  await capture(async () => { passed = await runCheckAction(await prepareRecipeCheck(name, false)); });
  check("all passing checks return zero", passed, 0);
  await put("z.check.ts", 'process.stderr.write("x".repeat(200000)); process.exitCode = 1;\n');
  const noisy = await capture(async () => { await runCheckAction(await prepareRecipeCheck(name, false)); });
  checkTrue("output is byte bounded", noisy.length < 67_000);
  check("truncated output is identified", noisy.split(/\s+/).filter((word) => word.startsWith("[") || word.endsWith("]")), ["[output", "truncated]"]);
  await put("z.check.ts", "setInterval(() => {}, 1000);\n");
  let timed = -1;
  const started = Date.now();
  const hanging = await capture(async () => { timed = await runCheckAction(await prepareRecipeCheck(name, false), 300); });
  check("hanging child fails", timed, 1);
  check("timeout names file and bound", hanging.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((row) => row[1] === "z.check.ts"), ["FAIL", "z.check.ts", "(timeout", "after", "300ms)"]);
  checkTrue("hang returns within bounded time", Date.now() - started < 10_000);
  checkTrue("zero timeout refuses", await refused(() => runCheckAction(plan, 0)));
  checkTrue("excessive timeout refuses", await refused(() => runCheckAction(plan, 30_001)));
  const unconfirmed = await executeCommand(app, "recipe", { kind: "argv", argv: ["check", "local"] }, { surface: "mcp" });
  check("untrusted code requires confirmation", unconfirmed.stage, "confirm");
  check("real execution effect is destroy", unconfirmed.facts?.effect, "destroy");
  let preview: Awaited<ReturnType<typeof executeCommand>> | undefined;
  const previewOutput = await capture(async () => {
    preview = await executeCommand(app, "recipe", { kind: "argv", argv: ["check", "local", "--dry-run"] }, { surface: "mcp", transport: fixture.transport() });
  });
  check("dry-run reaches run without context or confirmation", [preview?.stage, preview?.error, preview?.facts?.effect], ["run", undefined, "read"]);
  check("dry-run lists instead of executing hanging code", previewOutput.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((row) => row.at(-1) === "z.check.ts"), ["would", "run", "z.check.ts"]);
  check("local action never contacts transport", fixture.contacts(), []);
  await symlink(resolve(root, "config"), join(directory, "escape"), "junction");
  checkTrue("escaping directory link refuses before execution", await refused(() => prepareRecipeCheck(name, true)));
  await rm(join(directory, "escape"), { recursive: true, force: true });
  await symlink(resolve(directory, "nested"), join(directory, "alias"), "junction");
  check("contained directory links are portable", (await prepareRecipeCheck(name, true)).files, ["alias/a.check.ts", "nested/a.check.ts", "z.check.ts"]);
  await rm(join(directory, "alias"), { recursive: true, force: true });
  await rm(join(directory, "node_modules"), { recursive: true, force: true });
  await symlink(resolve(root, "config"), join(directory, "node_modules"), "junction");
  check("dependency links are pruned without following", (await prepareRecipeCheck(name, true)).files, ["nested/a.check.ts", "z.check.ts"]);
  await requires("symlink", "portable check file links", async () => {
    await symlink(join(directory, "nested", "a.check.ts"), join(directory, "linked.check.ts"), "file");
    checkTrue("contained file link is discovered", (await prepareRecipeCheck(name, true)).files.includes("linked.check.ts"));
    await rm(join(directory, "linked.check.ts"));
    await symlink(join(root, "app.ts"), join(directory, "linked.check.ts"), "file");
    checkTrue("escaping file link refuses", await refused(() => prepareRecipeCheck(name, true)));
    await rm(join(directory, "linked.check.ts"));
  });
  await rm(join(directory, "nested", "node_modules"), { recursive: true, force: true });
  await symlink(resolve(root, "config"), join(directory, "nested", "node_modules"), "junction");
  checkTrue("nested dependency escape still refuses during portable walk", await refused(() => prepareRecipeCheck(name, true)));
  await rm(join(directory, "nested", "node_modules"), { recursive: true, force: true });
  await put("z.check.ts", "process.exit(4);\n");
  let execution: Awaited<ReturnType<typeof executeCommand>> | undefined;
  await capture(async () => {
    execution = await executeCommand(app, "recipe", { kind: "argv", argv: ["check", "local"] }, { surface: "mcp", confirmed: true, transport: fixture.transport() });
  });
  check("confirmed real pipeline carries child failures", [execution?.stage, execution?.exitCode], ["run", 1]);
  check("confirmed check never contacts transport", fixture.contacts(), []);
} finally {
  await fixture.dispose();
}
finish("recipe check action");
