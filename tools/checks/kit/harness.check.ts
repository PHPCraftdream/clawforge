// Self-test for the shared harness (check/checkTrue/finish): the exact pass/fail output
// shape, deepStrictEqual semantics (undefined vs. a missing key, NaN), and the exit code
// finish() sets. Each scenario is a real script run from a temp directory outside any
// "#checks/..." package scope, so the harness is imported by an absolute file URL — proving
// it works the way a script outside this repo's own subpath-import map would use it.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { check, finish } from "./harness.ts";
import { runProcess } from "./spawn.ts";

const harnessUrl = pathToFileURL(resolve(import.meta.dirname, "harness.ts")).href;

interface Ran {
  readonly code: number | null;
  readonly output: string;
}

async function runScript(dir: string, source: string): Promise<Ran> {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.ts`);
  await writeFile(file, `import { check, checkTrue, finish } from "${harnessUrl}";\n${source}`);
  const { code, output } = await runProcess(process.execPath, ["--experimental-strip-types", file]);
  return { code, output };
}

const dir = await mkdtemp(join(tmpdir(), "clawforge-harness-check-"));
try {
  const allPass = await runScript(
    dir,
    'check("simple equality", 1, 1);\ncheckTrue("boolean sugar", true);\nfinish("demo");\n',
  );
  check("a passing check prints \"  ok   name\"", allPass.output.includes("  ok   simple equality\n"), true);
  check("checkTrue sugars check(name, cond, true)", allPass.output.includes("  ok   boolean sugar\n"), true);
  check("finish() prints the all-passed summary", allPass.output.includes("all demo checks passed\n"), true);
  check("finish() sets exit code 0 when nothing failed", allPass.code, 0);

  const mismatch = await runScript(dir, 'check("mismatch", { a: 1 }, { a: 2 });\nfinish("demo");\n');
  check(
    "a failing check prints \"  FAIL name\" plus expected/got",
    mismatch.output.includes("  FAIL mismatch\n    expected { a: 2 }\n    got      { a: 1 }\n"),
    true,
  );
  check("finish() prints the failure count, not the all-passed line", mismatch.output.includes("1 failed\n"), true);
  check("finish() sets a non-zero exit code when something failed", mismatch.code === 0, false);

  // The whole point of deepStrictEqual over JSON.stringify: a key holding undefined and a
  // missing key serialize identically ("{\"a\":1}") but are not the same value.
  const undefinedVsMissing = await runScript(
    dir,
    'check("undefined key vs missing key", { a: 1, b: undefined }, { a: 1 });\nfinish("demo");\n',
  );
  check(
    "an explicit undefined property differs from a missing one",
    undefinedVsMissing.output.includes("  FAIL undefined key vs missing key\n"),
    true,
  );
  check("...and is reported as a failure, exit code included", undefinedVsMissing.code === 0, false);

  // The reverse fix: a plain `actual === expected` (one of the two patterns the harness
  // replaces) would call NaN !== NaN a failure. deepStrictEqual does not.
  const nanEquality = await runScript(dir, 'check("NaN equals itself", NaN, NaN);\nfinish("demo");\n');
  check("NaN compares equal to NaN under deepStrictEqual", nanEquality.output.includes("  ok   NaN equals itself\n"), true);
  check("...so the suite passes", nanEquality.code, 0);
} finally {
  await rm(dir, { recursive: true, force: true });
}

finish("harness");
