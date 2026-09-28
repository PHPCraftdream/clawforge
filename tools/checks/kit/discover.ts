// Finds *.check.ts files under tools/checks, and sweeps the deployments a killed run can
// leave behind under apps/.

import { open, readdir, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appsDir } from "#framework/integration/deployment/scaffold.ts";
import { CAPABILITIES, isCapability, type Capability } from "./capabilities/capabilities.ts";

/** tools/checks — one level up from this file, so moving kit/ does not move the root. */
export const checksRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface LabeledCheck {
  readonly file: string;
  readonly label: string;
  /** Mutates state other checks read (e.g. rebuilds dist/): runs alone, after the parallel pool. */
  readonly exclusive: boolean;
  /** Host capabilities (capabilities.ts) this file cannot run at all without — run.ts skips
   *  (or, under --require/OC_CHECK_REQUIRE, fails) the file rather than starting it. */
  readonly requires: readonly Capability[];
}

/** A file opts out of parallel runs with a `// check:exclusive — <reason>` line in its header. */
const EXCLUSIVE_MARKER = /^\/\/ check:exclusive(?![A-Za-z-])/m;

/** A file that cannot run at all without one or more host capabilities names them with a
 *  `// check:requires <cap>[, <cap>...]` line in its header — same 2KB budget as the
 *  exclusive marker, since both describe the file rather than its content. */
const REQUIRES_MARKER = /^\/\/ check:requires\s+(.+)$/m;

/** Exported for discover.check.ts: pure header-text parsing, no filesystem needed to test it. */
export function parseRequires(header: string, file: string): Capability[] {
  const match = REQUIRES_MARKER.exec(header);
  if (match === null) return [];
  return match[1].split(",").map((entry) => {
    const capability = entry.trim();
    if (!isCapability(capability)) {
      throw new Error(`${file}: unknown capability "${capability}" in a check:requires header (known: ${CAPABILITIES.join(", ")})`);
    }
    return capability;
  });
}

interface Header {
  readonly exclusive: boolean;
  readonly requires: readonly Capability[];
}

async function readHeader(file: string): Promise<Header> {
  const handle = await open(file, "r");
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(2048), 0, 2048, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    return { exclusive: EXCLUSIVE_MARKER.test(text), requires: parseRequires(text, file) };
  } finally {
    await handle.close();
  }
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (entry.name.endsWith(".check.ts")) found.push(full);
  }
  return found.sort();
}

/** Every check file under tools/checks, labeled by its path relative to it (POSIX form). */
export async function discoverChecks(): Promise<LabeledCheck[]> {
  const files = await walk(checksRoot);
  return Promise.all(files.map(async (file) => {
    const header = await readHeader(file);
    return { file, label: relative(checksRoot, file).replaceAll("\\", "/"), ...header };
  }));
}

/** The parallel pool and the files that must run alone after it, each in the given order. */
export function splitExclusive(entries: readonly LabeledCheck[]): { pooled: LabeledCheck[]; alone: LabeledCheck[] } {
  return { pooled: entries.filter((entry) => !entry.exclusive), alone: entries.filter((entry) => entry.exclusive) };
}

/** The labels containing at least one filter substring; all of them when there are none. */
export function selectChecks(labels: readonly string[], filters: readonly string[]): string[] {
  if (filters.length === 0) return [...labels];
  return labels.filter((label) => filters.some((filter) => label.includes(filter)));
}

// Checks that create a real deployment under apps/ remove it in a finally block; a killed
// run skips it and leaves e.g. apps/cli-help-check-97131cc3. Only names of exactly that
// shape (-check-<hex>) older than the suite's duration are swept.
const SWEEP_AGE_MINUTES = 30;
const CHECK_DEPLOYMENT_NAME = /-check-[0-9a-f]{8,10}$/;

export async function sweepOrphanedCheckDeployments(): Promise<void> {
  const entries = await readdir(appsDir, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - SWEEP_AGE_MINUTES * 60_000;
  for (const entry of entries) {
    if (!entry.isDirectory() || !CHECK_DEPLOYMENT_NAME.test(entry.name)) continue;
    const full = resolve(appsDir, entry.name);
    const info = await stat(full).catch(() => undefined);
    if (info === undefined || info.mtimeMs >= cutoff) continue;
    await rm(full, { recursive: true, force: true });
    process.stderr.write(`swept orphaned check deployment: apps/${entry.name}\n`);
  }
}
