// The persistent CLI helper: `./clawforge cli-start` brings up a long-lived container so
// `./clawforge cli`/`./clawforge mcp-serve` can `docker exec` into it instead of paying `docker compose
// run --rm`'s create/destroy cost on every call. Covers both layers:
//   - DockerRuntime.startHelper/stopHelper/helperRunning/execInHelper against a stubbed
//     transport (no docker, no network);
//   - the command-level fallback: cli()/mcpServe() try execInHelper first and fall back to
//     runOneOff only on HelperNotRunning, not on any other failure.

import { resolve } from "node:path";
import { DockerRuntime } from "#framework/runtime/runtime-docker.ts";
import { HelperNotRunning } from "#framework/runtime/runtime.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { cli } from "#framework/commands/interface/cli.ts";
import { mcpServe } from "#framework/commands/management/mcp.ts";
import { cliStart, cliStop } from "#framework/commands/interface/cli-helper.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
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

const paths = {
  async toTarget(path: string): Promise<string> {
    return path;
  },
} as unknown as PathBridge;

// Every case below is about the arguments a helper command gets. Two things the runtime
// needs before it can build any of them, stated once here: a data directory (the deployment
// environment is written beside it, and compose is pointed at that file rather than given
// the values as arguments) and a transport that can write it.
const stubSettings = { env: {}, dataDir: "/srv/openclaw/data" } as Settings;

function withFileOps(transport: Transport): Transport {
  // Added after the spread, not before: none of the stubs below writes files, and every case
  // here is about the arguments a command gets rather than about what lands on the target.
  return {
    ...transport,
    mkdirp: async (): Promise<void> => {},
    writeFile: async (): Promise<void> => {},
    remove: async (): Promise<void> => {},
  } as unknown as Transport;
}

// --- DockerRuntime: startHelper / stopHelper / helperRunning / execInHelper -------------

