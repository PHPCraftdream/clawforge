// Shared check()/checkTrue()/finish() for *.check.ts files. Each file runs in its own
// process (see kit/run.ts), so this module's failure counter never sees more than one
// file's checks — no reset between files is needed.

import { deepStrictEqual } from "node:assert/strict";
import { inspect } from "node:util";

let failed = 0;

function describe(value: unknown): string {
  return inspect(value, { depth: null, breakLength: Infinity, compact: true, sorted: false });
}

/** Compares with deepStrictEqual, never JSON.stringify: undefined vs. a missing key, NaN,
 *  null, Set/Map and key order all compare correctly instead of silently matching or
 *  silently differing. Prints "  ok   name" on success, "  FAIL name" plus the expected/got
 *  values on failure. */
export function check(name: string, actual: unknown, expected: unknown): void {
  try {
    deepStrictEqual(actual, expected);
    process.stderr.write(`  ok   ${name}\n`);
  } catch {
    failed += 1;
    process.stderr.write(`  FAIL ${name}\n    expected ${describe(expected)}\n    got      ${describe(actual)}\n`);
  }
}

/** Sugar for check(name, condition, true) — for the common boolean-assertion call shape. */
export function checkTrue(name: string, condition: boolean): void {
  check(name, condition, true);
}

/** Prints the suite's summary line and sets process.exitCode. Call once, after every check(). */
export function finish(suite: string): void {
  process.stderr.write(failed === 0 ? `all ${suite} checks passed\n` : `${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
