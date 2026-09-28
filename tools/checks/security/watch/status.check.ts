// `./clawforge watch status` — the persisted last state, when it last changed, and whether a
// webhook is configured. Proves the one thing this action's task cares about most: the URL
// itself never appears anywhere it can print, configured or not.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchStatus } from "#framework/watch/status.ts";
import { writeWatchState } from "#framework/watch/state.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { registerSecret } from "#framework/core/log.ts";
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

const MARKER = "watch-status-secret-marker";
const WEBHOOK = `https://hooks.example/${MARKER}`;

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
  }

  // --- a real state: level, both timestamps, every reason and the heartbeat fields ------

  const HEARTBEAT_MARKER = "watch-status-heartbeat-secret-marker";
  const HEARTBEAT_URL = `https://hb.example/${HEARTBEAT_MARKER}`;
  registerSecret(HEARTBEAT_URL);

  await writeWatchState({
    level: "degraded",
    reasons: [{ code: "PROVIDER_MISSING", detail: "no provider configured" }],
    checkedAt: "2026-01-01T00:00:00.000Z",
    changedAt: "2025-12-31T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    heartbeatError: "heartbeat responded with 503",
  });

  {
    const { text, parsed } = await jsonOf(
      { settings: { env: { OC_WATCH_WEBHOOK: WEBHOOK, OC_WATCH_HEARTBEAT_URL: HEARTBEAT_URL } } } as unknown as Context,
      ["--json"],
    );
    check("reports the persisted level", parsed.level, "degraded");
    check("reports when it was last checked", parsed.checkedAt, "2026-01-01T00:00:00.000Z");
    check("reports when the level last changed — a DIFFERENT time than checkedAt", parsed.changedAt, "2025-12-31T00:00:00.000Z");
    check("reports the reason", parsed.reasons, [{ code: "PROVIDER_MISSING", detail: "no provider configured" }]);
    check("reports the webhook as configured", parsed.webhookConfigured, true);
    check("reports the heartbeat as configured", parsed.heartbeatConfigured, true);
    check("reports the last successful heartbeat ping", parsed.heartbeatAt, "2026-01-01T00:00:00.000Z");
    check("reports the last heartbeat error", parsed.heartbeatError, "heartbeat responded with 503");
    check("the webhook marker inside the URL never appears anywhere", text.includes(MARKER), false);
    check("nor the webhook's scheme+host either", text.includes("hooks.example"), false);
    check("the heartbeat marker inside its URL never appears anywhere either", text.includes(HEARTBEAT_MARKER), false);
    check("nor the heartbeat's scheme+host", text.includes("hb.example"), false);
    check(
      "the envelope carries no field either URL itself could hide in",
      Object.keys(parsed),
      ["level", "reasons", "checkedAt", "changedAt", "webhookConfigured", "heartbeatConfigured", "heartbeatAt", "heartbeatError"],
    );
  }

  // --- unconfigured reads honestly too, against that same real state --------------------

  {
    const { parsed } = await jsonOf({ settings: { env: {} } } as unknown as Context, ["--json"]);
    check("webhook reads not-configured when unset, against a real prior state too", parsed.webhookConfigured, false);
    check("heartbeat reads not-configured when unset, against a real prior state too", parsed.heartbeatConfigured, false);
    check("the state itself is unaffected by whether the webhook/heartbeat is configured", parsed.level, "degraded");
    check("the last successful ping is still reported even when the heartbeat is now unconfigured", parsed.heartbeatAt, "2026-01-01T00:00:00.000Z");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all watch status checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
