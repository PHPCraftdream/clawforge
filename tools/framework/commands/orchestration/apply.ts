// `./clawforge apply` — run the plan, then check the result.
//
// "Applied" and "working" are different claims, and the weaker one is the easy one to make:
// every step returned successfully, so the command reports success, and the instance is
// still broken for a reason none of the steps was looking at. This command makes the
// stronger claim — it inspects again afterwards and reports what it found, so the answer a
// coder gets is about the instance rather than about the steps.
//
// It refuses a plan whose declaration changed while it was being read. That is the cheap
// half of concurrency safety: it does not stop two people applying at once, but it does
// stop the far more ordinary case of applying steps that were chosen for a different
// version of the repository.

import { log, info, warn, die } from "#src/core/log.ts";
import { emit, isCaptured } from "#src/core/output.ts";
import { computePlan } from "./plan.ts";
import { gatherInspection } from "./inspect/gather.ts";
import { currentComposition, declarationChecksum, frameworkVersion } from "../management/lock.ts";
import { isHealthy, nextActions, PROBLEM_CODES } from "#src/service/inspection.ts";
import { applyConfig } from "./config.ts";
import { secrets } from "../management/secrets.ts";
import { up, restart } from "../lifecycle/lifecycle.ts";
import { provisionAgent, removeOwnedObject } from "../management/provision-agent/index.ts";
import type { OwnedKind } from "#src/set/ownership/ledger.ts";
import { Journal, snapshotConfig, newOperationId } from "#src/service/operations.ts";
import { runOwning, takeLock, withLockUnlessHeld } from "#src/runtime/instance-lock.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { withSetSource } from "#src/set/artifacts/source.ts";
import { withUnpackedArtifact, recordInstalledSet, storeArtifactForRollback, requirementProblems, runningImageDigest } from "#src/set/artifacts/install.ts";
import type { PlanAction, Plan } from "./plan.ts";
import type { Context } from "#src/core/context.ts";

/** Whether the container is running but its image could not be resolved to any digest at
 *  all — a container built or tagged in a way docker cannot report RepoDigests for, say.
 *  requirementProblems() treats an undefined imageDigest as "nothing to compare, no
 *  problem", which is right for inspect's informational reporting (unknown legitimately
 *  means "cannot say") but wrong for deciding whether to RECORD a set as installed: that
 *  decision needs proof of a match, not merely the absence of a proven mismatch. */
export async function runningImageUnconfirmed(ctx: Context): Promise<boolean> {
  const running = await ctx.runtime.runningImageIdentity?.();
  // Either shape of "cannot determine anything about the running image" refuses recording —
  // an identity object with no digests, AND no identity at all (no container found, or a
  // runtime backend that does not implement this). Only checking the former let a fully
  // unknown image identity sail through as if it were confirmed.
  return running === undefined || running.digests.length === 0;
}

/** How each executable step is actually performed. Commands are called directly rather than
 *  by shelling out to `./clawforge`: the step already knows which function it means, and going back
 *  out through the dispatcher would lose the Context, the output sink and the error. */
const RUNNERS: Record<string, (ctx: Context, action: PlanAction) => Promise<void>> = {
  secrets: (ctx) => secrets(ctx, ["--apply"]),
  "apply-config": (ctx) => applyConfig(ctx, []),
  up: (ctx) => up(ctx, []),
  restart: (ctx) => restart(ctx, []),
};

function runnerFor(action: PlanAction): ((ctx: Context, action: PlanAction) => Promise<void>) | undefined {
  if (action.id.startsWith("provision-agent:")) {
    const recipe = action.id.slice("provision-agent:".length);
    return (ctx) => provisionAgent(ctx, [recipe]);
  }
  if (action.id.startsWith("remove-owned:")) {
    // "remove-owned:<kind>:<name>" — the agent case never reaches here: planActions marks it
    // advisory, and runSteps skips advisory actions before asking for a runner at all.
    const rest = action.id.slice("remove-owned:".length);
    const separator = rest.indexOf(":");
    const kind = rest.slice(0, separator) as OwnedKind;
    const name = rest.slice(separator + 1);
    return (ctx) => removeOwnedObject(ctx, kind, name);
  }
  return RUNNERS[action.id];
}

