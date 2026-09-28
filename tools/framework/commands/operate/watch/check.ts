// `./clawforge watch check` — one probe cycle: reuse `inspect`'s own gatherer (the same probes,
// the same problem codes — a second gatherer would eventually answer the same question
// differently, gather.ts's own header makes the same point), keep only the findings that
// say whether the instance is doing its job, add watch's own channel/disk findings
// (health.ts), and alert exactly on a change.
//
// Also owns `watch test` (watchTest, below runWatchCycle): the same webhook/heartbeat
// targets, sent a one-off test message instead of a real transition, so delivery can be
// proven before an outage is the first time it is tried.

import { log, info, warn, die, maskSecrets } from "../../../core/io/log.ts";
import { emit, isCaptured } from "../../../core/io/output.ts";
import { gatherInspection } from "../../orchestration/inspect/gather.ts";
import type { Inspection, Problem, ProblemCode, ChannelsStatusResponse } from "../../../service/inspection.ts";
import type { Context } from "../../../core/context.ts";
import { readWatchState, writeWatchState } from "./state.ts";
import type { WatchLevel, WatchReason, WatchState } from "./state.ts";
import {
  WATCH_HEARTBEAT_URL_ENV,
  WATCH_WEBHOOK_ENV,
  codeDiff,
  describeTransition,
  parseHeartbeatUrl,
  parseWebhookUrl,
  postHeartbeat,
  postTestAlert,
  postWebhookAlert,
  resolveWebhookTarget,
  transitionPayload,
  watchHeartbeatUrlRaw,
  watchWebhookRaw,
} from "./webhook.ts";
import type { WatchWebhookTarget } from "./webhook.ts";
import { channelFindings, diskFindings, mergeFindings } from "./health.ts";
import type { CommandArgument } from "../../../core/app.ts";
import { parseDeclaredArgs } from "../../../core/arguments.ts";

/** Drives both watch check's own parser and its slice of watch's openclawCommands declaration. */
export const WATCH_CHECK_ARGUMENTS: CommandArgument[] = [
  { name: "json", description: "With check/status: emit JSON instead of text", kind: "flag" },
];

/** The subset of `inspect`'s problem codes that say something about LIVENESS — the gateway
 *  answering, bootstrapped, reaching its own configured endpoints. Deliberately narrower
 *  than the full inspection: CONFIG_DRIFT, RECIPE_MIRROR_DRIFT, a stale lock and the rest
 *  are real findings `doctor` already owns, but none of them mean the instance stopped
 *  doing its job, and paging an operator for one would train them to ignore the page.
 *  PROVIDER_MISSING is left out: env-keyed, subscription and CLI-backend providers read as
 *  missing, which here would mean a permanent false "degraded". */
const LIVENESS_CODES: ReadonlySet<ProblemCode> = new Set([
  "NOT_BOOTSTRAPPED",
  "TARGET_UNREACHABLE",
  "GATEWAY_DOWN",
  "GATEWAY_UNHEALTHY",
  "EGRESS_UNREACHABLE",
]);

/** Blocking-severity liveness findings mean the instance is not doing its job at all
 *  ("down"); warning-severity ones mean it is serving but impaired ("degraded") — the same
 *  severity `service/inspection.ts` already assigns each code, read rather than re-decided
 *  here, so this cannot disagree with what `doctor` calls blocking. */
export function watchLevel(problems: readonly Problem[]): { level: WatchLevel; reasons: WatchReason[] } {
  const relevant = problems.filter((entry) => LIVENESS_CODES.has(entry.code));
  const reasons = relevant.map((entry) => ({ code: entry.code, detail: entry.detail }));
  if (relevant.some((entry) => entry.severity === "blocking")) return { level: "down", reasons };
  if (relevant.length > 0) return { level: "degraded", reasons };
  return { level: "ok", reasons };
}

function summary(level: WatchLevel): string {
  return level === "ok" ? "ok — doing its job" : level === "degraded" ? "degraded — serving, but impaired" : "down — not doing its job";
}

/** Transport/webhook/heartbeat errors may echo a credential: masked, and capped before
 *  reaching the state file — shared by TARGET_UNREACHABLE's detail and a heartbeat failure's. */
