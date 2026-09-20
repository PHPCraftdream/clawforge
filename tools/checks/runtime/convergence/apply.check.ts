// `./clawforge apply` — what it runs, what it refuses, and what it does after a step fails.
//
// The step runners themselves are the commands this framework already has and are covered
// where they live. What is new here, and what a coder is trusting when they type this, is
// the sequencing around them: stop at the first failure, say where it got to, and never
// perform an advisory step.

import { runSteps, blockingRemainder, isApplyDryRun } from "#framework/commands/orchestration/apply.ts";
import { PROBLEM_CODES } from "#framework/service/inspection.ts";
import type { PlanAction } from "#framework/commands/orchestration/plan.ts";
import type { Context } from "#framework/core/context.ts";
import { withOutputSink } from "#framework/core/output.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

const ctx = {} as unknown as Context;

check("apply recognizes a standalone dry-run flag", isApplyDryRun(["--dry-run"]), true);
check("apply does not treat --expect's value as a dry-run flag", isApplyDryRun(["--expect", "--dry-run"]), false);
check("apply does not treat --set's value as a dry-run flag", isApplyDryRun(["--set", "--dry-run"]), false);
check("apply still recognizes dry-run after an option value", isApplyDryRun(["--expect", "checksum", "--dry-run"]), true);

function action(id: string, advisory = false): PlanAction {
  return { id, summary: id, command: `./clawforge ${id}`, because: [], ...(advisory ? { advisory: true } : {}) };
}

/** runSteps dispatches by step id to the real commands, so a check cannot substitute its
 *  own runners. What it can do is choose ids: an id with no runner is reported as failed,
 *  which is how an unimplemented step surfaces, and lets the sequencing be observed
 *  without a live instance. */
async function outcomes(actions: PlanAction[]): Promise<{ id: string; status: string; detail?: string }[]> {
  let result: { id: string; status: string; detail?: string }[] = [];
  await withOutputSink(
    () => {},
    async () => {
      result = await runSteps(ctx, actions);
    },
  );
  return result.map((entry) => ({ id: entry.id, status: entry.status, ...(entry.detail === undefined ? {} : { detail: entry.detail }) }));
}

// --- advisory steps are never performed ----------------------------------------------------

{
  const result = await outcomes([action("reconnect-mcp", true), action("lock", true)]);
  check("advisory steps are reported advisory, not run", result, [
    { id: "reconnect-mcp", status: "advisory", detail: "advisory: for you to do, not this command" },
    { id: "lock", status: "advisory", detail: "advisory: for you to do, not this command" },
  ]);
}

// --- a step with no runner is a failure, not a flavor of skip -------------------------------

{
  const result = await outcomes([action("something-nobody-implemented")]);
  check("an unrunnable step is reported as failed", result, [
    { id: "something-nobody-implemented", status: "failed", detail: "no runner for this step" },
  ]);
  // Reported rather than omitted: a list of steps that quietly loses one describes a run
  // that did not happen. Failed rather than skipped: a plan naming an action nobody
  // implemented is a plan and its runner table drifting apart, and reporting it like a
  // routine "chose not to run" hides the defect from whoever reads the journal.
  check("and it still appears in the outcome", result.length, 1);
}

// --- the outcome names every step it was given ---------------------------------------------

{
  const result = await outcomes([action("reconnect-mcp", true), action("unknown-a"), action("unknown-b")]);
  check("every planned step appears in the outcome", result.map((entry) => entry.id), ["reconnect-mcp", "unknown-a", "unknown-b"]);
  check("advisory, then the no-runner failure, then blocked — three different facts", result.map((entry) => entry.status), ["advisory", "failed", "blocked"]);
}

// --- stopping at the first failure ---------------------------------------------------------
//
// The runners are real commands, so the failure is provoked through one that cannot succeed
// without an instance: `up` with no Context at all throws immediately. What matters is what
// happens to the steps after it.

