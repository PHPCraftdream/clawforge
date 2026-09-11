// Runs every *.check.ts in this directory.
//
// These need no instance, no target and no network: they cover the parts of the framework
// where a mistake is silent — path translation, archive safety, the argument contract, the
// composition of a deployment. `./clawforge smoke` covers the live instance instead.

import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function runChecks(): Promise<number> {
  const files = (await readdir(here)).filter((name) => name.endsWith(".check.ts")).sort();

  let failed = 0;
  for (const file of files) {
    process.stderr.write(`\n${file}\n`);
    process.exitCode = 0;
    // Imported rather than spawned: one process, and a check that throws is a failure like
    // any other.
    try {
      await import(pathToFileURL(resolve(here, file)).href);
      if (process.exitCode !== 0) failed += 1;
    } catch (error) {
      process.stderr.write(`  FAIL ${file} threw: ${(error as Error).message}\n`);
      failed += 1;
    }
  }

  process.stderr.write(
    failed === 0 ? `\n${files.length} check file(s) passed\n` : `\n${failed} of ${files.length} check file(s) failed\n`,
  );
  return failed === 0 ? 0 : 1;
}