const ERROR_DETAIL_MAX = 200;

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const masked = maskSecrets(message);
  return masked.length > ERROR_DETAIL_MAX ? `${masked.slice(0, ERROR_DETAIL_MAX)}…` : masked;
}

/** Whether this cycle differs from the last completed one: the level changed, or at the same
 *  non-ok level the set of reason codes did (details are ignored — see codeDiff). The first
 *  cycle is a baseline, never a transition. */
function isTransition(previousLevel: WatchLevel | undefined, level: WatchLevel, added: readonly string[], cleared: readonly string[]): boolean {
  if (previousLevel === undefined) return false;
  if (previousLevel !== level) return true;
  if (level === "ok") return false;
  return added.length > 0 || cleared.length > 0;
}

/** watchLevel()'s verdict, or "down" when the inspection could not run at all (Docker daemon
 *  down, SSH refused, wsl.exe silent) — the outage this command exists to report. Also
 *  carries the inspection's own observed.channels through, unread by watchLevel() itself
 *  but exactly what withAdditionalFindings() below needs for channelFindings() — one
 *  gatherInspection() call (with its `channels` option set) rather than a second one just
 *  to get the channel data.
 *
 *  Defaults to gatherInspection with that option set; a test that passes its own `gather`
 *  decides for itself whether to include channels — resolveWatchOutcome does not second-guess it. */
export async function resolveWatchOutcome(
  ctx: Context,
  gather: (ctx: Context) => Promise<Inspection> = (target) => gatherInspection(target, { channels: true }),
): Promise<{ level: WatchLevel; reasons: WatchReason[]; channels?: ChannelsStatusResponse }> {
  try {
    const inspection = await gather(ctx);
    return { ...watchLevel(inspection.problems), channels: inspection.observed.channels };
  } catch (error) {
    return { level: "down", reasons: [{ code: "TARGET_UNREACHABLE", detail: errorDetail(error) }] };
  }
}

/** Everything after "what is the level right now, and is the webhook/heartbeat usable":
 *  transition detection, the alert (only on change, never repeated for an unchanged state),
 *  the heartbeat ping (only while this cycle itself is ok), persistence (skipped when a
 *  required alert could not be delivered, so the next cycle retries it instead of accepting
 *  the change silently), reporting, and the exit-code contract. Split out of watchCheck() so
 *  it is testable against a synthetic level/reasons pair and stub webhook/heartbeat targets
 *  without also having to stand up gatherInspection's whole target-reaching machinery — the
 *  same reason gather.ts itself is split into gather/observe/helpers. Takes the
 *  already-parsed targets, not a Context: this needs nothing else from one. */
