// Regression test for a bug in DockerRuntime.portConflict(): it used to format `docker ps`
// output with `{{index .Labels "com.docker.compose.project"}}` — `.Labels` is a comma-joined
// STRING there, not a map, so `index` on it fails and the command exits non-zero. Fixed to
// use the per-key accessor `{{.Label "com.docker.compose.project"}}` instead.
//
// No docker and no network: the transport is a stub returning canned `docker ps` output.

import { resolve } from "node:path";
import { DockerRuntime } from "../framework/runtime-docker.ts";
import { useDeployment, deploymentName } from "../framework/deployment.ts";
import { monorepoRoot } from "../framework/env.ts";
import { preflightPort } from "../framework/commands/lifecycle.ts";
import type { Context } from "../framework/context.ts";
import type { ExecResult, Transport } from "../framework/transport.ts";
import type { Settings } from "../framework/env.ts";
import type { PathBridge } from "../framework/paths.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

useDeployment(resolve(monorepoRoot, "apps", "example app"));
const ownProject = deploymentName();

const paths = {
  async toTarget(path: string): Promise<string> {
    return path;
  },
} as unknown as PathBridge;

/** Builds a DockerRuntime whose `docker ps --filter publish=...` call answers with the given
 *  canned result, regardless of the rest of the arguments. */
function runtimeWith(psResult: ExecResult): DockerRuntime {
  const transport = {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      if (command === "docker" && args[0] === "ps") return psResult;
      throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
    },
  } as unknown as Transport;

  return new DockerRuntime(transport, {} as Settings, paths, { service: "app" });
}

// --- DockerRuntime.portConflict ------------------------------------------------

{
  const runtime = runtimeWith({ code: 0, stdout: "", stderr: "" });
  check("empty stdout means the port is free", await runtime.portConflict("18789"), undefined);
}

{
  const runtime = runtimeWith({ code: 1, stdout: "", stderr: "no such filter" });
  check("a non-zero exit means the port is free", await runtime.portConflict("18789"), undefined);
}

{
  const runtime = runtimeWith({ code: 0, stdout: "other-project\tother-project-app-1", stderr: "" });
  const holder = await runtime.portConflict("18789");
  check("a real conflict names the container", holder?.includes("other-project-app-1"), true);
  check("a real conflict names the other project", holder?.includes("other-project"), true);
}

{
  const runtime = runtimeWith({ code: 0, stdout: `${ownProject}\tapp-1`, stderr: "" });
  check(
    "the same deployment restarting its own container is not a conflict",
    await runtime.portConflict("18789"),
    undefined,
  );
}

{
  const runtime = runtimeWith({ code: 0, stdout: "\tsome-container", stderr: "" });
  const holder = await runtime.portConflict("18789");
  check("an empty project field is reported as \"none\"", holder?.includes("(compose project none)"), true);
  check("an empty project field still names the container", holder?.includes("some-container"), true);
}

// --- preflightPort ---------------------------------------------------------------

function contextWithConflict(holder: string | undefined): Context {
  return {
    settings: { gatewayPort: "18789" },
    runtime: {
      async portConflict(): Promise<string | undefined> {
        return holder;
      },
    },
  } as unknown as Context;
}

{
  let message: string | undefined;
  try {
    await preflightPort(contextWithConflict("other-app-1 (compose project other)"));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("a conflict makes preflightPort throw", message !== undefined, true);
  check("the message names the port", message?.includes("18789"), true);
  check("the message names the holder", message?.includes("other-app-1 (compose project other)"), true);
  check("the message points at OPENCLAW_GATEWAY_PORT", message?.includes("OPENCLAW_GATEWAY_PORT"), true);
}

{
  let threw = false;
  try {
    await preflightPort(contextWithConflict(undefined));
  } catch {
    threw = true;
  }
  check("no conflict means preflightPort does not throw", threw, false);
}

process.stderr.write(failed === 0 ? "all runtime-port checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
