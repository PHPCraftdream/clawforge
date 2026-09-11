// `./clawforge apply` — what it runs, what it refuses, and what it does after a step fails.
//
// The step runners themselves are the commands this framework already has and are covered
// where they live. What is new here, and what a coder is trusting when they type this, is
// the sequencing around them: stop at the first failure, say where it got to, and never
// perform an advisory step.

import { runSteps, blockingRemainder } from "../framework/commands/apply.ts";
import { PROBLEM_CODES } from "../framework/inspection.ts";
import type { PlanAction } from "../framework/commands/plan.ts";
import type { Context } from "../framework/context.ts";
import { withOutputSink } from "../framework/output.ts";

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

function action(id: string, advisory = false): PlanAction {
  return { id, summary: id, command: `./clawforge ${id}`, because: [], ...(advisory ? { advisory: true } : {}) };
}

/** runSteps dispatches by step id to the real commands, so a check cannot substitute its
 *  own runners. What it can do is choose ids: an id with no runner is reported as skipped,
 *  which is the same path an unknown step takes, and lets the sequencing be observed
 *  without a live instance. */
async function outcomes(actions: PlanAction[]): Promise<{ id: string; status: string }[]> {
  let result: { id: string; status: string; detail?: string }[] = [];
  await withOutputSink(
    () => {},
    async () => {
      result = await runSteps(ctx, actions);
    },
  );
  return result.map((entry) => ({ id: entry.id, status: entry.status }));
}

// --- advisory steps are never performed ----------------------------------------------------

{
  const result = await outcomes([action("reconnect-mcp", true), action("lock", true)]);
  check("advisory steps are skipped, not run", result, [
    { id: "reconnect-mcp", status: "skipped" },
    { id: "lock", status: "skipped" },
  ]);
}

// --- a step with no runner is reported, not silently dropped -------------------------------

{
  const result = await outcomes([action("something-nobody-implemented")]);
  check("an unrunnable step is reported as skipped", result, [{ id: "something-nobody-implemented", status: "skipped" }]);
  // Reported rather than omitted: a list of steps that quietly loses one describes a run
  // that did not happen.
  check("and it still appears in the outcome", result.length, 1);
}

// --- the outcome names every step it was given ---------------------------------------------

{
  const result = await outcomes([action("reconnect-mcp", true), action("unknown-a"), action("unknown-b")]);
  check("every planned step appears in the outcome", result.map((entry) => entry.id), ["reconnect-mcp", "unknown-a", "unknown-b"]);
  check("in the order the plan gave them", result.map((entry) => entry.status), ["skipped", "skipped", "skipped"]);
}

// --- stopping at the first failure ---------------------------------------------------------
//
// The runners are real commands, so the failure is provoked through one that cannot succeed
// without an instance: `up` with no Context at all throws immediately. What matters is what
// happens to the steps after it.

{
  const result = await outcomes([action("up"), action("apply-config"), action("restart")]);
  check("the failing step is recorded as failed", result[0], { id: "up", status: "failed" });
  check("and everything after it is skipped rather than attempted", result.slice(1), [
    { id: "apply-config", status: "skipped" },
    { id: "restart", status: "skipped" },
  ]);
  // A restart after a configuration that never applied would put the instance back on
  // exactly what it was already running, and reporting those steps as done would describe
  // an instance nobody has.
  check("no step after a failure reports success", result.some((entry) => entry.status === "done"), false);
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