export async function runWatchCycle(
  webhookTarget: WatchWebhookTarget | undefined,
  level: WatchLevel,
  reasons: WatchReason[],
  jsonOnly: boolean,
  heartbeatUrl?: URL,
): Promise<void> {
  const previous = await readWatchState();
  const now = new Date().toISOString();
  // No previous state is not a transition: there is nothing to have changed FROM, and the
  // first cycle after `watch install` (or after a corrupt/missing state file) should
  // establish a baseline rather than page on it.
  const previousLevel = previous?.level;
  const previousReasons = previous?.reasons ?? [];
  const { added, cleared } = codeDiff(
    previousReasons.map((entry) => entry.code),
    reasons.map((entry) => entry.code),
  );
  const transitioned = isTransition(previousLevel, level, added, cleared);

  if (transitioned && previousLevel !== undefined && webhookTarget !== undefined) {
    try {
      await postWebhookAlert(webhookTarget, transitionPayload(previousLevel, level, previousReasons, reasons, now));
    } catch (error) {
      // Level and reasons stay as they were so the next cycle retries the same change; only
      // the diagnostics move. since/fromCodes keep the start of the streak, toCodes this attempt.
      const detail = errorDetail(error);
      await writeWatchState({
        ...previous!,
        lastRunAt: now,
        lastError: detail,
        alertPending: {
          from: previousLevel,
          to: level,
          since: previous!.alertPending?.since ?? now,
          fromCodes: previous!.alertPending?.fromCodes ?? previousReasons.map((entry) => entry.code),
          toCodes: reasons.map((entry) => entry.code),
        },
      });
      die(
        `watch: ${summary(level)}, but the alert for ${describeTransition(previousLevel, level, added, cleared)} was not delivered: ` +
          `${detail}\nstate was left at "${previousLevel}" so this is retried next cycle`,
      );
    }
  }

  // Dead-man's switch: pinged only while THIS cycle itself reads ok — a ping mid-outage
  // would tell the external service the instance is fine when it is not, defeating the
  // whole point of a heartbeat that is supposed to stop the moment something really is
  // down. A failed ping is a warning only: the heartbeat target being unreachable says
  // nothing about the instance watch exists to report on, so it never moves level or the
  // exit code.
  let heartbeatOutcome: { ok: true } | { ok: false; detail: string } | undefined;
  if (level === "ok" && heartbeatUrl !== undefined) {
    try {
      await postHeartbeat(heartbeatUrl);
      heartbeatOutcome = { ok: true };
    } catch (error) {
      heartbeatOutcome = { ok: false, detail: errorDetail(error) };
    }
  }

  const state: WatchState = {
    level,
    reasons,
    checkedAt: now,
    changedAt: transitioned || previous?.changedAt === undefined ? now : previous.changedAt,
    // Reaching here means the cycle completed — delivered, or nothing needed delivering —
    // so any earlier failure streak is over.
    lastRunAt: now,
    lastError: undefined,
    alertPending: undefined,
    intervalMinutes: previous?.intervalMinutes,
    heartbeatAt: heartbeatOutcome?.ok ? now : previous?.heartbeatAt,
    heartbeatError: heartbeatOutcome === undefined ? previous?.heartbeatError : heartbeatOutcome.ok ? undefined : heartbeatOutcome.detail,
  };
  await writeWatchState(state);

  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          level,
          reasons,
          transitioned,
          alerted: transitioned && webhookTarget !== undefined,
          checkedAt: now,
          changedAt: state.changedAt,
          codesAdded: added,
          codesCleared: cleared,
          ...(heartbeatOutcome !== undefined && !heartbeatOutcome.ok ? { heartbeatWarning: heartbeatOutcome.detail } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    log(`watch: ${summary(level)}`);
    if (reasons.length === 0) info("no liveness problems found");
    for (const reason of reasons) warn(`${reason.code}  ${reason.detail}`);
    if (heartbeatOutcome !== undefined && !heartbeatOutcome.ok) warn(`heartbeat ping failed: ${heartbeatOutcome.detail}`);
    info(
      previousLevel === undefined
        ? "first cycle — baseline recorded, no alert sent"
        : transitioned ? `state changed: ${describeTransition(previousLevel, level, added, cleared)}` : "state unchanged since the last cycle",
    );
  }

  // Every cycle's exit code says what an external scheduler needs to know, independent of
  // whether an alert fired this time: 0 while the instance is doing its job, non-zero
  // otherwise — the same binary vocabulary `doctor` already uses for "blocking found".
  if (level !== "ok") {
    die(`the instance is ${level}: ${reasons.map((entry) => entry.code).join(", ") || "no reason recorded"}`);
  }
}

/** Adds channel/disk findings unless the target is unreachable or not bootstrapped; channels
 *  are skipped while the gateway is down, disk is still read (a full disk often is why).
 *  channelFindings() reads base.channels — resolveWatchOutcome's own gatherInspection call,
 *  not a second CLI round-trip here. */
async function withAdditionalFindings(
  ctx: Context,
  base: { level: WatchLevel; reasons: WatchReason[]; channels?: ChannelsStatusResponse },
): Promise<{ level: WatchLevel; reasons: WatchReason[] }> {
  const hasCode = (code: string): boolean => base.reasons.some((entry) => entry.code === code);
  if (hasCode("TARGET_UNREACHABLE") || hasCode("NOT_BOOTSTRAPPED")) return base;

  const findings = [
    ...(hasCode("GATEWAY_DOWN") ? [] : channelFindings(base.channels)),
    ...(await diskFindings(ctx)),
  ];
  return mergeFindings(base, findings);
}

