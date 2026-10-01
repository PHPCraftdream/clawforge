// runWatchCycle() under contention: a competing runner reports "busy" instead of delivering a
// duplicate or stale transition, and the cycle lock is only reclaimed from a provably stale owner.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatchCycle } from "#framework/commands/operate/watch/index.ts";
import type { WatchWebhookTarget } from "#framework/commands/operate/watch/webhook.ts";
import { watchStateFile, writeWatchState } from "#framework/commands/operate/watch/state.ts";
import type { WatchState } from "#framework/commands/operate/watch/state.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { START_TIME_TOLERANCE_MS, localLiveness, machineName, platformProbes } from "#framework/runtime/lock/process-identity.ts";
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
  const calls: { url: string; body: unknown }[] = [];
  let nextResponse: () => Response | Promise<Response> = () => new Response(null, { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return nextResponse();
  }) as typeof fetch;

  const MARKER = "watch-check-secret-marker";
  const webhookUrl = new URL(`https://hooks.example/${MARKER}`);
  const webhookTarget: WatchWebhookTarget = { url: webhookUrl, format: "generic" };
  // Controlled runners hold the first POST while a second cycle attempts the same history.
  {
    await writeWatchState({ level: "ok", reasons: [] });
    calls.length = 0;
    let entered!: () => void;
    let release!: () => void;
    const posting = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    nextResponse = async () => { entered(); await barrier; return new Response(null, { status: 200 }); };
    const first = deathOf(() => runWatchCycle(webhookTarget, "down", [{ code: "GATEWAY_DOWN", detail: "offline" }], false));
    await posting;
    try {
      const busy = await deathOf(() => runWatchCycle(webhookTarget, "down", [{ code: "GATEWAY_DOWN", detail: "offline" }], false));
      check("a competing runner reports contention rather than a stale transition", busy.includes("watch cycle busy"), true);
      check("the competing runner cannot deliver a duplicate alert", calls.length, 1);
    } finally { release(); }
    await first;
    nextResponse = () => new Response(null, { status: 200 });
    await deathOf(() => runWatchCycle(webhookTarget, "down", [{ code: "GATEWAY_DOWN", detail: "offline" }], false));
    check("a later identical cycle still does not alert", calls.length, 1);
    const down = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("the serialized history is consistently down with no pending alert", [down.level, down.alertPending], ["down", undefined]);
    await runWatchCycle(webhookTarget, "ok", [], false);
    await runWatchCycle(webhookTarget, "ok", [], false);
    check("recovery sends exactly one additional transition alert", calls.length, 2);
    nextResponse = () => new Response(null, { status: 503 });
    await deathOf(() => runWatchCycle(webhookTarget, "down", [{ code: "GATEWAY_DOWN", detail: "offline again" }], false));
    const failed = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    await deathOf(() => runWatchCycle(webhookTarget, "down", [{ code: "GATEWAY_DOWN", detail: "offline again" }], false));
    const retry = JSON.parse(await readFile(watchStateFile(), "utf8")) as WatchState;
    check("delivery retries keep the original transition and failure start", [retry.level, retry.alertPending?.since, retry.alertPending?.toCodes], ["ok", failed.alertPending?.since, ["GATEWAY_DOWN"]]);
    nextResponse = () => new Response(null, { status: 200 });
  }
  {
    const lock = `${watchStateFile()}.lock`;
    await mkdir(lock);
    const unknownOwner = join(lock, "unknown.json");
    await writeFile(unknownOwner, JSON.stringify({ pid: process.pid, machine: "foreign-host" }));
    const refused = await deathOf(() => runWatchCycle(undefined, "ok", [], true));
    check("unknown/foreign owner is not reclaimed", refused.includes("watch cycle busy"), true);
    check("unknown owner record remains intact", JSON.parse(await readFile(unknownOwner, "utf8")).machine, "foreign-host");
    await rm(lock, { recursive: true });
    await mkdir(lock);
    await writeFile(join(lock, "reused.json"), JSON.stringify({ pid: process.pid, machine: machineName(), startedAt: "2000-01-01T00:00:00.000Z" }));
    const originalProbe = platformProbes.processStartedAt;
    platformProbes.processStartedAt = async () => "2026-01-01T00:00:00.000Z";
    try {
      await runWatchCycle(undefined, "ok", [], true);
      check("provably stale PID identity permits the next completed cycle", JSON.parse(await readFile(watchStateFile(), "utf8")).level, "ok");
    } finally { platformProbes.processStartedAt = originalProbe; }
    // The newly acquired lock was released: a subsequent invocation can publish too.
    await runWatchCycle(undefined, "ok", [], true);
  }

  // The 15 s start-time tolerance is the reuse/jitter compromise: probe drift just under it
  // must read the owner alive, just over it must not.
  {
    const actual = new Date().toISOString();
    const originalProbe = platformProbes.processStartedAt;
    platformProbes.processStartedAt = async () => actual;
    try {
      const near = (delta: number) =>
        ({ pid: process.pid, machine: machineName(), startedAt: new Date(Date.parse(actual) + delta).toISOString() });
      check("probe drift just under the tolerance reads alive", await localLiveness(near(-(START_TIME_TOLERANCE_MS - 2000))), "alive");
      check("probe drift just over the tolerance reads dead", await localLiveness(near(-(START_TIME_TOLERANCE_MS + 2000))), "dead");
    } finally { platformProbes.processStartedAt = originalProbe; }
  }
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
finish("watch check cycle lock");
