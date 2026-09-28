// Runs every *.check.ts under tools/checks, or a filtered subset of it — each as its own
// child process (kit/spawn.ts), with bounded parallelism. These need no instance, no target
// and no network: they cover the parts of the framework where a mistake is silent — path
// translation, archive safety, the argument contract, the composition of a deployment.
// `./clawforge smoke` covers a live instance instead.

import { availableParallelism } from "node:os";
import { reportError } from "#framework/core/io/log.ts";
import { emit } from "#framework/core/io/output.ts";
import { discoverChecks, selectChecks, splitExclusive, sweepOrphanedCheckDeployments, type LabeledCheck } from "./discover.ts";
import { runCheckFile, type CheckResult } from "./spawn.ts";

export { selectChecks } from "./discover.ts";

export interface RunChecksOptions {
  /** Substrings a check's relative path must contain at least one of. Every check when empty. */
  readonly filters?: readonly string[];
  /** Print the matching paths instead of running them. */
  readonly list?: boolean;
  /** Concurrent check-file processes. Defaults to OC_CHECK_JOBS, else min(4, cores/2), at least 1. */
  readonly jobs?: number;
}

function defaultJobs(): number {
  const fromEnv = Number(process.env.OC_CHECK_JOBS ?? "");
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

/** Runs `entries` with `jobs` concurrent workers. Results settle out of order but `onReady`
 *  fires in `entries` order — as soon as an entry's predecessors have all fired — so output
 *  stays deterministic across runs while work still overlaps. */
async function runPooled(entries: readonly LabeledCheck[], jobs: number, onReady: (result: CheckResult) => void): Promise<void> {
  const results: CheckResult[] = Array.from({ length: entries.length });
  const done: boolean[] = Array.from({ length: entries.length }, () => false);
  let printCursor = 0;

  function drain(): void {
    while (printCursor < entries.length && done[printCursor]) {
      onReady(results[printCursor]);
      printCursor += 1;
    }
  }

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= entries.length) return;
      results[index] = await runCheckFile(entries[index].file, entries[index].label);
      done[index] = true;
      drain();
    }
  }

  const workerCount = Math.max(1, Math.min(jobs, entries.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

export async function runChecks(options: RunChecksOptions = {}): Promise<number> {
  const filters = options.filters ?? [];
  const list = options.list ?? false;
  const jobs = options.jobs ?? defaultJobs();

  await sweepOrphanedCheckDeployments();

  const labeled = await discoverChecks();
  const matching = new Set(selectChecks(labeled.map((entry) => entry.label), filters));
  const selected = labeled.filter((entry) => matching.has(entry.label));

  if (selected.length === 0 && filters.length > 0) {
    reportError(`no check matches: ${filters.join(", ")}`);
    return 1;
  }

  if (list) {
    for (const entry of selected) emit(`${entry.label}\n`);
    return 0;
  }

  let failed = 0;
  const report = (result: CheckResult): void => {
    process.stderr.write(`\n${result.label}\n`);
    process.stderr.write(result.output);
    if (!result.ok) {
      failed += 1;
      process.stderr.write(`  FAIL ${result.label}${result.reason === undefined ? "" : ` — ${result.reason}`}\n`);
    }
  };
  // Exclusive files (see discover.ts) run alone once the parallel pool has drained.
  const { pooled, alone } = splitExclusive(selected);
  await runPooled(pooled, jobs, report);
  await runPooled(alone, 1, report);

  process.stderr.write(
    failed === 0
      ? `\n${selected.length} check file(s) passed\n`
      : `\n${failed} of ${selected.length} check file(s) failed\n`,
  );
  return failed === 0 ? 0 : 1;
}
