// Incomplete scans must stop both backup and pull before publication.

import { resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { pullScenario } from "../../../runtime/service/state/pull-harness.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { createBackup } from "#framework/commands/lifecycle/backup/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));

const results: [string, ExecResult, boolean][] = [
  ["signal-empty", { code: -1, stdout: "", stderr: "" }, true],
  ["signal-partial", { code: -1, stdout: "data/workspace/first.md\n", stderr: "" }, true],
  ["timeout-zero", { code: 0, stdout: "", stderr: "", timedOut: true }, true],
  ["timeout-one", { code: 1, stdout: "", stderr: "", timedOut: true }, true],
  ["error", { code: 2, stdout: "", stderr: "" }, true],
  ["unexpected", { code: 127, stdout: "", stderr: "" }, true],
  ["complete-match", { code: 0, stdout: "data/workspace/first.md\n", stderr: "" }, true],
  ["complete-clean", { code: 1, stdout: "", stderr: "" }, false],
];

function scenarioForScan(result: ExecResult, scanNumber = 1) {
  const scenario = pullScenario();
  const { ctx, events, files } = scenario;
  const exec = ctx.transport.exec.bind(ctx.transport);
  let scans = 0;
  Object.defineProperty(ctx.transport, "mkdirPrivate", {
    value: async (path: string): Promise<void> => {
      events.push(`private-directory:${path}`);
      files.set(path, "");
    },
  });
  Object.defineProperty(ctx.transport, "writePrivateFile", {
    value: async (path: string, content: string): Promise<void> => {
      events.push(`private-pattern:${path}`);
      files.set(path, content);
    },
  });
  const remove = ctx.transport.remove.bind(ctx.transport);
  ctx.transport.remove = async (path) => {
    events.push(`remove:${path}`);
    await remove(path);
  };
  ctx.transport.exec = async (command, args, options) => {
    if (command !== "grep") return exec(command, args, options);
    events.push(`grep:${args.join(" ")}`);
    scans += 1;
    return scans === scanNumber ? result : { code: 1, stdout: "", stderr: "" };
  };
  return { ...scenario, scans: () => scans };
}

function checkCleanup(label: string, scenario: ReturnType<typeof scenarioForScan>): void {
  const { events, files } = scenario;
  check(`${label} releases its lock`, scenario.lock(), false);
  check(`${label} cleans scan and publication staging`, [...files.keys()].some((path) =>
    path.startsWith("/tmp/clawforge-verify-") || path.includes(".clawforge-backup-") || path.includes(".clawforge-pull-")), false);
  const patterns = events.filter((event) => event.startsWith("private-pattern:")).map((event) => event.slice("private-pattern:".length));
  checkTrue(`${label} used the secret scan`, patterns.length > 0);
  checkTrue(`${label} removes every pattern`, patterns.every((path) => events.includes(`remove:${path}`)));
  const sessions = events.filter((event) => event.startsWith("private-directory:") && !event.endsWith("/tree"))
    .map((event) => event.slice("private-directory:".length));
  checkTrue(`${label} removes every private session`, sessions.every((path) => events.includes(`rm:-rf ${path}`)));
}

for (const profile of ["share", "migrate"] as const) {
  for (const operation of ["backup", "pull"] as const) {
    for (const [name, result, refuses] of results) {
      const label = `${operation} ${profile} ${name}`;
      const scenario = scenarioForScan(result);
      let rejected = false;
      await withOutputSink(() => {}, async () => {
        try {
          if (operation === "backup") await createBackup(scenario.ctx, { profile });
          else await openclawCommands.pull.run(scenario.ctx, ["--profile", profile]);
        } catch {
          rejected = true;
        }
      });
      check(`${label} preserves the scan verdict`, rejected, refuses);
      checkCleanup(label, scenario);
      if (refuses) {
        check(`${label} never publishes an archive`, scenario.events.some((event) => event.startsWith("mv:") && event.includes(".tar.gz")), false);
        check(`${label} leaves only the previous snapshot`, [...scenario.files.keys()].filter((path) => path.endsWith(".tar.gz")).length, 1);
      }
    }
  }
}

// The second share scan runs after backup publication; refusal must delete that source too.
for (const [name, result, refuses] of results.filter(([, , refuses]) => refuses)) {
  const label = `pull staged share ${name}`;
  const scenario = scenarioForScan(result, 2);
  let rejected = false;
  await withOutputSink(() => {}, async () => {
    try { await openclawCommands.pull.run(scenario.ctx, ["--share"]); }
    catch { rejected = true; }
  });
  check(`${label} refuses publication`, rejected, refuses);
  check(`${label} reached staged verification`, scenario.scans(), 2);
  checkCleanup(label, scenario);
  check(`${label} deletes the published backup and staged snapshot`, [...scenario.files.keys()].filter((path) => path.endsWith(".tar.gz")).length, 1);
  check(`${label} never moves a new snapshot into place`, scenario.events.some((event) => event.startsWith("mv:") && event.includes("-state-") && event.includes(".tar.gz")), false);
}

finish("incomplete-scan");
