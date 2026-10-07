// The frame law check (stage 7 S1.2a, invariant I12, decision O6): a thin runner over the
// pure measurement in frame-law-counter.ts. Violations that exist today are RECORDED, not
// failures: the ratchet lives in tools/checks/architecture/baseline.json under
// "frameLawViolations" and is DECREASING-ONLY — a new violation key, a count above the
// recorded total, or a changed mechanism at a recorded key fails; a count below the
// recorded total must lower the baseline in the same commit. A case that stops BEFORE a
// resolver decision for a SETUP reason (unknown producer/row, unresolvable paste
// directory, model crash) is a failure naming the case — recorded violations are fine,
// silent setup stops are not. Surfaces group, not exclusive, no checkout writes.

import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { runFrameLaw } from "./frame-law-counter.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const { violations, reached, attempted, setupFailures, stageCounts, finalRuns } = runFrameLaw();

// Every violation prints with a stable format — the negative controls read these lines.
for (const [key, reason] of violations) {
  process.stderr.write(`  frame law violation: ${key} \u2014 ${reason}\n`);
}
process.stderr.write(`law tally: reached ${reached}/${attempted}\n`);
process.stderr.write(`stage tally: ${stageCounts.map(({ stage, count }) => `${stage} ${count}`).join(", ")} (${stageCounts.reduce((sum, item) => sum + item.count, 0)} accounted); final runs ${finalRuns}\n`);
check("frame law: every attempt has one stage", stageCounts.reduce((sum, item) => sum + item.count, 0), attempted);
checkTrue("frame law: final-run path reaches at least one delegated final decision", finalRuns > 0);

for (const failure of setupFailures) {
  checkTrue(`frame law: setup stop before a decision — ${failure}`, false);
}

// --- the ratchet: measured vs recorded (baseline.json, decreasing-only) ----------------------

interface FrameLawBaseline {
  readonly comment: string;
  readonly violations: Record<string, string>;
  readonly total: number;
}
const baselinePath = pathResolve(monorepoRoot, "tools", "checks", "architecture", "baseline.json");
const baseline = (JSON.parse(await readFile(baselinePath, "utf8")) as { frameLawViolations: FrameLawBaseline }).frameLawViolations;
const recorded = baseline.violations;

for (const [key, reason] of violations) {
  const known = recorded[key];
  if (known === undefined) {
    checkTrue(`frame law violation: ${key} \u2014 not recorded in the baseline`, false);
    continue;
  }
  check(`frame law: the mechanism at ${key} changed \u2014 update the recorded reason`, reason, known);
}
if (violations.size > baseline.total) {
  checkTrue(`frame law: ${violations.size} measured violations exceed the recorded total ${baseline.total}`, false);
}
if (violations.size < baseline.total) {
  checkTrue(`frame law: measured ${violations.size} is below the recorded ${baseline.total} \u2014 lower the frameLawViolations baseline to ${violations.size} in the same commit`, false);
}

finish("frame law");
