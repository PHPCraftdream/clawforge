// `./clawforge cli …` — runs the OpenClaw CLI in a throwaway container that shares the gateway's
// network namespace and data mounts.

import { die, dieWithExitCode } from "#src/core/io/log.ts";
import { isCaptured, emitRaw } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { HelperNotRunning } from "#src/runtime/runtime.ts";
import { CLI_HELPER_SERVICE } from "./cli-helper.ts";

export async function cli(ctx: Context, args: string[]): Promise<void> {
  // A leading bare -- is our own boundary (`./clawforge cli -- --help` reaches OpenClaw's
  // real --help instead of ours) and is stripped; everything else passes through untouched —
  // filtering would break OpenClaw's own flags, which include --force on several subcommands.
  const passed = args[0] === "--" ? args.slice(1) : args;

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
