// `./clawforge watch check` — the parts that do not need a live target:
//
// - watchLevel(): only the five liveness codes ever move the needle, and severity decides
//   ok/degraded/down the same way service/inspection.ts already assigns it.
// - parseWebhookUrl(): https accepted, http refused unless localhost/127.0.0.1, and the
//   refusal never repeats the value it is refusing.
// - runWatchCycle(): the transition matrix — no previous state is a baseline, not an
//   alert; an unchanged level never posts; a changed level posts exactly once; a failed
//   POST leaves the persisted state at its old value so the next cycle retries it — and
//   that the webhook URL never appears anywhere this run could have printed it, on either
//   path.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchLevel, runWatchCycle } from "#framework/watch/index.ts";
import { parseWebhookUrl } from "#framework/watch/webhook.ts";
import { watchStateFile, writeWatchState } from "#framework/watch/state.ts";
import type { WatchState } from "#framework/watch/state.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { problem } from "#framework/service/inspection.ts";
import type { Problem } from "#framework/service/inspection.ts";

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

// --- watchLevel(): severity decides the bucket, and only the five liveness codes count ------

{
  const findings = (codes: Problem["code"][]): Problem[] => codes.map((code) => problem(code, `${code} detail`));
  check("no problems -> ok, no reasons", watchLevel([]), { level: "ok", reasons: [] });
  check("PROVIDER_MISSING alone -> degraded (warning severity)", watchLevel(findings(["PROVIDER_MISSING"])).level, "degraded");
  check("EGRESS_UNREACHABLE alone -> degraded (warning severity)", watchLevel(findings(["EGRESS_UNREACHABLE"])).level, "degraded");
  check("GATEWAY_DOWN alone -> down (blocking severity)", watchLevel(findings(["GATEWAY_DOWN"])).level, "down");
  check("GATEWAY_UNHEALTHY alone -> down (blocking severity)", watchLevel(findings(["GATEWAY_UNHEALTHY"])).level, "down");
  check("NOT_BOOTSTRAPPED alone -> down (blocking severity)", watchLevel(findings(["NOT_BOOTSTRAPPED"])).level, "down");
  check(
    "a down code alongside a degraded one still reads down",
    watchLevel(findings(["PROVIDER_MISSING", "GATEWAY_DOWN"])).level,
    "down",
  );
  check("a code inspect/doctor own but liveness does not (CONFIG_DRIFT) never moves the level", watchLevel(findings(["CONFIG_DRIFT"])).level, "ok");
  check(
    "and is excluded from reasons even alongside a real one",
    watchLevel([problem("CONFIG_DRIFT", "unrelated"), problem("GATEWAY_DOWN", "down detail")]).reasons,
    [{ code: "GATEWAY_DOWN", detail: "down detail" }],
  );
}

// --- parseWebhookUrl(): https-only unless localhost, and never repeats the value -----------

{
  check("https is accepted", parseWebhookUrl("https://hooks.example/x").protocol, "https:");
  check("http+localhost is accepted", parseWebhookUrl("http://localhost:9000/x").hostname, "localhost");
  check("http+127.0.0.1 is accepted", parseWebhookUrl("http://127.0.0.1:9000/x").hostname, "127.0.0.1");
  check(
    "http against a real host is refused",
    (() => { try { parseWebhookUrl("http://hooks.example/x"); return ""; } catch (error) { return (error as Error).message; } })(),
    "OC_WATCH_WEBHOOK must be https, or http only against localhost/127.0.0.1",
  );
  check(
    "an unparsable value is refused",
    (() => { try { parseWebhookUrl("not a url"); return ""; } catch (error) { return (error as Error).message; } })(),
    "OC_WATCH_WEBHOOK is not a valid URL",
  );
  check(
    "the refusal never repeats the value being refused",
    (() => { try { parseWebhookUrl("http://leaked-marker.example/x"); return ""; } catch (error) { return (error as Error).message; } })().includes("leaked-marker"),
    false,
  );
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

  // First run: no previous state at all — a baseline, never a transition, whatever the level is.
  {
    calls.length = 0;
    const message = await deathOf(() => runWatchCycle(webhookUrl, "down", [{ code: "GATEWAY_DOWN", detail: "down detail" }], true));
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
    await runWatchCycle(webhookUrl, "ok", [], false);
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
    await deathOf(() => runWatchCycle(webhookUrl, "down", reasons, false));
    check("a real transition posts exactly once", calls.length, 1);
    const postedBody = calls[0]?.body as { at?: string } | undefined;
    check(
      "the payload names the transition",
      postedBody,
      { deployment: deploymentName(), from: "ok", to: "down", reasons, at: postedBody?.at },
    );
    const written = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("the transition is persisted", written.level, "down");
    check("changedAt moves on a real transition", written.changedAt !== "2020-01-01T00:00:00.000Z", true);
  }

  // A failed delivery: the old state survives untouched, so the next cycle sees the same
  // unreported transition and retries it — and the exit is still non-zero.
  {
    const before: WatchState = { level: "ok", reasons: [], checkedAt: "2021-06-01T00:00:00.000Z", changedAt: "2021-06-01T00:00:00.000Z" };
    await writeWatchState(before);
    calls.length = 0;
    nextResponse = () => new Response(null, { status: 500 });
    const written: string[] = [];
    const message = await withOutputSink((chunk) => written.push(chunk), () =>
      deathOf(() => runWatchCycle(webhookUrl, "down", [{ code: "GATEWAY_DOWN", detail: "down detail" }], false)));
    check("a failed delivery is still attempted exactly once", calls.length, 1);
    check("a failed delivery reports non-zero (throws)", message.includes("was not delivered"), true);
    check("and says the state was kept for a retry", message.includes(`kept at "ok"`) || message.includes(`retried next cycle`), true);
    const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("the state file is left exactly as it was — not advanced to the new level", after, before);
    check("the webhook URL never appears in anything this run wrote", written.join("").includes(MARKER), false);
    check("nor in the thrown message itself", message.includes(MARKER), false);
  }

  // Same failure, but the underlying fetch rejects outright (a network error, not just a
  // bad status) rather than resolving with one — the other way a POST can fail.
  {
    const before: WatchState = { level: "ok", reasons: [], checkedAt: "2021-06-01T00:00:00.000Z", changedAt: "2021-06-01T00:00:00.000Z" };
    await writeWatchState(before);
    calls.length = 0;
    globalThis.fetch = (async () => { throw new Error("network is down"); }) as typeof fetch;
    const message = await deathOf(() => runWatchCycle(webhookUrl, "down", [{ code: "GATEWAY_DOWN", detail: "down detail" }], false));
    check("a rejected fetch is reported the same way as a bad status", message.includes("was not delivered"), true);
    const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("and the state is kept there too", after, before);
    check("the URL never appears in a rejected-fetch message either", message.includes(MARKER), false);
  }
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all watch check checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
