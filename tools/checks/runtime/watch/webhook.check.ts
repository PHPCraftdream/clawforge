// `./clawforge watch check`'s alert webhook, one layer down from check.check.ts's own
// coverage of runWatchCycle's transition matrix:
//
// - detectWebhookFormat (through resolveWebhookTarget): autodetected from the URL host
//   alone, matching each vendor's own incoming-webhook host (docs/guide/monitoring-and-access.md links the docs).
// - resolveWebhookTarget: OC_WATCH_WEBHOOK_FORMAT overrides autodetection when set, an
//   unknown value is a configuration error, and format=telegram with no
//   OC_WATCH_TELEGRAM_CHAT_ID is refused the same way, before any probe cycle runs.
// - postWebhookAlert's per-format body: generic keeps the original structured JSON; slack/
//   discord/telegram get a one-two line human message, capped to that format's own
//   documented limit (2,000 for Discord's `content`, 4,096 for Telegram's `text`).
// - postTestAlert's per-format body: `watch test`'s own message, never transitionPayload's
//   shape, same delivery proof (deliverWebhook) as a real alert.
// - Telegram's own success contract: a 2xx reply carrying `ok:false` is treated as
//   undelivered, end to end through runWatchCycle — the persisted state is kept exactly
//   like a failed POST to any other format.
// - transitionPayload's codesAdded/codesCleared, and the chat formats' "new:"/"cleared:"
//   line: a codes-only change (same level, different reason-code set) reads as understandable
//   as a level change does, a detail-only change adds/clears nothing.
// - runWatchCycle()'s codes-only path, end to end: an undelivered codes-only change
//   retries the same way a level transition's own failure does (since/fromCodes survive,
//   toCodes refreshes), and a state file predating alertPending's fromCodes/toCodes still
//   parses and still alerts correctly from it.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatchCycle } from "#framework/commands/operate/watch/index.ts";
import {
  WATCH_TELEGRAM_CHAT_ID_ENV,
  WATCH_WEBHOOK_FORMAT_ENV,
  codesChangeLine,
  describeTransition,
  postTestAlert,
  postWebhookAlert,
  resolveWebhookTarget,
  transitionPayload,
  webhookRespondedWith,
} from "#framework/commands/operate/watch/webhook.ts";
import { ALERT_NOT_DELIVERED } from "#framework/commands/operate/watch/check.ts";
import type { WatchWebhookTarget } from "#framework/commands/operate/watch/webhook.ts";
import { readWatchState, watchStateFile, writeWatchState } from "#framework/commands/operate/watch/state.ts";
import type { WatchState } from "#framework/commands/operate/watch/state.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function deathOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function ctxWith(env: Record<string, string>): Context {
  return { settings: { env } } as unknown as Context;
}

// --- resolveWebhookTarget(): autodetection from the URL host alone --------------------

{
  check("hooks.slack.com autodetects as slack", resolveWebhookTarget(ctxWith({}), new URL("https://hooks.slack.com/services/x")).format, "slack");
  check(
    "discord.com/api/webhooks/... autodetects as discord",
    resolveWebhookTarget(ctxWith({}), new URL("https://discord.com/api/webhooks/1/abc")).format,
    "discord",
  );
  check(
    "the legacy discordapp.com host autodetects as discord too",
    resolveWebhookTarget(ctxWith({}), new URL("https://discordapp.com/api/webhooks/1/abc")).format,
    "discord",
  );
  check(
    "a discord.com URL outside /api/webhooks/ does NOT autodetect as discord",
    resolveWebhookTarget(ctxWith({}), new URL("https://discord.com/somewhere/else")).format,
    "generic",
  );
  check("api.telegram.org autodetects as telegram", resolveWebhookTarget(ctxWith({ [WATCH_TELEGRAM_CHAT_ID_ENV]: "123" }), new URL("https://api.telegram.org/botX/sendMessage")).format, "telegram");
  check("an unrelated host stays generic", resolveWebhookTarget(ctxWith({}), new URL("https://hooks.example/x")).format, "generic");
}

