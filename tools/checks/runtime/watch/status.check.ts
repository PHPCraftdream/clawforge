// `./clawforge watch status` — the persisted last state, when it last changed, whether a
// webhook/heartbeat is configured, the run diagnostics (last run, last error, an undelivered
// alert, staleness), and that a state file from before any of this existed still parses.
// Proves the one thing this action's task cares about most throughout: the URL itself never
// appears anywhere it can print, configured or not.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { watchStatus } from "#framework/commands/operate/watch/status.ts";
import { watchStateFile, writeWatchState } from "#framework/commands/operate/watch/state.ts";
import { DEFAULT_WATCH_INTERVAL_MINUTES } from "#framework/commands/operate/watch/install.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { registerSecret } from "#framework/core/io/log.ts";
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

/** Captured output is always the JSON envelope for this action (like inspect/doctor's own
 *  isCaptured() branch — see status.ts), whether or not --json was asked for. */
async function jsonOf(ctx: Context, args: string[]): Promise<{ text: string; parsed: Record<string, unknown> }> {
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => watchStatus(ctx, args));
  const text = written.join("");
  return { text, parsed: JSON.parse(text) as Record<string, unknown> };
}

/** Patches the raw writer directly, not withOutputSink: that helper makes isCaptured() true,
 *  which forces watchStatus's JSON branch regardless of args (same as inspect/doctor's own
 *  isCaptured() override) — not what a real terminal run is, and not what this is testing. */
async function textOf(ctx: Context, args: string[] = []): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: string): boolean => { out += chunk; return true; };
  try {
    await watchStatus(ctx, args);
  } finally {
    process.stderr.write = original;
  }
  return out;
}

const MARKER = "watch-status-secret-marker";
const WEBHOOK = `https://hooks.example/${MARKER}`;
const ENVELOPE_KEYS = [
  "level", "reasons", "checkedAt", "changedAt", "lastRunAt", "lastError", "alertPending",
  "intervalMinutes", "staleThresholdMinutes", "stale", "webhookConfigured", "heartbeatConfigured",
  "heartbeatAt", "heartbeatError",
];

check(
  "a bad argument is refused",
  (await deathOf(() => watchStatus({ settings: { env: {} } } as unknown as Context, ["--bogus"]))).includes("unknown argument: --bogus"),
  true,
);

const root = await mkdtemp(join(tmpdir(), "clawforge-watch-status-check-"));
useDeployment(root);

