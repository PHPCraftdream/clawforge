// Runs one check file as its own child process: two files never share a module registry, an
// env mutation, or the useDeployment() singleton — a leak in one cannot reach another. A
// fixture that stands in for the host (useLinuxHost) still works: it mutates this child's own
// process.env.NODE_OPTIONS, which that child's own children (not its siblings) inherit.
// Also home of runProcess, the one helper the checks themselves use to spawn a child.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";

export interface CheckResult {
  readonly label: string;
  readonly ok: boolean;
  readonly output: string;
  readonly durationMs: number;
  /** Set only on a non-passing result: why, beyond "read the output above". */
  readonly reason?: string;
}

const TIMEOUT_MS = 15 * 60_000;

/** Spawns `file`, capturing stdout+stderr as one interleaved block in the order the child
 *  wrote it. Resolves — never rejects — with ok=false for a non-zero exit, a signal, a
 *  spawn failure, or exceeding the wall-clock guard. */
export function runCheckFile(file: string, label: string): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", file], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

    let settled = false;
    const finish = (result: Omit<CheckResult, "label" | "output" | "durationMs">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        label,
        output: Buffer.concat(chunks).toString("utf8"),
        durationMs: Date.now() - started,
        ...result,
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: `timed out after ${Math.round(TIMEOUT_MS / 60_000)} minutes` });
    }, TIMEOUT_MS);

    child.on("error", (error) => finish({ ok: false, reason: `failed to start: ${error.message}` }));
    child.on("close", (code, signal) => {
      if (signal !== null) finish({ ok: false, reason: `killed by ${signal}` });
      else if (code !== 0) finish({ ok: false, reason: `exited with code ${code}` });
      else finish({ ok: true });
    });
  });
}

/** Deadline for a child Node that loads the framework (a gate, an MCP server): it catches a
 *  hang, not a slow start — a cold start under parallel checks takes seconds, a hang forever. */
export const CHILD_NODE_DEADLINE_MS = 60_000;

export interface ProcessOptions {
  readonly cwd?: string;
  /** Defaults to this process's environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. Without it (and without keepStdinOpen) stdin is ignored. */
  readonly input?: string;
  /** stdin stays an open, never-written pipe: a server wrongly started blocks on it instead of seeing EOF. */
  readonly keepStdinOpen?: boolean;
  /** SIGKILL after this many ms and report timedOut; no limit when omitted. */
  readonly timeoutMs?: number;
  /** Defaults to true for a Windows `.cmd` (Node refuses to spawn one without a shell), else false. */
  readonly shell?: boolean;
}

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr interleaved in arrival order. */
  readonly output: string;
  readonly timedOut: boolean;
  /** Set when the process could not be started; its message is also appended to output. */
  readonly error?: Error;
}

/** Spawns `command`, collecting stdout, stderr and their interleaving. Never rejects. Under a
 *  shell the command stays unquoted — npm.cmd finds its own installation from %~dp0, and a
 *  quoted invocation sends it looking for npm-prefix.js beside the working directory — while an
 *  argument containing a space is quoted. */
export function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((settle) => {
    const shell = options.shell ?? (process.platform === "win32" && command.endsWith(".cmd"));
    const argv = shell ? args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)) : args;
    const wantsStdin = options.input !== undefined || options.keepStdinOpen === true;
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell,
      stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle({ code, stdout, stderr, output, timedOut, ...(error === undefined ? {} : { error }) });
    };

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      output += String(chunk);
    });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.on("error", (error) => {
      output += error.message;
      finish(null, error);
    });
    child.on("close", (code) => finish(code));
    // A child that exits before reading its input breaks the pipe; its exit already tells the story.
    child.stdin?.on("error", () => {});
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

// --- run-time telemetry (kit/timings, folded here: kit/ sits at the layout entry cap) ----------

export const TIMINGS_VERSION = 1;

/** Per-file sample cap — the store keeps only the most recent ones. */
export const SAMPLES_PER_FILE = 5;

export interface TimingSample {
  /** Epoch ms when the run that produced the sample finished. */
  readonly at: number;
  readonly ms: number;
  /** platform-arch-cpuCount — medians are only compared against the same class of host. */
  readonly host: string;
}

export interface TimingsFile {
  readonly version: typeof TIMINGS_VERSION;
  readonly files: Readonly<Record<string, readonly TimingSample[]>>;
}

