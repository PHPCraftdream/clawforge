// `./clawforge watch check`'s own channel/disk findings (watch/health.ts) — the two liveness
// signals `inspect`/`doctor` do not compute:
//
// - channelFindings(): configured+enabled channel accounts read from `channels status --json`
//   (the same CLI path openclaw-cli.ts's openclawCliJson already uses for agents/mcp/cron);
//   not-running, a captured lastError, or connected: false all read as CHANNEL_UNHEALTHY
//   (degraded, never down); unconfigured/disabled accounts and a failing CLI call are gaps,
//   not findings.
// - diskFindings(): `df -Pk <dataDir>` against OC_WATCH_DISK_MIN_MB — degraded below the
//   threshold, down below 10% of it or 100 MB (whichever is higher); a failed or unparsable
//   `df` is DISK_UNKNOWN (degraded), never a silent ok and never down.
// - mergeFindings(): only ever escalates a base ok/degraded/down verdict, never downgrades it.

import { registerSecret } from "#framework/core/log.ts";
import { channelFindings, diskFindings, mergeFindings, parseDfAvailableKb, DISK_MIN_MB_ENV } from "#framework/watch/health.ts";
import type { WatchFinding } from "#framework/watch/health.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

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

// --- channelFindings(): only a configured, enabled account's own trouble is reported -------

function channelsCtx(channelAccounts: unknown, runOneOffOverride?: () => Promise<ExecResult>): Context {
  return {
    settings: { env: {} },
    runtime: {
      async runOneOff(): Promise<ExecResult> {
        if (runOneOffOverride !== undefined) return runOneOffOverride();
        return { code: 0, stdout: JSON.stringify({ channelAccounts }), stderr: "" };
      },
    },
  } as unknown as Context;
}

{
  const healthy = channelsCtx({
    telegram: [{ accountId: "default", enabled: true, configured: true, running: true, connected: true, lastError: null }],
  });
  check("a healthy, connected account produces no finding", await channelFindings(healthy), []);
}

{
  const notConfigured = channelsCtx({
    telegram: [{ accountId: "default", enabled: true, configured: false, running: false, connected: false }],
  });
  check("an unconfigured account is not a fault, whatever else it reports", await channelFindings(notConfigured), []);
}

{
  const disabled = channelsCtx({
    telegram: [{ accountId: "default", enabled: false, configured: true, running: false, connected: false }],
  });
  check("a deliberately disabled account is not a fault", await channelFindings(disabled), []);
}

{
  const notRunning = channelsCtx({
    telegram: [{ accountId: "default", enabled: true, configured: true, running: false }],
  });
  const findings = await channelFindings(notRunning);
  check("configured but not running -> one CHANNEL_UNHEALTHY finding", findings.length, 1);
  check("severity is degraded, never down", findings[0]?.level, "degraded");
  check("the code is CHANNEL_UNHEALTHY", findings[0]?.reason.code, "CHANNEL_UNHEALTHY");
  check("the detail names the channel/account and the fault", findings[0]?.reason.detail, "telegram/default: configured but not running");
}

{
  const errored = channelsCtx({
    telegram: [{ accountId: "default", enabled: true, configured: true, running: true, lastError: "auth failed: bad token" }],
  });
  const findings = await channelFindings(errored);
  check("a captured lastError with no connection state -> CHANNEL_UNHEALTHY", findings[0]?.reason.detail, "telegram/default: last error: auth failed: bad token");
  const recovered = channelsCtx({
    telegram: [{ accountId: "default", enabled: true, configured: true, running: true, connected: true, lastError: "auth failed: bad token" }],
  });
  check("a connected account is healthy despite a lingering lastError", (await channelFindings(recovered)).length, 0);
}

{
  const disconnected = channelsCtx({
    telegram: [{ accountId: "default", enabled: true, configured: true, running: true, connected: false, lastError: null }],
  });
  const findings = await channelFindings(disconnected);
  check("configured, running, but not connected -> CHANNEL_UNHEALTHY", findings[0]?.reason.detail, "telegram/default: configured but not connected");
}

{
  const LEAKED = "leaked-channel-secret-0123456789abcdef";
  registerSecret(LEAKED);
  const longError = `token rejected (auth=${LEAKED}) ${"detail ".repeat(60)}`;
  const errored = channelsCtx({
    telegram: [{ accountId: "default", enabled: true, configured: true, running: true, connected: false, lastError: longError }],
  });
  const findings = await channelFindings(errored);
  check("a registered secret in lastError is masked", findings[0]?.reason.detail.includes(LEAKED), false);
  check("the detail is capped rather than carrying the whole message", (findings[0]?.reason.detail.length ?? 0) <= 210, true);
}

{
  const failing = channelsCtx({}, async () => ({ code: 1, stdout: "", stderr: "cli refused" }));
  check("a failing CLI call is a gap, not a finding", await channelFindings(failing), []);
}

{
  const nonJson = channelsCtx({}, async () => ({ code: 0, stdout: "not json", stderr: "" }));
  check("a non-JSON answer is a gap, not a finding", await channelFindings(nonJson), []);
}

{
  const malformed = channelsCtx("not an object");
  check("a malformed channelAccounts shape is a gap, not a finding", await channelFindings(malformed), []);
}

// --- diskFindings(): degraded below the threshold, down below 10% of it or 100 MB -----------

