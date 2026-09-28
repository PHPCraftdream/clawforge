// `./clawforge watch check` — one probe cycle: reuse `inspect`'s own gatherer (the same probes,
// the same problem codes — a second gatherer would eventually answer the same question
// differently, gather.ts's own header makes the same point), keep only the findings that
// say whether the instance is doing its job, add watch's own channel/disk findings
// (health.ts), and alert exactly on a change.

import { log, info, warn, die, maskSecrets } from "../../../core/io/log.ts";
import { emit, isCaptured } from "../../../core/io/output.ts";
import { gatherInspection } from "../../orchestration/inspect/gather.ts";
import type { Inspection, Problem, ProblemCode } from "../../../service/inspection.ts";
import type { Context } from "../../../core/context.ts";
import { readWatchState, writeWatchState } from "./state.ts";
import type { WatchLevel, WatchReason, WatchState } from "./state.ts";
import {
  parseHeartbeatUrl,
  parseWebhookUrl,
  postHeartbeat,
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

/** watchLevel()'s verdict, or "down" when the inspection could not run at all (Docker daemon
 *  down, SSH refused, wsl.exe silent) — the outage this command exists to report. */
export async function resolveWatchOutcome(
  ctx: Context,
  gather: (ctx: Context) => Promise<Inspection> = gatherInspection,
): Promise<{ level: WatchLevel; reasons: WatchReason[] }> {
  try {
    const inspection = await gather(ctx);
    return watchLevel(inspection.problems);
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
  const transitioned = previousLevel !== undefined && previousLevel !== level;

  if (transitioned && previousLevel !== undefined && webhookTarget !== undefined) {
    try {
      await postWebhookAlert(webhookTarget, transitionPayload(previousLevel, level, reasons, now));
    } catch (error) {
      // The state file is NOT written below this point: the next cycle still sees the old
      // level as "previous", so it reads as the same unreported transition and retries the
      // alert instead of silently accepting it as normal.
      die(
        `watch: ${summary(level)}, but the alert for ${previousLevel} → ${level} was not delivered: ` +
          `${(error as Error).message}\nstate was left at "${previousLevel}" so this is retried next cycle`,
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
    changedAt: transitioned || previous === undefined ? now : previous.changedAt,
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
      previous === undefined
        ? "first cycle — baseline recorded, no alert sent"
        : transitioned ? `state changed from ${previousLevel} to ${level}` : "state unchanged since the last cycle",
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
 *  are skipped while the gateway is down, disk is still read (a full disk often is why). */
async function withAdditionalFindings(
  ctx: Context,
  base: { level: WatchLevel; reasons: WatchReason[] },
): Promise<{ level: WatchLevel; reasons: WatchReason[] }> {
  const hasCode = (code: string): boolean => base.reasons.some((entry) => entry.code === code);
  if (hasCode("TARGET_UNREACHABLE") || hasCode("NOT_BOOTSTRAPPED")) return base;

  const findings = [
    ...(hasCode("GATEWAY_DOWN") ? [] : await channelFindings(ctx)),
    ...(await diskFindings(ctx)),
  ];
  return mergeFindings(base, findings);
}

export async function watchCheck(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = parseDeclaredArgs(WATCH_CHECK_ARGUMENTS, args).json === true;

  // Validated before gatherInspection ever reaches the target: a misconfigured webhook or
  // heartbeat URL is a configuration error worth stopping on every cycle, not just the one
  // that would have tried to use it, and there is no reason to pay for a probe cycle first.
  const webhookRaw = watchWebhookRaw(ctx);
  const webhookUrl = webhookRaw === undefined ? undefined : parseWebhookUrl(webhookRaw);
  const webhookTarget = webhookUrl === undefined ? undefined : resolveWebhookTarget(ctx, webhookUrl);

  const heartbeatRaw = watchHeartbeatUrlRaw(ctx);
  const heartbeatUrl = heartbeatRaw === undefined ? undefined : parseHeartbeatUrl(heartbeatRaw);

  const base = await resolveWatchOutcome(ctx);
  const { level, reasons } = await withAdditionalFindings(ctx, base);

  await runWatchCycle(webhookTarget, level, reasons, jsonOnly, heartbeatUrl);
}
