// `./clawforge watch check`'s alert webhook, one layer down from check.check.ts's own
// coverage of runWatchCycle's transition matrix:
//
// - detectWebhookFormat (through resolveWebhookTarget): autodetected from the URL host
//   alone, matching each vendor's own incoming-webhook host (README links the docs).
// - resolveWebhookTarget: OC_WATCH_WEBHOOK_FORMAT overrides autodetection when set, an
//   unknown value is a configuration error, and format=telegram with no
//   OC_WATCH_TELEGRAM_CHAT_ID is refused the same way, before any probe cycle runs.
// - postWebhookAlert's per-format body: generic keeps the original structured JSON; slack/
//   discord/telegram get a one-two line human message, capped to that format's own
//   documented limit (2,000 for Discord's `content`, 4,096 for Telegram's `text`).
// - Telegram's own success contract: a 2xx reply carrying `ok:false` is treated as
//   undelivered, end to end through runWatchCycle — the persisted state is kept exactly
//   like a failed POST to any other format.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatchCycle } from "#framework/watch/index.ts";
import {
  WATCH_TELEGRAM_CHAT_ID_ENV,
  WATCH_WEBHOOK_FORMAT_ENV,
  postWebhookAlert,
  resolveWebhookTarget,
  transitionPayload,
} from "#framework/watch/webhook.ts";
import type { WatchWebhookTarget } from "#framework/watch/webhook.ts";
import { watchStateFile, writeWatchState } from "#framework/watch/state.ts";
import type { WatchState } from "#framework/watch/state.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

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

  const payload = transitionPayload("ok", "down", [{ code: "GATEWAY_DOWN", detail: "gateway did not answer" }], "2026-01-01T00:00:00.000Z");

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
    check("the text names the deployment and the transition", typeof body?.text === "string" && body.text.includes("ok → down"), true);
    check("the text names the reason code", typeof body?.text === "string" && body.text.includes("GATEWAY_DOWN"), true);
    check("the text names when", typeof body?.text === "string" && body.text.includes(payload.at), true);
  }

  {
    stubFetch();
    const target: WatchWebhookTarget = { url: new URL("https://discord.com/api/webhooks/1/x"), format: "discord" };
    await postWebhookAlert(target, payload);
    const body = calls[0]?.body as { content?: string };
    check("discord posts a bare {content} object", Object.keys(body ?? {}), ["content"]);
    check("the content names the transition", typeof body?.content === "string" && body.content.includes("ok → down"), true);
  }

  {
    stubFetch();
    const target: WatchWebhookTarget = { url: new URL("https://api.telegram.org/botX/sendMessage"), format: "telegram", telegramChatId: "-100123" };
    await postWebhookAlert(target, payload);
    const body = calls[0]?.body as { chat_id?: string; text?: string };
    check("telegram posts {chat_id, text}", Object.keys(body ?? {}).sort(), ["chat_id", "text"]);
    check("chat_id is exactly OC_WATCH_TELEGRAM_CHAT_ID's value", body?.chat_id, "-100123");
    check("the text names the transition", typeof body?.text === "string" && body.text.includes("ok → down"), true);
  }

  // --- discord/telegram cap the text to their own documented limit --------------------

  {
    const longReasons = Array.from({ length: 80 }, (_, index) => ({
      code: `REASON_${index}`,
      detail: "x".repeat(100),
    }));
    const longPayload = transitionPayload("ok", "down", longReasons, "2026-01-01T00:00:00.000Z");

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
    check("a telegram ok:false transition is reported as not delivered", message.includes("was not delivered"), true);
    const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("the state file is left exactly as it was, same as a failed generic POST", after, before);
  }
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all watch webhook checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
