import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError, ConfirmationRequiredError } from "#framework/core/command/index.ts";
import { envReads, resetEnvReads } from "#framework/core/env.ts";
import { managementCommands } from "#framework/commands/interface/groups/openclawCommands.management.ts";
import { configure } from "#framework/commands/management/configuration/memory/declaration.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const fixtureRoot = await mkdtemp(join(tmpdir(), "memory-setup-action-"));
const fixture = await createDeploymentFixture({ root: fixtureRoot }).catch(async (error) => {
  await rm(fixtureRoot, { recursive: true, force: true });
  throw error;
});
const app = { name: "memory-setup-action-check", description: "fixture", commands: { memory: managementCommands.memory } };
const revision = "a".repeat(40);
const source = `https://huggingface.co/owner/model/resolve/${revision}/approved.gguf`;
const approvalArgs = ["--model-source", source, "--model-version", revision, "--model-checksum", "b".repeat(64), "--plugin-version", "1.2.3", "--model-max-bytes", "1024"];
const argv = ["setup", "--agent", "main", ...approvalArgs, "--allow-install", "--allow-download", "--json"];
const modelPath = "/home/node/.openclaw/models/approved.gguf";
const local = configure([], "embeddings", "local", modelPath, undefined, modelPath);
const declarationPath = join(fixtureRoot, "config", "desired-state.json");
const envPath = join(fixtureRoot, ".env");
try {
  await writeFile(declarationPath, JSON.stringify(local));
  await writeFile(envPath, "this file carries no assignment\n");
  const envBefore = await readFile(envPath, "utf8");
  const declarationBefore = await readFile(declarationPath, "utf8");
  resetEnvReads();
  const unconfirmed = await executeCommand(app, "memory", { kind: "argv", argv }, { surface: "mcp", confirmed: false, transport: fixture.transport() });
  check("setup unconfirmed stops at confirm", unconfirmed.stage, "confirm");
  checkTrue("setup typed confirmation required", unconfirmed.error instanceof ConfirmationRequiredError);
  check("setup confirmation zero env reads", envReads(), 0);
  check("setup confirmation zero contacts", fixture.contacts(), []);
  check("setup confirmation no declaration write", await readFile(declarationPath, "utf8"), declarationBefore);
  check("setup confirmation no env write", await readFile(envPath, "utf8"), envBefore);
  check("setup confirmation no environment provisioning", unconfirmed.environmentWrote, undefined);

  const badSource = argv.map((value) => value === source ? "https://unapproved.invalid/model.gguf" : value);
  const cases = [
    { label: "nonlocal", ops: configure([], "embeddings", "openai", "remote-model"), args: argv },
    { label: "invalid source", ops: local, args: badSource },
    { label: "missing install consent", ops: local, args: argv.filter((value) => value !== "--allow-install") },
    { label: "missing download consent", ops: local, args: argv.filter((value) => value !== "--allow-download") },
    { label: "missing both consents", ops: local, args: argv.filter((value) => !["--allow-install", "--allow-download"].includes(value)) },
    { label: "contradictory native identity", ops: local.map((op) => op.path === "agents.defaults.memorySearch.model" ? { ...op, value: "arbitrary-label" } : op), args: argv },
  ];
  for (const kase of cases) {
    const before = JSON.stringify(kase.ops);
    await writeFile(declarationPath, before);
    resetEnvReads();
    const result = await executeCommand(app, "memory", { kind: "argv", argv: kase.args }, { surface: "mcp", confirmed: true, transport: fixture.transport() });
    check(`setup ${kase.label} refuses in prepare`, result.stage, "prepare");
    checkTrue(`setup ${kase.label} typed refusal`, result.error instanceof ArgumentError);
    check(`setup ${kase.label} zero contacts`, fixture.contacts(), []);
    check(`setup ${kase.label} zero env reads`, envReads(), 0);
    check(`setup ${kase.label} no declaration write`, await readFile(declarationPath, "utf8"), before);
    check(`setup ${kase.label} no env write`, await readFile(envPath, "utf8"), envBefore);
    check(`setup ${kase.label} no provisioning`, result.environmentWrote, undefined);
  }

  await writeFile(declarationPath, declarationBefore);
  resetEnvReads();
  const valid = await executeCommand(app, "memory", { kind: "argv", argv }, { surface: "mcp", confirmed: true, transport: fixture.transport() });
  check("valid setup prepare reaches malformed-env context", valid.stage, "context");
  checkTrue("valid setup context refuses malformed env", valid.error instanceof Error);
  checkTrue("valid setup target context reads env", envReads() > 0);
  check("valid setup never reaches execution", valid.reachedRun, false);
  check("valid setup no automatic target contact", fixture.contacts(), []);
  check("valid setup no declaration write", await readFile(declarationPath, "utf8"), declarationBefore);
  check("valid setup no env write", await readFile(envPath, "utf8"), envBefore);
  check("valid setup no automatic provisioning", valid.environmentWrote, undefined);
} finally {
  await fixture.dispose();
}
finish("memory setup action");