try {
  // --- no previous state: an honest "nothing yet", not a crash --------------------------

  {
    const { parsed } = await jsonOf({ settings: { env: {} } } as unknown as Context, ["--json"]);
    check("with nothing checked yet, level is null rather than a guess", parsed.level, null);
    check("webhook reads not-configured when unset", parsed.webhookConfigured, false);
    check("heartbeat reads not-configured when unset", parsed.heartbeatConfigured, false);
    check("no heartbeat ping has ever landed", parsed.heartbeatAt, null);
    check("no heartbeat error either", parsed.heartbeatError, null);
    check("no run has ever happened", parsed.lastRunAt, null);
    check("no error either", parsed.lastError, null);
    check("no alert pending", parsed.alertPending, null);
    check("no interval was ever recorded", parsed.intervalMinutes, null);
    check("never run is never reported as stale", parsed.stale, false);
    check("the default threshold is 3x the documented default interval", parsed.staleThresholdMinutes, DEFAULT_WATCH_INTERVAL_MINUTES * 3);

    const text = await textOf({ settings: { env: {} } } as unknown as Context);
    check("text mode says plainly that nothing has run yet", text.includes("no check has run yet"), true);
  }

  // --- a real state: level, both timestamps, every reason and the heartbeat fields ------

  const HEARTBEAT_MARKER = "watch-status-heartbeat-secret-marker";
  const HEARTBEAT_URL = `https://hb.example/${HEARTBEAT_MARKER}`;
  registerSecret(HEARTBEAT_URL);

  const now = new Date().toISOString();
  await writeWatchState({
    level: "degraded",
    reasons: [{ code: "PROVIDER_MISSING", detail: "no provider configured" }],
    checkedAt: now,
    changedAt: "2025-12-31T00:00:00.000Z",
    lastRunAt: now,
    heartbeatAt: now,
    heartbeatError: "heartbeat responded with 503",
  });

  {
    const { text, parsed } = await jsonOf(
      { settings: { env: { OC_WATCH_WEBHOOK: WEBHOOK, OC_WATCH_HEARTBEAT_URL: HEARTBEAT_URL } } } as unknown as Context,
      ["--json"],
    );
    check("reports the persisted level", parsed.level, "degraded");
    check("reports when it was last checked", parsed.checkedAt, now);
    check("reports when the level last changed — a DIFFERENT time than checkedAt", parsed.changedAt, "2025-12-31T00:00:00.000Z");
    check("reports the reason", parsed.reasons, [{ code: "PROVIDER_MISSING", detail: "no provider configured" }]);
    check("reports the webhook as configured", parsed.webhookConfigured, true);
    check("reports the heartbeat as configured", parsed.heartbeatConfigured, true);
    check("reports the last successful heartbeat ping", parsed.heartbeatAt, now);
    check("reports the last heartbeat error", parsed.heartbeatError, "heartbeat responded with 503");
    check("reports lastRunAt", parsed.lastRunAt, now);
    check("no error, nothing pending — a healthy cycle", [parsed.lastError, parsed.alertPending], [null, null]);
    check("a fresh run is never stale", parsed.stale, false);
    check("the webhook marker inside the URL never appears anywhere", text.includes(MARKER), false);
    check("nor the webhook's scheme+host either", text.includes("hooks.example"), false);
    check("the heartbeat marker inside its URL never appears anywhere either", text.includes(HEARTBEAT_MARKER), false);
    check("nor the heartbeat's scheme+host", text.includes("hb.example"), false);
    check("the envelope carries no field either URL itself could hide in", Object.keys(parsed), ENVELOPE_KEYS);
  }

  // --- unconfigured reads honestly too, against that same real state --------------------

  {
    const { parsed } = await jsonOf({ settings: { env: {} } } as unknown as Context, ["--json"]);
    check("webhook reads not-configured when unset, against a real prior state too", parsed.webhookConfigured, false);
    check("heartbeat reads not-configured when unset, against a real prior state too", parsed.heartbeatConfigured, false);
    check("the state itself is unaffected by whether the webhook/heartbeat is configured", parsed.level, "degraded");
    check("the last successful ping is still reported even when the heartbeat is now unconfigured", parsed.heartbeatAt, now);
  }

  // --- lastError / alertPending: surfaced in both text and JSON -------------------------

  {
    await writeWatchState({
      level: "ok",
      reasons: [],
      checkedAt: "2026-02-01T00:00:00.000Z",
      changedAt: "2026-02-01T00:00:00.000Z",
      lastRunAt: new Date().toISOString(),
      lastError: "webhook responded with 500",
      alertPending: { from: "ok", to: "down", since: "2026-02-01T00:05:00.000Z" },
    });
    const ctx = { settings: { env: {} } } as unknown as Context;
    const { parsed } = await jsonOf(ctx, ["--json"]);
    check("lastError is reported", parsed.lastError, "webhook responded with 500");
    check("alertPending names the transition and since", parsed.alertPending, { from: "ok", to: "down", since: "2026-02-01T00:05:00.000Z" });

    const text = await textOf(ctx);
    check("text mode warns about the last error", text.includes("last error: webhook responded with 500"), true);
    check(
      "text mode warns about the undelivered alert, naming the transition and since",
      text.includes("alert pending since 2026-02-01T00:05:00.000Z: ok → down"),
      true,
    );
  }

  // --- diagnostics-only state: a configuration error before any cycle ever completed ----

  {
    await writeWatchState({ lastRunAt: "2026-03-01T00:00:00.000Z", lastError: "OC_WATCH_WEBHOOK is not a valid URL" });
    const ctx = { settings: { env: {} } } as unknown as Context;
    const { parsed } = await jsonOf(ctx, ["--json"]);
    check("no level is fabricated", parsed.level, null);
    check("lastRunAt is still reported", parsed.lastRunAt, "2026-03-01T00:00:00.000Z");
    check("and the error that stopped it", parsed.lastError, "OC_WATCH_WEBHOOK is not a valid URL");

    const text = await textOf(ctx);
    check("text mode says there is no successful cycle yet, not that nothing ever ran", text.includes("no successful check cycle yet"), true);
    check("and still names when the last attempt ran", text.includes("2026-03-01T00:00:00.000Z"), true);
  }

  // --- staleness: compares lastRunAt against 3x the recorded (or default) interval ------

  {
    const old = new Date(Date.now() - 20 * 60_000).toISOString(); // 20 minutes ago
    await writeWatchState({
      level: "ok", reasons: [], checkedAt: old, changedAt: old, lastRunAt: old, intervalMinutes: 5,
    });
    const ctx = { settings: { env: {} } } as unknown as Context;
    const { parsed } = await jsonOf(ctx, ["--json"]);
    check("20 minutes since the last run, at a 5-minute interval (15-minute threshold), reads stale", parsed.stale, true);
    check("the threshold reflects the recorded interval, not the default", parsed.staleThresholdMinutes, 15);
    const text = await textOf(ctx);
    check("text mode warns about the stale run", text.includes("the scheduled check may not be"), true);
  }

  {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    await writeWatchState({
      level: "ok", reasons: [], checkedAt: old, changedAt: old, lastRunAt: old, intervalMinutes: 60,
    });
    const { parsed } = await jsonOf({ settings: { env: {} } } as unknown as Context, ["--json"]);
    check("the same 20-minute gap at a 60-minute interval (180-minute threshold) is not stale", parsed.stale, false);
  }

  // --- backward compatibility: a state file from before this field existed still parses -

  {
    const legacy = { level: "ok", reasons: [], checkedAt: "2020-05-01T00:00:00.000Z", changedAt: "2020-05-01T00:00:00.000Z" };
    await mkdir(dirname(watchStateFile()), { recursive: true });
    await writeFile(watchStateFile(), `${JSON.stringify(legacy)}\n`, "utf8");

    const ctx = { settings: { env: {} } } as unknown as Context;
    const { parsed } = await jsonOf(ctx, ["--json"]);
    check("a pre-diagnostics state file still reports its level", parsed.level, "ok");
    check("and its own checkedAt/changedAt", [parsed.checkedAt, parsed.changedAt], [legacy.checkedAt, legacy.changedAt]);
    check("lastRunAt falls back to checkedAt when the file never recorded one", parsed.lastRunAt, legacy.checkedAt);
    check("no diagnostics fields this old file never had are fabricated", [parsed.lastError, parsed.alertPending, parsed.intervalMinutes], [null, null, null]);
    check("a check this old reads as stale under the default threshold", parsed.stale, true);

    const text = await textOf(ctx);
    check("text mode renders a legacy file without crashing", text.includes("watch: ok"), true);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all watch status checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