export interface StepOutcome {
  readonly id: string;
  readonly status: "done" | "failed" | "skipped";
  readonly detail?: string;
}

export interface ApplyOutcome {
  readonly deployment: string;
  /** The journal entry this run wrote — the same id the configuration snapshot and the MCP
   *  result carry, so "what happened in that operation" has one answer. */
  readonly operationId: string;
  readonly changed: boolean;
  readonly healthy: boolean;
  readonly steps: StepOutcome[];
  readonly problems: readonly { readonly code: string; readonly detail: string }[];
  readonly nextActions: string[];
}

/** Returns whether argv contains the apply dry-run flag rather than an option value. */
export function isApplyDryRun(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--set" || arg === "--expect") {
      index += 1;
      continue;
    }
    if (arg === "--dry-run") return true;
  }
  return false;
}

/** Runs the executable steps in order, stopping at the first failure.
 *
 *  Stopping is the point. The steps depend on each other — a restart after a configuration
 *  that failed to apply would put the instance back on exactly what it was already running,
 *  and reporting the later steps as successful would describe an instance nobody has. What
 *  did not run is reported as skipped rather than omitted, so the answer says where it got
 *  to. */
export async function runSteps(
  ctx: Context,
  actions: readonly PlanAction[],
  journal?: Journal,
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  let stopped = false;

  const record = async (outcome: StepOutcome): Promise<void> => {
    outcomes.push(outcome);
    // Written as each step finishes, not once at the end: a run that is killed mid-way is
    // exactly the case the journal exists for, and a record assembled afterwards would be
    // lost with it.
    await journal?.step(outcome.id, outcome.status, outcome.detail);
  };

  for (const action of actions) {
    if (action.advisory === true) {
      await record({ id: action.id, status: "skipped", detail: "advisory: for you to do, not this command" });
      continue;
    }
    if (stopped) {
      await record({ id: action.id, status: "skipped", detail: "an earlier step failed" });
      continue;
    }

    const runner = runnerFor(action);
    if (runner === undefined) {
      await record({ id: action.id, status: "skipped", detail: "no runner for this step" });
      continue;
    }

    log(`step: ${action.summary}`);
    try {
      await runner(ctx, action);
      await record({ id: action.id, status: "done" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await record({ id: action.id, status: "failed", detail });
      stopped = true;
    }
  }

  return outcomes;
}

export async function apply(ctx: Context, args: string[]): Promise<void> {
  return applyWithSource(ctx, args);
}

/** With --set, the declaration and the recipe files come from the artifact for the whole run:
 *  planning AND every step. Unpacking only for the plan would compute steps from the artifact
 *  and then execute them against the working tree — an install that reports the set's id while
 *  having mirrored somebody's uncommitted edits. */
async function applyWithSource(ctx: Context, args: string[]): Promise<void> {
  const index = args.indexOf("--set");
  if (index === -1) {
    await applyFromSource(ctx, args);
    return;
  }

  const artifact = args[index + 1] ?? die("--set needs an artifact path");
  await withUnpackedArtifact(artifact, (staging, verified) =>
    withSetSource(staging, async () => {
      if (isApplyDryRun(args)) {
        await applyFromSource(ctx, args);
        return;
      }

      // Refused before anything is touched, the same way the declaration-changed check
      // below refuses before any step runs. up/restart (the only steps that touch the
      // running container) start whatever this deployment's OWN .env already names —
      // applying this artifact never pulls or switches to the image it requires. Recording
      // this set as installed while the runtime keeps running a different image would not be
      // optimistic, it would be false: not "may still work", but provably does not match,
      // right now. requirementProblems is the same check inspect's own SET_REQUIREMENT_UNMET
      // finding already uses — reused here so this run reports the mismatch itself, instead
      // of leaving it to a LATER inspect that reads the record this apply is about to write.
      const framework = await frameworkVersion();
      const requirementIssues = requirementProblems(verified.manifest, {
        framework,
        imageDigest: await runningImageDigest(ctx, verified.manifest),
      });
      if (requirementIssues.length > 0) {
        die(
          `this set cannot be installed here:\n${requirementIssues.map((entry) => `  ${entry.detail}`).join("\n")}\n` +
            "Point this deployment's OPENCLAW_IMAGE at the required digest (or update the framework) before applying it.",
        );
      }

      const operationId = newOperationId("apply");
      // Nesting-safe, the same way provisionAgent()'s own lock-taking already is: a caller
      // (rollback --set) that already holds the instance lock for the whole operation must
      // not have this acquire refuse itself as "another operation changing this instance".
      await withLockUnlessHeld(ctx, "apply set", operationId, { breakLock: args.includes("--break-lock") }, async () => {
        await storeArtifactForRollback(artifact, verified);
        const ranSteps = await applyFromSource(ctx, args, operationId);

        // applyFromSource's own "nothing to apply" fast path (0 executable actions — the
        // live config already matched what this set declares) returns WITHOUT ever opening
        // a Journal or taking a config snapshot for operationId: there is nothing to run, so
        // there was nothing it thought worth recording. But recordInstalledSet() below is
        // about to write installed.operationId = operationId regardless — and rollback --set
        // later reads exactly that field to find the one snapshot it needs to restore. A set
        // transition (this set's id differs from whatever was installed before, e.g. the same
        // set reinstalled under a new name) that happens to change nothing about the live
        // config still needs a recorded operation for rollback --set to point at, or undoing
        // it later finds nothing and refuses (task #185) even though nothing here actually
        // needs restoring — the live config already IS what a rollback would reach. Recorded
        // after applyFromSource rather than before: this branch only runs when nothing was
        // executed, so the config here is exactly the config before this call too.
        //
        // Decided from applyFromSource()'s OWN report of whether it ran anything, not from
        // probing readOperation(ctx, operationId) afterward: a readOperation() failure means
        // "could not read this record", which is also true for a REAL run whose Journal (with
        // its correct, pre-change snapshot) exists but hit one transient read error right
        // after — that false positive used to make this branch re-open a fresh Journal and
        // take a NEW snapshot NOW, i.e. of the config AFTER the real steps already changed
        // it, silently clobbering the correct pre-change snapshot rollback --set needs.
        if (!ranSteps) {
          const noopJournal = await Journal.open(ctx, "apply", deploymentName(), operationId);
          const snapshot = await snapshotConfig(ctx, operationId);
          if (snapshot !== undefined) await noopJournal.noteSnapshot(snapshot);
          await noopJournal.close("succeeded", "no executable steps — the live configuration already matched this set");
        }

        // Checked again now that up/restart have run: the pre-check only proves the
        // instance was NOT already wrong before this apply touched it, not that whatever
        // apply actually did brought it into line — up/restart may not have recreated the
        // container at all (nothing in the plan called for it), or compose may not have
        // picked up the change for a reason of its own. The set is not recorded as installed
        // over a running instance this apply cannot show actually matches it.
        const afterIssues = requirementProblems(verified.manifest, {
          framework,
          imageDigest: await runningImageDigest(ctx, verified.manifest),
        });
        // An undefined imageDigest here means requirementProblems() found nothing to compare
        // against — which, for THIS decision, is not good enough: recording a set as
        // installed is a claim of proof, and a container running with no resolvable digest
        // at all is exactly as unproven as one with the wrong digest.
        const unconfirmed = await runningImageUnconfirmed(ctx);
        if (afterIssues.length > 0 || unconfirmed) {
          die(
            unconfirmed && afterIssues.length === 0
              ? "apply finished, but this instance's running image could not be resolved to any digest — " +
                "there is no proof it matches what this set requires. The set is NOT recorded as installed."
              : `apply finished, but the running instance still does not match what this set requires:\n` +
                `${afterIssues.map((entry) => `  ${entry.detail}`).join("\n")}\n` +
                "The set is NOT recorded as installed.",
          );
        }

        await recordInstalledSet(ctx, verified.manifest, verified.id, operationId);
      });
    }),
  );
}

/** Returns whether it actually ran executable steps (opened a Journal, took a config
 *  snapshot, executed the plan) as opposed to a dry run or the "nothing to apply" fast
 *  path — the one fact applyWithSource's --set branch needs to decide whether a no-op
 *  transition still needs a snapshot taken on its behalf. */
async function applyFromSource(ctx: Context, args: string[], heldOperationId?: string): Promise<boolean> {
  const jsonOnly = args.includes("--json");
  const dryRun = isApplyDryRun(args);
  const breakLock = args.includes("--break-lock");
  let expected: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json" || arg === "--dry-run" || arg === "--break-lock") continue;
    if (arg === "--set") {
      // Consumed by applyWithSource above; skipped here so its value is not read as a flag.
      index += 1;
      continue;
    }
    if (arg === "--expect") {
      expected = args[index + 1] ?? die("--expect needs a declaration checksum");
      index += 1; // the value, consumed here so the loop does not read it as a flag
      continue;
    }
    die(`unknown argument: ${arg}`);
  }

  const plan = await computePlan(ctx);

  // The declaration a caller planned against, if it named one. Checked before any step runs:
  // the value of the refusal is entirely in it happening first.
  if (expected !== undefined && expected !== plan.declarationChecksum) {
    die(
      "the declaration changed after that plan was computed — the steps in it were chosen " +
        "for a different version of this repository.\n" +
        `planned against ${expected}, now ${plan.declarationChecksum}\n` +
        "Look at the current one and apply that: ./clawforge plan",
    );
  }

  if (dryRun) {
    emitOrPrint(jsonOnly, plan, () => {
      log(`${plan.actions.length} step(s) would run — nothing was applied`);
      for (const action of plan.actions) info(`  ${action.advisory === true ? "(you)" : action.command}`);
    });
    return false;
  }

  const executable = plan.actions.filter((action) => action.advisory !== true);
  if (executable.length === 0) {
    // Nothing to record: an operation that changes nothing does not need a journal entry,
    // and writing one for every no-op apply would bury the runs that did something.
    //
    // But it still ends the same way as a run that did work. Returning here before the
    // blocking check was half a fix, and half is worse than none for a command whose own
    // help promises the stronger claim: an unhealthy gateway with nothing for the plan to
    // do reported success and exited zero.
    const outcome = await confirm(
      ctx,
      plan,
      plan.actions.map((action) => ({ id: action.id, status: "skipped" as const, detail: "advisory" })),
      false,
      "(none)",
    );
    report(jsonOnly, outcome, "nothing to apply");
    failOnRemainder(blockingRemainder(outcome.problems), outcome);
    return false;
  }

  // The lock first, and the journal only once it is held. A run refused here never started,
  // so it must not leave a record that reads as one: an entry with no outcome means "began
  // and we do not know how it ended", which is the state worth noticing, and filling the
  // journal with refusals would drown it.
  //
  // Held for the whole run rather than per step: what this prevents happens between the
  // steps — one run restarting the instance while another is halfway through provisioning
  // against it.
  const operationId = heldOperationId ?? newOperationId("apply");
  const held = heldOperationId === undefined ? await takeLock(ctx, "apply", operationId, { breakLock }) : undefined;

  // journal and outcome are assigned in the runOwning callback below; the code after the
  // finally runs only when that callback completed, because a throw inside it propagates.
  let journal!: Journal;
  let steps: StepOutcome[];
  let outcome!: ApplyOutcome;
  let failedStep: StepOutcome | undefined;
  let snapshot: string | undefined;
  let remaining: readonly { readonly code: string; readonly detail: string }[] = [];

  try {
    await runOwning(held, async () => {
      if (declarationChecksum(await currentComposition(ctx)) !== plan.declarationChecksum) {
        die("the declaration changed while preparing this apply — compute a new plan");
      }
      journal = await Journal.open(ctx, "apply", plan.deployment, operationId);
      // Before the first mutating step, not after one fails: a copy taken afterwards would be
      // a copy of the damage.
      snapshot = await snapshotConfig(ctx, journal.id);
      if (snapshot !== undefined) await journal.noteSnapshot(snapshot);

      steps = await runSteps(ctx, plan.actions, journal);
      failedStep = steps.find((step) => step.status === "failed");
      outcome = await confirm(ctx, plan, steps, steps.some((step) => step.status === "done"), journal.id);

      // Every step succeeding is not the claim this command makes. What it promises is that
      // the instance is now what the repository declares — so the confirming inspection has
      // the last word, and a run that ends with something blocking is a failed run whatever
      // its steps returned. Recorded that way too: a journal entry reading "succeeded" beside
      // an instance running an unapplied declaration is worse than no entry.
      remaining = blockingRemainder(outcome.problems);

      await journal.close(
        failedStep === undefined && remaining.length === 0 ? "succeeded" : "failed",
        failedStep !== undefined
          ? `stopped at "${failedStep.id}": ${failedStep.detail ?? "no detail"}`
          : remaining.length === 0
            ? undefined
            : `every step ran, but the instance still reports ${remaining.map((entry) => entry.code).join(", ")}`,
      );
    });
  } finally {
    await held?.release();
  }

  report(jsonOnly, outcome, undefined);

  if (failedStep !== undefined) {
    throw new Error(
      `step "${failedStep.id}" failed: ${failedStep.detail ?? "no detail"}\n` +
        `The instance is left as that step found it. What ran, and what did not: ` +
        `./clawforge operations ${journal.id}\n` +
        (snapshot === undefined
          ? "No configuration snapshot was taken, so there is nothing to roll back to."
          : `Put the previous configuration back: ./clawforge rollback --operation ${journal.id}`),
    );
  }

  failOnRemainder(remaining, outcome);
  return true;
}

/** The one place both paths end. A run that leaves the instance not doing its job is a
 *  failed run, whether it executed ten steps or none — which is the difference between
 *  "applied" and "working", and the only reason this command inspects afterwards at all. */
function failOnRemainder(
  remaining: readonly { readonly code: string; readonly detail: string }[],
  outcome: ApplyOutcome,
): void {
  if (remaining.length === 0) return;
  throw new Error(
    `the instance is not what this repository declares: ${remaining.map((entry) => entry.code).join(", ")}\n` +
      `${remaining.map((entry) => `  ${entry.code}  ${entry.detail}`).join("\n")}\n` +
      `Next: ${outcome.nextActions.join(", ")}`,
  );
}

/** Which codes mean "not doing its job". Derived from the one table rather than listed here
 *  again, so a code added there is covered without anyone remembering to come back. */
const BLOCKING = new Set(
  Object.entries(PROBLEM_CODES)
    .filter(([, meaning]) => meaning.severity === "blocking")
    .map(([code]) => code),
);

/** What the confirming inspection found that still means the instance is not what the
 *  repository declares.
 *
 *  Exported so the rule can be checked on its own: reaching it through apply() would need a
 *  planner, an inspector and a target, and the rule — "the inspection afterwards has the
 *  last word, not the steps" — is the entire fix. */
export function blockingRemainder(
  problems: readonly { readonly code: string; readonly detail: string }[],
): readonly { readonly code: string; readonly detail: string }[] {
  return problems.filter((entry) => BLOCKING.has(entry.code));
}

/** The stronger claim: inspect again and report what the instance actually is now. */
async function confirm(ctx: Context, plan: Plan, steps: StepOutcome[], changed: boolean, operationId: string): Promise<ApplyOutcome> {
  const after = await gatherInspection(ctx);
  return {
    deployment: plan.deployment,
    operationId,
    changed,
    healthy: isHealthy(after),
    steps,
    problems: after.problems.map((entry) => ({ code: entry.code, detail: entry.detail })),
    nextActions: nextActions(after.problems),
  };
}

function emitOrPrint(jsonOnly: boolean, payload: unknown, print: () => void): void {
  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  print();
}

function report(jsonOnly: boolean, outcome: ApplyOutcome, headline: string | undefined): void {
  emitOrPrint(jsonOnly, outcome, () => {
    if (headline !== undefined) log(`${outcome.deployment}: ${headline}`);
    for (const step of outcome.steps) {
      if (step.status === "done") info(`done     ${step.id}`);
      else if (step.status === "failed") warn(`failed   ${step.id}: ${step.detail ?? ""}`);
      else info(`skipped  ${step.id}${step.detail === undefined ? "" : ` (${step.detail})`}`);
    }

    // What the instance is now, not what the steps returned.
    if (outcome.healthy && outcome.problems.length === 0) {
      log(`${outcome.deployment} is what this repository declares`);
      return;
    }
    log(`${outcome.problems.length} problem(s) remain`);
    for (const entry of outcome.problems) warn(`${entry.code}  ${entry.detail}`);
    if (outcome.nextActions.length > 0) info(`next: ${outcome.nextActions.join(", ")}`);
  });
}
