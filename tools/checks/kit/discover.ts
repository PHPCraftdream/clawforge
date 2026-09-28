// Finds *.check.ts files under tools/checks, and sweeps the deployments a killed run can
// leave behind under apps/.

import { readdir, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appsDir } from "#framework/integration/deployment/scaffold.ts";

/** tools/checks — one level up from this file, so moving kit/ does not move the root. */
export const checksRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface LabeledCheck {
  readonly file: string;
  readonly label: string;
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
  return files.map((file) => ({ file, label: relative(checksRoot, file).replaceAll("\\", "/") }));
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
