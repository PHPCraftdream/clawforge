// `./clawforge exec …` — runs an arbitrary command in the same sidecar `./clawforge cli` uses:
// the OpenClaw image, the gateway's network namespace, the same data mounts — but any
// command, not just the app's own CLI entrypoint. For diagnostics `cli` cannot reach: reading
// a file bundled in the image, a curl probe against something only reachable from inside that
// network namespace (a recipe's sidecar port, for instance).

import { die } from "#src/core/log.ts";
import { isCaptured, emit } from "#src/core/output.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport.ts";
import { HelperNotRunning } from "#src/runtime/runtime.ts";
import { CLI_HELPER_SERVICE } from "./cli-helper.ts";

export async function exec(ctx: Context, args: string[]): Promise<void> {
  if (args.length === 0) {
    die("usage: ./clawforge exec <command> [args...], e.g. ./clawforge exec cat /app/docs/channels/telegram.md");
  }
  const [command, ...rest] = args;

  // Same capture/streaming and failure-reporting shape as `cli` — see its own comments for why.
  const captured = isCaptured();
  const options = captured ? { input: "", allowFailure: true } : {};

  const report = (result: ExecResult): void => {
    if (!captured) return;
    emit(result.stdout);
    if (result.code !== 0) {
      emit(result.stderr);
      die(`exec ${args.join(" ")} failed (exit ${result.code})`);
    }
  };

  if (ctx.runtime.execCommand === undefined) {
    die(`${ctx.runtime.description} does not support ./clawforge exec`);
  }

  // Tried first, same reasoning as `cli`: an already-running helper answers faster than a
  // fresh one-off container, and proves the gateway is reachable in the same step.
  try {
    report(await ctx.runtime.execCommand(CLI_HELPER_SERVICE, command, rest, options));
    return;
  } catch (error) {
    if (!(error instanceof HelperNotRunning)) throw error;
  }

  if (!(await ctx.runtime.isRunning())) {
    die("the gateway is not running. Start it with ./clawforge up");
  }

  // Disposable by design, same as `cli`'s own fallback: everything it touches lives in the
  // bind mounts, and --entrypoint hands the whole command line to the one-off container
  // instead of the "cli" service's own fixed "node dist/index.js" entrypoint.
  report(await ctx.runtime.runOneOff("cli", rest, { profile: "cli", entrypoint: command, ...options }));
}