function diskCtx(dfResult: (() => Promise<ExecResult>) | ExecResult, env: Record<string, string> = {}): Context {
  return {
    settings: { dataDir: "/srv/openclaw/data", env },
    transport: {
      async exec(command: string): Promise<ExecResult> {
        if (command !== "df") throw new Error(`unexpected command: ${command}`);
        return typeof dfResult === "function" ? dfResult() : dfResult;
      },
    },
  } as unknown as Context;
}

function dfOutput(availableKb: number): ExecResult {
  return {
    code: 0,
    stdout: `Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sdf        1055762868 26143892 ${availableKb}       3% /\n`,
    stderr: "",
  };
}

{
  check("plenty of free space -> no finding", await diskFindings(diskCtx(dfOutput(10 * 1024 * 1024))), []);
}

{
  // Default threshold 1024 MB, down bound max(102.4, 100) = 102.4 MB.
  const findings = await diskFindings(diskCtx(dfOutput(500 * 1024)));
  check("below the default threshold but above the down bound -> degraded DISK_LOW", findings[0]?.level, "degraded");
  check("the code is DISK_LOW", findings[0]?.reason.code, "DISK_LOW");
}

{
  const findings = await diskFindings(diskCtx(dfOutput(50 * 1024)));
  check("below the down bound -> down DISK_LOW", findings[0]?.level, "down");
}

{
  const findings = await diskFindings(diskCtx(dfOutput(5 * 1024), { [DISK_MIN_MB_ENV]: "50" }));
  // threshold 50 MB, 10% = 5 MB, floor 100 MB -> down bound is 100 MB, 5 MB is well below it.
  check("a low custom threshold still gets the 100 MB down floor", findings[0]?.level, "down");
}

{
  const findings = await diskFindings(diskCtx(dfOutput(2000), { [DISK_MIN_MB_ENV]: "2500" }));
  // threshold 2500 MB, available ~1.95 MB — far below even the down bound.
  check("a custom threshold is honored for degraded/down alike", findings[0]?.reason.detail.includes("2500 MB"), true);
}

{
  const failed = await diskFindings(diskCtx({ code: 1, stdout: "", stderr: "df: /srv/openclaw/data: No such file or directory" }));
  check("a failing df -> one finding", failed.length, 1);
  check("DISK_UNKNOWN, not a silent ok", failed[0]?.reason.code, "DISK_UNKNOWN");
  check("never down for a measurement failure", failed[0]?.level, "degraded");
}

{
  const thrown = await diskFindings(diskCtx(async () => { throw new Error("wsl.exe never answered"); }));
  check("a thrown transport error -> DISK_UNKNOWN, not a crash", thrown[0]?.reason.code, "DISK_UNKNOWN");
}

{
  const unparsable = await diskFindings(diskCtx({ code: 0, stdout: "not df output at all", stderr: "" }));
  check("unparsable df output -> DISK_UNKNOWN", unparsable[0]?.reason.code, "DISK_UNKNOWN");
}

// --- parseDfAvailableKb(): the POSIX -Pk shape, and its edges -------------------------------

{
  check(
    "the standard header + one data line",
    parseDfAvailableKb("Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sdf 100 10 90 10% /\n"),
    90,
  );
  check("header only, no data line -> undefined", parseDfAvailableKb("Filesystem 1024-blocks Used Available Capacity Mounted on\n"), undefined);
  check("empty output -> undefined", parseDfAvailableKb(""), undefined);
  check("too few fields -> undefined", parseDfAvailableKb("header\n/dev/sdf 100\n"), undefined);
}

// --- mergeFindings(): only ever escalates -----------------------------------------------

{
  const base = { level: "ok" as const, reasons: [] };
  check("no findings leaves ok as ok", mergeFindings(base, []), { level: "ok", reasons: [] });
}

{
  const base = { level: "ok" as const, reasons: [] };
  const finding: WatchFinding = { level: "degraded", reason: { code: "DISK_LOW", detail: "low" } };
  check("a degraded finding escalates ok -> degraded", mergeFindings(base, [finding]).level, "degraded");
}

{
  const base = { level: "ok" as const, reasons: [] };
  const finding: WatchFinding = { level: "down", reason: { code: "DISK_LOW", detail: "critical" } };
  check("a down finding escalates ok -> down", mergeFindings(base, [finding]).level, "down");
}

{
  const base = { level: "degraded" as const, reasons: [{ code: "EGRESS_UNREACHABLE", detail: "base" }] };
  const finding: WatchFinding = { level: "down", reason: { code: "DISK_LOW", detail: "critical" } };
  const merged = mergeFindings(base, [finding]);
  check("a down finding escalates degraded -> down", merged.level, "down");
  check("the base reason is kept alongside the new one", merged.reasons, [{ code: "EGRESS_UNREACHABLE", detail: "base" }, { code: "DISK_LOW", detail: "critical" }]);
}

{
  const base = { level: "down" as const, reasons: [{ code: "GATEWAY_DOWN", detail: "base" }] };
  const finding: WatchFinding = { level: "degraded", reason: { code: "CHANNEL_UNHEALTHY", detail: "extra" } };
  check("a degraded finding never downgrades an existing down", mergeFindings(base, [finding]).level, "down");
}

process.stderr.write(failed === 0 ? "all watch health checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
