// `./clawforge cli …` — runs the OpenClaw CLI in a throwaway container that shares the gateway's
// network namespace and data mounts.
//

import { die } from "../log.ts";
import { isCaptured, emit } from "../output.ts";
import type { Context } from "../context.ts";
import type { ExecResult } from "../transport.ts";
import { HelperNotRunning } from "../runtime.ts";
import { CLI_HELPER_SERVICE } from "./cli-helper.ts";

export async function cli(ctx: Context, args: string[]): Promise<void> {
  // Passed through untouched, deliberately: the MCP confirmation is a tool argument checked
  // by the server (see mcp-server.ts) and never reaches argv, so nothing here needs
  // filtering — and filtering would break OpenClaw's own flags, which include --force on
  // several of its subcommands.
  const passed = args;

  if (passed.length === 0) {
    die("usage: ./clawforge cli <openclaw arguments>, e.g. ./clawforge cli agent --agent main -m 'hi'");
  }

  // Under a sink the child's own stdout would land in the middle of a JSON-RPC message, so
  // it is captured and re-emitted through the same sink as everything else. On a terminal
  // it streams, which is what someone watching a long command wants.
  const captured = isCaptured();
  // allowFailure only when captured: with nothing capturing it, a failure should surface the
  // way every other streamed command's does, through the transport's own error.
  const options = captured ? { input: "", allowFailure: true } : {};

  /** What the caller gets back when the output was captured. stderr is added only on a
   *  failure: on the way through `docker compose` it carries progress lines ("Container …
   *  Running") that are noise beside an answer, but the whole reason a command failed. */
  const report = (result: ExecResult): void => {
    if (!captured) return;
    emit(result.stdout);
    if (result.code !== 0) {
      emit(result.stderr);
      die(`openclaw ${passed.join(" ")} failed (exit ${result.code})`);
    }
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
