import { check, finish } from "#checks/kit/harness.ts";
import { createDeploymentFixture, stageTally } from "#checks/kit/deployment-fixture.ts";
import { runProcess } from "#checks/kit/spawn.ts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Stage } from "#framework/core/command/execute.ts";
import { buildChangedInventory, runChangedInventory } from "#checks/integration/mcp/dispatch/changed-inventory.ts";

const fixture = await createDeploymentFixture();
const tally = stageTally();
const moduleUrl = (name: string): string => pathToFileURL(join(process.cwd(), "tools", "framework", name)).href;
const script = `
  const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp/server.ts"))});
  const { useDeployment } = await import(${JSON.stringify(moduleUrl("runtime/deployment.ts"))});
  const { defineApp } = await import(${JSON.stringify(moduleUrl("core/app.ts"))});
  const { commandBody, materializeCommands } = await import(${JSON.stringify(moduleUrl("core/command/spec.ts"))});
  const { emit } = await import(${JSON.stringify(moduleUrl("core/io/output.ts"))});
  const { UserError } = await import(${JSON.stringify(moduleUrl("core/io/log.ts"))});
  await useDeployment(${JSON.stringify(fixture.root)});
  const mode = process.env.CASE_MODE;
  const body = (effect) => commandBody({
    effect, arguments: [], needs: "target",
    preparesEnvironment: mode.startsWith("environment"),
    ...(mode === "prepare" ? { prepare: async () => { throw new UserError("prepare refusal"); } } : {}),
    run: async () => {
      emit(JSON.stringify({ changed: effect !== "read" }));
      if (mode === "run") throw new Error("interrupted run");
    },
  });
  const commands = materializeCommands({
    destroy: { summary: "fixture destroy", group: "change", structured: true, ...body("destroy") },
    change: { summary: "fixture change", group: "change", structured: true, ...body("change") },
    read: { summary: "fixture read", group: "check", structured: true, ...body("read") },
  });
  const settings = mode.startsWith("environment") ? () => { throw new UserError(mode === "environment-no-write" ? "settings refusal no write" : "settings refusal"); } : undefined;
  const app = defineApp({ name: "fixture", description: "MCP changed fixture", commands, settings });
  await serveMcp(app, [], [], {
    observe: (stage) => process.stderr.write("PIPELINE_STAGE " + stage + "\\n"),
    transport: new Proxy({}, { get: (_target, method) => (...args) => { process.stderr.write("TRANSPORT_CONTACT " + String(method) + "\\n"); throw new Error("fixture transport refusal"); } }),
  });
`;

try {
  const inventory = buildChangedInventory();
  check("changed inventory has mutating units", inventory.length > 0, true);
  await runChangedInventory({ fixture, tally });
  const scenarios: readonly { label: string; mode: string; call: { name: string; arguments: Record<string, unknown> }; expected: Stage; changed?: boolean; bare: boolean }[] = [
    { label: "parse bare unknown named field", mode: "safe", call: { name: "change", arguments: { __unknown: "x" } }, expected: "parse", bare: true },
    { label: "destroy confirmation refusal", mode: "safe", call: { name: "destroy", arguments: {} }, expected: "confirm", bare: true },
    { label: "prepare refusal", mode: "prepare", call: { name: "change", arguments: {} }, expected: "prepare", changed: false, bare: false },
    { label: "context refusal without environment write", mode: "environment-no-write", call: { name: "change", arguments: {} }, expected: "context", changed: false, bare: false },
    { label: "context refusal after environment token write", mode: "environment", call: { name: "change", arguments: {} }, expected: "context", changed: true, bare: false },
    { label: "safe mutating run", mode: "safe", call: { name: "change", arguments: { confirm: true } }, expected: "run", changed: true, bare: false },
    { label: "read run", mode: "safe", call: { name: "read", arguments: {} }, expected: "run", changed: false, bare: false },
    { label: "interrupted mutating run", mode: "run", call: { name: "change", arguments: { confirm: true } }, expected: "run", changed: true, bare: false },
  ];
  const envPath = join(fixture.root, ".env");
  const originalEnv = await readFile(envPath, "utf8");
  for (const scenario of scenarios) {
    await writeFile(envPath, originalEnv, "utf8");
    if (scenario.mode === "environment") {
      const withoutToken = originalEnv.replace(/^OPENCLAW_GATEWAY_TOKEN=.*\n/m, "");
      await writeFile(envPath, withoutToken, "utf8");
    }
    const expectedToken = scenario.mode !== "environment";
    const envBefore = await readFile(envPath, "utf8");
    check(`${scenario.label}: token setup is independent`, envBefore.includes("OPENCLAW_GATEWAY_TOKEN="), expectedToken);
    const mode = scenario.mode;
    const result = await runProcess(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, CASE_MODE: mode },
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: scenario.call })}\n`, timeoutMs: 60_000,
    });
    const stageLine = new RegExp("PIPELINE_STAGE (parse|confirm|prepare|environment|context|run)", "g");
    const observed = result.stderr.match(stageLine)?.map((entry) => entry.slice("PIPELINE_STAGE ".length)) ?? [];
    const responses = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const resultBody = responses.find((response) => response.id === 1)?.result as Record<string, unknown> | undefined;
    const bare = resultBody !== undefined && typeof resultBody.isError === "boolean" && !("structuredContent" in resultBody) && !("structured" in resultBody);
    check(`${scenario.label}: stdio server exits successfully`, result.code, 0);
    check(`${scenario.label}: actual stage observed`, observed.at(-1), scenario.expected);
    const payload = resultBody?.structuredContent as Record<string, unknown> | undefined;
    const actualChanged = payload?.changed ?? resultBody?.changed;
    check(`${scenario.label}: changed envelope present as expected`, typeof actualChanged === "boolean", scenario.changed !== undefined);
    if (scenario.changed !== undefined) check(`${scenario.label}: literal changed value`, actualChanged, scenario.changed);
    check(`${scenario.label}: refusal envelope is bare as expected`, bare, scenario.bare);
    check(`${scenario.label}: recording transport untouched`, result.stderr.includes("TRANSPORT_CONTACT"), false);
    tally.case(scenario.label, observed.at(-1) as Stage | undefined ?? "parse", result.code === 0 ? undefined : new Error(result.stderr));
  }
  check("fixture env is isolated in OS temp", originalEnv.includes(fixture.root), true);
  await rm(envPath);
  await mkdir(envPath);
  const result = await runProcess(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(), env: { ...process.env, CASE_MODE: "environment-no-write" },
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "change", arguments: {} } })}\n`, timeoutMs: 60_000,
  });
  const stageLine = new RegExp("PIPELINE_STAGE (parse|confirm|prepare|environment|context|run)", "g");
  const observed = result.stderr.match(stageLine)?.map((entry) => entry.slice("PIPELINE_STAGE ".length)) ?? [];
  check("environment refusal without writable env: stdio server exits successfully", result.code, 0);
  check("environment refusal without writable env: actual stage observed", observed.at(-1), "environment");
  check("environment refusal without writable env: recording transport untouched", result.stderr.includes("TRANSPORT_CONTACT"), false);
} finally {
  tally.print("mcp-changed");
  await fixture.dispose();
}
finish("mcp-changed");
