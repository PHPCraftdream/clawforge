// `./clawforge watch status` — the persisted last state, when it changed, and whether an
// alert webhook/heartbeat is configured. Never the URL itself, in any form: only booleans
// and (for the heartbeat) the last successful ping time and last failure detail.

import { info, log, warn } from "../core/log.ts";
import { emit, isCaptured } from "../core/output.ts";
import type { Context } from "../core/context.ts";
import { readWatchState } from "./state.ts";
import { watchHeartbeatUrlRaw, watchWebhookRaw } from "./webhook.ts";
import { WATCH_CHECK_ARGUMENTS } from "./check.ts";
import { parseDeclaredArgs } from "../argv/parse-args.ts";

export async function watchStatus(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = parseDeclaredArgs(WATCH_CHECK_ARGUMENTS, args).json === true;

  const state = await readWatchState();
  const webhookConfigured = watchWebhookRaw(ctx) !== undefined;
  const heartbeatConfigured = watchHeartbeatUrlRaw(ctx) !== undefined;

  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          level: state?.level ?? null,
          reasons: state?.reasons ?? [],
          checkedAt: state?.checkedAt ?? null,
          changedAt: state?.changedAt ?? null,
          webhookConfigured,
          heartbeatConfigured,
          heartbeatAt: state?.heartbeatAt ?? null,
          heartbeatError: state?.heartbeatError ?? null,
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
  info(`heartbeat: ${heartbeatConfigured ? "configured" : "not configured"}${state?.heartbeatAt ? `, last ping ${state.heartbeatAt}` : ""}`);
  if (state?.heartbeatError) warn(`heartbeat: last ping failed — ${state.heartbeatError}`);
}