/** A configuration error stops watchCheck before any cycle; record it so `watch status`
 *  shows it. Only lastRunAt/lastError move. */
async function recordConfigError(error: unknown): Promise<void> {
  const previous = await readWatchState();
  await writeWatchState({ ...previous, lastRunAt: new Date().toISOString(), lastError: errorDetail(error) });
}

export async function watchCheck(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = parseDeclaredArgs(WATCH_CHECK_ARGUMENTS, args).json === true;

  // Validated before gatherInspection ever reaches the target: a misconfigured webhook or
  // heartbeat URL is a configuration error worth stopping on every cycle, not just the one
  // that would have tried to use it, and there is no reason to pay for a probe cycle first.
  let webhookTarget: WatchWebhookTarget | undefined;
  let heartbeatUrl: URL | undefined;
  try {
    const webhookRaw = watchWebhookRaw(ctx);
    const webhookUrl = webhookRaw === undefined ? undefined : parseWebhookUrl(webhookRaw);
    webhookTarget = webhookUrl === undefined ? undefined : resolveWebhookTarget(ctx, webhookUrl);

    const heartbeatRaw = watchHeartbeatUrlRaw(ctx);
    heartbeatUrl = heartbeatRaw === undefined ? undefined : parseHeartbeatUrl(heartbeatRaw);
  } catch (error) {
    await recordConfigError(error);
    throw error;
  }

  const base = await resolveWatchOutcome(ctx);
  const { level, reasons } = await withAdditionalFindings(ctx, base);

  await runWatchCycle(webhookTarget, level, reasons, jsonOnly, heartbeatUrl);
}

// --- `watch test` -----------------------------------------------------------------------

export interface WatchTestResult {
  readonly target: "webhook" | "heartbeat";
  readonly ok: boolean;
  /** Absent on success. Masked/capped the same way runWatchCycle's own failures are. */
  readonly detail?: string;
}

/** A test ping is the same signal as a cycle's, so it updates only the heartbeat fields. */
async function recordHeartbeatOutcome(now: string, detail: string | undefined): Promise<void> {
  const previous = await readWatchState();
  await writeWatchState({ ...previous, heartbeatAt: detail === undefined ? now : previous?.heartbeatAt, heartbeatError: detail });
}

/** Proves delivery on demand: a test message (marked as a test, never a transition payload)
 *  to the webhook and a heartbeat ping, for whichever is configured. Any configured target
 *  that fails exits non-zero; none configured is reported, not failed. */
export async function watchTest(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = parseDeclaredArgs(WATCH_CHECK_ARGUMENTS, args).json === true;
  const now = new Date().toISOString();
  const results: WatchTestResult[] = [];

  const webhookRaw = watchWebhookRaw(ctx);
  if (webhookRaw !== undefined) {
    try {
      const webhookTarget = resolveWebhookTarget(ctx, parseWebhookUrl(webhookRaw));
      await postTestAlert(webhookTarget, now);
      results.push({ target: "webhook", ok: true });
    } catch (error) {
      results.push({ target: "webhook", ok: false, detail: errorDetail(error) });
    }
  }

  const heartbeatRaw = watchHeartbeatUrlRaw(ctx);
  if (heartbeatRaw !== undefined) {
    try {
      await postHeartbeat(parseHeartbeatUrl(heartbeatRaw));
      results.push({ target: "heartbeat", ok: true });
      await recordHeartbeatOutcome(now, undefined);
    } catch (error) {
      const detail = errorDetail(error);
      results.push({ target: "heartbeat", ok: false, detail });
      await recordHeartbeatOutcome(now, detail);
    }
  }

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify({ configured: results.length > 0, results }, null, 2)}\n`);
  } else if (results.length === 0) {
    info(`neither ${WATCH_WEBHOOK_ENV} nor ${WATCH_HEARTBEAT_URL_ENV} is configured — nothing to test`);
  } else {
    log("watch test");
    for (const result of results) {
      if (result.ok) info(`${result.target}: delivered`);
      else warn(`${result.target}: failed — ${result.detail}`);
    }
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    die(`watch test: ${failed.map((result) => result.target).join(", ")} failed to deliver`);
  }
}
