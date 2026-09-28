// `./clawforge watch check`'s heartbeat (dead-man's switch) primitives in webhook.ts —
// runWatchCycle's own use of them (pinged only on an ok cycle, a failure never changing
// level/exit) is check.check.ts's job; this file proves the pieces underneath it:
//
// - watchHeartbeatUrlRaw: same optional/blank/trim contract as the webhook's own raw reader.
// - parseHeartbeatUrl: the same https-or-localhost-http rule as parseWebhookUrl, under
//   OC_WATCH_HEARTBEAT_URL's own name.
// - postHeartbeat: a plain GET (what healthchecks.io, Uptime Kuma's push monitor and Better
//   Stack's heartbeat monitor all accept), success on 2xx, and a thrown error — never
//   repeating the URL — on anything else.

import { WATCH_HEARTBEAT_URL_ENV, parseHeartbeatUrl, postHeartbeat, watchHeartbeatUrlRaw } from "#framework/watch/webhook.ts";
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

check("the env var name is OC_WATCH_HEARTBEAT_URL", WATCH_HEARTBEAT_URL_ENV, "OC_WATCH_HEARTBEAT_URL");

// --- watchHeartbeatUrlRaw(): unset, blank and whitespace-only all read as "not configured" -

{
  const ctx = (env: Record<string, string>): Context => ({ settings: { env } } as unknown as Context);
  check("unset reads as not configured", watchHeartbeatUrlRaw(ctx({})), undefined);
  check("an empty string reads as not configured", watchHeartbeatUrlRaw(ctx({ [WATCH_HEARTBEAT_URL_ENV]: "" })), undefined);
  check("whitespace-only reads as not configured", watchHeartbeatUrlRaw(ctx({ [WATCH_HEARTBEAT_URL_ENV]: "   " })), undefined);
  check(
    "a real value is trimmed and returned",
    watchHeartbeatUrlRaw(ctx({ [WATCH_HEARTBEAT_URL_ENV]: "  https://hc-ping.com/x  " })),
    "https://hc-ping.com/x",
  );
}

// --- parseHeartbeatUrl(): https, or http only against localhost/127.0.0.1 ---------------

{
  check("https is accepted", parseHeartbeatUrl("https://hc-ping.com/x").protocol, "https:");
  check("http+localhost is accepted", parseHeartbeatUrl("http://localhost:9000/x").hostname, "localhost");
  check("http+127.0.0.1 is accepted", parseHeartbeatUrl("http://127.0.0.1:9000/x").hostname, "127.0.0.1");
  check(
    "http against a real host is refused",
    (() => { try { parseHeartbeatUrl("http://hc-ping.com/x"); return ""; } catch (error) { return (error as Error).message; } })(),
    "OC_WATCH_HEARTBEAT_URL must be https, or http only against localhost/127.0.0.1",
  );
  check(
    "an unparsable value is refused",
    (() => { try { parseHeartbeatUrl("not a url"); return ""; } catch (error) { return (error as Error).message; } })(),
    "OC_WATCH_HEARTBEAT_URL is not a valid URL",
  );
  check(
    "the refusal never repeats the value being refused",
    (() => { try { parseHeartbeatUrl("http://leaked-heartbeat-marker.example/x"); return ""; } catch (error) { return (error as Error).message; } })().includes("leaked-heartbeat-marker"),
    false,
  );
}

// --- postHeartbeat(): a plain GET, success on 2xx, a thrown (URL-free) error otherwise --

const originalFetch = globalThis.fetch;
try {
  const calls: { url: string; method: string | undefined; hadBody: boolean }[] = [];
  let nextResponse: () => Response | Promise<Response> = () => new Response(null, { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, hadBody: init?.body !== undefined });
    return nextResponse();
  }) as typeof fetch;

  const MARKER = "watch-heartbeat-secret-marker";
  const url = new URL(`https://hb.example/${MARKER}`);

  {
    calls.length = 0;
    nextResponse = () => new Response(null, { status: 200 });
    await postHeartbeat(url);
    check("exactly one request is made", calls.length, 1);
    check("it is a GET", calls[0]?.method, "GET");
    check("it carries no body", calls[0]?.hadBody, false);
  }

  {
    calls.length = 0;
    nextResponse = () => new Response(null, { status: 204 });
    const message = await deathOf(() => postHeartbeat(url));
    check("204 (No Content) still counts as success", message, "");
  }

  {
    calls.length = 0;
    nextResponse = () => new Response("service unavailable", { status: 503 });
    const message = await deathOf(() => postHeartbeat(url));
    check("a non-2xx status is reported by number", message.includes("503"), true);
    check("the failure message never repeats the URL", message.includes(MARKER), false);
  }

  {
    calls.length = 0;
    globalThis.fetch = (async () => { throw new Error("network is down"); }) as typeof fetch;
    const message = await deathOf(() => postHeartbeat(url));
    check("a rejected fetch is reported too", message.includes("heartbeat request failed"), true);
    check("and it never repeats the URL either", message.includes(MARKER), false);
  }
} finally {
  globalThis.fetch = originalFetch;
}

process.stderr.write(failed === 0 ? "all watch heartbeat checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
