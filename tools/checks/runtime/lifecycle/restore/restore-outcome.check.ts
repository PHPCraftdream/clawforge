// Public restore JSON reports data restoration independently of gateway startup.
import { resolve } from "node:path";
import type { Context } from "#framework/core/context.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { lockPath, runOwning, type HeldLock } from "#framework/runtime/lock/instance-lock.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));
const DATA_DIR = "/srv/clawforge-restore-outcome/data";
const ARCHIVE = "/srv/clawforge-restore-outcome/backups/full.tar.gz";

function fixture(secretsPresent: boolean): { ctx: Context; calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    settings: { dataDir: DATA_DIR, env: {} },
    transport: {
      description: "restore-outcome-fixture",
      async exists(path: string): Promise<boolean> {
        return path !== `${DATA_DIR}/config/.env` || secretsPresent;
      },
      async readFile(path: string): Promise<string> {
        if (path === `${DATA_DIR}/config/openclaw.json`) {
          return JSON.stringify({ provider: { key: { source: "env", id: "REQUIRED_VAR" } } });
        }
        return path === `${DATA_DIR}/config/.env` ? "REQUIRED_VAR=fixture-only-placeholder\n" : "";
      },
      async writeFile(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async remove(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (command === "tar" && args.includes("-tzf")) return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        if (command === "tar" && args.includes("-tvzf")) return { code: 0, stdout: "", stderr: "" };
        if (command === "tar" && args.includes("-xzf")) calls.push("extract");
        if (command === "stat") return { code: 0, stdout: "1000:1000", stderr: "" };
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: args[1] ?? "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: {
      async isRunning(): Promise<boolean> { return true; },
      async stop(): Promise<void> { calls.push("stop"); },
      async start(): Promise<void> { calls.push("start"); },
      async waitForHealth(): Promise<void> { calls.push("health"); },
    },
  } as unknown as Context;
  return { ctx, calls };
}

for (const scenario of [
  { name: "missing secrets", secretsPresent: false, noStart: false, started: false, reason: "missing-secrets", nextAction: "./clawforge secrets --apply --store <name>, then ./clawforge up" },
  { name: "explicit no-start", secretsPresent: true, noStart: true, started: false, reason: "no-start", nextAction: "./clawforge up" },
  { name: "healthy startup", secretsPresent: true, noStart: false, started: true },
]) {
  const { ctx, calls } = fixture(scenario.secretsPresent);
  // Mirror restore nested under a parent mutation; locking itself has separate checks.
  const held = { resource: `${ctx.transport.description}\u0000${lockPath(ctx)}` } as HeldLock;
  let output = "";
  await withOutputSink((line) => { output += line; }, () => runOwning(held, () =>
    openclawCommands.restore.run(ctx, [ARCHIVE, "--force", "--json", ...(scenario.noStart ? ["--no-start"] : [])]),
  ));
  const report = JSON.parse(output) as Record<string, unknown>;
  check(`${scenario.name}: data restoration succeeds`, [report.ok, report.changed, report.restored], [true, true, true]);
  check(`${scenario.name}: data was actually extracted`, calls.includes("extract"), true);
  check(`${scenario.name}: JSON reports actual startup`, report.started, scenario.started);
  check(`${scenario.name}: gateway start agrees with JSON`, calls.includes("start"), scenario.started);
  check(`${scenario.name}: health was awaited when started`, calls.includes("health"), scenario.started);
  check(`${scenario.name}: reason identifies the skipped start`, report.reason, scenario.reason);
  check(`${scenario.name}: next action matches the missing prerequisite`, report.nextAction, scenario.nextAction);
  check(`${scenario.name}: JSON excludes credential names and values`, /REQUIRED_VAR|fixture-only-placeholder/.test(output), false);
}

finish("restore outcome");
