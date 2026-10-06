// `./clawforge apply` — what it runs, what it refuses, and what it does after a step fails.
//
// The step runners themselves are the commands this framework already has and are covered
// where they live. What is new here, and what a coder is trusting when they type this, is
// the sequencing around them: stop at the first failure, say where it got to, and never
// perform an advisory step. Recovery steps in a real run are apply-recovery.check.ts, the
// context refresh across a composite run apply-refresh.check.ts.

import { runSteps, blockingRemainder, APPLY_ARGUMENTS, runnerFor } from "#framework/commands/orchestration/apply.ts";
import { parseDeclaredArgs } from "#framework/core/command/index.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import { planActions } from "#framework/commands/orchestration/plan.ts";
import type { PlanAction } from "#framework/commands/orchestration/plan.ts";
import { problem, PROBLEM_CODES } from "#framework/service/inspection.ts";
import type { Inspection, Problem } from "#framework/service/inspection.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "#checks/runtime/convergence/inspect/fixture.ts";
import type { Context } from "#framework/core/context.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
const ctx = {} as unknown as Context;

/** The declaration's parser throws rather than returns, so the message is the observable. */
function deathOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

const dryRunGiven = (argv: string[]): boolean => parseDeclaredArgs(APPLY_ARGUMENTS, argv)["dry-run"] === true;

check("apply recognizes a standalone dry-run flag", dryRunGiven(["--dry-run"]), true);
// --expect/--set with nothing after but another of apply's own flags used to swallow it as
// a bogus value (a checksum/artifact literally "--dry-run") and silently drop the flag —
// now that value option refuses to swallow a declared flag and names which one needs a value.
check("--expect right before --dry-run needs a value, not a swallowed flag", deathOf(() => dryRunGiven(["--expect", "--dry-run"])), "--expect needs a value");
check("--set right before --dry-run needs a value, not a swallowed flag", deathOf(() => dryRunGiven(["--set", "--dry-run"])), "--set needs a value");
check("apply still recognizes dry-run after an option value", dryRunGiven(["--expect", "a".repeat(64), "--dry-run"]), true);

{
  const { deployment, goodChecksums, stubContext } = await setupFixtureDeployment();
  try {
    const base = stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      liveConfig: { gateway: { mode: "remote" } },
      batchSlotFailures: ["'mcp' 'list' '--json'"],
    });
    let mutations = 0;
    const ctx = {
      ...base,
      transport: {
        ...base.transport,
        writeFile: async () => { mutations++; throw new Error("unexpected write"); },
        mkdir: async () => { mutations++; throw new Error("unexpected mkdir"); },
      },
    } as Context;
    let error = "";
    await withOutputSink(() => {}, async () => {
      try { await orchestrationCommands.apply.run(ctx, []); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    });
    check("apply refuses uncertain CLI state before config drift could mutate", error.includes("apply stopped before changes") && error.includes("mcp list"), true);
    check("apply performs no target writes after a failed read", mutations, 0);
  } finally {
    await teardownFixtureDeployment(deployment);
  }
}

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
// something different by each. "done" needs a runner that succeeds without a live instance —
// recover-env is exactly that, and the journal section below runs it for real; the seam
// itself stays pinned in release/operations.check.ts, where all four round-trip through disk.

{
  const result = await outcomes([action("lock", true), action("reconnect-mcp", true), action("unknown-a"), action("up"), action("restart")]);
  check("one plan, no label doing double duty", result.map((entry) => entry.status), ["advisory", "advisory", "failed", "blocked", "blocked"]);
  check("the step that could not run at all is not mislabeled as blocked", [result[2].status, result[2].detail], ["failed", "no runner for this step"]);
}

// --- every executable id a plan can emit has a runner ----------------------------------------
//
// runSteps turns a missing runner into a failed run — an implementation gap discovered in
// production, not at check time. So the table is pinned here against the planner itself,
// for every id family it can emit, rather than only the recovery rows this change added.

function inspectionWith(problems: Problem[], running = true): Inspection {
  return {
    declared: { deployment: "example", config: [], image: "example/image:tag", recipes: ["demo"] },
    observed: {
      running,
      health: running ? "healthy" : undefined,
      probes: {},
      config: {},
      secrets: [],
      agents: [],
      mcpServers: [],
      cronJobs: [],
      foreignObjects: [],
    },
    problems,
  };
}

{
  const everyFamily = [
    problem("ENV_STALE", "OPENCLAW_GATEWAY_PORT differs"),
    problem("STORE_INCOMPLETE", "ZAI_API_KEY (provider zai)"),
    problem("DECLARATION_MISSING", "config/desired-state.json does not exist"),
    problem("SECRET_MISSING", "ZAI_API_KEY"),
    problem("CONFIG_DRIFT", "gateway.mode differs"),
    problem("GATEWAY_DOWN", "not running"),
    problem("RECIPE_MIRROR_DRIFT", "demo differs", command(["provision-agent", "demo"])),
    problem("SET_OBJECT_ORPHANED", "cron job left over", command(["set", "forget", "--kind", "cron-job", "--name", "demo-refresh"])),
  ];
  for (const running of [true, false]) {
    const actions = planActions(inspectionWith(everyFamily, running));
    for (const action of actions) {
      if (action.advisory === true) continue;
      check(`a runner exists for ${action.id}${running ? "" : " (stopped instance)"}`, runnerFor(action) !== undefined, true);
    }
  }
  // Advisory on purpose, with a runner anyway: if a future plan emits it as executable it
  // must fail loudly at the --force refusal (asserted below), not fall out of the table.
  const storeDump = planActions(inspectionWith([problem("STORE_INCOMPLETE", "x")]))[0];
  check("the advisory store dump still has its refusal runner", runnerFor(storeDump) !== undefined, true);
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

finish("apply");
