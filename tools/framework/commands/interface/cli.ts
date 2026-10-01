// `./clawforge cli …` — runs the OpenClaw CLI in a throwaway container that shares the gateway's
// network namespace and data mounts.

import { die, dieWithExitCode } from "#src/core/io/log.ts";
import { isCaptured, emitRaw } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { HelperNotRunning } from "#src/runtime/runtime.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import { CLI_HELPER_SERVICE } from "./cli-helper.ts";

export const CLI_ARGUMENTS = [
  {
    name: "args",
    summary: "Arguments passed to OpenClaw's CLI verbatim",
    description: "Arguments passed to OpenClaw's CLI verbatim, e.g. [\"config\", \"get\", \"gateway.mode\"]",
    kind: "variadic",
    required: true,
  },
] as const;

/** The command body; cli(ctx, args) stays for callers that already hold a Context. The
 *  verbatim tail starts at the first token that is no declared flag of ours — a leading
 *  bare -- is consumed as the boundary, everything after it is literal. */
export const CLI = commandBody({
  effect: "destroy",
  arguments: CLI_ARGUMENTS,
  async run(ctx, { args: passed }) {
    await runCli(ctx, [...passed]);
  },
});

export async function cli(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(CLI, ctx, args);
}

async function runCli(ctx: Context, passed: string[]): Promise<void> {
  if (passed.length === 0) {
    die("usage: ./clawforge cli <openclaw arguments>, e.g. ./clawforge cli agent --agent main -m 'hi'");
  }

  // Under a sink the child's own stdout would land in the middle of a JSON-RPC message, so
  // it is captured and re-emitted through the same sink as everything else. On a terminal
  // it streams, which is what someone watching a long command wants.
  const captured = isCaptured();
  // allowFailure always: a non-zero exit is reported below with openclaw's own exit code
  // (dieWithExitCode), never surfaced as the transport's own generic rejection.
  const options = captured ? { input: "", allowFailure: true } : { allowFailure: true };

  /** stderr is added only on failure and only when captured: through `docker compose` it
   *  carries progress-line noise, but is the whole reason a command failed; streamed output
   *  already reached the terminal by the time this runs. */
  const report = (result: ExecResult): void => {
    if (captured) {
      emitRaw(result.stdout);
      if (result.code !== 0) emitRaw(result.stderr);
    }
    if (result.code !== 0) dieWithExitCode(`openclaw ${passed.join(" ")} failed (exit ${result.code})`, result.code);
  };

  // Tried first, before the isRunning() preflight below: a helper that execs successfully
  // already proves the gateway is reachable, and skipping the extra round trip on the fast
  // path is most of the point of having a helper at all.
  try {
    report(await ctx.runtime.execInHelper(CLI_HELPER_SERVICE, passed, options));
    return;
  } catch (error) {
    if (!(error instanceof HelperNotRunning)) throw error;
  }

  if (!(await ctx.runtime.isRunning())) {
    die("the gateway is not running. Start it with ./clawforge up");
  }

  // Disposable by design: everything it touches lives in the bind mounts.
  report(await ctx.runtime.runOneOff("cli", passed, { profile: "cli", ...options }));
}
