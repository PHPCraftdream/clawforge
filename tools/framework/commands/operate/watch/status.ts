// `./clawforge watch status` — the persisted last state, when it changed, whether an alert
// webhook/heartbeat is configured, when `watch check` last ran, the most recent
// config/delivery error, an undelivered alert, and whether the schedule looks stale.
// Never either URL itself, in any form: only booleans and (for the heartbeat) the last
// successful ping time and last failure detail.

import { info, log, warn } from "../../../core/io/log.ts";
import { emit, isCaptured } from "../../../core/io/output.ts";
import type { Context } from "../../../core/context.ts";
import { readWatchState } from "./state.ts";
import { watchHeartbeatUrlRaw, watchWebhookRaw } from "./webhook.ts";
import { WATCH_CHECK_ARGUMENTS } from "./check.ts";
import { DEFAULT_WATCH_INTERVAL_MINUTES } from "./install.ts";
import { parseDeclaredArgs } from "../../../core/arguments.ts";

// How many missed intervals before "stale" fires — one alone could just be a slow cycle or
// scheduler jitter; three in a row means the scheduled check itself likely stopped running.
const STALE_GRACE_MULTIPLIER = 3;

/** Minutes since the last INVOKED run (lastRunAt — every cycle, config error or not), or
 *  checkedAt for a state file written before lastRunAt existed. Undefined when watch check
 *  has never run at all: "stale" does not apply to a check that was never scheduled. */
function referenceTime(lastRunAt: string | undefined, checkedAt: string | undefined): string | undefined {
  return lastRunAt ?? checkedAt;
}

function staleThresholdMinutes(intervalMinutes: number | undefined): number {
  return (intervalMinutes ?? DEFAULT_WATCH_INTERVAL_MINUTES) * STALE_GRACE_MULTIPLIER;
}

function isStale(reference: string | undefined, intervalMinutes: number | undefined): boolean {
  if (reference === undefined) return false;
  const last = Date.parse(reference);
  if (!Number.isFinite(last)) return false;
  return Date.now() - last > staleThresholdMinutes(intervalMinutes) * 60_000;
}

export async function watchStatus(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = parseDeclaredArgs(WATCH_CHECK_ARGUMENTS, args).json === true;

  const state = await readWatchState();
  const webhookConfigured = watchWebhookRaw(ctx) !== undefined;
  const heartbeatConfigured = watchHeartbeatUrlRaw(ctx) !== undefined;
  const lastRunAt = referenceTime(state?.lastRunAt, state?.checkedAt);
  const thresholdMinutes = staleThresholdMinutes(state?.intervalMinutes);
  const stale = isStale(lastRunAt, state?.intervalMinutes);

  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          level: state?.level ?? null,
          reasons: state?.reasons ?? [],
          checkedAt: state?.checkedAt ?? null,
          changedAt: state?.changedAt ?? null,
          lastRunAt: lastRunAt ?? null,
          lastError: state?.lastError ?? null,
          alertPending: state?.alertPending ?? null,
          intervalMinutes: state?.intervalMinutes ?? null,
          staleThresholdMinutes: thresholdMinutes,
          stale,
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

  if (lastRunAt === undefined) {
    log("watch: no check has run yet");
    info("run ./clawforge watch check, or schedule it with ./clawforge watch install");
  } else if (state?.level === undefined) {
    log("watch: no successful check cycle yet");
    info(`last run      ${lastRunAt}`);
  } else {
    log(`watch: ${state.level}`);
    if (state.checkedAt !== undefined) info(`last checked  ${state.checkedAt}`);
    if (state.changedAt !== undefined) info(`last changed  ${state.changedAt}`);
    if (state.lastRunAt !== undefined && state.lastRunAt !== state.checkedAt) info(`last run      ${state.lastRunAt}`);
    for (const reason of state.reasons ?? []) info(`${reason.code}  ${reason.detail}`);
  }
  if (stale) {
    warn(
      `last run was ${lastRunAt} — over ${thresholdMinutes} minutes ago; the scheduled check may not be ` +
        "running (see ./clawforge watch install, or ./clawforge watch test to check delivery)",
    );
  }
  if (state?.lastError !== undefined) warn(`last error: ${state.lastError}`);
  if (state?.alertPending !== undefined) {
    const pending = state.alertPending;
    warn(`alert pending since ${pending.since}: ${pending.from} → ${pending.to} has not been delivered yet`);
  }
  info(`webhook: ${webhookConfigured ? "configured" : "not configured"}`);
  info(`heartbeat: ${heartbeatConfigured ? "configured" : "not configured"}${state?.heartbeatAt ? `, last ping ${state.heartbeatAt}` : ""}`);
  if (state?.heartbeatError) warn(`heartbeat: last ping failed — ${state.heartbeatError}`);
}
