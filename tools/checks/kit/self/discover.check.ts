// A check file opts out of parallel runs with a `// check:exclusive` header line, and names a
// host capability it cannot run without with `// check:requires <cap>[, <cap>...]`.

import { check, checkTrue, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";
import { discoverChecks, parseRequires, runChecks, splitExclusive } from "#checks/kit/run.ts";
import {
  SAMPLES_PER_FILE,
  TIMINGS_FILENAME,
  TIMINGS_VERSION,
  hostId,
  isValidTimings,
  loadTimingsFile,
  median,
  mergeSamples,
  rankFiles,
  recordRunTimings,
  renderRunTimings,
  runTimingSummary,
  writeJsonAtomic,
  type TimingSample,
} from "#checks/kit/spawn.ts";
import type { Capability } from "#checks/kit/capabilities/capabilities.ts";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { availableParallelism, tmpdir } from "node:os";
import { withOutputSink } from "#framework/core/io/output.ts";

const found = await discoverChecks();
const exclusive = found.filter((entry) => entry.exclusive).map((entry) => entry.label);

check("a check that drops a scratch deployment into apps/ runs alone", exclusive.includes("golden/golden.check.ts"), true);
check("the package build check runs pooled: it builds into a temp dir, not the checkout's dist/", exclusive.includes("foundation/packaging/build-output.check.ts"), false);
check("an ordinary check stays in the parallel pool", exclusive.includes("foundation/core/env.check.ts"), false);

const { pooled, alone } = splitExclusive(found);
check("every file lands in exactly one group", pooled.length + alone.length, found.length);
check("the exclusive group is exactly the marked files", alone.map((entry) => entry.label), exclusive);

// Every discovered entry carries a requires array, even when it names nothing.
check("a file with no check:requires header names no capability", found.every((entry) => Array.isArray(entry.requires)), true);

// --- parseRequires: pure header-text parsing, no filesystem involved --------------------------

check("no marker at all means no requirement", parseRequires("// an ordinary header\n", "x.check.ts"), []);
check("one capability parses to a single-entry list", parseRequires("// check:requires docker\n", "x.check.ts"), ["docker"]);
check("several capabilities parse in order, whitespace trimmed", parseRequires("// check:requires docker,  wsl ,posix-sh\n", "x.check.ts"), ["docker", "wsl", "posix-sh"]);
check(
  "the exclusive marker on the same file does not confuse the requires parse",
  parseRequires("// check:exclusive — rebuilds dist/\n// check:requires docker\n", "x.check.ts"),
  ["docker"],
);

{
  let message = "";
  try {
    parseRequires("// check:requires ssh\n", "x.check.ts");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("an unknown capability throws, naming the file and the bad capability", message.includes("x.check.ts") && message.includes("ssh"), true);
}

// A real deployment can share the old cleanup's naming shape and contain private config. It
// lives under isolatedAppsRoot (the CLAWFORGE_CHECKS_APPS_DIR seam appsRootFor honors), so
// the checkout's own apps/ is never created or touched — the preservation invariant is about
// runChecks, not about where the deployment physically sits.
{
  const apps = await isolatedAppsRoot("discover-guard");
  try {
    let directory = "";
    for (;;) {
      directory = resolve(apps.root, `guard-check-${randomBytes(4).toString("hex")}`);
      try {
        await mkdir(directory);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const secretFile = resolve(directory, "secrets", "sentinel.txt");
    await mkdir(resolve(directory, "secrets"));
    await writeFile(secretFile, "fixture-secret-sentinel", "utf8");
    await withOutputSink(() => {}, () => runChecks({ list: true }));
    check("--list preserves a deployment with a check-shaped name", await readFile(secretFile, "utf8"), "fixture-secret-sentinel");

    await withOutputSink(() => {}, () => runChecks({ filters: ["no-such-check-filter-9e13"] }));
    check("an unmatched filter preserves the same deployment", await readFile(secretFile, "utf8"), "fixture-secret-sentinel");
  } finally {
    await apps.dispose();
  }
}

// --- run-time telemetry (folded into this file: kit/ sits at the layout entry cap) ---

function sample(ms: number, at = 1_000): TimingSample {
  return { at, ms, host: "test-host" };
}

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "clawforge-check-timings-"));
  roots.push(root);
  return root;
}

async function captureStderr(body: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await body();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

// --- mergeSamples ------------------------------------------------------------------------------

check("merging into an empty store just adds the fresh samples", mergeSamples({}, [{ label: "a.ts", ...sample(5) }]), { "a.ts": [sample(5)] });
check(
  "a fresh sample appends to the file's history",
  mergeSamples({ "a.ts": [sample(1), sample(2)] }, [{ label: "a.ts", ...sample(3) }]),
  { "a.ts": [sample(1), sample(2), sample(3)] },
);
check(
  "other files' histories survive a filtered run untouched",
  mergeSamples({ "a.ts": [sample(1)], "b.ts": [sample(9)] }, [{ label: "a.ts", ...sample(2) }]),
  { "a.ts": [sample(1), sample(2)], "b.ts": [sample(9)] },
);
{
  const flooded = Array.from({ length: SAMPLES_PER_FILE + 2 }, (_, index) => ({ label: "a.ts", ...sample(index + 1, index + 1) }));
  const merged = mergeSamples({}, flooded);
  check("the per-file cap keeps only the last samples", merged["a.ts"].length, SAMPLES_PER_FILE);
  check("the kept samples are the most recent ones", merged["a.ts"][0], sample(3, 3));
}

// --- median / rankFiles ------------------------------------------------------------------------

check("median of an empty list is 0", median([]), 0);
check("median of an odd list is the middle value", median([30, 10, 20]), 20);
check("median of an even list averages the middle two", median([10, 40, 20, 30]), 25);

{
  const files = {
    "slow.ts": [sample(400), sample(600)],
    "mid.ts": [sample(300)],
    "idle.ts": [sample(0)],
    "unranked.ts": [sample(50)],
  };
  const { ranked, totalMs } = rankFiles(files, 2);
  check("rankFiles cuts to the top n", ranked.length, 2);
  check("rankFiles orders by median, slowest first", ranked.map((entry) => entry.label), ["slow.ts", "mid.ts"]);
  check("rankFiles computes each share of the serial total", Math.round(ranked[0].share * 1000) / 1000, Math.round((500 / 850) * 1000) / 1000);
  check("rankFiles totals every file with samples, not just the cut", totalMs, 850);
  check("a zero-median file still shares when everything is zero", rankFiles({ "z.ts": [sample(0)] }, 5).ranked[0].share, 0);
}

// --- runTimingSummary / rendering --------------------------------------------------------------

{
  const durations = [
    { label: "b.ts", ms: 100 },
    { label: "a.ts", ms: 300 },
    { label: "c.ts", ms: 0 },
  ];
  const summary = runTimingSummary(200, 2, durations);
  check("the serial sum adds every per-file duration", summary.serialMs, 400);
  check("efficiency is serial / (wall x jobs)", summary.efficiency, 1);
  check("efficiency clamps to 1", runTimingSummary(1_000, 2, durations).efficiency, 0.2);
  check("efficiency stays 0 for a zero wall time", runTimingSummary(0, 2, durations).efficiency, 0);
  check("slowest orders by duration, ties by label", summary.slowest.map((entry) => entry.label), ["a.ts", "b.ts", "c.ts"]);
  check("slowest cuts to the requested count", runTimingSummary(200, 2, durations, 1).slowest.length, 1);

  const rendered = renderRunTimings(summary).split("\n");
  check("the run block is two plain lines", rendered.length, 3);
  const line = rendered[0].split(" ");
  check("line one labels wall, serial, jobs and parallel efficiency in order", [line[1], line[3], line[5], line[7], line[8]], ["wall", "serial", "jobs", "parallel", "efficiency"]);
  check("line one reports the run's wall time, serial sum, job count and clamped efficiency", [line[2], line[4], line[6], line[9]], ["0.2s,", "0.4s,", "2,", "100%"]);
  const slow = rendered[1].split(" ");
  check("line two lists the slowest files in duration order", [slow[1], slow[4], slow[7]], ["a.ts", "b.ts", "c.ts"]);
  check("line two reports each file's share of the serial sum", [slow[3], slow[6], slow[9]], ["(75%),", "(25%),", "(0%)"]);
}

// --- isValidTimings / hostId -------------------------------------------------------------------

check("a well-formed store validates", isValidTimings({ version: TIMINGS_VERSION, files: { "a.ts": [sample(1)] } }), true);
check("an unknown version is rejected", isValidTimings({ version: 99, files: {} }), false);
check("non-object content is rejected", isValidTimings("[]"), false);
check("a file map with non-array samples is rejected", isValidTimings({ version: TIMINGS_VERSION, files: { "a.ts": 3 } }), false);
check("a sample with a non-number ms is rejected", isValidTimings({ version: TIMINGS_VERSION, files: { "a.ts": [{ at: 1, ms: "x", host: "h" }] } }), false);
check("hostId is platform-arch-cpus", hostId("win32", "x64", 8), "win32-x64-8");

// --- the store on disk -------------------------------------------------------------------------

{
  const root = await tempRoot();
  const path = join(root, TIMINGS_FILENAME);
  check("a missing store reads as absent, not ignored", await loadTimingsFile(path), {});
  await writeJsonAtomic(path, { version: TIMINGS_VERSION, files: { "a.ts": [sample(7)] } });
  const loaded = await loadTimingsFile(path);
  check("a written store round-trips", loaded.data?.files, { "a.ts": [sample(7)] });
  checkTrue("an atomic write leaves no temp files behind", (await readdir(root)).every((name) => !name.endsWith(".tmp")));
}

{
  const root = await tempRoot();
  const path = join(root, TIMINGS_FILENAME);
  await writeFile(join(root, TIMINGS_FILENAME), "{not json", "utf8");
  check("corrupt JSON is ignored with a reason", (await loadTimingsFile(path)).ignored !== undefined, true);
  await writeFile(join(root, TIMINGS_FILENAME), JSON.stringify({ version: 42, files: {} }), "utf8");
  check("an unknown schema version is ignored with a reason", (await loadTimingsFile(path)).ignored !== undefined, true);

  const warning = await captureStderr(() => recordRunTimings({ dir: root, samples: [{ label: "a.ts", ms: 10 }] }));
  checkTrue("rewriting an ignored store warns once on stderr", warning.includes("ignored"));
  const after = await loadTimingsFile(path);
  check("the rewrite is a versioned store with the run's sample", after.data, {
    version: TIMINGS_VERSION,
    files: { "a.ts": [{ at: after.data?.files["a.ts"][0].at ?? 0, ms: 10, host: hostId(process.platform, process.arch, availableParallelism()) }] },
  });
}

{
  const root = await tempRoot();
  const out = join(root, "out.json");
  await recordRunTimings({ dir: root, samples: [{ label: "a.ts", ms: 10 }], off: true, outPath: out });
  checkTrue("off writes no repository-root store", (await readdir(root)).filter((name) => name !== "out.json").length === 0);
  check("the artifact is a plain label-to-ms map", JSON.parse(await readFile(out, "utf8")), { "a.ts": 10 });
}

{
  const missing = await tempRoot();
  const warning = await captureStderr(() => recordRunTimings({ dir: join(missing, "no-such-dir"), samples: [{ label: "a.ts", ms: 1 }], outPath: undefined }));
  check("an unwritable store degrades to a warning naming the failure, never a throw", warning.trim().split(" ").slice(3, 7), ["could", "not", "be", "written"]);
}

// --- the runner end-to-end, with fake results --------------------------------------------------

const LABELS = ["kit/timings/a.check.ts", "kit/timings/b.check.ts", "kit/timings/s.check.ts"];
const entries = LABELS.map((label) => ({
  file: label,
  label,
  exclusive: false as const,
  requires: (label.endsWith("s.check.ts") ? ["docker"] : []) as readonly Capability[],
}));
const probe = { missing: async (required: readonly Capability[]): Promise<Capability[]> => [...required] };
const runFile = async (_file: string, label: string): Promise<{ label: string; ok: boolean; output: string; durationMs: number }> => ({
  label,
  ok: true,
  output: "",
  durationMs: label.endsWith("a.check.ts") ? 300 : 100,
});

{
  const root = await tempRoot();
  let tick = 0;
  await captureStderr(() =>
    runChecks({ entries, probe, runFile, checkoutRoot: root, timingsDir: root, jobs: 2, now: () => (tick += 50) }),
  ).then((output) => {
    const lines = output.split("\n");
    const block = (lines.find((entry) => entry.split(" ")[0] === "timings:") ?? "").split(" ");
    const slowest = (lines.find((entry) => entry.split(" ")[0] === "slowest:") ?? "").split(" ");
    check("the end-of-run block reports the fake wall, serial, jobs and clamped efficiency", [block[2], block[4], block[6], block[9]], ["0.1s,", "0.4s,", "2,", "100%"]);
    check("the slowest list orders the fake files, the skipped one at zero", [slowest[1], slowest[4], slowest[7], slowest[9]], ["kit/timings/a.check.ts", "kit/timings/b.check.ts", "kit/timings/s.check.ts", "(0%)"]);
  });
  const stored = await loadTimingsFile(join(root, TIMINGS_FILENAME));
  check("every file, ran or skipped, has a sample entry", Object.keys(stored.data?.files ?? {}).sort(), [...LABELS].sort());
  check("the skipped file's sample is zero ms", stored.data?.files["kit/timings/s.check.ts"][0].ms, 0);

  await captureStderr(() => runChecks({
    entries: entries.filter((entry) => entry.label.endsWith("b.check.ts")),
    probe,
    runFile: async (_file, label) => ({ label, ok: true, output: "", durationMs: 700 }),
    checkoutRoot: root,
    timingsDir: root,
    jobs: 1,
    now: () => 0,
    filters: ["b.check.ts"],
  }));
  const merged = await loadTimingsFile(join(root, TIMINGS_FILENAME));
  check("a filtered run merges instead of replacing", merged.data?.files["kit/timings/b.check.ts"].length, 2);
  checkTrue("other files keep their history across the filtered run", (merged.data?.files["kit/timings/a.check.ts"].length ?? 0) === 1);

  const ranking = await captureStderr(() => runChecks({ entries, timingsDir: root, timingsOnly: 2 }));
  const summary = (ranking.split("\n").find((entry) => entry.split(" ")[0] === "total") ?? "").split(" ");
  check("the stored ranking prints without running anything", [summary[0]], ["total"]);
  // medians: a 300, b 400 (100, 700), s 0 — the serial total is 700.
  check("the ranking totals are the medians and coverage", [Number(summary[3]), Number(summary[5]), Number(summary[7])], [700, 0, 3]);
  const numbered = ranking.split("\n").filter((entry) => /^\s*\d+\./.exec(entry) !== null);
  check("the ranking is cut to --top", numbered.length, 2);
  checkTrue("the ranking orders by median, slowest first", numbered.length > 0 && numbered[0].includes("b.check.ts"));

  const empty = await captureStderr(() => runChecks({ entries, timingsDir: join(root, "never"), timingsOnly: 20 }));
  const notice = (empty.split("\n").find((entry) => entry.split(" ")[0] === "no") ?? "").split(" ");
  check("no stored data prints a clear message and the run still succeeds", notice.slice(0, 5), ["no", "check", "timing", "data", "yet"]);
}

for (const timingsRoot of roots) await rm(timingsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
finish("discovery");
