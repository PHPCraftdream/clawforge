// `./clawforge expose` — reach a loopback-bound gateway from outside this host, choosing the
// narrowest sensible scope: an SSH tunnel (ssh targets), `tailscale serve` (tailnet-only,
// never `funnel`), or a status report of what is actually published right now.
//
// Lives in commands/operate/ with watch/, incident/, recover-env/: things an operator runs
// against an already-deployed instance. Wired into managementCommands the same as every
// other command — help grouping there is by operator intent, independent of this directory.

import { die } from "#src/core/io/log.ts";
import type { Context } from "#src/core/context.ts";
import { dieUnknownAction } from "#src/core/arguments.ts";
import { exposeSsh } from "./ssh.ts";
import { exposeTailscale } from "./tailscale.ts";
import { exposeStatus } from "./status.ts";

/** The action words the dispatcher below and its bare-usage/unknown-action refusals share. */
const EXPOSE_ACTIONS = ["ssh", "tailscale", "status"] as const;

export { summarizeExposure, exposureOneLiner, EXPOSE_STATUS_ARGUMENTS } from "./status.ts";
export type { ExposureSummary } from "./status.ts";
export { EXPOSE_SSH_ARGUMENTS } from "./ssh.ts";
export { EXPOSE_TAILSCALE_ARGUMENTS } from "./tailscale.ts";

/** Only `tailscale --apply` mutates anything (runs `tailscale serve` on the target); ssh and
 *  status only read and print. One predicate for the MCP gate's readOnlyWhen/changedWhen/
 *  requiresConfirmationWhen, so the three cannot drift apart for a future action. */
export function exposeActionIsReadOnly(argv: string[]): boolean {
  return !(argv[0] === "tailscale" && argv.includes("--apply"));
}

export async function expose(ctx: Context, args: string[]): Promise<void> {
  const [action, ...rest] = args;
  switch (action) {
    case "ssh": return exposeSsh(ctx, rest);
    case "tailscale": return exposeTailscale(ctx, rest);
    case "status": return exposeStatus(ctx, rest);
    case undefined: die(`usage: ./clawforge expose <${EXPOSE_ACTIONS.join("|")}> [...] (see ./clawforge expose --help)`);
    default: dieUnknownAction(action, `unknown action: ${action} (expected ssh, tailscale or status)`, EXPOSE_ACTIONS);
  }
}
