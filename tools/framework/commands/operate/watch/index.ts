// `./clawforge watch` — health monitoring with a webhook alert on state change, so an operator
// learns the instance stopped doing its job without polling by hand.
//
// Lives in commands/operate/ with expose/, incident/ and recover-env/ — see expose/index.ts's
// own header for the grouping this and its siblings share.

import { die } from "../../../core/io/log.ts";
import type { Context } from "../../../core/context.ts";
import type { CommandArgument } from "../../../core/app.ts";
import { dieUnknownAction, scopeByAction } from "../../../core/arguments.ts";
import { watchCheck, watchTest, WATCH_CHECK_ARGUMENTS } from "./check.ts";
import { watchInstall, watchUninstall, WATCH_INSTALL_ARGUMENTS, WATCH_UNINSTALL_ARGUMENTS } from "./install.ts";
import { watchStatus } from "./status.ts";

/** The action words the dispatcher below and its bare-usage/unknown-action refusals share. */
const WATCH_ACTIONS = ["check", "install", "uninstall", "status", "test"] as const;

/** What each action's own parser accepts (status and test read --json like check);
 *  WATCH_FLAG_ARGUMENTS is derived from it. */
export const WATCH_ACTION_ARGUMENTS: Readonly<Record<string, readonly CommandArgument[]>> = {
  check: WATCH_CHECK_ARGUMENTS,
  install: WATCH_INSTALL_ARGUMENTS,
  uninstall: WATCH_UNINSTALL_ARGUMENTS,
  status: WATCH_CHECK_ARGUMENTS,
  test: WATCH_CHECK_ARGUMENTS,
};

export const WATCH_FLAG_ARGUMENTS: CommandArgument[] = scopeByAction(WATCH_ACTION_ARGUMENTS);

export { watchLevel, runWatchCycle, resolveWatchOutcome } from "./check.ts";
export type { WatchLevel, WatchReason, WatchState } from "./state.ts";

/** Only install/uninstall --apply mutate the target (a crontab entry); check, status and
 *  test only read the instance and this deployment's own state file — test reaches an
 *  external webhook/heartbeat URL, never the target itself. One predicate for the MCP
 *  gate's readOnlyWhen/changedWhen/requiresConfirmationWhen, same reasoning as
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
    case "test": return watchTest(ctx, rest);
    case undefined: die(`usage: ./clawforge watch <${WATCH_ACTIONS.join("|")}> [...] (see ./clawforge watch --help)`);
    default: dieUnknownAction(action, `unknown action: ${action} (expected check, install, uninstall, status or test)`, WATCH_ACTIONS);
  }
}
