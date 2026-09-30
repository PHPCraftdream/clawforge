// `./clawforge watch check` — the parts that do not need a live target:
//
// - watchLevel(): only the four liveness codes ever move the needle (PROVIDER_MISSING is
//   deliberately excluded — unreliable detection), and severity decides ok/degraded/down the
//   same way service/inspection.ts already assigns it.
// - parseWebhookUrl(): https accepted, http refused unless localhost/127.0.0.1, and the
//   refusal never repeats the value it is refusing.
// - resolveWatchOutcome(): gatherInspection() throwing outright (a transport failure, not a
//   liveness finding) reads as TARGET_UNREACHABLE/down instead of propagating and killing the
//   cycle before it can alert or persist anything; and it forwards whatever gather() answered
//   for observed.channels untouched — the plumbing withAdditionalFindings()'s channelFindings()
//   call relies on instead of a CLI call of its own (see inspect/fixture.ts's own batching
//   proof, and health.check.ts for channelFindings() itself).
// - watchCheck(): a configuration error is recorded before it exits, without touching what a
//   previous real cycle already recorded.
//
// The runWatchCycle() transition matrix is cycle.check.ts; the heartbeat, the cycle lock and
// `watch test` are cycle-heartbeat.check.ts, cycle-lock.check.ts and watch-test.check.ts.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchLevel, runWatchCycle, resolveWatchOutcome } from "#framework/commands/operate/watch/index.ts";
import { watchCheck } from "#framework/commands/operate/watch/check.ts";
import { parseWebhookUrl } from "#framework/commands/operate/watch/webhook.ts";
import type { WatchWebhookTarget } from "#framework/commands/operate/watch/webhook.ts";
import { watchStateFile, writeWatchState } from "#framework/commands/operate/watch/state.ts";
import type { WatchState } from "#framework/commands/operate/watch/state.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { registerSecret } from "#framework/core/io/log.ts";
import { problem } from "#framework/service/inspection.ts";
import type { Problem } from "#framework/service/inspection.ts";
import type { Context } from "#framework/core/context.ts";
import type { Inspection } from "#framework/service/inspection.ts";
import { check, finish } from "#checks/kit/harness.ts";
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
  check("EGRESS_UNREACHABLE alone -> degraded (warning severity)", watchLevel(findings(["EGRESS_UNREACHABLE"])).level, "degraded");
  check("CHANNEL_UNKNOWN alone -> degraded (telemetry is not confirmed)", watchLevel(findings(["CHANNEL_UNKNOWN"])).level, "degraded");
  check("GATEWAY_DOWN alone -> down (blocking severity)", watchLevel(findings(["GATEWAY_DOWN"])).level, "down");
  check("GATEWAY_UNHEALTHY alone -> down (blocking severity)", watchLevel(findings(["GATEWAY_UNHEALTHY"])).level, "down");
  check("NOT_BOOTSTRAPPED alone -> down (blocking severity)", watchLevel(findings(["NOT_BOOTSTRAPPED"])).level, "down");
  // PROVIDER_MISSING is excluded from liveness on purpose: detection cannot see an
  // env-keyed/subscription/CLI-backend provider, so it would page "degraded" forever on an
  // instance that answers every prompt fine — doctor still reports it, watch never does.
  check("PROVIDER_MISSING alone never moves the level -> ok, no reasons", watchLevel(findings(["PROVIDER_MISSING"])), { level: "ok", reasons: [] });
  check(
    "a down code alongside a degraded one still reads down",
    watchLevel(findings(["EGRESS_UNREACHABLE", "GATEWAY_DOWN"])).level,
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
  // --- resolveWatchOutcome(): gatherInspection throwing (a transport error unrelated to
  // NotBootstrapped — a downed Docker daemon, a refused SSH host, wsl.exe never answering)
  // reads as TARGET_UNREACHABLE/down instead of killing the whole cycle before an alert or a
  // state write ever happens -----------------------------------------------------------------

  {
    const dummyCtx = {} as unknown as Context;
    const okGather = async (): Promise<Inspection> => ({ declared: {}, observed: {}, problems: [] }) as unknown as Inspection;
    check("a gatherInspection that succeeds still goes through watchLevel", (await resolveWatchOutcome(dummyCtx, okGather)).level, "ok");

    const LEAKED_TOKEN = "leaked-transport-token-0123456789abcdef";
    registerSecret(LEAKED_TOKEN);
    const throwingGather = async (): Promise<Inspection> => {
      throw new Error(`connect ECONNREFUSED 203.0.113.5:22 (auth=${LEAKED_TOKEN}) ${"detail ".repeat(60)}`);
    };
    const outcome = await resolveWatchOutcome(dummyCtx, throwingGather);
    check("gatherInspection throwing -> level down", outcome.level, "down");
    check("the reason code is TARGET_UNREACHABLE", outcome.reasons[0]?.code, "TARGET_UNREACHABLE");
    check("the detail masks a registered secret", outcome.reasons[0]?.detail.includes(LEAKED_TOKEN), false);
    check("the detail is capped rather than the whole error message", (outcome.reasons[0]?.detail.length ?? 0) <= 210, true);

    // The full cycle: an alert fires on the ok -> down transition, and the outage (with its
    // masked reason) is what ends up persisted for `watch status` to show — cron's own stdout
    // goes to /dev/null, so this is the only trace of the outage an operator gets between runs.
    await writeWatchState({ level: "ok", reasons: [], checkedAt: "2022-01-01T00:00:00.000Z", changedAt: "2022-01-01T00:00:00.000Z" });
    calls.length = 0;
    nextResponse = () => new Response(null, { status: 200 });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return nextResponse();
    }) as typeof fetch;
    await deathOf(() => runWatchCycle(webhookTarget, outcome.level, outcome.reasons, false));
    check("the outage alerts exactly once on the ok -> down transition", calls.length, 1);
    const posted = calls[0]?.body as { reasons?: { code: string }[] } | undefined;
    check("the alert names TARGET_UNREACHABLE as the reason", posted?.reasons?.[0]?.code, "TARGET_UNREACHABLE");
    const written = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("state is recorded as down", written.level, "down");
    check("with the TARGET_UNREACHABLE reason", written.reasons?.[0]?.code, "TARGET_UNREACHABLE");
    check("the persisted state never carries the leaked secret", JSON.stringify(written).includes(LEAKED_TOKEN), false);
  }

  // --- resolveWatchOutcome() forwards observed.channels, gather() called exactly once ------
  //
  // channelFindings() (health.ts) takes the already-parsed answer, not a Context — it cannot
  // make a CLI call of its own. So the only way watch check's channel findings could still
  // cost a second exec is resolveWatchOutcome() calling gather() (gatherInspection) more than
  // once per cycle, or discarding observed.channels along the way. Neither happens here: one
  // call, and the field comes back exactly as gather() answered it.

  {
    const dummyCtx = {} as unknown as Context;
    let gatherCalls = 0;
    const channelsPayload = { channelAccounts: { telegram: [{ accountId: "default", configured: true, enabled: true, running: false }] } };
    const countedGather = async (): Promise<Inspection> => {
      gatherCalls += 1;
      return { declared: {}, observed: { channels: channelsPayload }, problems: [] } as unknown as Inspection;
    };
    const outcome = await resolveWatchOutcome(dummyCtx, countedGather);
    check("gather() is called exactly once per cycle", gatherCalls, 1);
    check("resolveWatchOutcome forwards observed.channels untouched", outcome.channels, channelsPayload);
  }

  {
    // No channels field at all (a gatherInspection() call that never set the `channels`
    // option) — a gap, not a crash or a synthesized empty shape.
    const dummyCtx = {} as unknown as Context;
    const noChannelsGather = async (): Promise<Inspection> => ({ declared: {}, observed: {}, problems: [] }) as unknown as Inspection;
    const outcome = await resolveWatchOutcome(dummyCtx, noChannelsGather);
    check("no channels field on the inspection -> undefined, not thrown", outcome.channels, undefined);
  }

  // --- watchCheck(): a configuration error is recorded before it exits, without touching
  // whatever a previous real cycle already recorded ------

  {
    await writeWatchState({ level: "ok", reasons: [], checkedAt: "2023-05-01T00:00:00.000Z", changedAt: "2023-05-01T00:00:00.000Z" });
    const ctx = { settings: { env: { OC_WATCH_WEBHOOK: "ftp://nope" } } } as unknown as Context;
    const message = await deathOf(() => watchCheck(ctx, []));
    check("watchCheck still throws the original configuration error", message.includes("OC_WATCH_WEBHOOK must be https"), true);
    const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check(
      "the previous cycle's level/reasons/checkedAt/changedAt survive untouched",
      [after.level, after.reasons, after.checkedAt, after.changedAt],
      ["ok", [], "2023-05-01T00:00:00.000Z", "2023-05-01T00:00:00.000Z"],
    );
    check("lastRunAt now records this attempt", typeof after.lastRunAt, "string");
    check("lastError names the configuration error", after.lastError?.includes("OC_WATCH_WEBHOOK must be https"), true);
  }

  {
    // No previous state at all: the diagnostics-only write still succeeds, with no level to
    // fabricate — there is genuinely no cycle result yet.
    await rm(watchStateFile(), { force: true });
    const ctx = { settings: { env: { OC_WATCH_HEARTBEAT_URL: "ftp://nope" } } } as unknown as Context;
    const message = await deathOf(() => watchCheck(ctx, []));
    check("a heartbeat URL configuration error is caught the same way", message.includes("OC_WATCH_HEARTBEAT_URL must be https"), true);
    const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("no level is fabricated for a config error with no previous cycle", after.level, undefined);
    check("lastError is still recorded", typeof after.lastError, "string");

    // The first completed cycle after that is the baseline: it gets its own changedAt.
    const printed: string[] = [];
    await withOutputSink((chunk) => printed.push(chunk), () => runWatchCycle(undefined, "ok", [], false));
    const baseline = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("the first cycle after a config-error-only state records changedAt", typeof baseline.changedAt, "string");
    check("and clears the recorded error", baseline.lastError, undefined);
    check("changedAt is this cycle itself", baseline.changedAt, baseline.checkedAt);
  }
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
finish("watch check");
