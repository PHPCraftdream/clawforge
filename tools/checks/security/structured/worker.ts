import { appendPrivateJournal, PrivateDataError } from "#framework/security/privacy/private-config.ts";
import { withInstanceLock } from "#framework/runtime/lock/instance-lock.ts";
import { diagnosticTransport, diskLocks, errorReport } from "./diagnostics.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import type { Context } from "#framework/core/context.ts";
const [root, writer] = process.argv.slice(2);
useRecipesDir(`${root}/recipes`);
const diagnostic = diagnosticTransport();
const ctx = { settings: { dataDir: root, env: {} }, transport: diagnostic.transport } as unknown as Context;
const observations: Array<Record<string, unknown>> = [];
const accepted: number[] = [];
const attempts: Array<{ index: number; attempts: number; elapsedMs: number; lastError?: string }> = [];
for (let index = 0; index < 3; index++) {
  // Native lock ownership includes shell-backed gating, publication and release.
  // Bound elapsed retry time, not a small attempt count; never silently skip a record.
  const started = performance.now();
  const deadline = started + 30_000;
  let count = 0;
  let lastError: string | undefined;
  do {
    count++;
    try {
      await withInstanceLock(ctx, "u5-worker", `u5-${writer}-${index}-${count}`, {}, async () => {
        await appendPrivateJournal(ctx, `${root}/vault/concurrent.jsonl`, { writer, index });
      });
      accepted.push(index);
      observations.push({ index, phase: "after-accepted-release", disk: await diskLocks(ctx) });
      break;
    } catch (error) {
      // Acquisition errors stay raw outside append's content-free error boundary.
      if (error instanceof PrivateDataError && !["io", "busy"].includes(error.code)) throw error;
      lastError = `${error instanceof PrivateDataError ? error.code : "raw-lock"}: ${error instanceof Error ? error.message : String(error)}`;
      if (count === 1) observations.push({ index, phase: "first-failure", error: errorReport(error), disk: await diskLocks(ctx), transport: diagnostic.report() });
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(30, remaining)));
    }
  } while (performance.now() < deadline);
  if (!accepted.includes(index)) observations.push({ index, phase: "exhausted", lastError, disk: await diskLocks(ctx), transport: diagnostic.report() });
  attempts.push({ index, attempts: count, elapsedMs: Math.round(performance.now() - started), lastError });
}
process.stdout.write(JSON.stringify({ writer, accepted, attempts, observations, transport: diagnostic.report(), finalDisk: await diskLocks(ctx) }));