{
  const result = await outcomes([action("up"), action("apply-config"), action("restart")]);
  check("the failing step is recorded as failed", result.map((entry) => ({ id: entry.id, status: entry.status }))[0], { id: "up", status: "failed" });
  check("and everything after it is blocked rather than attempted", result.slice(1).map((entry) => ({ id: entry.id, status: entry.status })), [
    { id: "apply-config", status: "blocked" },
    { id: "restart", status: "blocked" },
  ]);
  // A restart after a configuration that never applied would put the instance back on
  // exactly what it was already running, and reporting those steps as done would describe
  // an instance nobody has.
  check("no step after a failure reports success", result.some((entry) => entry.status === "done"), false);
}

// --- the statuses are different facts, not one label with three moods -------------------------
//
// The whole reason "skipped" was split is that a reader needs a different reaction to each.
// One plan therefore has to produce advisory, failed and blocked side by side and mean
// something different by each. "done" is the one status this harness cannot reach — every
// real runner needs a live instance to succeed — so its place in the vocabulary is pinned
// at the journal seam (release/operations.check.ts), where all four round-trip through disk.

{
  const result = await outcomes([action("lock", true), action("reconnect-mcp", true), action("unknown-a"), action("up"), action("restart")]);
  check("one plan, no label doing double duty", result.map((entry) => entry.status), ["advisory", "advisory", "failed", "blocked", "blocked"]);
  check("the step that could not run at all is not mislabeled as blocked", [result[2].status, result[2].detail], ["failed", "no runner for this step"]);
}

// --- the confirming inspection has the last word ----------------------------------------------
//
// Every step succeeding is not the claim this command makes. It promises the instance is now
// what the repository declares — and it used to report success regardless of what the
// inspection afterwards found, which is how a run ended "succeeded" with the declaration
// unapplied and the journal agreeing.

{
  const remaining = blockingRemainder([
    { code: "CONFIG_DRIFT", detail: "gateway.mode differs" },
    { code: "LOCK_MISSING", detail: "no lock file" },
  ]);
  check("a blocking finding afterwards makes it a failed run", remaining.map((entry) => entry.code), ["CONFIG_DRIFT"]);
  // A warning is a difference worth naming, not a reason to call a working instance broken —
  // the same rule doctor follows, so the two cannot disagree about one instance.
  check("a warning afterwards does not", blockingRemainder([{ code: "LOCK_MISSING", detail: "none" }]), []);
  check("and a clean inspection leaves nothing", blockingRemainder([]), []);
}

{
  // Both paths through the command end at the same check. Making only the one that ran
  // steps fail was half a fix, and half is worse than none here: an unhealthy gateway with
  // nothing for the plan to do reported success and exited zero, which is precisely the
  // claim this command's help makes and the reason it re-inspects at all.
  const noopOutcome = { deployment: "example", operationId: "(none)", changed: false, healthy: false, steps: [], problems: [{ code: "GATEWAY_UNHEALTHY", detail: "the runtime reports the container \"unhealthy\"" }], nextActions: ["./clawforge logs --tail 100"] };
  check("a run with nothing to do still fails on a blocking finding", blockingRemainder(noopOutcome.problems).length, 1);
  check("and passes when the finding is only a warning", blockingRemainder([{ code: "LOCK_MISSING", detail: "none" }]).length, 0);
}

{
  // Derived from the one table rather than a second list here, so a code added there is
  // covered without anyone remembering to come back to this file.
  const blocking = Object.entries(PROBLEM_CODES)
    .filter(([, meaning]) => meaning.severity === "blocking")
    .map(([code]) => code);
  const detected = blockingRemainder(blocking.map((code) => ({ code, detail: "x" }))).map((entry) => entry.code);
  check("every blocking code in the table fails a run", detected.sort(), blocking.sort());
}

process.stderr.write(failed === 0 ? "all apply checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
