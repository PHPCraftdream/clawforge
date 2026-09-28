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
import { CapabilityProbe, isCapability, type Capability } from "./capabilities/capabilities.ts";
import { gateFor, parseRequireList, skipLine, summaryLine } from "./capabilities/gate.ts";

export { selectChecks } from "./discover.ts";

export interface RunChecksOptions {
  /** Substrings a check's relative path must contain at least one of. Every check when empty. */
  readonly filters?: readonly string[];
  /** Print the matching paths instead of running them. */
  readonly list?: boolean;
  /** Concurrent check-file processes. Defaults to OC_CHECK_JOBS, else min(4, cores/2), at least 1. */
  readonly jobs?: number;
  /** Capabilities (docker, wsl, posix-sh, rsync, linux-host) whose absence must fail a file
   *  that requires them, instead of skipping it — merged with OC_CHECK_REQUIRE. */
  readonly require?: readonly string[];
}

function defaultJobs(): number {
  const fromEnv = Number(process.env.OC_CHECK_JOBS ?? "");
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

/** The outcome of deciding + (maybe) running one entry: `skipped` names why when the file was
 *  never started; its absence means the file ran (or was failed outright by --require). */
type Outcome = CheckResult & { readonly skipped?: readonly Capability[] };

/** Probes `entry.requires` once, then runs, skips or fails it — a file whose requirement is
 *  unmet is never spawned at all. */
async function runEntry(entry: LabeledCheck, probe: CapabilityProbe, forced: ReadonlySet<Capability>): Promise<Outcome> {
  const missing = await probe.missing(entry.requires);
  const gate = gateFor(missing, forced);
  if (gate.kind === "run") return runCheckFile(entry.file, entry.label);
  if (gate.kind === "skip") return { label: entry.label, ok: true, output: "", durationMs: 0, skipped: gate.missing };
  return { label: entry.label, ok: false, output: "", durationMs: 0, reason: `unmet requirement: ${gate.missing.join(", ")}` };
}

/** Runs `entries` with `jobs` concurrent workers. Results settle out of order but `onReady`
 *  fires in `entries` order — as soon as an entry's predecessors have all fired — so output
 *  stays deterministic across runs while work still overlaps. */
async function runPooled(
  entries: readonly LabeledCheck[],
  jobs: number,
  run: (entry: LabeledCheck) => Promise<Outcome>,
  onReady: (result: Outcome) => void,
): Promise<void> {
  const results: Outcome[] = Array.from({ length: entries.length });
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
      results[index] = await run(entries[index]);
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

  let forced: Set<Capability>;
  try {
    forced = new Set([
      ...parseRequireList(options.require?.join(","), isCapability),
      ...parseRequireList(process.env.OC_CHECK_REQUIRE, isCapability),
    ]);
  } catch (error) {
    reportError((error as Error).message);
    return 1;
  }

  await sweepOrphanedCheckDeployments();

  const labeled = await discoverChecks();
  const matching = new Set(selectChecks(labeled.map((entry) => entry.label), filters));
  const selected = labeled.filter((entry) => matching.has(entry.label));

  if (selected.length === 0 && filters.length > 0) {
    reportError(`no check matches: ${filters.join(", ")}`);
    return 1;
  }

  if (list) {
    for (const entry of selected) {
      emit(entry.requires.length === 0 ? `${entry.label}\n` : `${entry.label} (requires: ${entry.requires.join(", ")})\n`);
    }
    return 0;
  }

  let failed = 0;
  const skippedByCapability = new Map<Capability, number>();
  let skippedTotal = 0;
  const report = (result: Outcome): void => {
    if (result.skipped !== undefined) {
      skippedTotal += 1;
      for (const capability of result.skipped) skippedByCapability.set(capability, (skippedByCapability.get(capability) ?? 0) + 1);
      process.stderr.write(skipLine(result.label, result.skipped));
      return;
    }
    process.stderr.write(`\n${result.label}\n`);
    process.stderr.write(result.output);
    if (!result.ok) {
      failed += 1;
      process.stderr.write(`  FAIL ${result.label}${result.reason === undefined ? "" : ` — ${result.reason}`}\n`);
    }
  };
  // Exclusive files (see discover.ts) run alone once the parallel pool has drained. A file
  // whose requirement is unmet is never started, in either group.
  const probe = new CapabilityProbe();
  const run = (entry: LabeledCheck): Promise<Outcome> => runEntry(entry, probe, forced);
  const { pooled, alone } = splitExclusive(selected);
  await runPooled(pooled, jobs, run, report);
  await runPooled(alone, 1, run, report);

  process.stderr.write(summaryLine(selected.length - skippedTotal, failed, skippedByCapability));
  return failed === 0 ? 0 : 1;
}
