// `clawforge exec …` — runs an arbitrary command in the same sidecar `clawforge cli` uses:
// the OpenClaw image, the gateway's network namespace, the same data mounts — but any
// command, not just the app's own CLI entrypoint. For diagnostics `cli` cannot reach: reading
// a file bundled in the image, a curl probe against something only reachable from inside that
// network namespace (a recipe's sidecar port, for instance).

import { die, dieWithExitCode } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { isCaptured, emitRaw } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { HelperNotRunning, requireBootstrapped } from "#src/runtime/runtime.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import { CLI_HELPER_SERVICE } from "./cli-helper.ts";

export const EXEC_ARGUMENTS = [
  {
    name: "args",
    summary: "Command and arguments to run",
    description: "Command and arguments to run, e.g. [\"curl\", \"-fsS\", \"http://127.0.0.1:18789/healthz\"]",
    kind: "variadic",
    verbatim: true,
    required: true,
  },
] as const;

/** The command body; exec(ctx, args) stays for callers that already hold a Context. Same
 *  verbatim-tail rule as cli: the first token that is no flag of ours starts the command,
 *  and everything from there is literal. */
export const EXEC = commandBody({
  effect: "destroy",
  arguments: EXEC_ARGUMENTS,
  async run(ctx, { args }) {
    await runExec(ctx, [...args]);
  },
});

export async function exec(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(EXEC, ctx, args);
}

async function runExec(ctx: Context, rawArgs: string[]): Promise<void> {
  // Empty argv is refused by the parser: the verbatim variadic is declared required (see cli).
  const [command, ...rest] = rawArgs;

  // Same never-bootstrapped refusal as cli's; without it the isRunning() preflight below
  // dies with the bare NotBootstrapped message.
  await requireBootstrapped(ctx);

  // Same capture/streaming and failure-reporting shape as `cli` — see its own comments for why.
  const captured = isCaptured();
  const options = captured ? { input: "", allowFailure: true } : { allowFailure: true };

  const report = (result: ExecResult): void => {
    if (captured) {
      // Both streams whatever the exit code: a successful command's diagnostics live on stderr.
      emitRaw(result.stdout);
      emitRaw(result.stderr);
    }
    if (result.code !== 0) dieWithExitCode(`exec ${rawArgs.join(" ")} failed (exit ${result.code})`, result.code);
  };

  if (ctx.runtime.execCommand === undefined) {
    die(`${ctx.runtime.description} does not support ${commandLine("exec")}`);
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
    die(`the gateway is not running. Start it with ${commandLine("up")}`);
  }

  // Disposable by design, same as `cli`'s own fallback: everything it touches lives in the
  // bind mounts, and --entrypoint hands the whole command line to the one-off container
  // instead of the "cli" service's own fixed "node dist/index.js" entrypoint.
  report(await ctx.runtime.runOneOff("cli", rest, { profile: "cli", entrypoint: command, ...options }));
}
