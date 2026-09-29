import { gatherInspection } from "#framework/commands/orchestration/inspect/gather.ts";
import { parseChannelsStatus } from "#framework/commands/orchestration/inspect/live.ts";
import type { Problem } from "#framework/service/inspection.ts";
import { watchCheck } from "#framework/commands/operate/watch/check.ts";
import { readWatchState, writeWatchState, withOperatorWatchState } from "#framework/commands/operate/watch/state.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "../fixture.ts";

const fixture = await setupFixtureDeployment();
const originalFetch = globalThis.fetch;

try {
  const notRequested = await gatherInspection(fixture.stubContext({}));
  check("unrequested channels have no unknown finding", notRequested.problems.some((entry) => entry.code === "CHANNEL_UNKNOWN"), false);

  for (const response of [undefined, { code: 7, stdout: "private-output", stderr: "private-error" }, { code: 0, stdout: "not-json", stderr: "" }, { code: 0, stdout: "null", stderr: "" }]) {
    const problems: Problem[] = [];
    check("failed or malformed requested reads remain absent", parseChannelsStatus(response, problems), undefined);
    check("failed requested reads identify unknown telemetry", problems[0]?.code, "CHANNEL_UNKNOWN");
    check("failure reasons contain no raw output", JSON.stringify(problems).includes("private-"), false);
  }

  for (const spec of [{}, { channelsStatus: { channel: "malformed" } }]) {
    const ctx = fixture.stubContext(spec);
    const gathered = await gatherInspection(ctx, { channels: true });
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