{
  const calls: string[][] = [];
  const transport = {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      calls.push([command, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as Transport;
  const runtime = new DockerRuntime(withFileOps(transport), stubSettings, paths, { service: "gateway" });

  await runtime.startHelper("cli-helper", "cli");
  const startCall = calls.at(-1) ?? [];
  check("startHelper includes --profile cli", startCall.includes("--profile") && startCall.includes("cli"), true);
  check("startHelper runs up --detach", startCall.includes("up") && startCall.includes("--detach"), true);
  check("startHelper names the service", startCall.includes("cli-helper"), true);

  await runtime.stopHelper("cli-helper", "cli");
  const stopCall = calls.at(-1) ?? [];
  check("stopHelper runs rm --force --stop", ["rm", "--force", "--stop"].every((f) => stopCall.includes(f)), true);
  check("stopHelper names the service", stopCall.includes("cli-helper"), true);
}

{
  // restart is its own runtime primitive on purpose: start() converges on "running", which
  // an already-healthy instance satisfies, so it would not re-read a config file edited
  // inside a bind mount.
  const calls: string[][] = [];
  const transport = {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      calls.push([command, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as Transport;
  const runtime = new DockerRuntime(withFileOps(transport), stubSettings, paths, { service: "gateway" });

  await runtime.restart();
  const call = calls.at(-1) ?? [];
  check("restart asks compose to restart the service", call.includes("restart") && call.includes("gateway"), true);
  check("restart does not recreate the container", call.includes("up") || call.includes("--force-recreate"), false);
}

{
  // runOneOff({allowFailure: true}) must reach transport.exec unchanged — callers that need
  // the untruncated result of a failing call (rather than the 5-line error message) depend
  // on this passthrough.
  let sawAllowFailure: boolean | undefined;
  const transport = {
    description: "stub",
    async exec(_command: string, _args: string[], options?: { allowFailure?: boolean }): Promise<ExecResult> {
      sawAllowFailure = options?.allowFailure;
      return { code: 1, stdout: "", stderr: "" };
    },
  } as unknown as Transport;
  const runtime = new DockerRuntime(withFileOps(transport), stubSettings, paths, { service: "gateway" });

  const result = await runtime.runOneOff("cli", ["whatever"], { profile: "cli", input: "", allowFailure: true });
  check("runOneOff forwards allowFailure to transport.exec", sawAllowFailure, true);
  check("runOneOff({allowFailure:true}) returns the failing result instead of throwing", result.code, 1);
}

{
  const transport = {
    description: "stub",
    async exec(): Promise<ExecResult> {
      return { code: 0, stdout: "b23066c5927b\n", stderr: "" };
    },
  } as unknown as Transport;
  const runtime = new DockerRuntime(withFileOps(transport), stubSettings, paths, { service: "gateway" });
  check("helperRunning true when ps returns an id", await runtime.helperRunning("cli-helper"), true);
}

{
  const transport = {
    description: "stub",
    async exec(): Promise<ExecResult> {
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as Transport;
  const runtime = new DockerRuntime(withFileOps(transport), stubSettings, paths, { service: "gateway" });
  check("helperRunning false when ps returns nothing", await runtime.helperRunning("cli-helper"), false);
}

{
  // No container: execInHelper must throw HelperNotRunning specifically, not a generic
  // Error — cli()/mcpServe() distinguish this from "the command itself failed".
  const transport = {
    description: "stub",
    async exec(): Promise<ExecResult> {
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as Transport;
  const runtime = new DockerRuntime(withFileOps(transport), stubSettings, paths, { service: "gateway" });
  let threw: unknown;
  try {
    await runtime.execInHelper("cli-helper", ["--version"]);
  } catch (error) {
    threw = error;
  }
  check("execInHelper throws HelperNotRunning when no container exists", threw instanceof HelperNotRunning, true);
}

{
  const calls: string[][] = [];
  const transport = {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      calls.push([command, ...args]);
      if (args[0] === "compose") return { code: 0, stdout: "abc123\n", stderr: "" };
      return { code: 0, stdout: "OpenClaw 2026.6.34\n", stderr: "" };
    },
  } as unknown as Transport;
  const runtime = new DockerRuntime(withFileOps(transport), stubSettings, paths, { service: "gateway" });

  await runtime.execInHelper("cli-helper", ["--version"]);
  const execCall = calls.at(-1) ?? [];
  check("execInHelper runs docker exec -i", execCall.slice(0, 3), ["docker", "exec", "-i"]);
  check("execInHelper targets the container id", execCall.includes("abc123"), true);
  check(
    "execInHelper runs node dist/index.js plus the given args",
    execCall.slice(-3),
    ["node", "dist/index.js", "--version"],
  );
}

// --- cli(): tries the helper first, falls back only on HelperNotRunning -----------------

function runtimeStub(overrides: {
  execInHelper?: () => Promise<ExecResult>;
  isRunning?: () => Promise<boolean>;
  runOneOff?: (service: string, args: string[]) => Promise<ExecResult>;
  waitForHealth?: (timeoutSeconds?: number) => Promise<void>;
  helperRunning?: () => Promise<boolean>;
  startHelper?: () => Promise<void>;
  stopHelper?: () => Promise<void>;
}) {
  return {
    isRunning: overrides.isRunning ?? (async () => true),
    execInHelper: overrides.execInHelper ?? (async () => {
      throw new HelperNotRunning("cli-helper");
    }),
    runOneOff: overrides.runOneOff ?? (async () => ({ code: 0, stdout: "", stderr: "" })),
    waitForHealth: overrides.waitForHealth ?? (async () => {}),
    helperRunning: overrides.helperRunning ?? (async () => false),
    startHelper: overrides.startHelper ?? (async () => {}),
    stopHelper: overrides.stopHelper ?? (async () => {}),
  };
}

{
  let runOneOffCalled = false;
  const ctx = {
    runtime: runtimeStub({
      execInHelper: async () => ({ code: 0, stdout: "OpenClaw 2026.6.34\n", stderr: "" }),
      runOneOff: async () => {
        runOneOffCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  } as unknown as Context;

  await cli(ctx, ["--version"]);
  check("cli() does not fall back when the helper answers", runOneOffCalled, false);
}

{
  let runOneOffArgs: string[] | undefined;
  const ctx = {
    runtime: runtimeStub({
      runOneOff: async (_service, args) => {
        runOneOffArgs = args;
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  } as unknown as Context;

  await cli(ctx, ["--version"]);
  check("cli() falls back to runOneOff on HelperNotRunning", runOneOffArgs, ["--version"]);
}

{
  // A failure from inside the running container (bad subcommand, etc.) is not
  // HelperNotRunning — it must propagate, not silently retry as a one-off.
  const ctx = {
    runtime: runtimeStub({
      execInHelper: async () => {
        throw new Error("boom");
      },
      runOneOff: async () => {
        throw new Error("should not be reached");
      },
    }),
  } as unknown as Context;

  let message: string | undefined;
  try {
    await cli(ctx, ["--version"]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("cli() propagates a real command failure instead of falling back", message, "boom");
}

{
  const ctx = {
    runtime: runtimeStub({ isRunning: async () => false }),
  } as unknown as Context;

  let message: string | undefined;
  try {
    await cli(ctx, ["--version"]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("cli() dies when the gateway is not running and the helper is not up", message?.includes("./clawforge up"), true);
}

// --- cli() over MCP: captured output, arguments passed through untouched -------------------

{
  // Streaming is right on a terminal and wrong under a sink, where the child's stdout would
  // land inside a JSON-RPC message. The switch is on how output is consumed, so both paths
  // are checked through the same call.
  let sawOptions: Record<string, unknown> | undefined;
  const ctx = {
    runtime: runtimeStub({
      execInHelper: async (): Promise<ExecResult> => ({ code: 0, stdout: "helper said this\n", stderr: "" }),
    }),
  } as unknown as Context;
  (ctx.runtime as unknown as { execInHelper: (s: string, a: string[], o?: Record<string, unknown>) => Promise<ExecResult> }).execInHelper =
    async (_service, _args, options) => {
      sawOptions = options;
      return { code: 0, stdout: "helper said this\n", stderr: "" };
    };

  await cli(ctx, ["status"]);
  check("on a terminal the child streams rather than being captured", sawOptions?.input, undefined);

  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    await cli(ctx, ["status"]);
  });
  check("under a sink the child's output is captured", sawOptions?.input, "");
  check("and handed back as the result", written.join(""), "helper said this\n");
}

{
  // OpenClaw's own flags must survive: several of its subcommands take --force, and the MCP
  // confirmation is a tool argument the server checks, never part of argv.
  let sawArgs: string[] | undefined;
  const ctx = {
    runtime: runtimeStub({
      runOneOff: async (_service, args) => {
        sawArgs = args;
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  } as unknown as Context;

  await cli(ctx, ["agents", "delete", "x", "--force"]);
  check("arguments reach OpenClaw's CLI untouched", sawArgs, ["agents", "delete", "x", "--force"]);
}

{
  // A failing OpenClaw command must reach the caller as a failure carrying its own output —
  // not as a success, and not as the transport's truncated message.
  const ctx = {
    runtime: runtimeStub({
      execInHelper: async (): Promise<ExecResult> => ({ code: 3, stdout: "partial answer\n", stderr: "the real reason\n" }),
    }),
  } as unknown as Context;

  const written: string[] = [];
  let message = "";
  await withOutputSink((chunk) => written.push(chunk), async () => {
    try {
      await cli(ctx, ["doctor"]);
    } catch (error) {
      message = (error as Error).message;
    }
  });

  check("a failing command reports its exit code", message.includes("exit 3"), true);
  check("its stdout is still handed back", written.join("").includes("partial answer"), true);
  check("and its stderr, which on a failure is the reason", written.join("").includes("the real reason"), true);
}

check("cli is declared destructive, so MCP requires a confirmation", openclawCommands.cli.destructive, true);
check("cli is no longer kept out of MCP", openclawCommands.cli.consoleOnly, undefined);

// --- mcpServe(): same fallback contract --------------------------------------------------

{
  let runOneOffCalled = false;
  const ctx = {
    runtime: runtimeStub({
      execInHelper: async () => ({ code: 0, stdout: "", stderr: "" }),
      runOneOff: async () => {
        runOneOffCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  } as unknown as Context;

  await mcpServe(ctx, []);
  check("mcpServe() does not fall back when the helper answers", runOneOffCalled, false);
}

{
  let runOneOffArgs: string[] | undefined;
  let readinessWait: number | undefined;
  const ctx = {
    runtime: runtimeStub({
      waitForHealth: async (timeoutSeconds) => {
        readinessWait = timeoutSeconds;
      },
      runOneOff: async (_service, args) => {
        runOneOffArgs = args;
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  } as unknown as Context;

  await mcpServe(ctx, []);
  check("mcpServe() falls back to runOneOff with mcp serve args", runOneOffArgs, ["mcp", "serve"]);
  check("mcpServe() waits for gateway readiness before handing over stdio", readinessWait, 30);
}

// --- cliStart() / cliStop() ---------------------------------------------------------------

{
  let started = false;
  const ctx = {
    runtime: runtimeStub({
      helperRunning: async () => false,
      startHelper: async () => {
        started = true;
      },
    }),
  } as unknown as Context;

  await cliStart(ctx, []);
  check("cliStart() starts the helper when not running", started, true);
}

{
  let started = false;
  const ctx = {
    runtime: runtimeStub({
      helperRunning: async () => true,
      startHelper: async () => {
        started = true;
      },
    }),
  } as unknown as Context;

  await cliStart(ctx, []);
  check("cliStart() does nothing when already running", started, false);
}

{
  const ctx = {
    runtime: runtimeStub({ isRunning: async () => false }),
  } as unknown as Context;

  let message: string | undefined;
  try {
    await cliStart(ctx, []);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("cliStart() dies when the gateway is not running", message?.includes("./clawforge up"), true);
}

{
  // Regression: cliStop() used to check helperRunning() first and skip cleanup entirely
  // for a container that exists but already stopped on its own (e.g. after a reboot),
  // leaving it behind. It must always attempt the (idempotent) stop.
  let stopped = false;
  const ctx = {
    runtime: runtimeStub({
      helperRunning: async () => false,
      stopHelper: async () => {
        stopped = true;
      },
    }),
  } as unknown as Context;

  await cliStop(ctx, []);
  check("cliStop() always attempts cleanup, even if helperRunning() says false", stopped, true);
}

process.stderr.write(failed === 0 ? "all cli-helper checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
