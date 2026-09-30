// runWatchCycle(): the transition matrix — no previous state is a baseline, not an
// alert; an unchanged level never posts; a changed level posts exactly once; a failed
// POST leaves the persisted state at its old value so the next cycle retries it — and
// that the webhook URL never appears anywhere this run could have printed it, on either
// path. Also a codes-only change at an unchanged non-ok level: a new or cleared reason
// code alerts the same as a level change would, a detail-only change never does (its own
// retry path and old-state compatibility are covered in webhook.check.ts, alongside that
// file's own delivery-failure coverage).

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatchCycle } from "#framework/commands/operate/watch/index.ts";
import type { WatchWebhookTarget } from "#framework/commands/operate/watch/webhook.ts";
import { watchStateFile, writeWatchState } from "#framework/commands/operate/watch/state.ts";
import type { WatchState } from "#framework/commands/operate/watch/state.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
async function deathOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}
// --- runWatchCycle(): the transition matrix, persistence, and the webhook's own contract ---

const root = await mkdtemp(join(tmpdir(), "clawforge-watch-check-check-"));
useDeployment(root);
const originalFetch = globalThis.fetch;

try {
  const calls: { url: string; body: unknown }[] = [];
  let nextResponse: () => Response | Promise<Response> = () => new Response(null, { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return nextResponse();
  }) as typeof fetch;

  const MARKER = "watch-check-secret-marker";
  const webhookUrl = new URL(`https://hooks.example/${MARKER}`);
  const webhookTarget: WatchWebhookTarget = { url: webhookUrl, format: "generic" };

  // First run: no previous state at all — a baseline, never a transition, whatever the level is.
  {
    calls.length = 0;
    const message = await deathOf(() => runWatchCycle(webhookTarget, "down", [{ code: "GATEWAY_DOWN", detail: "down detail" }], true));
    check("first run never posts (nothing to transition FROM)", calls.length, 0);
    check("first run still reports the current level via a non-zero exit", message.includes("the instance is down"), true);
    const written = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("first run still persists a baseline", written.level, "down");
  }

  // Unchanged level: no post, checkedAt moves, changedAt does not.
  {
    const baseline: WatchState = { level: "ok", reasons: [], checkedAt: "2020-01-01T00:00:00.000Z", changedAt: "2020-01-01T00:00:00.000Z" };
    await writeWatchState(baseline);
    calls.length = 0;
    await runWatchCycle(webhookTarget, "ok", [], false);
    check("an unchanged level never posts", calls.length, 0);
    const written = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("checkedAt moves", written.checkedAt !== baseline.checkedAt, true);
    check("changedAt does not, when the level did not change", written.changedAt, baseline.changedAt);
  }

  // A real transition, delivered successfully: posts exactly once, with the right payload,
  // and persists the new level with a fresh changedAt.
  {
    await writeWatchState({ level: "ok", reasons: [], checkedAt: "2020-01-01T00:00:00.000Z", changedAt: "2020-01-01T00:00:00.000Z" });
    calls.length = 0;
    nextResponse = () => new Response(null, { status: 200 });
    const reasons = [{ code: "GATEWAY_DOWN", detail: "down detail" }];
    await deathOf(() => runWatchCycle(webhookTarget, "down", reasons, false));
    check("a real transition posts exactly once", calls.length, 1);
    const postedBody = calls[0]?.body as { at?: string } | undefined;
    check(
      "the payload names the transition",
      postedBody,
      { deployment: deploymentName(), from: "ok", to: "down", reasons, at: postedBody?.at, codesAdded: ["GATEWAY_DOWN"], codesCleared: [] },
    );
    const written = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("the transition is persisted", written.level, "down");
    check("changedAt moves on a real transition", written.changedAt !== "2020-01-01T00:00:00.000Z", true);
  }

  // A failed delivery: level/reasons/checkedAt/changedAt survive untouched, so the next
  // cycle sees the same unreported transition and retries it — the exit is still non-zero,
  // and the diagnostics record that delivery is failing.
  {
    const before: WatchState = { level: "ok", reasons: [], checkedAt: "2021-06-01T00:00:00.000Z", changedAt: "2021-06-01T00:00:00.000Z" };
    await writeWatchState(before);
    calls.length = 0;
    nextResponse = () => new Response(null, { status: 500 });
    const written: string[] = [];
    const message = await withOutputSink((chunk) => written.push(chunk), () =>
      deathOf(() => runWatchCycle(webhookTarget, "down", [{ code: "GATEWAY_DOWN", detail: "down detail" }], false)));
    check("a failed delivery is still attempted exactly once", calls.length, 1);
    check("a failed delivery reports non-zero (throws)", message.includes("was not delivered"), true);
    check("and says the state was kept for a retry", message.includes(`kept at "ok"`) || message.includes(`retried next cycle`), true);
    const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check(
      "level/reasons/checkedAt/changedAt are left exactly as they were — not advanced to the new level",
      [after.level, after.reasons, after.checkedAt, after.changedAt],
      [before.level, before.reasons, before.checkedAt, before.changedAt],
    );
    check("lastRunAt now records this attempt", typeof after.lastRunAt, "string");
    check("lastError records the delivery failure", after.lastError?.includes("500"), true);
    check("alertPending names the undelivered transition", [after.alertPending?.from, after.alertPending?.to], ["ok", "down"]);
    check("alertPending.since is set to this first failure", after.alertPending?.since, after.lastRunAt);
    check("the webhook URL never appears in anything this run wrote", written.join("").includes(MARKER), false);
    check("nor in the thrown message itself", message.includes(MARKER), false);
    check("nor in the persisted diagnostics", JSON.stringify(after).includes(MARKER), false);
  }

  // Same failure, but the underlying fetch rejects outright (a network error, not just a
  // bad status) rather than resolving with one — the other way a POST can fail.
  {
    const before: WatchState = { level: "ok", reasons: [], checkedAt: "2021-06-01T00:00:00.000Z", changedAt: "2021-06-01T00:00:00.000Z" };
    await writeWatchState(before);
    calls.length = 0;
    globalThis.fetch = (async () => { throw new Error("network is down"); }) as typeof fetch;
    const message = await deathOf(() => runWatchCycle(webhookTarget, "down", [{ code: "GATEWAY_DOWN", detail: "down detail" }], false));
    check("a rejected fetch is reported the same way as a bad status", message.includes("was not delivered"), true);
    const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check(
      "level/reasons/checkedAt/changedAt are kept there too",
      [after.level, after.reasons, after.checkedAt, after.changedAt],
      [before.level, before.reasons, before.checkedAt, before.changedAt],
    );
    check("lastError records the rejected fetch", after.lastError?.includes("network is down"), true);
    const firstFailureSince = after.alertPending?.since;
    check("the URL never appears in a rejected-fetch message either", message.includes(MARKER), false);

    // Retrying: a second consecutive failure keeps the ORIGINAL alertPending.since (how long
    // this has been undelivered survives every retry) while lastRunAt/lastError move to the
    // latest attempt.
    calls.length = 0;
    nextResponse = () => new Response(null, { status: 503 });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return nextResponse();
    }) as typeof fetch;
    await deathOf(() => runWatchCycle(webhookTarget, "down", [{ code: "GATEWAY_DOWN", detail: "still down" }], false));
    const retried = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("a second consecutive failure keeps the original alertPending.since", retried.alertPending?.since, firstFailureSince);
    check("but lastRunAt moves to this attempt", retried.lastRunAt !== after.lastRunAt, true);
    check("and lastError reflects the latest failure", retried.lastError?.includes("503"), true);
  }

  // Clearing: once a retry actually delivers, lastError/alertPending are cleared — the
  // failure streak is over.
  {
    await writeWatchState({
      level: "ok",
      reasons: [],
      checkedAt: "2022-02-01T00:00:00.000Z",
      changedAt: "2022-02-01T00:00:00.000Z",
      lastRunAt: "2022-02-01T00:05:00.000Z",
      lastError: "webhook responded with 500",
      alertPending: { from: "ok", to: "down", since: "2022-02-01T00:05:00.000Z" },
    });
    calls.length = 0;
    nextResponse = () => new Response(null, { status: 200 });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return nextResponse();
    }) as typeof fetch;
    await deathOf(() => runWatchCycle(webhookTarget, "down", [{ code: "GATEWAY_DOWN", detail: "down detail" }], false));
    const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("a delivered retry clears lastError", after.lastError, undefined);
    check("and clears alertPending", after.alertPending, undefined);
    check("and advances the level", after.level, "down");
  }

  // Clearing without a delivery: the level naturally reverts to the last-reported one before
  // a pending alert was ever delivered — nothing left to report, so the streak clears too.
  {
    await writeWatchState({
      level: "ok",
      reasons: [],
      checkedAt: "2022-03-01T00:00:00.000Z",
      changedAt: "2022-03-01T00:00:00.000Z",
      lastRunAt: "2022-03-01T00:05:00.000Z",
      lastError: "webhook responded with 500",
      alertPending: { from: "ok", to: "down", since: "2022-03-01T00:05:00.000Z" },
    });
    calls.length = 0;
    await runWatchCycle(webhookTarget, "ok", [], false);
    check("no webhook call is made when the level did not change from previous", calls.length, 0);
    const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("lastError is cleared once there is nothing pending to report", after.lastError, undefined);
    check("alertPending is cleared too", after.alertPending, undefined);
  }

  // --- runWatchCycle(): a codes-only change at an unchanged non-ok level — the SET of
  // reason codes moving is a transition worth alerting on too, not just the level:
  // `degraded`(CHANNEL_UNHEALTHY) -> `degraded`(CHANNEL_UNHEALTHY, DISK_LOW) must alert.
  // Only the code set counts — a reason's own detail text (free MB, an error
  // string) changing alone never alerts. -----------------------------------------------

  {
    // A new code joins at the same level: alerts, and the payload names from/to as equal
    // levels with the new code called out.
    await writeWatchState({
      level: "degraded",
      reasons: [{ code: "CHANNEL_UNHEALTHY", detail: "telegram/default: configured but not running" }],
      checkedAt: "2025-01-01T00:00:00.000Z",
      changedAt: "2025-01-01T00:00:00.000Z",
    });
    calls.length = 0;
    nextResponse = () => new Response(null, { status: 200 });
    const reasons = [
      { code: "CHANNEL_UNHEALTHY", detail: "telegram/default: configured but not running" },
      { code: "DISK_LOW", detail: "/data has 50 MB free, below the OC_WATCH_DISK_MIN_MB threshold of 1024 MB" },
    ];
    await deathOf(() => runWatchCycle(webhookTarget, "degraded", reasons, false));
    check("a new reason code at an unchanged level still alerts", calls.length, 1);
    const body = calls[0]?.body as { from?: string; to?: string; codesAdded?: string[]; codesCleared?: string[] } | undefined;
    check("the payload reads degraded -> degraded", [body?.from, body?.to], ["degraded", "degraded"]);
    check("codesAdded names the new code", body?.codesAdded, ["DISK_LOW"]);
    check("codesCleared is empty", body?.codesCleared, []);
    const written = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("the new reason set is persisted", written.reasons, reasons);
    check("changedAt moves for a codes-only change too", written.changedAt !== "2025-01-01T00:00:00.000Z", true);
  }

  {
    // A code clears while another stays, level unchanged: alerts too, naming what cleared.
    await writeWatchState({
      level: "degraded",
      reasons: [
        { code: "CHANNEL_UNHEALTHY", detail: "a" },
        { code: "DISK_LOW", detail: "b" },
      ],
      checkedAt: "2025-02-01T00:00:00.000Z",
      changedAt: "2025-02-01T00:00:00.000Z",
    });
    calls.length = 0;
    nextResponse = () => new Response(null, { status: 200 });
    const reasons = [{ code: "CHANNEL_UNHEALTHY", detail: "a" }];
    await deathOf(() => runWatchCycle(webhookTarget, "degraded", reasons, false));
    check("a cleared reason code at an unchanged level still alerts", calls.length, 1);
    const body = calls[0]?.body as { codesAdded?: string[]; codesCleared?: string[] } | undefined;
    check("codesCleared names the resolved code", body?.codesCleared, ["DISK_LOW"]);
    check("codesAdded is empty", body?.codesAdded, []);
  }

  {
    // The same code, only its detail changed (free MB drifting, a different error string):
    // never alerts, and changedAt does not move — nothing about the STATE changed.
    await writeWatchState({
      level: "degraded",
      reasons: [{ code: "DISK_LOW", detail: "/data has 500 MB free, below the threshold of 1024 MB" }],
      checkedAt: "2025-03-01T00:00:00.000Z",
      changedAt: "2025-03-01T00:00:00.000Z",
    });
    calls.length = 0;
    const reasons = [{ code: "DISK_LOW", detail: "/data has 480 MB free, below the threshold of 1024 MB" }];
    await deathOf(() => runWatchCycle(webhookTarget, "degraded", reasons, false));
    check("the same code with only its detail changed never alerts", calls.length, 0);
    const written = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("the fresher detail is still persisted", written.reasons, reasons);
    check("changedAt does not move for a detail-only change", written.changedAt, "2025-03-01T00:00:00.000Z");
  }

  // The retry path for an undelivered codes-only change, and old-state (pre-fromCodes/
  // toCodes) compatibility, are covered in webhook.check.ts alongside its own delivery/retry
  // coverage — see "retry of an undelivered codes-only change" and "old-state compatibility"
  // there.
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
finish("watch check cycle");
