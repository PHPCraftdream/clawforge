// `./clawforge watch status` — the persisted last state, when it changed, and whether an
// alert webhook is configured. Never the URL itself, in any form: only the boolean.

import { die, info, log } from "../core/log.ts";
import { emit, isCaptured } from "../core/output.ts";
import type { Context } from "../core/context.ts";
import { readWatchState } from "./state.ts";
import { watchWebhookRaw } from "./webhook.ts";

export async function watchStatus(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = args.includes("--json");
  for (const arg of args) {
    if (arg !== "--json") die(`unknown argument: ${arg}`);
  }

  const state = await readWatchState();
  const webhookConfigured = watchWebhookRaw(ctx) !== undefined;

  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          level: state?.level ?? null,
          reasons: state?.reasons ?? [],
          checkedAt: state?.checkedAt ?? null,
          changedAt: state?.changedAt ?? null,
          webhookConfigured,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (state === undefined) {
    log("watch: no check has run yet");
    info("run ./clawforge watch check, or schedule it with ./clawforge watch install");
  } else {
    log(`watch: ${state.level}`);
    info(`last checked  ${state.checkedAt}`);
    info(`last changed  ${state.changedAt}`);
    for (const reason of state.reasons) info(`${reason.code}  ${reason.detail}`);
  }
  info(`webhook: ${webhookConfigured ? "configured" : "not configured"}`);
}
