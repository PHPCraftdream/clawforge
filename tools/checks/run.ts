// Runs every *.check.ts below this directory, or a filtered subset of it.
//
// These need no instance, no target and no network: they cover the parts of the framework
// where a mistake is silent — path translation, archive safety, the argument contract, the
// composition of a deployment. `./clawforge smoke` covers a live instance instead.

import { readdir, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reportError } from "#framework/core/io/log.ts";
import { emit } from "#framework/core/io/output.ts";
import { appsDir } from "#framework/integration/deployment/scaffold.ts";
import { hostPlatform } from "#framework/runtime/transport/transport.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function checkFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await checkFiles(full)));
    else if (entry.name.endsWith(".check.ts")) found.push(full);
  }
  return found.sort();
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

async function sweepOrphanedCheckDeployments(): Promise<void> {
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

export interface RunChecksOptions {
  /** Substrings a check's relative path must contain at least one of. Every check when empty. */
  readonly filters?: readonly string[];
  /** Print the matching paths instead of running them. */
  readonly list?: boolean;
}

export async function runChecks(options: RunChecksOptions = {}): Promise<number> {
  const filters = options.filters ?? [];
  const list = options.list ?? false;

  await sweepOrphanedCheckDeployments();

  const files = await checkFiles(here);
  const labeled = files.map((file) => ({ file, label: relative(here, file).replaceAll("\\", "/") }));
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
  for (const { file, label } of selected) {
    process.stderr.write(`\n${label}\n`);
    process.exitCode = 0;
    // Imported rather than spawned: one process, and a check that throws is a failure like
    // any other.
    const nodeOptions = process.env.NODE_OPTIONS;
    try {
      await import(pathToFileURL(file).href);
      if (process.exitCode !== 0) failed += 1;
    } catch (error) {
      process.stderr.write(`  FAIL ${label} threw: ${(error as Error).message}\n`);
      failed += 1;
    } finally {
      // A fixture may stand in for the host (useLinuxHost); nothing carries over to the next file.
      hostPlatform.current = process.platform;
      if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = nodeOptions;
    }
  }

  process.stderr.write(
    failed === 0
      ? `\n${selected.length} check file(s) passed\n`
      : `\n${failed} of ${selected.length} check file(s) failed\n`,
  );
  return failed === 0 ? 0 : 1;
}
