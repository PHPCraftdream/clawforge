// `./clawforge expose` — reach a loopback-bound gateway from outside this host, choosing the
// narrowest sensible scope: an SSH tunnel (ssh targets), `tailscale serve` (tailnet-only,
// never `funnel`), or a status report of what is actually published right now.
//
// Lives outside commands/management/ on purpose: every command-family directory in this repo
// (commands/ itself, management/, orchestration/, lifecycle/, sets/, interface/) already sits
// exactly at tools/checks/foundation/layout.check.ts's 7-direct-entry cap, and moving an
// unrelated file just to free a slot would be its own, unrelated bit of churn. tools/framework/
// has no direct source file of its own, so the cap does not apply to it — the one place a new
// command family fits without relocating something that has nothing to do with it. Wired into
// managementCommands (interface/groups/openclawCommands.management.ts) exactly like every
// other command's `run`; this module's own subpath import resolves the same way every other
// one under tools/framework does, through the framework package's own imports map.

import { die } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { exposeSsh } from "./ssh.ts";
import { exposeTailscale } from "./tailscale.ts";
import { exposeStatus } from "./status.ts";

export { summarizeExposure, exposureOneLiner } from "./status.ts";
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
    case undefined: die("usage: ./clawforge expose <ssh|tailscale|status> [...]");
    default: die(`unknown action: ${action} (expected ssh, tailscale or status)`);
  }
}
