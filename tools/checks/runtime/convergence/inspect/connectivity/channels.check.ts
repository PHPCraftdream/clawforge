import { gatherInspection, renderJson } from "#framework/commands/orchestration/inspect/gather.ts";
import { parseChannelsStatus } from "#framework/commands/orchestration/inspect/live.ts";
import { channelProblems, normalizeChannels } from "#framework/service/inspection.ts";
import type { Problem, Inspection } from "#framework/service/inspection.ts";
import { watchCheck } from "#framework/commands/operate/watch/check.ts";
import { readWatchState, writeWatchState, withOperatorWatchState } from "#framework/commands/operate/watch/state.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "../fixture.ts";

const fixture = await setupFixtureDeployment();
const originalFetch = globalThis.fetch;

try {
  const notRequested = await gatherInspection(fixture.stubContext({}), { channels: false });
  check("unrequested channels have no unknown finding", notRequested.problems.some((entry) => entry.code === "CHANNEL_UNKNOWN"), false);

  const operational = await gatherInspection(fixture.stubContext({ channelsStatus: { telegram: [{ configured: true, enabled: true, running: false, probe: { ok: true } }] } }));
  check("default inspect publishes stopped polling as actionable", operational.problems.some((entry) => entry.code === "CHANNEL_UNHEALTHY"), true);
  check("default inspect retains operational telemetry", (operational.observed.channels?.channelAccounts?.telegram as { running: boolean }[] | undefined)?.[0]?.running, false);
  check("consumer JSON never calls getMe-ok stopped polling healthy", renderJson(operational).healthy, false);
  const missing = await gatherInspection(fixture.stubContext({ channelsStatus: { telegram: [{ configured: true, enabled: true, credentialPresent: true }] } }));
  check("configuration without polling retains credential facts", (missing.observed.channels?.channelAccounts?.telegram as { credentialPresent?: boolean }[] | undefined)?.[0]?.credentialPresent, true);
  check("consumer JSON unknown polling is not healthy", renderJson(missing).healthy, false);
  const healthyAccount = { configured: true, enabled: true, running: true, connected: true, probe: { ok: true } };
  const consumerBase: Inspection = {
    declared: operational.declared,
    observed: { running: true, health: "healthy", probes: { healthz: 200, startupz: 200, readyz: 200 }, config: {}, secrets: [], foreignObjects: [] },
    problems: [],
  };
  function consumer(account: typeof healthyAccount): Inspection {
    const channels = { channelAccounts: { telegram: [account] } };
    return { ...consumerBase, observed: { ...consumerBase.observed, channels }, problems: channelProblems(channels) };
  }
  const healthyConsumer = consumer(healthyAccount);
  check("consumer control has independent healthy runtime and probes", [healthyConsumer.observed.running, healthyConsumer.observed.health, healthyConsumer.observed.probes, healthyConsumer.problems], [true, "healthy", { healthz: 200, startupz: 200, readyz: 200 }, []]);
  check("consumer JSON healthy channel control is healthy", renderJson(healthyConsumer).healthy, true);
  const emptyChannels = { channelAccounts: {} };
  check("explicit empty channel inventory preserves a healthy gateway", renderJson({ ...consumerBase, observed: { ...consumerBase.observed, channels: emptyChannels }, problems: channelProblems(emptyChannels) }).healthy, true);
  const stoppedConsumer = consumer({ ...healthyAccount, running: false });
  check("only stopped polling produces a channel warning, not another blocker", stoppedConsumer.problems.map((entry) => [entry.code, entry.severity]), [["CHANNEL_UNHEALTHY", "warning"]]);
  check("consumer JSON only runningfalse changes healthy verdict", renderJson(stoppedConsumer).healthy, false);
  check("consumer JSON unknown polling is unhealthy without fixture blockers", renderJson({ ...consumerBase, observed: { ...consumerBase.observed, channels: missing.observed.channels }, problems: channelProblems(missing.observed.channels) }).healthy, false);
  const siblingProblems: Problem[] = [];
  const siblings = parseChannelsStatus({ code: 0, stdout: JSON.stringify({ channelAccounts: { telegram: [{ configured: true, connected: true }, null, { configured: true, running: "bad", credentialPresent: true }] } }), stderr: "" }, siblingProblems);
  check("malformed account preserves valid sibling", (siblings?.channelAccounts?.telegram as { connected?: boolean }[] | undefined)?.[0]?.connected, true);
  check("malformed accounts produce unknown polling", siblingProblems.every((entry) => entry.code === "CHANNEL_UNKNOWN") && siblingProblems.length > 0, true);
  const repeated = normalizeChannels(normalizeChannels({ channelAccounts: { telegram: [null, { configured: true, running: "bad", credentialPresent: true }] } }));
  check("repeated normalization retains unknown placeholders and credential facts", repeated?.channelAccounts?.telegram, [{ accountId: "account-1", healthState: "unknown" }, { accountId: "account-2", configured: true, healthState: "unknown", credentialPresent: true }]);
  check("repeated normalization cannot turn malformed polling healthy", channelProblems(repeated).map((entry) => entry.code), ["CHANNEL_UNKNOWN", "CHANNEL_UNKNOWN"]);
  const pollingProblems: Problem[] = [];
  const polling = parseChannelsStatus({ code: 0, stdout: JSON.stringify({ channelAccounts: { telegram: [{ configured: true, enabled: true, running: false, probe: { ok: true, bot: { id: 123456789, username: "private-bot" }, user: { id: "private-user" }, chat: { id: "private-chat" }, token: "private-token", url: "https://private.invalid/token" }, accountId: "123456789", lastError: "token-secret https://private.invalid" }] } }), stderr: "" }, pollingProblems);
  check("API success does not prove polling healthy", pollingProblems.map((entry) => entry.code), ["CHANNEL_UNHEALTHY"]);
  check("channel output rejects IDs URLs and raw errors", /123456789|private\.|private-bot|private-user|private-chat|private-token|token-secret/.test(JSON.stringify({ polling, pollingProblems })), false);
  check("probe publishes only a boolean verdict", (polling?.channelAccounts?.telegram as { probe: unknown }[] | undefined)?.[0]?.probe, { ok: true });
  const nativeProblems: Problem[] = [];
  const nativeStopped = parseChannelsStatus({ code: 0, stdout: '{"channelAccounts":{"telegram":[{"configured":true,"enabled":true,"running":false,"connected":true,"restartPending":true,"healthState":"not-running","probe":{"ok":true}}]}}' }, nativeProblems);
  check("native stopped state is preserved rather than invented unknown telemetry", [(nativeStopped?.channelAccounts?.telegram as { healthState?: string }[] | undefined)?.[0]?.healthState, nativeProblems.map(entry => entry.code)], ["not-running", ["CHANNEL_UNHEALTHY"]]);
  const partialProblems: Problem[] = [];
  const partial = parseChannelsStatus({ code: 1, stdout: JSON.stringify({ channelAccounts: { telegram: [{ configured: true, enabled: true, running: false }] } }), stderr: "private-error" }, partialProblems);
  check("failed explicit channel read retains valid facts", partial?.channelAccounts !== undefined, true);
  check("partial channel failure remains unknown and actionable", partialProblems.map((entry) => entry.code), ["CHANNEL_UNKNOWN", "CHANNEL_UNHEALTHY"]);
  const disabledProblems: Problem[] = [];
  parseChannelsStatus({ code: 0, stdout: '{"channelAccounts":{"telegram":[{"configured":true,"enabled":false,"running":false}]}}', stderr: "" }, disabledProblems);
  check("disabled polling is not alarming", disabledProblems, []);

  for (const response of [undefined, { code: 7, stdout: "private-output", stderr: "private-error" }, { code: 0, stdout: "not-json", stderr: "" }, { code: 0, stdout: "null", stderr: "" }]) {
    const problems: Problem[] = [];
    check("failed or malformed requested reads remain absent", parseChannelsStatus(response, problems), undefined);
    check("failed requested reads identify unknown telemetry", problems[0]?.code, "CHANNEL_UNKNOWN");
    check("failure reasons contain no raw output", JSON.stringify(problems).includes("private-"), false);
  }

  for (const spec of [{ channelsStatus: "unavailable" as const }, { channelsStatus: { channel: "malformed" } }]) {
    const ctx = fixture.stubContext(spec);
    const gathered = await gatherInspection(ctx);
    check("failed or malformed requested reads are visible in inspection", gathered.problems.some((entry) => entry.code === "CHANNEL_UNKNOWN"), true);
    check("HTTP probes remain healthy in the unknown channel scenario", Object.values(gathered.observed.probes).every((code) => code === 200), true);

    ctx.settings.env.OC_WATCH_WEBHOOK = "https://hooks.example/fixture";
    ctx.settings.env.OC_WATCH_HEARTBEAT_URL = "https://heartbeat.example/fixture";
    const baseExec = ctx.transport.exec.bind(ctx.transport);
    ctx.transport.exec = async (command, args, options) => command === "df"
      ? { code: 0, stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 9000000 1 8999999 1% /\n", stderr: "" }
      : baseExec(command, args, options);
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await withOperatorWatchState(ctx, async () => {
    await writeWatchState({ level: "degraded", reasons: [{ code: "CHANNEL_UNHEALTHY", detail: "fixture channel disconnected" }], checkedAt: "2020-01-01T00:00:00.000Z" });
    let failed = false;
    try {
      await withOutputSink(() => {}, () => watchCheck(ctx, ["--json"]));
    } catch {
      failed = true;
    }
    const state = await readWatchState();
    check("unknown channel cycles report a nonhealthy exit", failed, true);
    check("a channel outage cannot recover through missing telemetry", state?.level, "degraded");
    check("persisted state retains the unknown reason", state?.reasons?.some((entry) => entry.code === "CHANNEL_UNKNOWN"), true);
    check("unknown telemetry sends no healthy heartbeat", calls.some((entry) => entry.url.includes("heartbeat.example")), false);
    check("unknown telemetry sends no recovery alert", calls.some((entry) => (entry.body as { to?: string } | undefined)?.to === "ok"), false);
    check("changed degraded reasons send one alert", calls.length, 1);
    });
  }
} finally {
  globalThis.fetch = originalFetch;
  await teardownFixtureDeployment(fixture.deployment);
}

finish("inspect-channels");
