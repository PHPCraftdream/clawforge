// runWatchCycle()'s heartbeat parameter: the dead-man's switch is pinged only while THIS
// cycle's own level reads ok, a failed ping never changes level/exit, and the URL never leaks
// into anything this could print.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatchCycle } from "#framework/commands/operate/watch/index.ts";
import { watchStateFile, writeWatchState } from "#framework/commands/operate/watch/state.ts";
import type { WatchState } from "#framework/commands/operate/watch/state.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { registerSecret } from "#framework/core/io/log.ts";
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
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
finish("watch check cycle heartbeat");
