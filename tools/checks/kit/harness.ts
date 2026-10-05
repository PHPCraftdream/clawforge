// Shared check()/checkTrue()/finish() for *.check.ts files. Each file runs in its own
// process (see kit/run.ts), so this module's failure counter never sees more than one
// file's checks — no reset between files is needed.

import { deepStrictEqual } from "node:assert/strict";
import { inspect } from "node:util";
import { CapabilityProbe, isCapability, type Capability } from "./capabilities/capabilities.ts";
import { parseRequireList } from "./capabilities/gate.ts";

let failed = 0;
const skippedByCapability = new Map<Capability, number>();

// Injectable so a check (harness.check.ts) can prove the gating with fake probes instead of
// the real host; defaults probe lazily and honor OC_CHECK_REQUIRE, like a file-level gate.
let caseProbe: CapabilityProbe | undefined;
let forcedCapabilities: ReadonlySet<Capability> | undefined;

export function setCaseProbe(probe: CapabilityProbe | undefined, forced?: ReadonlySet<Capability>): void {
  caseProbe = probe;
  forcedCapabilities = forced;
}

function forcedSet(): ReadonlySet<Capability> {
  if (forcedCapabilities === undefined) {
    // Same loud failure as run.ts: a typo in OC_CHECK_REQUIRE must not silently require
    // nothing in a directly-run check file.
    forcedCapabilities = new Set(parseRequireList(process.env.OC_CHECK_REQUIRE, isCapability));
  }
  return forcedCapabilities;
}

/**
 * Runs `body` when the host has `capability`; otherwise reports the case as skipped —
 * `  SKIP <name> — needs <cap>`, counted by finish() and folded into the runner's summary —
 * or, when that capability is in --require/OC_CHECK_REQUIRE, as a failure instead.
 */
export async function requires(capability: Capability, name: string, body: () => Promise<void> | void): Promise<void> {
  const present = await (caseProbe ??= new CapabilityProbe()).has(capability);
  if (present) {
    await body();
    return;
  }
  if (forcedSet().has(capability)) {
    failed += 1;
    process.stderr.write(`  FAIL ${name}\n    required capability absent: ${capability}\n`);
    return;
  }
  skippedByCapability.set(capability, (skippedByCapability.get(capability) ?? 0) + 1);
  process.stderr.write(`  SKIP ${name} — needs ${capability}\n`);
}

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

/**
 * Labels an assertion the checker already enforced — a compile-time assertType/Equal, or the
 * assert.equal lines preceding it — so it cannot fail at runtime. Must only label, never
 * assert: it prints check()'s success line without touching `failed`.
 */
export function typeAssert(name: string): void {
  process.stderr.write(`  ok   ${name}\n`);
}

/** Prints the suite's summary line and sets process.exitCode. Call once, after every check()
 *  and requires(). Case-level capability skips are counted like the runner counts skipped
 *  files: named in a breakdown after the unchanged base wording. */
export function finish(suite: string): void {
  const skippedTotal = [...skippedByCapability.values()].reduce((sum, count) => sum + count, 0);
  const breakdown = [...skippedByCapability.entries()].map(([capability, count]) => `${capability}: ${count}`).join(", ");
  const skipNote = skippedTotal === 0 ? "" : `, ${skippedTotal} skipped (needs ${breakdown})`;
  process.stderr.write(failed === 0 ? `all ${suite} checks passed${skipNote}\n` : `${failed} failed${skipNote}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
