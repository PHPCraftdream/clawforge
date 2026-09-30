// watchTest(): a one-off delivery probe — never touches level/reasons/alertPending, reports
// success/failure per configured target, and says plainly when neither is configured.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchTest } from "#framework/commands/operate/watch/check.ts";
import { watchStateFile, writeWatchState } from "#framework/commands/operate/watch/state.ts";
import type { WatchState } from "#framework/commands/operate/watch/state.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { registerSecret } from "#framework/core/io/log.ts";
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
const root = await mkdtemp(join(tmpdir(), "clawforge-watch-check-check-"));
useDeployment(root);
const originalFetch = globalThis.fetch;

try {
  // --- watchTest(): a one-off delivery probe — never touches level/reasons/alertPending,
  // reports success/failure per configured target, and says plainly when neither is --------

  {
    const TEST_WEBHOOK_MARKER = "watch-test-webhook-secret-marker";
    const TEST_HEARTBEAT_MARKER = "watch-test-heartbeat-secret-marker";
    const testWebhookUrl = `https://hooks.example/${TEST_WEBHOOK_MARKER}`;
    const testHeartbeatUrl = `https://hb.example/${TEST_HEARTBEAT_MARKER}`;
    registerSecret(testHeartbeatUrl);

    let webhookStatus = 200;
    let heartbeatStatus = 200;
    let webhookCalls: { url: string; body: unknown }[] = [];
    let heartbeatCalls: { url: string; method: string | undefined }[] = [];
    const stubBoth = (): void => {
      webhookCalls = [];
      heartbeatCalls = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://hooks.example/")) {
          webhookCalls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
          return new Response(null, { status: webhookStatus });
        }
        heartbeatCalls.push({ url, method: init?.method });
        return new Response(null, { status: heartbeatStatus });
      }) as typeof fetch;
    };

    // Neither configured: nothing to test, exits 0, never calls fetch at all.
    {
      stubBoth();
      await writeWatchState({ level: "ok", reasons: [], checkedAt: "2024-01-01T00:00:00.000Z", changedAt: "2024-01-01T00:00:00.000Z" });
      const ctx = { settings: { env: {} } } as unknown as Context;
      const message = await deathOf(() => watchTest(ctx, []));
      check("neither configured never dies", message, "");
      check("and never calls fetch", [webhookCalls.length, heartbeatCalls.length], [0, 0]);

      const written: string[] = [];
      await withOutputSink((chunk) => written.push(chunk), () => watchTest(ctx, ["--json"]));
      const parsed = JSON.parse(written.join("")) as { configured: boolean; results: unknown[] };
      check("JSON reports configured:false with no results", [parsed.configured, parsed.results], [false, []]);
    }

    // Both configured, both succeed: a clearly-marked test payload, never a transition shape.
    {
      stubBoth();
      const ctx = { settings: { env: { OC_WATCH_WEBHOOK: testWebhookUrl, OC_WATCH_HEARTBEAT_URL: testHeartbeatUrl } } } as unknown as Context;
      const message = await deathOf(() => watchTest(ctx, []));
      check("both succeeding never dies", message, "");
      check("exactly one webhook POST", webhookCalls.length, 1);
      const body = webhookCalls[0]?.body as { deployment?: string; test?: boolean } | undefined;
      check("the test payload names the deployment", body?.deployment, deploymentName());
      check(
        "and is clearly marked as a test, never a transition shape",
        [body?.test, "from" in (body ?? {}), "to" in (body ?? {})],
        [true, false, false],
      );
      check("exactly one heartbeat GET", [heartbeatCalls.length, heartbeatCalls[0]?.method], [1, "GET"]);
      const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
      check("the heartbeat ping is recorded like a real cycle's own", typeof after.heartbeatAt, "string");
      check("level/checkedAt are untouched by a test", [after.level, after.checkedAt], ["ok", "2024-01-01T00:00:00.000Z"]);
      check("lastError/alertPending are never touched by a test", [after.lastError, after.alertPending], [undefined, undefined]);
    }

    // Webhook fails, heartbeat succeeds: reports both, exits non-zero for the failed target.
    {
      stubBoth();
      webhookStatus = 500;
      const ctx = { settings: { env: { OC_WATCH_WEBHOOK: testWebhookUrl, OC_WATCH_HEARTBEAT_URL: testHeartbeatUrl } } } as unknown as Context;
      const written: string[] = [];
      const message = await withOutputSink((chunk) => written.push(chunk), () => deathOf(() => watchTest(ctx, [])));
      check("a failed webhook target dies non-zero", message.includes("watch test"), true);
      check("naming the failed target", message.includes("webhook"), true);
      check("the webhook URL never leaks into the thrown message", message.includes(TEST_WEBHOOK_MARKER), false);
      check("nor into anything printed", written.join("").includes(TEST_WEBHOOK_MARKER), false);
      const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
      check("the heartbeat still succeeded and is recorded", typeof after.heartbeatAt, "string");
      webhookStatus = 200;
    }

    // Heartbeat fails: recorded the same way a real cycle's own failed ping is —
    // heartbeatAt kept at its last success, heartbeatError set.
    {
      const before = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
      stubBoth();
      heartbeatStatus = 503;
      const ctx = { settings: { env: { OC_WATCH_HEARTBEAT_URL: testHeartbeatUrl } } } as unknown as Context;
      const message = await deathOf(() => watchTest(ctx, []));
      check("a failed heartbeat target dies non-zero too", message.includes("heartbeat"), true);
      const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
      check("heartbeatAt is kept at its previous value, not cleared by a failed test", after.heartbeatAt, before.heartbeatAt);
      check("heartbeatError now records the test failure", typeof after.heartbeatError, "string");
      check("the heartbeat URL never appears in the persisted error", JSON.stringify(after).includes(TEST_HEARTBEAT_MARKER), false);
      heartbeatStatus = 200;
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
finish("watch check test");
