// `./clawforge watch` — health monitoring with a webhook alert on state change, so an operator
// learns the instance stopped doing its job without polling by hand.
//
// Lives outside commands/ on the same precedent as expose/ (see that module's own header
// and docs/architecture.md): every command-family directory here already sits at
// layout.check.ts's seven-direct-entry cap, and tools/framework/ itself has no direct
// source file of its own, so a new top-level module is where this fits without relocating
// something unrelated just to free a slot.

import { die } from "../core/log.ts";
import type { Context } from "../core/context.ts";
import { watchCheck } from "./check.ts";
import { watchInstall, watchUninstall } from "./install.ts";
import { watchStatus } from "./status.ts";

export { watchLevel, runWatchCycle } from "./check.ts";
export type { WatchLevel, WatchReason, WatchState } from "./state.ts";

/** Only install/uninstall --apply mutate the target (a crontab entry); check and status
 *  only read the instance and this deployment's own state file. One predicate for the
 *  MCP gate's readOnlyWhen/changedWhen/requiresConfirmationWhen, same reasoning as
 *  expose/index.ts's exposeActionIsReadOnly. */
export function watchActionIsReadOnly(argv: string[]): boolean {
  const action = argv[0];
  if (action === "install" || action === "uninstall") return !argv.includes("--apply");
  return true;
}

export async function watch(ctx: Context, args: string[]): Promise<void> {
  const [action, ...rest] = args;
  switch (action) {
    case "check": return watchCheck(ctx, rest);
    case "install": return watchInstall(ctx, rest);
    case "uninstall": return watchUninstall(ctx, rest);
    case "status": return watchStatus(ctx, rest);
    case undefined: die("usage: ./clawforge watch <check|install|uninstall|status> [...]");
    default: die(`unknown action: ${action} (expected check, install, uninstall or status)`);
  }
}
