// Runs every *.check.ts below this directory.
//
// These need no instance, no target and no network: they cover the parts of the framework
// where a mistake is silent — path translation, archive safety, the argument contract, the
// composition of a deployment. `./clawforge smoke` covers the live instance instead.

import { readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

export async function runChecks(): Promise<number> {
  const files = await checkFiles(here);

  let failed = 0;
  for (const file of files) {
    const label = relative(here, file).replaceAll("\\", "/");
    process.stderr.write(`\n${label}\n`);
    process.exitCode = 0;
    // Imported rather than spawned: one process, and a check that throws is a failure like
    // any other.
    try {
      await import(pathToFileURL(file).href);
      if (process.exitCode !== 0) failed += 1;
    } catch (error) {
      process.stderr.write(`  FAIL ${label} threw: ${(error as Error).message}\n`);
      failed += 1;
    }
  }

  process.stderr.write(
    failed === 0 ? `\n${files.length} check file(s) passed\n` : `\n${failed} of ${files.length} check file(s) failed\n`,
  );
  return failed === 0 ? 0 : 1;
}
