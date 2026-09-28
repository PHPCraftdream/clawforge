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
// - runWatchCycle(): the transition matrix — no previous state is a baseline, not an
//   alert; an unchanged level never posts; a changed level posts exactly once; a failed
//   POST leaves the persisted state at its old value so the next cycle retries it — and
//   that the webhook URL never appears anywhere this run could have printed it, on either
//   path.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchLevel, runWatchCycle, resolveWatchOutcome } from "#framework/commands/operate/watch/index.ts";
import { watchCheck, watchTest } from "#framework/commands/operate/watch/check.ts";
import { parseWebhookUrl } from "#framework/commands/operate/watch/webhook.ts";
import type { WatchWebhookTarget } from "#framework/commands/operate/watch/webhook.ts";
import { watchStateFile, writeWatchState } from "#framework/commands/operate/watch/state.ts";
import type { WatchState } from "#framework/commands/operate/watch/state.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { registerSecret } from "#framework/core/io/log.ts";
import { problem } from "#framework/service/inspection.ts";
import type { Problem } from "#framework/service/inspection.ts";
import type { Context } from "#framework/core/context.ts";
import type { Inspection } from "#framework/service/inspection.ts";

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
  check("EGRESS_UNREACHABLE alone -> degraded (warning severity)", watchLevel(findings(["EGRESS_UNREACHABLE"])).level, "degraded");
  check("GATEWAY_DOWN alone -> down (blocking severity)", watchLevel(findings(["GATEWAY_DOWN"])).level, "down");
  check("GATEWAY_UNHEALTHY alone -> down (blocking severity)", watchLevel(findings(["GATEWAY_UNHEALTHY"])).level, "down");
  check("NOT_BOOTSTRAPPED alone -> down (blocking severity)", watchLevel(findings(["NOT_BOOTSTRAPPED"])).level, "down");
  // PROVIDER_MISSING is excluded from liveness on purpose (B4): detection cannot see an
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
      { deployment: deploymentName(), from: "ok", to: "down", reasons, at: postedBody?.at },
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

  // --- runWatchCycle()'s heartbeat parameter: the dead-man's switch is pinged only while
  // THIS cycle's own level reads ok, a failed ping never changes level/exit, and the URL
  // never leaks into anything this could print (registered as a secret the same way
  // core/context.ts registers it, in case a future fetch/undici version ever echoes it back
  // in a rejection message) -------------------------------------------------------------

  {
    const HEARTBEAT_MARKER = "watch-check-heartbeat-secret-marker";
    const heartbeatUrl = new URL(`https://hb.example/${HEARTBEAT_MARKER}`);
    registerSecret(heartbeatUrl.toString());
    let heartbeatCalls: { url: string; method: string | undefined }[] = [];
    const stubHeartbeat = (status: number): void => {
      heartbeatCalls = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        heartbeatCalls.push({ url: String(input), method: init?.method });
        return new Response(null, { status });
      }) as typeof fetch;
    };

    await writeWatchState({ level: "ok", reasons: [], checkedAt: "2023-01-01T00:00:00.000Z", changedAt: "2023-01-01T00:00:00.000Z" });

    stubHeartbeat(200);
    await runWatchCycle(undefined, "ok", [], false, heartbeatUrl);
    check("an ok cycle pings the heartbeat exactly once, by GET", [heartbeatCalls.length, heartbeatCalls[0]?.method], [1, "GET"]);
    {
      const written = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
      check("a successful ping is recorded as heartbeatAt", typeof written.heartbeatAt, "string");
      check("no heartbeatError is recorded on success", written.heartbeatError, undefined);
    }

    for (const level of ["degraded", "down"] as const) {
      stubHeartbeat(200);
      await deathOf(() => runWatchCycle(undefined, level, [{ code: "GATEWAY_DOWN", detail: "d" }], false, heartbeatUrl));
      check(`a ${level} cycle never pings the heartbeat`, heartbeatCalls.length, 0);
    }

    // A failed ping: a warning only (surfaced as `heartbeatWarning` in the JSON envelope
    // this cycle prints, since a captured sink always answers JSON regardless of --json —
    // same reason check.ts's own if (jsonOnly || isCaptured()) branch exists), never a
    // level change or a non-zero exit by itself, and the previous successful ping time is
    // kept rather than cleared.
    {
      const before = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
      stubHeartbeat(503);
      const printed: string[] = [];
      const message = await withOutputSink((chunk) => printed.push(chunk), () =>
        deathOf(() => runWatchCycle(undefined, "ok", [], false, heartbeatUrl)));
      check("a failed ping is still attempted exactly once", heartbeatCalls.length, 1);
      check("a failed ping never dies on its own (no non-zero exit)", message, "");
      const envelope = JSON.parse(printed.join("")) as { heartbeatWarning?: string };
      check("a failed ping surfaces as heartbeatWarning in this cycle's output", typeof envelope.heartbeatWarning, "string");
      const after = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
      check("heartbeatAt is kept at its previous value, not cleared by a failure", after.heartbeatAt, before.heartbeatAt);
      check("heartbeatError now records the failure", typeof after.heartbeatError, "string");
      check("the heartbeat URL never appears in the printed envelope", printed.join("").includes(HEARTBEAT_MARKER), false);
      check("nor in the persisted state", JSON.stringify(after).includes(HEARTBEAT_MARKER), false);
    }

    // Same failure, but the underlying fetch rejects outright and its message echoes the
    // URL — the masking belt-and-suspenders case, proven the same way the webhook's own
    // rejected-fetch test above proves it.
    {
      globalThis.fetch = (async () => { throw new Error(`connect failed reaching ${heartbeatUrl.toString()}`); }) as typeof fetch;
      const printed: string[] = [];
      await withOutputSink((chunk) => printed.push(chunk), () => deathOf(() => runWatchCycle(undefined, "ok", [], false, heartbeatUrl)));
      const envelope = JSON.parse(printed.join("")) as { heartbeatWarning?: string };
      check("a rejected heartbeat fetch also surfaces as heartbeatWarning", typeof envelope.heartbeatWarning, "string");
      check("even an error message that echoes the URL comes out masked", printed.join("").includes(HEARTBEAT_MARKER), false);
    }

    // No heartbeat configured: never attempted, never mentioned.
    {
      stubHeartbeat(200);
      const printed: string[] = [];
      await withOutputSink((chunk) => printed.push(chunk), () => runWatchCycle(undefined, "ok", [], false, undefined));
      check("with no heartbeat URL, nothing is pinged", heartbeatCalls.length, 0);
      const envelope = JSON.parse(printed.join("")) as { heartbeatWarning?: string };
      check("and no heartbeatWarning field appears", envelope.heartbeatWarning, undefined);
    }
  }

  // --- resolveWatchOutcome() / B3: gatherInspection throwing (a transport error unrelated to
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

process.stderr.write(failed === 0 ? "all watch check checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