// --- resolveWebhookTarget(): OC_WATCH_WEBHOOK_FORMAT overrides autodetection ------------

{
  check(
    "the format env var overrides what the host would autodetect to",
    resolveWebhookTarget(ctxWith({ [WATCH_WEBHOOK_FORMAT_ENV]: "slack" }), new URL("https://hooks.example/x")).format,
    "slack",
  );
  check(
    "explicit generic overrides a host that would otherwise autodetect as slack",
    resolveWebhookTarget(ctxWith({ [WATCH_WEBHOOK_FORMAT_ENV]: "generic" }), new URL("https://hooks.slack.com/services/x")).format,
    "generic",
  );
  check(
    "an unknown format value is a configuration error, naming the four valid ones",
    (() => {
      try {
        resolveWebhookTarget(ctxWith({ [WATCH_WEBHOOK_FORMAT_ENV]: "bogus" }), new URL("https://hooks.example/x"));
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })(),
    "OC_WATCH_WEBHOOK_FORMAT must be generic, slack, discord or telegram",
  );
}

// --- resolveWebhookTarget(): telegram needs a chat id, validated up front --------------

{
  check(
    "format=telegram with no chat id is refused as a configuration error",
    (() => {
      try {
        resolveWebhookTarget(ctxWith({ [WATCH_WEBHOOK_FORMAT_ENV]: "telegram" }), new URL("https://hooks.example/x"));
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })(),
    "OC_WATCH_TELEGRAM_CHAT_ID is required when the webhook format is telegram",
  );
  check(
    "autodetected telegram (api.telegram.org) with no chat id is refused the same way",
    (() => {
      try {
        resolveWebhookTarget(ctxWith({}), new URL("https://api.telegram.org/botX/sendMessage"));
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })(),
    "OC_WATCH_TELEGRAM_CHAT_ID is required when the webhook format is telegram",
  );
  check(
    "a chat id present resolves with it carried on the target",
    resolveWebhookTarget(ctxWith({ [WATCH_TELEGRAM_CHAT_ID_ENV]: "-100123" }), new URL("https://api.telegram.org/botX/sendMessage")).telegramChatId,
    "-100123",
  );
}

// --- postWebhookAlert(): each format's own payload shape --------------------------------

const root = await mkdtemp(join(tmpdir(), "clawforge-watch-webhook-check-"));
useDeployment(root);
const originalFetch = globalThis.fetch;

try {
  let calls: { url: string; body: unknown }[] = [];
  // A telegram-shaped ok:true body by default: harmless for the other three formats (which
  // never inspect the response body), and lets every "delivered cleanly" test below reuse
  // the same stub without each one having to know telegram's own success contract.
  let nextResponse: () => Response | Promise<Response> = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const stubFetch = (): void => {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return nextResponse();
    }) as typeof fetch;
  };

  const payload = transitionPayload("ok", "down", [], [{ code: "GATEWAY_DOWN", detail: "gateway did not answer" }], "2026-01-01T00:00:00.000Z");

  {
    stubFetch();
    const target: WatchWebhookTarget = { url: new URL("https://hooks.example/x"), format: "generic" };
    await postWebhookAlert(target, payload);
    check("generic keeps the original structured envelope", calls[0]?.body, payload);
  }

  {
    stubFetch();
    const target: WatchWebhookTarget = { url: new URL("https://hooks.slack.com/services/x"), format: "slack" };
    await postWebhookAlert(target, payload);
    const body = calls[0]?.body as { text?: string };
    check("slack posts a bare {text} object", Object.keys(body ?? {}), ["text"]);
    check("the text names the deployment and the transition", typeof body?.text === "string" && body.text.includes(describeTransition("ok", "down", [], [])), true);
    check("the text names the reason code", typeof body?.text === "string" && body.text.includes("GATEWAY_DOWN"), true);
    check("the text names when", typeof body?.text === "string" && body.text.includes(payload.at), true);
  }

  {
    stubFetch();
    const target: WatchWebhookTarget = { url: new URL("https://discord.com/api/webhooks/1/x"), format: "discord" };
    await postWebhookAlert(target, payload);
    const body = calls[0]?.body as { content?: string };
    check("discord posts a bare {content} object", Object.keys(body ?? {}), ["content"]);
    check("the content names the transition", typeof body?.content === "string" && body.content.includes(describeTransition("ok", "down", [], [])), true);
  }

  {
    stubFetch();
    const target: WatchWebhookTarget = { url: new URL("https://api.telegram.org/botX/sendMessage"), format: "telegram", telegramChatId: "-100123" };
    await postWebhookAlert(target, payload);
    const body = calls[0]?.body as { chat_id?: string; text?: string };
    check("telegram posts {chat_id, text}", Object.keys(body ?? {}).sort(), ["chat_id", "text"]);
    check("chat_id is exactly OC_WATCH_TELEGRAM_CHAT_ID's value", body?.chat_id, "-100123");
    check("the text names the transition", typeof body?.text === "string" && body.text.includes(describeTransition("ok", "down", [], [])), true);
  }

  // --- transitionPayload(): codesAdded/codesCleared, and the chat formats make a
  // codes-only change (same level, different reason-code SET) understandable --------

  {
    const previousReasons = [{ code: "CHANNEL_UNHEALTHY", detail: "telegram/default: configured but not running" }];
    const reasons = [
      { code: "CHANNEL_UNHEALTHY", detail: "telegram/default: configured but not running" },
      { code: "DISK_LOW", detail: "/data has 50 MB free, below the threshold of 1024 MB" },
    ];
    const addedPayload = transitionPayload("degraded", "degraded", previousReasons, reasons, "2026-02-01T00:00:00.000Z");
    check("codesAdded names the newly appeared code", addedPayload.codesAdded, ["DISK_LOW"]);
    check("codesCleared is empty when nothing cleared", addedPayload.codesCleared, []);
    check(
      "generic keeps codesAdded/codesCleared alongside the original five fields, none renamed or dropped",
      Object.keys(addedPayload).sort(),
      ["at", "codesAdded", "codesCleared", "deployment", "from", "reasons", "to"],
    );

    const clearedPayload = transitionPayload("degraded", "degraded", reasons, previousReasons, "2026-02-01T00:00:00.000Z");
    check("codesCleared names the resolved code the other way around", clearedPayload.codesCleared, ["DISK_LOW"]);
    check("codesAdded is empty when nothing new joined", clearedPayload.codesAdded, []);

    const sameDetailPayload = transitionPayload(
      "degraded",
      "degraded",
      [{ code: "DISK_LOW", detail: "500 MB free" }],
      [{ code: "DISK_LOW", detail: "480 MB free" }],
      "2026-02-01T00:00:00.000Z",
    );
    check("a detail-only change adds and clears nothing", [sameDetailPayload.codesAdded, sameDetailPayload.codesCleared], [[], []]);

    const slackTarget: WatchWebhookTarget = { url: new URL("https://hooks.slack.com/services/x"), format: "slack" };
    stubFetch();
    await postWebhookAlert(slackTarget, addedPayload);
    const slackAdded = calls[0]?.body as { text?: string };
    check(
      "slack's text is readable for a same-level codes-only change: from → to, plus the new code",
      typeof slackAdded?.text === "string" && slackAdded.text.includes(describeTransition("degraded", "degraded", [], [])) && slackAdded.text.includes(codesChangeLine(["DISK_LOW"], []) ?? ""),
      true,
    );

    const discordTarget: WatchWebhookTarget = { url: new URL("https://discord.com/api/webhooks/1/x"), format: "discord" };
    stubFetch();
    await postWebhookAlert(discordTarget, clearedPayload);
    const discordCleared = calls[0]?.body as { content?: string };
    check(
      "discord's text names a cleared code too",
      typeof discordCleared?.content === "string" && discordCleared.content.includes(codesChangeLine([], ["DISK_LOW"]) ?? ""),
      true,
    );

    stubFetch();
    await postWebhookAlert(slackTarget, sameDetailPayload);
    const slackUnchanged = calls[0]?.body as { text?: string };
    check(
      "no codes changed -> no new:/cleared: line, just the level and current reasons",
      typeof slackUnchanged?.text === "string" && !slackUnchanged.text.includes("new:") && !slackUnchanged.text.includes("cleared:"),
      true,
    );
  }

  // --- discord/telegram cap the text to their own documented limit --------------------

  {
    const longReasons = Array.from({ length: 80 }, (_, index) => ({
      code: `REASON_${index}`,
      detail: "x".repeat(100),
    }));
    const longPayload = transitionPayload("ok", "down", [], longReasons, "2026-01-01T00:00:00.000Z");

    stubFetch();
    await postWebhookAlert({ url: new URL("https://discord.com/api/webhooks/1/x"), format: "discord" }, longPayload);
    const discordBody = calls[0]?.body as { content: string };
    check("discord's content never exceeds its own 2000-character limit", discordBody.content.length <= 2000, true);

    stubFetch();
    await postWebhookAlert(
      { url: new URL("https://api.telegram.org/botX/sendMessage"), format: "telegram", telegramChatId: "-100123" },
      longPayload,
    );
    const telegramBody = calls[0]?.body as { text: string };
    check("telegram's text never exceeds its own 4096-character limit", telegramBody.text.length <= 4096, true);
  }

  // --- postTestAlert(): watch test's own message, per format — never transitionPayload's
  // shape, so a receiving chat/telegram thread cannot mistake it for a real alert ----------

  {
    const at = "2026-01-01T00:00:00.000Z";

    stubFetch();
    await postTestAlert({ url: new URL("https://hooks.example/x"), format: "generic" }, at);
    const genericBody = calls[0]?.body as { deployment?: string; test?: boolean; at?: string };
    check("generic carries deployment/test/at, never from/to/reasons", Object.keys(genericBody ?? {}).sort(), ["at", "deployment", "test"]);
    check("test is true and deployment is named", [genericBody.test, genericBody.deployment], [true, deploymentName()]);

    stubFetch();
    await postTestAlert({ url: new URL("https://hooks.slack.com/services/x"), format: "slack" }, at);
    const slackBody = calls[0]?.body as { text?: string };
    check("slack gets a bare {text}, clearly marked as a test", Object.keys(slackBody ?? {}), ["text"]);
    check("the text says TEST, not a real transition", typeof slackBody?.text === "string" && slackBody.text.includes("TEST"), true);

    stubFetch();
    await postTestAlert({ url: new URL("https://discord.com/api/webhooks/1/x"), format: "discord" }, at);
    const discordBody = calls[0]?.body as { content?: string };
    check("discord gets a bare {content}", Object.keys(discordBody ?? {}), ["content"]);

    stubFetch();
    await postTestAlert({ url: new URL("https://api.telegram.org/botX/sendMessage"), format: "telegram", telegramChatId: "-100123" }, at);
    const telegramBody = calls[0]?.body as { chat_id?: string; text?: string };
    check("telegram gets {chat_id, text}, chat_id from the resolved target", telegramBody?.chat_id, "-100123");

    // Same delivery proof as postWebhookAlert: a non-2xx status still throws.
    stubFetch();
    nextResponse = () => new Response(null, { status: 500 });
    const message = await deathOf(() =>
      postTestAlert({ url: new URL("https://hooks.example/x"), format: "generic" }, at));
    check("a failed test delivery is reported the same way a real alert's is", message.includes(webhookRespondedWith(500)), true);
  }

  // --- Telegram's own success contract: 2xx + ok:false is NOT delivered ------------------

  {
    stubFetch();
    nextResponse = () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 200 });
    const target: WatchWebhookTarget = { url: new URL("https://api.telegram.org/botX/sendMessage"), format: "telegram", telegramChatId: "-100123" };
    const message = await deathOf(() => postWebhookAlert(target, payload));
    check("a 2xx reply carrying ok:false is reported as not delivered", message.includes("ok:false"), true);
  }

  {
    stubFetch();
    nextResponse = () => new Response("not json at all", { status: 200 });
    const target: WatchWebhookTarget = { url: new URL("https://api.telegram.org/botX/sendMessage"), format: "telegram", telegramChatId: "-100123" };
    const message = await deathOf(() => postWebhookAlert(target, payload));
    check("a 2xx reply this cannot parse as JSON is treated the same way — not proven delivered", message.includes("ok:false"), true);
  }

  {
    stubFetch();
    nextResponse = () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    const target: WatchWebhookTarget = { url: new URL("https://api.telegram.org/botX/sendMessage"), format: "telegram", telegramChatId: "-100123" };
    const message = await deathOf(() => postWebhookAlert(target, payload));
    check("a 2xx reply carrying ok:true delivers cleanly", message, "");
  }

  // --- end to end through runWatchCycle: ok:false leaves the persisted state untouched,
  // exactly like a failed POST to any other format (check.check.ts's own coverage) --------

  {
    const before: WatchState = { level: "ok", reasons: [], checkedAt: "2021-06-01T00:00:00.000Z", changedAt: "2021-06-01T00:00:00.000Z" };
    await writeWatchState(before);
    stubFetch();
    nextResponse = () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 200 });
    const target: WatchWebhookTarget = { url: new URL("https://api.telegram.org/botX/sendMessage"), format: "telegram", telegramChatId: "-100123" };
    const message = await deathOf(() => runWatchCycle(target, "down", [{ code: "GATEWAY_DOWN", detail: "down detail" }], false));
    check("a telegram ok:false transition is reported as not delivered", message.includes(ALERT_NOT_DELIVERED), true);
    const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check(
      "level/reasons/checkedAt/changedAt are left exactly as they were, same as a failed generic POST",
      [after.level, after.reasons, after.checkedAt, after.changedAt],
      [before.level, before.reasons, before.checkedAt, before.changedAt],
    );
    check("the failure is recorded as an undelivered alert too", after.alertPending?.to, "down");
  }

  // --- retry of an undelivered codes-only change: a failed delivery leaves
  // level/reasons at the pre-change snapshot (same as a level transition's own retry path),
  // so the next cycle still diffs against it and recognises the same unreported change
  // rather than dropping it — and a further code joining mid-outage is folded into toCodes
  // without losing since/fromCodes, exactly like a level transition's alertPending.since ---

  {
    const target: WatchWebhookTarget = { url: new URL("https://hooks.example/x"), format: "generic" };
    const before: WatchState = {
      level: "degraded",
      reasons: [{ code: "CHANNEL_UNHEALTHY", detail: "a" }],
      checkedAt: "2025-04-01T00:00:00.000Z",
      changedAt: "2025-04-01T00:00:00.000Z",
    };
    await writeWatchState(before);
    stubFetch();
    nextResponse = () => new Response(null, { status: 500 });
    const reasons = [
      { code: "CHANNEL_UNHEALTHY", detail: "a" },
      { code: "DISK_LOW", detail: "low" },
    ];
    const firstMessage = await deathOf(() => runWatchCycle(target, "degraded", reasons, false));
    check("a codes-only change's failed delivery is still attempted exactly once", calls.length, 1);
    check("and is reported the same way a level transition's failure is", firstMessage.includes(ALERT_NOT_DELIVERED), true);
    const after1 = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check(
      "level/reasons/checkedAt/changedAt are kept at the pre-change snapshot, not advanced",
      [after1.level, after1.reasons, after1.checkedAt, after1.changedAt],
      [before.level, before.reasons, before.checkedAt, before.changedAt],
    );
    check(
      "alertPending reads degraded -> degraded (from===to for a codes-only change)",
      [after1.alertPending?.from, after1.alertPending?.to],
      ["degraded", "degraded"],
    );
    check("alertPending.fromCodes is the pre-change code set", after1.alertPending?.fromCodes, ["CHANNEL_UNHEALTHY"]);
    check("alertPending.toCodes is the newly observed code set", after1.alertPending?.toCodes, ["CHANNEL_UNHEALTHY", "DISK_LOW"]);
    const firstSince = after1.alertPending?.since;

    // A second retry, with yet another code now present: still recognised as the SAME
    // unreported change (since/fromCodes survive), not lost and not a fresh alertPending.
    stubFetch();
    nextResponse = () => new Response(null, { status: 500 });
    const reasons2 = [
      { code: "CHANNEL_UNHEALTHY", detail: "a" },
      { code: "DISK_LOW", detail: "still low" },
      { code: "DISK_UNKNOWN", detail: "also now" },
    ];
    await deathOf(() => runWatchCycle(target, "degraded", reasons2, false));
    check("the retry attempts delivery again", calls.length, 1);
    const after2 = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("alertPending.since survives the retry, unlike a fresh pending change", after2.alertPending?.since, firstSince);
    check("alertPending.fromCodes stays fixed at the original pre-change set", after2.alertPending?.fromCodes, ["CHANNEL_UNHEALTHY"]);
    check(
      "alertPending.toCodes refreshes to this retry's own observed set",
      after2.alertPending?.toCodes,
      ["CHANNEL_UNHEALTHY", "DISK_LOW", "DISK_UNKNOWN"],
    );

    // Delivery finally succeeds: the pending change clears, and the latest reasons persist.
    stubFetch();
    nextResponse = () => new Response(null, { status: 200 });
    await deathOf(() => runWatchCycle(target, "degraded", reasons2, false));
    check("a delivered retry posts the codes-only change exactly once", calls.length, 1);
    const after3 = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("alertPending clears once delivered", after3.alertPending, undefined);
    check("lastError clears too", after3.lastError, undefined);
    check("the latest reason set is now persisted", after3.reasons, reasons2);
  }

  // --- old-state compatibility: a state file written before alertPending carried
  // fromCodes/toCodes (bare {from,to,since}) still parses, and a codes-only change starting
  // from one still alerts and clears the stale diagnostics on delivery -------------------

  {
    const target: WatchWebhookTarget = { url: new URL("https://hooks.example/x"), format: "generic" };
    const oldFormatState = {
      level: "degraded",
      reasons: [{ code: "CHANNEL_UNHEALTHY", detail: "a" }],
      checkedAt: "2025-05-01T00:00:00.000Z",
      changedAt: "2025-05-01T00:00:00.000Z",
      lastRunAt: "2025-05-01T00:05:00.000Z",
      lastError: "webhook responded with 500",
      alertPending: { from: "degraded", to: "degraded", since: "2025-05-01T00:05:00.000Z" },
    };
    await writeFile(watchStateFile(), `${JSON.stringify(oldFormatState, null, 2)}\n`, "utf8");
    const read = await readWatchState();
    check(
      "an old-format alertPending (no fromCodes/toCodes) still parses",
      read?.alertPending,
      { from: "degraded", to: "degraded", since: "2025-05-01T00:05:00.000Z" },
    );

    stubFetch();
    nextResponse = () => new Response(null, { status: 200 });
    const reasons = [
      { code: "CHANNEL_UNHEALTHY", detail: "a" },
      { code: "DISK_LOW", detail: "low" },
    ];
    await deathOf(() => runWatchCycle(target, "degraded", reasons, false));
    check("a codes-only change starting from an old-format state file still alerts", calls.length, 1);
    const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("and clears the stale alertPending/lastError it carried over", [after.alertPending, after.lastError], [undefined, undefined]);
  }
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

finish("watch webhook");