export function hostId(platform: string, arch: string, cpus: number): string {
  return `${platform}-${arch}-${cpus}`;
}

/** Structural validation of untrusted file content: anything but exactly this schema
 *  (including a future version) reads as invalid, and the caller ignores + rewrites. */
export function isValidTimings(value: unknown): value is TimingsFile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== TIMINGS_VERSION) return false;
  if (typeof record.files !== "object" || record.files === null) return false;
  return Object.values(record.files).every((samples) =>
    Array.isArray(samples) &&
    samples.every((sample) => {
      if (typeof sample !== "object" || sample === null) return false;
      const entry = sample as Record<string, unknown>;
      return typeof entry.at === "number" && typeof entry.ms === "number" && typeof entry.host === "string";
    }),
  );
}

/** Folds fresh samples into existing per-file histories, keeping the last `cap` per file.
 *  A filtered run only names its own files, so every other file's history survives. */
export function mergeSamples(
  existing: Readonly<Record<string, readonly TimingSample[]>>,
  fresh: readonly (TimingSample & { readonly label: string })[],
  cap: number = SAMPLES_PER_FILE,
): Record<string, TimingSample[]> {
  const files: Record<string, TimingSample[]> = {};
  for (const [label, samples] of Object.entries(existing)) files[label] = [...samples];
  for (const { label, ...sample } of fresh) {
    files[label] = [...(files[label] ?? []), sample].slice(-cap);
  }
  return files;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface TimedFile {
  readonly label: string;
  readonly ms: number;
  /** This file's median over the serial sum of all medians. */
  readonly share: number;
}

/** Medians per file, slowest first (ties by label), cut to `top`, with each share of the
 *  serial total. `totalMs` covers every file with samples, not just the cut. */
export function rankFiles(files: Readonly<Record<string, readonly TimingSample[]>>, top: number): { ranked: TimedFile[]; totalMs: number } {
  const medians = Object.entries(files).map(([label, samples]) => ({ label, ms: median(samples.map((sample) => sample.ms)) }));
  const totalMs = medians.reduce((sum, entry) => sum + entry.ms, 0);
  const ranked = medians
    .sort((a, b) => b.ms - a.ms || a.label.localeCompare(b.label))
    .slice(0, top)
    .map((entry) => ({ ...entry, share: totalMs > 0 ? entry.ms / totalMs : 0 }));
  return { ranked, totalMs };
}

export interface RunTimingSummary {
  readonly wallMs: number;
  /** Sum of per-file wall times — what the same files would take one after another. */
  readonly serialMs: number;
  readonly jobs: number;
  /** serialMs / (wallMs x jobs), clamped to 1 — how much of the promised parallelism a run used. */
  readonly efficiency: number;
  readonly slowest: readonly TimedFile[];
}

export function runTimingSummary(wallMs: number, jobs: number, durations: readonly { readonly label: string; readonly ms: number }[], top = 10): RunTimingSummary {
  const serialMs = durations.reduce((sum, entry) => sum + entry.ms, 0);
  const denominator = wallMs * jobs;
  const efficiency = denominator > 0 ? Math.min(1, serialMs / denominator) : 0;
  const slowest = [...durations]
    .sort((a, b) => b.ms - a.ms || a.label.localeCompare(b.label))
    .slice(0, top)
    .map((entry) => ({ label: entry.label, ms: entry.ms, share: serialMs > 0 ? entry.ms / serialMs : 0 }));
  return { wallMs, serialMs, jobs, efficiency, slowest };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** The end-of-run block — two plain lines, no color, CI-log first. */
export function renderRunTimings(summary: RunTimingSummary): string {
  const slowest = summary.slowest.map((entry) => `${entry.label} ${seconds(entry.ms)} (${percent(entry.share)})`).join(", ");
  return (
    `timings: wall ${seconds(summary.wallMs)}, serial ${seconds(summary.serialMs)}, jobs ${summary.jobs}, ` +
    `parallel efficiency ${percent(summary.efficiency)}\n` +
    `slowest: ${slowest}\n`
  );
}

/** The `check --timings` ranking, one line per file, then totals. */
export function renderStoredTimings(ranked: readonly TimedFile[], totalMs: number, missing: number, totalFiles: number): string {
  const lines = ranked.map((entry, index) => `${String(index + 1).padStart(3)}. ${entry.label} ${Math.round(entry.ms)} ms (${percent(entry.share)})`);
  lines.push(`total of medians: ${Math.round(totalMs)} ms; ${missing} of ${totalFiles} check files have no samples`);
  return `${lines.join("\n")}\n`;
}

// Filesystem half of the check-timing telemetry: loading, validating and atomically
// rewriting .check-timings.json, and the two write paths the runner uses — the per-run
// merge into the repository-root store and the optional OC_CHECK_TIMINGS_OUT artifact.
// Every failure here degrades to one stderr warning; telemetry must never fail a run.


export const TIMINGS_FILENAME = ".check-timings.json";

export interface RecordedSample {
  readonly label: string;
  readonly ms: number;
}

function warn(message: string): void {
  process.stderr.write(`  note: check timings: ${message}\n`);
}

interface Loaded {
  readonly data?: TimingsFile;
  /** Why stored data was ignored (corrupt or unknown version); undefined when fine or absent. */
  readonly ignored?: string;
}

export async function loadTimingsFile(path: string): Promise<Loaded> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { ignored: `unreadable (${(error as Error).message})` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isValidTimings(parsed)) return { ignored: "unknown schema version" };
    return { data: parsed };
  } catch {
    return { ignored: "corrupt JSON" };
  }
}

