// Runs every *.check.ts under tools/checks, or a filtered subset of it — each as its own
// child process (kit/spawn.ts), with bounded parallelism. These need no instance, no target
// and no network: they cover the parts of the framework where a mistake is silent — path
// translation, archive safety, the argument contract, the composition of a deployment.
// `./clawforge smoke` covers a live instance instead.

import { availableParallelism } from "node:os";
import { createHash } from "node:crypto";
import { readdir, readlink, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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

/** One path below apps/: a file with its size and (when small enough) content hash, or a
 *  directory marker — a deleted directory would otherwise be invisible to the walk. */
export interface AppsEntry {
  /** Path relative to apps/, forward slashes, "" for the root itself (never recorded). */
  readonly path: string;
  readonly directory?: true;
  readonly size?: number;
  /** sha256 of the content, only for files up to the {@link hashCapBytes} cap. */
  readonly hash?: string;
  /** Target string of a symlink or Windows junction entry, read without following the link. */
  readonly link?: string;
}

/** Files larger than this are sized but not hashed — snapshots stay cheap on big outputs. */
const hashCapBytes = 64 * 1024;

function kindOf(entry: AppsEntry): string {
  if (entry.link !== undefined) return `link ${entry.link}`;
  return entry.directory === true ? "dir" : `${entry.size}B${entry.hash === undefined ? "" : ` ${entry.hash.slice(0, 8)}`}`;
}

export interface CheckoutSnapshot {
  readonly apps: readonly AppsEntry[];
  /** `git status --porcelain`, empty when git is unavailable (then it is not compared). */
  readonly gitStatus: string | undefined;
  /** The ignored (`!!`) entries of `git status --porcelain --ignored=matching`, generated
   *  roots pruned; undefined when git is unavailable (not compared either). --porcelain
   *  cannot see ignored space — .claude/, secrets/, data/, *.token — exactly where a check
   *  that dies mid-write would leave its fixture behind, unnoticed. */
  readonly ignoredStatus: string | undefined;
}

// Ignored space the guard does not chase: node_modules and tools/framework/dist are build
// output a check may regenerate mid-run, apps/ is the deployment tree the walk above already
// covers, and worktrees/ holds whole sibling checkouts on hosts that have one. The excludes
// prune before git walks, so the ignored pass stays as cheap as the tracked one.
const IGNORED_STATUS_EXCLUDES = ["node_modules", "apps", "worktrees", "tools/framework/dist"];

function diffStatusLines(before: string, after: string, prefix: string): readonly string[] {
  const beforeLines = new Set(before.split("\n"));
  const afterLines = new Set(after.split("\n"));
  const gained = [...afterLines].filter((line) => line !== "" && !beforeLines.has(line)).sort();
  const lost = [...beforeLines].filter((line) => line !== "" && !afterLines.has(line)).sort();
  return [...gained.map((line) => `${prefix}gained: ${line}`), ...lost.map((line) => `${prefix}lost: ${line}`)];
}

function diffEntries(before: readonly AppsEntry[], after: readonly AppsEntry[]): readonly string[] {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const gained: string[] = [];
  const lost: string[] = [];
  const changed: string[] = [];
  for (const [path, entry] of afterByPath) {
    const was = beforeByPath.get(path);
    if (was === undefined) {
      gained.push(path);
      continue;
    }
    const beforeKind = kindOf(was);
    const afterKind = kindOf(entry);
    if (beforeKind !== afterKind) changed.push(`${path} (${beforeKind} → ${afterKind})`);
  }
  for (const path of beforeByPath.keys()) if (!afterByPath.has(path)) lost.push(path);
  const changes: string[] = [];
  if (gained.length > 0) changes.push(`apps/ gained: ${gained.sort().join(", ")}`);
  if (lost.length > 0) changes.push(`apps/ lost: ${lost.sort().join(", ")}`);
  if (changed.length > 0) changes.push(`apps/ changed: ${changed.sort().join(", ")}`);
  return changes;
}

export function diffSnapshots(before: CheckoutSnapshot, after: CheckoutSnapshot): readonly string[] {
  const changes = [...diffEntries(before.apps, after.apps)];
  if (before.gitStatus !== undefined && after.gitStatus !== undefined && before.gitStatus !== after.gitStatus) {
    changes.push(...diffStatusLines(before.gitStatus, after.gitStatus, "git status "));
  }
  if (before.ignoredStatus !== undefined && after.ignoredStatus !== undefined && before.ignoredStatus !== after.ignoredStatus) {
    changes.push(...diffStatusLines(before.ignoredStatus, after.ignoredStatus, "git ignored "));
  }
  return changes;
}

// Recursively lists everything below `root` (default: the real checkout's apps/), so a write
// INSIDE an existing app — invisible to top-level names and to --porcelain — is still caught.
export async function snapshotCheckout(root: string = resolve(monorepoRoot, "apps")): Promise<CheckoutSnapshot> {
  const apps: AppsEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // absent root or unreadable subdir records nothing
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = relative(root, join(dir, entry.name)).split("\\").join("/");
      if (entry.isSymbolicLink()) {
        apps.push({ path: rel, link: await readlink(join(dir, entry.name)) }); // recorded by target, never followed: no recursion, no cycles
      } else if (entry.isDirectory()) {
        apps.push({ path: rel, directory: true });
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const size = (await stat(join(dir, entry.name))).size;
        const file: AppsEntry = { path: rel, size, ...(size <= hashCapBytes ? { hash: createHash("sha256").update(await readFile(join(dir, entry.name))).digest("hex") } : {}) };
        apps.push(file);
      }
    }
  };
  await walk(root);
  // Ignored output (dist/ rebuilds, scratch prefixes) never shows in --porcelain; an absent
  // git only means the comparison is skipped, with a visible note below.
  const git = await runProcess("git", ["status", "--porcelain"], { cwd: monorepoRoot, timeoutMs: 30_000 });
  const ignored = await runProcess(
    "git",
    ["status", "--porcelain", "--ignored=matching", "--", ...IGNORED_STATUS_EXCLUDES.map((entry) => `:(exclude)${entry}`)],
    { cwd: monorepoRoot, timeoutMs: 30_000 },
  );
  // Only the ignored entries: the tracked and untracked halves are gitStatus's story, and
  // a file changing mid-run must not be reported twice by one guard. The pathspec excludes
  // prune the walk, but git still answers with one collapsed line for a wholly-ignored
  // directory — dropped here too, so a pruned root can never read as a new leftover.
  const ignoredEntries = ignored.error === undefined
    ? ignored.stdout
      .split("\n")
      .filter((line) => line.startsWith("!!") && !IGNORED_STATUS_EXCLUDES.some((root) => line.startsWith("!! " + root + "/")))
      .join("\n")
    : undefined;
  return { apps, gitStatus: git.error === undefined ? git.stdout : undefined, ignoredStatus: ignoredEntries };
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
