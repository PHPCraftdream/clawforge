// Regression test for a bug in DockerRuntime.portConflict(): it used to format `docker ps`
// output with `{{index .Labels "com.docker.compose.project"}}` — `.Labels` is a comma-joined
// STRING there, not a map, so `index` on it fails and the command exits non-zero. Fixed to
// use the per-key accessor `{{.Label "com.docker.compose.project"}}` instead.
//
// No docker and no network: the transport is a stub returning canned `docker ps` output.

import { resolve } from "node:path";
import { DockerRuntime } from "#framework/runtime/runtime-docker.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { preflightPort } from "#framework/commands/lifecycle/lifecycle.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult, Transport } from "#framework/runtime/transport.ts";
import type { Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";

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

interface PortFixture {
  isRunning?: boolean;
  ss?: ExecResult;
  /** `ss` fails to even launch (e.g. no such binary on a local transport) rather than
   *  exiting non-zero — both must fall through to netstat the same way. */
  ssThrows?: boolean;
  netstat?: ExecResult;
}

/** `ss` succeeds and finds nothing by default — the ordinary "free port" case — so a caller
 *  only has to script the one tool answer its scenario actually cares about. */
function contextWithConflict(holder: string | undefined, fixture: PortFixture = {}): Context {
  return {
    settings: { gatewayPort: "18789", bindAddress: "127.0.0.1" },
    runtime: {
      async portConflict(): Promise<string | undefined> {
        return holder;
      },
      async isRunning(): Promise<boolean> {
        return fixture.isRunning ?? false;
      },
    },
    transport: {
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (command === "ss") {
          if (fixture.ssThrows === true) throw new Error("spawn ss ENOENT");
          return fixture.ss ?? { code: 0, stdout: "", stderr: "" };
        }
        if (command === "netstat") return fixture.netstat ?? { code: 1, stdout: "", stderr: "" };
        throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
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
  check("no conflict and a free port means preflightPort does not throw", threw, false);
}

// --- a non-Docker listener on the same address:port --------------------------------------

{
  // ss finds something listening that Docker never published — a bare process squatting
  // the port, the exact gap portConflict() (Docker-only) cannot see.
  const ctx = contextWithConflict(undefined, {
    ss: { code: 0, stdout: "LISTEN 0 128 127.0.0.1:18789 0.0.0.0:*\n", stderr: "" },
  });
  let message: string | undefined;
  try {
    await preflightPort(ctx);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("a non-Docker listener makes preflightPort throw", message !== undefined, true);
  check("the message names the address and port", message?.includes("127.0.0.1:18789"), true);
  check("the message says Docker never saw it", message?.includes("not through Docker"), true);
  check("the message names the check-then-bind race honestly", message?.includes("not atomic"), true);
}

{
  // A wildcard bind (0.0.0.0/*) collides with a specific address the same way two specific
  // binds would — ss reports it against "*" or "0.0.0.0", never against our own address.
  const ctx = contextWithConflict(undefined, {
    ss: { code: 0, stdout: "LISTEN 0 128 0.0.0.0:18789 0.0.0.0:*\n", stderr: "" },
  });
  let threw = false;
  try {
    await preflightPort(ctx);
  } catch {
    threw = true;
  }
  check("a wildcard bind on the same port is still a conflict", threw, true);
}

{
  // Neither tool answers (both missing on the target) — an explicit warning, never a silent
  // "must be free".
  const ctx = contextWithConflict(undefined, {
    ss: { code: 127, stdout: "", stderr: "ss: not found" },
    netstat: { code: 127, stdout: "", stderr: "netstat: not found" },
  });
  let warned = "";
  let threw = false;
  await withOutputSink(
    (chunk) => {
      warned += chunk;
    },
    async () => {
      try {
        await preflightPort(ctx);
      } catch {
        threw = true;
      }
    },
  );
  check("neither ss nor netstat available does not refuse the run", threw, false);
  check("but it is warned about, not silently treated as free", warned.includes("neither ss nor netstat"), true);
}

{
  // ss itself cannot even be launched (e.g. no such binary on a local transport) — same
  // "unavailable" outcome as a nonzero exit, by falling through to netstat and then warning.
  const ctx = contextWithConflict(undefined, {
    ssThrows: true,
    netstat: { code: 127, stdout: "", stderr: "netstat: not found" },
  });
  let warned = "";
  await withOutputSink(
    (chunk) => {
      warned += chunk;
    },
    () => preflightPort(ctx),
  );
  check("ss throwing outright is treated the same as it exiting non-zero", warned.includes("neither ss nor netstat"), true);
}

{
  // The target's own gateway is already running and (necessarily) already holds the port —
  // an ordinary bootstrap re-run, not a conflict. The raw probe must not even be consulted:
  // scripting it to "always occupied" and still passing proves that.
  const ctx = contextWithConflict(undefined, {
    isRunning: true,
    ss: { code: 0, stdout: "LISTEN 0 128 127.0.0.1:18789 0.0.0.0:*\n", stderr: "" },
  });
  let threw = false;
  try {
    await preflightPort(ctx);
  } catch {
    threw = true;
  }
  check("the deployment's own already-running gateway is never a conflict with itself", threw, false);
}

{
  // A listener on some other address:port must not be mistaken for one on ours.
  const ctx = contextWithConflict(undefined, {
    ss: { code: 0, stdout: "LISTEN 0 128 127.0.0.1:19999 0.0.0.0:*\n", stderr: "" },
  });
  let threw = false;
  try {
    await preflightPort(ctx);
  } catch {
    threw = true;
  }
  check("a listener on a different port is not a conflict", threw, false);
}

process.stderr.write(failed === 0 ? "all runtime-port checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
