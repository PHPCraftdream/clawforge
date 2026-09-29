import { resolve } from "node:path";
import {
  IncidentPhaseFailure, preserveEvidence, runPhases,
} from "#framework/commands/operate/incident/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { registerSecret } from "#framework/core/io/log.ts";
import type { Context } from "#framework/core/context.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const secret = "synthetic-incident-secret";
registerSecret(secret);
useDeployment(resolve("incident-memory-fixture"));

for (const scenario of ["snapshot", "protect", "logs", "inspect", "inspect-and-collect"]) {
  const failedStep = scenario === "inspect-and-collect" ? "inspect" : scenario;
  const calls: string[] = [];
  const saved = new Map<string, string>();
  let preserveDir = "";
  let collectedFiles: readonly string[] = [];
  const reject = () => { throw new Error(`${failedStep} denied: ${secret}`); };
  const ctx = {
    transport: {
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    },
    runtime: {
      description: "memory-runtime",
      captureIncidentSnapshot: async () => {
        calls.push("snapshot");
        if (failedStep === "snapshot") reject();
        return { logs: `log ${secret}`, inspect: JSON.stringify({ token: secret }) };
      },
    },
    settings: {},
  } as unknown as Context;

  let thrown: unknown;
  try {
    await runPhases(ctx, { dryRun: false, keepExposure: false, tail: "500" }, {
      preserve: async (context, options, dir) => {
        preserveDir = dir;
        return preserveEvidence(context, options, dir, {
          protectDirectory: async () => {
            calls.push("protect");
            if (failedStep === "protect") reject();
          },
          writeFile: async (path, content) => {
            const step = path.endsWith("pre-rotate-logs.txt") ? "logs" : "inspect";
            calls.push(step);
            if (failedStep === step) reject();
            saved.set(path, content);
          },
        });
      },
      rotate: async () => {
        calls.push("rotate");
        return { phase: "rotate", actions: ["rotation attempted"], notes: [] };
      },
      audit: async () => {
        calls.push("audit");
        return {
          phase: { phase: "audit", actions: [], notes: [] },
          security: { findings: [], problems: [] },
          doctorLint: { raw: "{}" },
        };
      },
      collect: async (_context, _options, dir, files) => {
        calls.push("collect");
        collectedFiles = files;
        if (scenario === "inspect-and-collect") throw new Error(`collection denied: ${secret}`);
        return { phase: "collect", actions: ["collection attempted"], notes: [], archive: dir };
      },
    });
  } catch (error) {
    thrown = error;
  }

  checkTrue(`${failedStep}: phase failure reaches caller`, thrown instanceof IncidentPhaseFailure);
  const failure = thrown as IncidentPhaseFailure;
  const preserve = failure.report.phases.find((phase) => phase.phase === "preserve")!;
  check(`${failedStep}: rotate/audit/collect still run in order`, calls.slice(-3), ["rotate", "audit", "collect"]);
  checkTrue(`${failedStep}: preserve explicitly marks evidence incomplete`, preserve.error?.includes("incomplete") === true);
  checkTrue(`${failedStep}: safe original reason retained`, preserve.error?.includes(`${failedStep} denied`) === true);
  check(`${failedStep}: report and thrown message mask secret values`, JSON.stringify(failure.report).includes(secret) || failure.message.includes(secret) || String(failure.cause).includes(secret), false);
  const expectedFiles = failedStep === "inspect" ? ["pre-rotate-logs.txt"] : [];
  check(`${failedStep}: report names only confirmed files`, preserve.files, expectedFiles);
  check(`${failedStep}: collect receives only confirmed files`, collectedFiles, expectedFiles);
  check(`${failedStep}: writer received only masked evidence`, [...saved.values()].some((content) => content.includes(secret)), false);
  if (failedStep === "inspect") {
    checkTrue("partial preserve retains the real completed evidence path", preserve.actions.some((action) => action.includes(resolve(preserveDir, "pre-rotate-logs.txt"))));
    check("failed inspect is not reported as preserved", preserve.actions.some((action) => action.includes("pre-rotate-inspect.json")), false);
  }
  if (scenario === "inspect-and-collect") {
    check("failed collection does not claim a complete archive", failure.report.archive, undefined);
    checkTrue("failed collection retains its own safe reason", failure.report.phases.find((phase) => phase.phase === "collect")?.error?.includes("collection denied") === true);
    checkTrue("failed collection does not replace the original preserve failure", failure.message.includes("inspect denied"));
  }
}

finish("incident-preserve-failure");
