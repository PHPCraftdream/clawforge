// `./clawforge watch check` — one probe cycle: reuse `inspect`'s own gatherer (the same probes,
// the same problem codes — a second gatherer would eventually answer the same question
// differently, gather.ts's own header makes the same point), keep only the findings that
// say whether the instance is doing its job, and alert exactly on a change.

import { log, info, warn, die, maskSecrets } from "../core/log.ts";
import { emit, isCaptured } from "../core/output.ts";
import { gatherInspection } from "../commands/orchestration/inspect/gather.ts";
import type { Inspection, Problem, ProblemCode } from "../service/inspection.ts";
import type { Context } from "../core/context.ts";
import { readWatchState, writeWatchState } from "./state.ts";
import type { WatchLevel, WatchReason, WatchState } from "./state.ts";
import { parseWebhookUrl, postWebhookAlert, transitionPayload, watchWebhookRaw } from "./webhook.ts";

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

/** Transport errors may echo a credential: masked, and capped before reaching the state file. */
const TARGET_UNREACHABLE_DETAIL_MAX = 200;

function targetUnreachableDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const masked = maskSecrets(message);
  return masked.length > TARGET_UNREACHABLE_DETAIL_MAX ? `${masked.slice(0, TARGET_UNREACHABLE_DETAIL_MAX)}…` : masked;
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
    return { level: "down", reasons: [{ code: "TARGET_UNREACHABLE", detail: targetUnreachableDetail(error) }] };
  }
}

/** Everything after "what is the level right now, and is the webhook usable": transition
 *  detection, the alert (only on change, never repeated for an unchanged state),
 *  persistence (skipped when a required alert could not be delivered, so the next cycle
 *  retries it instead of accepting the change silently), reporting, and the exit-code
 *  contract. Split out of watchCheck() so it is testable against a synthetic level/reasons
 *  pair and a stub webhook target without also having to stand up gatherInspection's whole
 *  target-reaching machinery — the same reason gather.ts itself is split into
 *  gather/observe/helpers. Takes the already-parsed URL, not a Context: this needs nothing
 *  else from one. */
export async function runWatchCycle(webhookUrl: URL | undefined, level: WatchLevel, reasons: WatchReason[], jsonOnly: boolean): Promise<void> {
  const previous = await readWatchState();
  const now = new Date().toISOString();
  // No previous state is not a transition: there is nothing to have changed FROM, and the
  // first cycle after `watch install` (or after a corrupt/missing state file) should
  // establish a baseline rather than page on it.
  const previousLevel = previous?.level;
  const transitioned = previousLevel !== undefined && previousLevel !== level;

  if (transitioned && previousLevel !== undefined && webhookUrl !== undefined) {
    try {
      await postWebhookAlert(webhookUrl, transitionPayload(previousLevel, level, reasons, now));
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

  const state: WatchState = {
    level,
    reasons,
    checkedAt: now,
    changedAt: transitioned || previous === undefined ? now : previous.changedAt,
  };
  await writeWatchState(state);

  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        { level, reasons, transitioned, alerted: transitioned && webhookUrl !== undefined, checkedAt: now, changedAt: state.changedAt },
        null,
        2,
      )}\n`,
    );
  } else {
    log(`watch: ${summary(level)}`);
    if (reasons.length === 0) info("no liveness problems found");
    for (const reason of reasons) warn(`${reason.code}  ${reason.detail}`);
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

export async function watchCheck(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = args.includes("--json");
  for (const arg of args) {
    if (arg !== "--json") die(`unknown argument: ${arg}`);
  }

  // Validated before gatherInspection ever reaches the target: a misconfigured webhook is
  // a configuration error worth stopping on every cycle, not just the one that would have
  // tried to use it, and there is no reason to pay for a probe cycle first.
  const webhookRaw = watchWebhookRaw(ctx);
  const webhookUrl = webhookRaw === undefined ? undefined : parseWebhookUrl(webhookRaw);

  const { level, reasons } = await resolveWatchOutcome(ctx);

  await runWatchCycle(webhookUrl, level, reasons, jsonOnly);
}
