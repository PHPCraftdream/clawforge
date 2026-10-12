import assert from "node:assert/strict";
import { createContext } from "#framework/core/context.ts";
import { composeProjectName } from "#framework/runtime/deployment.ts";
import type { ExecOptions, ExecResult, Transport } from "#framework/runtime/transport/transport.ts";
import { readSetupMounts } from "#framework/commands/management/configuration/memory/setup/mounts.ts";
import { MemoryError } from "#framework/commands/management/configuration/memory/declaration.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { finish } from "#checks/kit/harness.ts";

const deployment = await createDeploymentFixture();
const gatewayId = "a".repeat(64), helperId = "b".repeat(64);
const root = "/home/node/.openclaw";
const bind = { Type: "bind", Source: "/srv/instance/config", Destination: root, RW: true };
const clock = Date.now;
try {
  for (const scenario of ["valid", "shadow", "readonly", "ambiguous", "missing", "wrong-label", "duplicate-id", "invalid-rw", "control-path", "failed", "timed-out", "expired", "budget"] as const) {
    let now = 1000;
    Date.now = () => now;
    const calls: { command: string; args: string[]; options: ExecOptions }[] = [];
    let project = "";
    const transport = {
      description: "local",
      async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
        calls.push({ command, args: [...args], options });
        assert.equal(command, "docker");
        assert.equal(options.input, "");
        assert.equal(options.stream, false);
        assert.equal(options.allowFailure, true);
        assert.equal(options.timeoutMs, 1000 - (calls.length - 1) * 100);
        now += scenario === "expired" ? 1001 : 100;
        if (scenario === "failed") return { code: 1, stdout: "PRIVATE", stderr: "PRIVATE" };
        if (scenario === "timed-out") return { code: 0, stdout: "PRIVATE", stderr: "PRIVATE", timedOut: true };
        if (args[0] === "ps") {
          const service = calls.length === 1 ? "managed-gateway" : "cli-helper";
          assert.deepEqual(args, ["ps", "--quiet", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`]);
          return { code: 0, stdout: scenario === "ambiguous" ? `${gatewayId}\n${helperId}\n` : scenario === "missing" ? "" : `${service === "cli-helper" ? helperId : gatewayId}\n`, stderr: "" };
        }
        assert.deepEqual(args, ["inspect", gatewayId, helperId]);
        const gatewayMounts = [{ ...bind, RW: scenario === "invalid-rw" ? "true" : scenario === "readonly" ? false : true }];
        if (scenario === "control-path") gatewayMounts[0].Destination = root + String.fromCharCode(1);
        const helperMounts = scenario === "shadow" ? [bind, { Type: "tmpfs", Source: "", Destination: root + "/models", RW: true }] : [bind];
        // Independent Docker inspect shape; deliberately reversed to require ID-based mapping.
        const rows = [
          { Id: helperId, State: { Running: true }, Config: { Labels: { "com.docker.compose.project": project, "com.docker.compose.service": "cli-helper" } }, Mounts: helperMounts },
          { Id: scenario === "duplicate-id" ? helperId : gatewayId, State: { Running: true }, Config: { Labels: { "com.docker.compose.project": scenario === "wrong-label" ? "foreign" : project, "com.docker.compose.service": "managed-gateway" } }, Mounts: gatewayMounts },
        ];
        return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
      },
    } as unknown as Transport;
    const ctx = await createContext({ transport, service: { name: "managed-gateway" } });
    project = composeProjectName();
    assert.equal(calls.length, 0);
    if (["valid", "shadow", "readonly"].includes(scenario)) {
      const inventory = await readSetupMounts(ctx, 1000);
      assert.equal(calls.length, 3);
      assert.deepEqual(inventory.gateway, [{ source: bind.Source, destination: root, type: "bind", writable: scenario !== "readonly" }]);
      assert.equal(inventory.helper.length, scenario === "shadow" ? 2 : 1);
      if (scenario === "shadow") assert.deepEqual(inventory.helper[1], { source: "", destination: root + "/models", type: "tmpfs", writable: true });
      // Shadow mounts and RW=false must remain visible to the operation's policy gate.
    } else {
      await assert.rejects(readSetupMounts(ctx, scenario === "budget" ? 0 : 1000), (error: unknown) => error instanceof MemoryError && error.code === "MOUNT" && !error.message.includes("PRIVATE") && error.cause === undefined);
      assert.equal(calls.length, scenario === "budget" ? 0 : ["ambiguous", "missing", "failed", "timed-out", "expired"].includes(scenario) ? 1 : 3);
    }
  }
} finally {
  Date.now = clock;
  await deployment.dispose();
}
finish("memory setup mounts");
