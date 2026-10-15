// A failed or timed-out call on a local-only-cancellation transport (SSH) may leave the
// remote command running, so teardown on the ORDINARY failure path (no signal) waits the
// remote watchdog out before any destructive cleanup. A confirmed-local transport, or a
// mutation that completed, waits for nothing.

import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { withTeardown } from "#framework/commands/management/recipe/recovery/trial/teardown.ts";
import { withOutputSink } from "#framework/core/io/output.ts";

const WAIT_MS = 150;
const TARGETS = { project: "failure-wait", home: "/tmp/failure-wait", envFile: "", overrideFile: "", pinnedFile: "", dataDir: "", definitionFile: "" };

async function run(leftoverMs: number): Promise<{ cleanupAfterMs: number; rejected: boolean; noticed: boolean }> {
  const started = Date.now();
  let cleanupAt = 0;
  let noticed = false;
  let rejected = false;
  await withOutputSink(() => {}, async () => {
    try {
      await withTeardown(TARGETS, async (register) => {
        register({ name: "cleanup", run: async () => { cleanupAt = Date.now(); } });
        throw new Error("mutation failed");
      }, undefined, 1000, "local-only", () => false, () => undefined, () => { noticed = true; }, () => leftoverMs);
    } catch {
      rejected = true;
    }
  });
  return { cleanupAfterMs: cleanupAt - started, rejected, noticed };
}

const waited = await run(WAIT_MS);
checkTrue("the original failure is still raised", waited.rejected);
checkTrue("cleanup waited out the remote watchdog", waited.cleanupAfterMs >= WAIT_MS - 10);
checkTrue("the wait is announced", waited.noticed);

const immediate = await run(0);
checkTrue("with nothing possibly running, cleanup does not wait", immediate.cleanupAfterMs < WAIT_MS);
check("no notice when nothing is waited for", immediate.noticed, false);

finish("trial failure-path remote wait");
