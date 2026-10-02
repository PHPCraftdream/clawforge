// Runs every *.check.ts under tools/checks, or a filtered subset of it — each as its own
// child process (kit/spawn.ts), with bounded parallelism. These need no instance, no target
// and no network: they cover the parts of the framework where a mistake is silent — path
// translation, archive safety, the argument contract, the composition of a deployment.
// `./clawforge smoke` covers a live instance instead.

import { availableParallelism } from "node:os";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { reportError } from "#framework/core/io/log.ts";
import { emit } from "#framework/core/io/output.ts";
import { discoverChecks, selectChecks, splitExclusive, type LabeledCheck } from "./discover.ts";
import { runCheckFile, runProcess, type CheckResult } from "./spawn.ts";
import { CapabilityProbe, isCapability, type Capability } from "./capabilities/capabilities.ts";
import { gateFor, parseCaseSkips, parseRequireList, skipLine, summaryLine } from "./capabilities/gate.ts";

export { selectChecks } from "./discover.ts";

export interface RunChecksOptions {
  /** Substrings a check's relative path must contain at least one of. Every check when empty. */
  readonly filters?: readonly string[];
  /** Print the matching paths instead of running them. */
  readonly list?: boolean;
  /** Concurrent check-file processes. Defaults to OC_CHECK_JOBS, else min(4, cores/2), at least 1. */
  readonly jobs?: number;
  /** Capabilities (docker, wsl, posix-sh, rsync, linux-host, windows-host, ssh-loopback, gnu-userland, bash, pwsh) whose
   *  absence must fail a file that requires them, instead of skipping it — merged with
   *  OC_CHECK_REQUIRE. */
  readonly require?: readonly string[];
}

function defaultJobs(): number {
  const fromEnv = Number(process.env.OC_CHECK_JOBS ?? "");
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

// --- the checkout is left as the run found it (R33-02) ----------------------------------------

export interface CheckoutSnapshot {
  readonly apps: readonly string[];
  /** `git status --porcelain`, empty when git is unavailable (then it is not compared). */
  readonly gitStatus: string | undefined;
}

export function diffSnapshots(before: CheckoutSnapshot, after: CheckoutSnapshot): readonly string[] {
  const changes: string[] = [];
  const appeared = after.apps.filter((name) => !before.apps.includes(name));
  const disappeared = before.apps.filter((name) => !after.apps.includes(name));
  if (appeared.length > 0) changes.push(`apps/ gained: ${appeared.join(", ")}`);
  if (disappeared.length > 0) changes.push(`apps/ lost: ${disappeared.join(", ")}`);
  if (before.gitStatus !== undefined && after.gitStatus !== undefined && before.gitStatus !== after.gitStatus) {
    const beforeLines = new Set(before.gitStatus.split("\n"));
    const afterLines = new Set(after.gitStatus.split("\n"));
    const gained = [...afterLines].filter((line) => line !== "" && !beforeLines.has(line)).sort();
    const lost = [...beforeLines].filter((line) => line !== "" && !afterLines.has(line)).sort();
    for (const line of gained) changes.push(`git status gained: ${line}`);
    for (const line of lost) changes.push(`git status lost: ${line}`);
  }
  return changes;
}

async function snapshotCheckout(): Promise<CheckoutSnapshot> {
  let apps: string[] = [];
  try {
    apps = (await readdir(resolve(monorepoRoot, "apps"), { withFileTypes: true })).map((entry) => entry.name).sort();
  } catch {
    apps = [];
  }
  // Ignored output (dist/ rebuilds, scratch prefixes) never shows in --porcelain; an absent
  // git only means the comparison is skipped, with a visible note below.
  const git = await runProcess("git", ["status", "--porcelain"], { cwd: monorepoRoot, timeoutMs: 30_000 });
  return { apps, gitStatus: git.error === undefined ? git.stdout : undefined };
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
  let skippedFiles = 0;
  const skippedByCapability = new Map<Capability, number>();
  const report = (result: Outcome): void => {
    if (result.skipped !== undefined) {
      skippedFiles += 1;
      for (const capability of result.skipped) skippedByCapability.set(capability, (skippedByCapability.get(capability) ?? 0) + 1);
      process.stderr.write(skipLine(result.label, result.skipped));
      return;
    }
    process.stderr.write(`\n${result.label}\n`);
    process.stderr.write(result.output);
    // A ran file's own case-level skips count toward the same breakdown as file-level ones.
    for (const skip of parseCaseSkips(result.output)) {
      for (const capability of skip.capabilities) skippedByCapability.set(capability, (skippedByCapability.get(capability) ?? 0) + 1);
    }
    if (!result.ok) {
      failed += 1;
      process.stderr.write(`  FAIL ${result.label}${result.reason === undefined ? "" : ` — ${result.reason}`}\n`);
    }
  };
  // Exclusive files (see discover.ts) run alone once the parallel pool has drained. A file
  // whose requirement is unmet is never started, in either group.
  const probe = new CapabilityProbe();
  const run = (entry: LabeledCheck): Promise<Outcome> => runEntry(entry, probe, forced);
  const before = await snapshotCheckout();
  const { pooled, alone } = splitExclusive(selected);
  await runPooled(pooled, jobs, run, report);
  await runPooled(alone, 1, run, report);
  const after = await snapshotCheckout();
  const changed = diffSnapshots(before, after);
  if (before.gitStatus === undefined || after.gitStatus === undefined) {
    process.stderr.write("  note: git unavailable — the checkout was not compared against the pre-run snapshot\n");
  }
  if (changed.length > 0) {
    failed += 1;
    process.stderr.write(`  FAIL the run changed the checkout\n    ${changed.join("\n    ")}\n`);
  }

  process.stderr.write(summaryLine(selected.length - skippedFiles, failed, skippedByCapability));
  return failed === 0 ? 0 : 1;
}
