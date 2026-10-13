import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareRecipeCheck, runCheckAction } from "#framework/commands/management/recipe/recovery/checks/check.ts";
import { composeTargets } from "#framework/commands/management/recipe/recovery/checks/lint/compose.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { readName } from "#framework/core/values/names.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "clawforge-recipe-lint-")));
const fixture = await createDeploymentFixture({ root });
const directory = join(root, "recipes", "local");
const name = readName("recipe", "local");
async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await writeFile(join(directory, path), content);
}
async function run(dry = false): Promise<{ code: number; output: string }> {
  let code = -1;
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, async () => { code = await runCheckAction(await prepareRecipeCheck(name, dry)); });
  return { code, output };
}
const hash = "a".repeat(64);
try {
  await put("recipe.json", JSON.stringify({ description: "lint", privateFiles: ["private"] }));
  await put("Dockerfile", "FROM scratch\n");
  check("lint-only passes", (await run()).code, 0);
  await put("Dockerfile", "FROM alpine:latest\n");
  check("warning exits zero", (await run()).code, 0);
  await put("Dockerfile", "ADD https://example/a /a\n");
  check("lint error exits one", (await run()).code, 1);
  await put("own.check.ts", "throw new Error('OWN_CHECK_EXECUTED');\n");
  const combined = await run();
  const combinedRows = combined.output.split(/\r?\n/).map((row) => row.trim().split(/\s+/));
  checkTrue("lint printed before own check failures", combinedRows.findIndex((row) => row[1] === "remote-add-unpinned") < combinedRows.findIndex((row) => row[0] === "FAIL" && row[1] === "own.check.ts"));
  checkTrue("own checks still execute after lint errors", combined.output.includes("OWN_CHECK_EXECUTED"));
  const preview = await run(true);
  check("dry run exits zero despite errors", preview.code, 0);
  const previewRows = preview.output.split(/\r?\n/).map((row) => row.trim().split(/\s+/));
  check("dry run lists lint target", previewRows.find((row) => row[1] === "lint"), ["would", "lint", "Dockerfile"]);
  check("dry run lists own target", previewRows.find((row) => row[1] === "run"), ["would", "run", "own.check.ts"]);
  checkTrue("dry run does not execute own check", !preview.output.includes("OWN_CHECK_EXECUTED"));
  await rm(join(directory, "own.check.ts"));
  await put("Dockerfile", "# recipe-check: allow remote-add-unpinned reviewed\nADD https://example/a /a\n");
  check("waived errors exit zero", (await run()).code, 0);
  await rm(join(directory, "Dockerfile"));
  await put("build/Container", "ARG SUM\nADD --checksum=sha256:$SUM https://example/a /a\n");
  await put("compose.yml", `services:\n  app:\n    build:\n      context: build\n      dockerfile: Container\n      args:\n        SUM: '${hash}'\n`);
  const compose = await prepareRecipeCheck(name, false);
  check("compose named Dockerfile discovered relative to context", compose.lint.targets, ["build/Container"]);
  check("compose args validate pinned ADD", compose.lint.findings, []);
  check("compose lint-only exits zero", (await run()).code, 0);
  await put("nested/Dockerfile.dev", "FROM scratch\n");
  await put("nested/test.Dockerfile", "FROM scratch\n");
  await put("private/Dockerfile", "ADD https://example/a /a\n");
  await put("node_modules/Dockerfile", "ADD https://example/a /a\n");
  await put("nested/node_modules/Dockerfile", "ADD https://example/a /a\n");
  check("portable name discovery", (await prepareRecipeCheck(name, false)).lint.targets, ["build/Container", "nested/Dockerfile.dev", "nested/test.Dockerfile"]);
  for (const [label, text] of [
    ["malformed", "services: ["],
    ["escape", "services:\n  app:\n    build:\n      dockerfile: ../outside"],
    ["private", "services:\n  app:\n    build:\n      dockerfile: private/Dockerfile"],
    ["missing", "services:\n  app:\n    build:\n      dockerfile: missing"],
    ["absolute", "services:\n  app:\n    build:\n      dockerfile: D:/outside"],
  ]) {
    await put("compose.yml", text);
    const plan = await prepareRecipeCheck(name, false);
    check(`${label} compose reports warning`, plan.lint.findings.map((f) => [f.code, f.severity]), [["compose-unparsed", "warning"]]);
    check(`${label} preserves name-discovered lint`, plan.lint.targets, ["nested/Dockerfile.dev", "nested/test.Dockerfile"]);
  }
  await put("compose.yml", "services:\n  app:\n    image: alpine:3.22\n");
  await rm(join(directory, "nested"), { recursive: true });
  check("valid image-only compose avoids empty refusal", (await run()).code, 0);
  await rm(join(directory, "compose.yml"));
  let refused = false;
  try { await prepareRecipeCheck(name, false); } catch (error) { refused = error instanceof Error && error.message.split(/\s+/).filter((word) => ["no", "checks", "found"].includes(word)).join("-") === "no-checks-found"; }
  checkTrue("unchanged empty refusal", refused);
} finally { await fixture.dispose(); }
check("compose list args", composeTargets("services:\n  app:\n    build:\n      context: .\n      args:\n        - SUM=abc\n        - UNKNOWN\n"), [{ file: "Dockerfile", args: { SUM: "abc", UNKNOWN: undefined } }]);
finish("recipe lint action");
