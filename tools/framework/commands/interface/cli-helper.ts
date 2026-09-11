// `./clawforge cli-start` / `./clawforge cli-stop` — explicit control over the persistent CLI helper
// container that `cli` and `mcp-serve` exec into when it is running, instead of paying a
// fresh container's create/destroy cost on every call.

import { log, die } from "../../core/log.ts";
import type { Context } from "../../core/context.ts";

export const CLI_HELPER_SERVICE = "cli-helper";
export const CLI_PROFILE = "cli";

export async function cliStart(ctx: Context, _args: string[]): Promise<void> {
  if (!(await ctx.runtime.isRunning())) {
    die("the gateway is not running. Start it with ./clawforge up");
  }
  if (await ctx.runtime.helperRunning(CLI_HELPER_SERVICE)) {
    log("the CLI helper is already running");
    return;
  }
  await ctx.runtime.startHelper(CLI_HELPER_SERVICE, CLI_PROFILE);
  log("CLI helper started — ./clawforge cli and ./clawforge mcp-serve will exec into it");
}

export async function cliStop(ctx: Context, _args: string[]): Promise<void> {
  // No running-check first: `rm --force --stop` is already a safe no-op when nothing is
  // there, and a check-then-act here would miss a container that exists but already
  // stopped on its own (e.g. after a host reboot), leaving it behind uncleaned.
  await ctx.runtime.stopHelper(CLI_HELPER_SERVICE, CLI_PROFILE);
  log("CLI helper stopped");
}
