import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AppDefinition } from "#framework/core/app.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import type { Env } from "#framework/core/env.ts";
import { UserError } from "#framework/core/io/log.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { operateCommands } from "#framework/commands/interface/groups/openclawCommands.operate.ts";
import { runningConnectionFactsWithoutContext } from "#framework/commands/operate/recover-env/bootstrap.ts";
import { TargetReadUnknownError, type ExecResult, type Transport } from "#framework/runtime/transport/transport.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

useLinuxHost();

type Answer = ExecResult | Error;
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const failed: ExecResult = { code: 17, stdout: "", stderr: "failure" };
const cases: readonly { name: string; listing: Answer; inspections: Answer[] }[] = [
  { name: "listing throws", listing: new Error("recovery-list-sentinel"), inspections: [] },
  { name: "listing exits nonzero", listing: failed, inspections: [] },
  { name: "inspection throws", listing: ok("old\n"), inspections: [new Error("recovery-inspect-sentinel")] },
  { name: "inspection exits nonzero", listing: ok("old\n"), inspections: [failed] },
  { name: "malformed JSON", listing: ok("old\n"), inspections: [ok("{invalid-json-sentinel")] },
  ...["null", "[]", "{}", '{"State":{"Running":"false"}}'].map((document) => ({
    name: `malformed structure ${document}`, listing: ok("old\n"), inspections: [ok(document)],
  })),
];

function recoveryTransport(listing: Answer, inspections: Answer[]): { transport: Transport; dockerCalls: string[][] } {
  let index = 0;
  const dockerCalls: string[][] = [];
  const transport = {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      if (command !== "docker") throw new Error(`unexpected exec: ${command}`);
      dockerCalls.push([...args]);
      const answer = args[0] === "ps" ? listing : args[0] === "inspect" ? inspections[index++] : undefined;
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error("unexpected Docker call");
      return answer;
    },
  } as unknown as Transport;
  return { transport, dockerCalls };
}

const app: AppDefinition = {
  name: "recovery-advice-fixture",
  description: "recovery diagnostic fixture",
  service: { name: "gateway" },
  commands: { "recover-env": operateCommands["recover-env"] },
};
const seedWithoutDataDir = [
  "OC_TARGET_LOCATION=local",
  "OPENCLAW_GATEWAY_PORT=9999",
  "OPENCLAW_GATEWAY_TOKEN=not-a-real-token-check-only-value",
  "",
].join("\n");
const validInspection = JSON.stringify({
  State: { Running: true },
  Mounts: [{ Destination: "/home/node/.openclaw", Source: "/srv/data/config" }],
  NetworkSettings: { Ports: { "18789/tcp": [{ HostPort: "18790" }] } },
  Config: { Labels: { "com.docker.compose.project": "fresh-project" }, Image: "ghcr.io/openclaw/openclaw:extended-stable" },
});

const fixture = await createDeploymentFixture();
try {
  const diagnosticEnv = join(tmpdir(), basename(fixture.root), ".env");
  await writeFile(diagnosticEnv, seedWithoutDataDir, "utf8");
  for (const entry of cases) {
    const { transport } = recoveryTransport(entry.listing, entry.inspections);
    let error: unknown;
    try {
      await runningConnectionFactsWithoutContext({ env: {} as Env, transport, service: "gateway" });
    } catch (caught) {
      error = caught;
    }
    check(`${entry.name}: local recovery failure is unknown`, error instanceof TargetReadUnknownError, true);
    const advice = error instanceof UserError ? error.advice : [];
    check(`every local recovery unknown carries diagnostic kind and argv: ${entry.name}`, advice.map((step) => ({ kind: step.kind, argv: "argv" in step ? step.argv : undefined })), [{ kind: "clawforge", argv: ["recover-env", "--dry-run"] }]);
    const step = advice[0];
    if (step?.kind === "clawforge") {
      const { transport: diagnosticTransport, dockerCalls } = recoveryTransport(ok("old\n"), [ok(validInspection)]);
      const execution = await withOutputSink(() => {}, () => executeCommand(app, step.argv[0]!, { kind: "argv", argv: step.argv.slice(1) }, { surface: "terminal", transport: diagnosticTransport }));
      checkTrue(`${entry.name}: advised recovery diagnostic reaches run and contacts Docker without OC_DATA_DIR`, execution.stage === "run" && execution.error === undefined && dockerCalls.length === 2);
      check(`${entry.name}: advised dry-run leaves missing fact unchanged`, await readFile(diagnosticEnv, "utf8"), seedWithoutDataDir);
    }
  }
} finally {
  await fixture.dispose();
}
finish("recovery advice selfcheck");