/** Temp file + rename in the same directory: two overlapping runs may race to a rename
 *  (last writer wins), but a reader never sees a torn file. */
export async function writeJsonAtomic(timingsPath: string, value: unknown): Promise<void> {
  const timingsTemp = `${timingsPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(timingsTemp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(timingsTemp, timingsPath);
}

/** End-of-run persistence. Merges this run's per-file durations into the store under `dir`
 *  (unless `off`), and mirrors the run's own durations as a plain {label: ms} object to
 *  `outPath` (default OC_CHECK_TIMINGS_OUT) when one is set. Never throws. */
export async function recordRunTimings(options: {
  readonly dir: string;
  readonly samples: readonly RecordedSample[];
  readonly off?: boolean;
  readonly outPath?: string;
}): Promise<void> {
  const outPath = options.outPath ?? process.env.OC_CHECK_TIMINGS_OUT;
  if (options.off === true && outPath === undefined) return;
  const at = Date.now();
  const host = hostId(process.platform, process.arch, availableParallelism());
  try {
    if (options.off !== true) {
      const path = join(options.dir, TIMINGS_FILENAME);
      const loaded = await loadTimingsFile(path);
      if (loaded.ignored !== undefined) warn(`${TIMINGS_FILENAME} ignored (${loaded.ignored}) — rewriting it`);
      const files = mergeSamples(loaded.data?.files ?? {}, options.samples.map((sample) => ({ ...sample, at, host })));
      await writeJsonAtomic(path, { version: TIMINGS_VERSION, files });
    }
    if (outPath !== undefined) {
      await writeJsonAtomic(outPath, Object.fromEntries(options.samples.map((sample) => [sample.label, sample.ms])));
    }
  } catch (error) {
    warn(`could not be written (${(error as Error).message})`);
  }
}

/** The `check --timings` path: prints the stored ranking (median per file) without running
 *  anything, plus how many of the current check files have never been sampled. */
export async function printStoredTimings(options: { readonly dir: string; readonly top: number; readonly current: readonly string[] }): Promise<void> {
  const loaded = await loadTimingsFile(join(options.dir, TIMINGS_FILENAME));
  const stored = loaded.data;
  if (stored === undefined) {
    process.stderr.write(
      loaded.ignored === undefined
        ? `no check timing data yet — run the checks once and ${TIMINGS_FILENAME} will appear at the repository root\n`
        : `no usable check timing data (${loaded.ignored}) — run the checks once to rewrite ${TIMINGS_FILENAME}\n`,
    );
    return;
  }
  const { ranked, totalMs } = rankFiles(stored.files, options.top);
  const missing = options.current.filter((label) => !(label in stored.files)).length;
  process.stderr.write(renderStoredTimings(ranked, totalMs, missing, options.current.length));
}

/** The end-of-run block, rendered from a run's wall time, job count and per-file durations. */
export function renderRunBlock(wallMs: number, jobs: number, samples: readonly RecordedSample[]): string {
  return renderRunTimings(runTimingSummary(wallMs, jobs, samples));
}
