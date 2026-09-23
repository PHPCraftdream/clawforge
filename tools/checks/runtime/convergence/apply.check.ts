// `./clawforge apply` — what it runs, what it refuses, and what it does after a step fails.
//
// The step runners themselves are the commands this framework already has and are covered
// where they live. What is new here, and what a coder is trusting when they type this, is
// the sequencing around them: stop at the first failure, say where it got to, and never
// perform an advisory step.

import { runSteps, blockingRemainder, isApplyDryRun, runnerFor, apply, TargetChangedError } from "#framework/commands/orchestration/apply.ts";
import type { ApplyOutcome, StepOutcome } from "#framework/commands/orchestration/apply.ts";
import { planActions } from "#framework/commands/orchestration/plan.ts";
import type { PlanAction } from "#framework/commands/orchestration/plan.ts";
import { problem, PROBLEM_CODES } from "#framework/service/inspection.ts";
import type { Inspection, Problem } from "#framework/service/inspection.ts";
import { Journal } from "#framework/service/operations.ts";
import type { OperationRecord } from "#framework/service/operations.ts";
import { operations } from "#framework/commands/orchestration/operations.ts";
import { useDeployment, useComposeProjectOverride } from "#framework/runtime/deployment.ts";
import { setupFixtureDeployment, teardownFixtureDeployment, DATA } from "./inspect/fixture.ts";
import { refreshCheckTransport, refreshLiveConfig } from "../connection-facts/apply-driver.ts";
import type { RefreshState } from "../connection-facts/apply-driver.ts";
import { mkdir, mkdtemp, readFile, readdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContext, refreshContext } from "#framework/core/context.ts";
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
    problem("RECIPE_MIRROR_DRIFT", "demo differs", "./clawforge provision-agent demo"),
    problem("SET_OBJECT_ORPHANED", "cron job left over", "./clawforge set forget --kind cron-job --name demo-refresh"),
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

// --- recovery steps in a real run: journal, refusal, dry run ----------------------------------
//
// recover-env is the one runner that can genuinely succeed in this harness (it needs a real
// .env and a stub runtime answer, no instance), so it is the vehicle for the claims the
// other sections cannot reach: a "done" step, and the steps landing in the journal under
// ONE operation id that ./clawforge operations reads back.

/** A transport backed by the real filesystem, rooted at nothing — every path it is given is
 *  already absolute. Enough of the contract for the journal and the operations command. */
function localTransport(): {
  mkdirp(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  listFiles(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
} {
  return {
    async mkdirp(path) { await mkdir(path, { recursive: true }); },
    async writeFile(path, content) { await writeFile(path, content, "utf8"); },
    async readFile(path) { return readFile(path, "utf8"); },
    async exists(path) { return access(path).then(() => true, () => false); },
    async listFiles(path) {
      return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
    },
    async remove(path) { await rm(path, { force: true }); },
  };
}

{
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-apply-recovery-check-"));
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    await mkdir(resolve(deployment, "secrets"), { recursive: true });
    // One stale fact among matching ones, and a token whose VALUE nothing may assert about —
    // only that the line survives the merge untouched. The port both sides carry differently
    // is the P2-03 round-3 case: a planned run must not choose a direction for it.
    const envBefore = [
      "OC_DATA_DIR=/srv/clawforge/data",
      "OPENCLAW_GATEWAY_PORT=9999",
      "OC_COMPOSE_PROJECT=recovery-check",
      "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable",
      "OPENCLAW_GATEWAY_TOKEN=tok-apply-check-value",
      "",
    ].join("\n");
    await writeFile(resolve(deployment, ".env"), envBefore, "utf8");
    const declarationBefore = JSON.stringify([{ path: "gateway.mode", value: "local" }]);
    await writeFile(resolve(deployment, "config", "desired-state.json"), declarationBefore, "utf8");
    const storeBefore = "OPENCLAW_GATEWAY_TOKEN=stored-gateway-token\n";
    await writeFile(resolve(deployment, "secrets", "local.env"), storeBefore, "utf8");
    useDeployment(deployment);

    const ctx = {
      settings: { dataDir: resolve(deployment, "data") },
      transport: localTransport(),
      runtime: {
        runningConnectionFacts: async () => ({
          dataDir: "/srv/clawforge/data",
          port: "18790",
          composeProject: "recovery-check",
          image: "ghcr.io/openclaw/openclaw:extended-stable",
        }),
      },
    } as unknown as Context;

    // The plan shape a combined recovery produces: the dump's --force refusal is provoked
    // for real — the declaration and the store both EXIST here, which is exactly the state
    // the finding warns about and the command refuses to overwrite.
    const actions: PlanAction[] = [
      { id: "recover-env", summary: "recover-env", command: "./clawforge recover-env", because: ["ENV_STALE"] },
      { id: "reconnect-mcp", summary: "reconnect-mcp", because: ["MCP_RESTART_REQUIRED"], advisory: true },
      { id: "apply-config-dump", summary: "apply-config-dump", command: "./clawforge apply-config --dump", because: ["DECLARATION_MISSING"] },
      { id: "up", summary: "up", command: "./clawforge up", because: ["GATEWAY_DOWN"] },
    ];

    const journal = await Journal.open(ctx, "apply", "recovery-check");
    let outcomes: { id: string; status: string; detail?: string }[] = [];
    await withOutputSink(
      () => {},
      async () => { outcomes = await runSteps(ctx, actions, journal); },
    );
    await journal.close("failed", "stopped at apply-config-dump");

    // The runner here is deliberately the BARE (safe) form: it fills what .env is missing
    // entirely and never picks the direction for facts both sides carry (P2-03, round 3) —
    // which is why a diverged port survives it.
    check("the recovery step really runs and reports done", outcomes[0], { id: "recover-env", status: "done" });
    check("the diverged port is NOT written over — the direction is the operator's, not a planned run's", (await readFile(resolve(deployment, ".env"), "utf8")).includes("OPENCLAW_GATEWAY_PORT=18790"), false);
    check("the file keeps the port it started with", (await readFile(resolve(deployment, ".env"), "utf8")).includes("OPENCLAW_GATEWAY_PORT=9999"), true);
    check("and the token line passes through untouched", (await readFile(resolve(deployment, ".env"), "utf8")).includes("OPENCLAW_GATEWAY_TOKEN=tok-apply-check-value"), true);
    check("the refusal is a failed step, not a silent pass", [outcomes[2].id, outcomes[2].status], ["apply-config-dump", "failed"]);
    check("the refusal names the file and the way past it", [(outcomes[2].detail ?? "").includes("already exists"), (outcomes[2].detail ?? "").includes("--force")], [true, true]);
    check("the refused dump leaves the declaration byte-identical", await readFile(resolve(deployment, "config", "desired-state.json"), "utf8"), declarationBefore);
    check("what did not run is blocked, and says so", outcomes[3], { id: "up", status: "blocked", detail: "an earlier step failed" });

    // One operation id for the whole run, readable back through the operations command.
    let listed = "";
    await withOutputSink((chunk) => { listed += chunk; }, async () => { await operations(ctx, [journal.id, "--json"]); });
    const record = JSON.parse(listed) as OperationRecord;
    check("operations reads the run back under the one operation id", record.id, journal.id);
    check("the recorded steps are the run's steps, in order", record.steps.map((step) => ({ id: step.id, status: step.status })), outcomes.map((step) => ({ id: step.id, status: step.status })));
    check("and the record is a single apply operation", [record.command, record.outcome], ["apply", "failed"]);

    // The same contract for the store dump's runner, hand-planned executable: it must refuse
    // the existing store rather than overwrite it, and leave it byte-identical.
    let storeRefusal: { id: string; status: string; detail?: string }[] = [];
    await withOutputSink(
      () => {},
      async () => {
        storeRefusal = await runSteps(ctx, [{ id: "secrets-dump", summary: "secrets-dump", command: "./clawforge secrets --dump", because: ["STORE_INCOMPLETE"] }]);
      },
    );
    check("the store refusal is a failed step too", storeRefusal.map((step) => [step.id, step.status]), [["secrets-dump", "failed"]]);
    check("it names the store and --force", [(storeRefusal[0].detail ?? "").includes("already exists"), (storeRefusal[0].detail ?? "").includes("--force")], [true, true]);
    check("and the store survives byte-identical", await readFile(resolve(deployment, "secrets", "local.env"), "utf8"), storeBefore);
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
}

// --- --dry-run writes nothing -----------------------------------------------------------------
//
// apply --dry-run computes the plan (so the recovery steps are IN it) and stops before any
// runner. Asserted against a real deployment folder holding all three recovery findings.

{
  const { deployment, goodChecksums, stubContext } = await setupFixtureDeployment();
  try {
    const envPath = join(deployment, ".env");
    const storePath = join(deployment, "secrets", "local.env");
    const declarationPath = join(deployment, "config", "desired-state.json");
    const staleEnv = [
      "OC_DATA_DIR=/srv/clawforge/data",
      "OPENCLAW_GATEWAY_PORT=9999",
      "OC_COMPOSE_PROJECT=folder-check",
      "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable",
      "OPENCLAW_GATEWAY_TOKEN=tok-dry-run-value",
      "",
    ].join("\n");
    await writeFile(envPath, staleEnv, "utf8");
    await mkdir(resolve(deployment, "secrets"), { recursive: true });
    await writeFile(storePath, "OPENCLAW_GATEWAY_TOKEN=stored-gateway-token\n", "utf8");
    await rm(declarationPath, { force: true });

    const spec = { targetEnv: "ZAI_API_KEY=k\nOPENCLAW_GATEWAY_TOKEN=stored-gateway-token\n", mirrorChecksums: goodChecksums };
    const base = stubContext(spec);
    const ctx = { ...base, runtime: { ...base.runtime, runningConnectionFacts: async () => ({ dataDir: "/srv/clawforge/data", port: "18790", composeProject: "folder-check", image: "ghcr.io/openclaw/openclaw:extended-stable" }) } } as unknown as Context;

    const envBefore = await readFile(envPath, "utf8");
    const storeBefore = await readFile(storePath, "utf8");
    let output = "";
    let threw = false;
    await withOutputSink((chunk) => { output += chunk; }, async () => {
      try { await apply(ctx, ["--dry-run"]); } catch { threw = true; }
    });
    check("a dry run over a three-finding folder does not throw", threw, false);
    check("it names all three recovery steps as what would run", [output.includes("recover-env"), output.includes("secrets-dump"), output.includes("apply-config-dump")], [true, true, true]);
    // Under the sink the dry run's answer is the plan itself — emitOrPrint emits the JSON
    // and never runs the terminal print that says "nothing was applied". The same fact is
    // asserted in the shape the sink actually receives: the whole plan, exactly the three
    // recovery steps — and the byte-identical files below are the other half of the claim.
    const planned = JSON.parse(output) as { actions: { id: string; advisory?: boolean }[] };
    check("the answer is the plan itself, exactly those three, so nothing was applied", planned.actions.map((action) => action.id), ["recover-env", "secrets-dump", "apply-config-dump"]);
    check("the .env and store steps are advisory in the plan itself", planned.actions.slice(0, 2).map((action) => action.advisory), [true, true]);
    check("the declaration dump is the plan's one executable step", planned.actions[2].advisory ?? false, false);
    check("the stale .env is untouched", await readFile(envPath, "utf8"), envBefore);
    check("the store is untouched", await readFile(storePath, "utf8"), storeBefore);
    check("no declaration appeared", await access(declarationPath).then(() => true, () => false), false);
  } finally {
    await teardownFixtureDeployment(deployment);
  }
}

// --- a composite run keeps up with its own .env rewrites (P2-03) ------------------------------
//
// recover-env and secrets --apply rewrite the deployment .env mid-run — the file the Context
// was built from at process start. Every later step used to keep interpolating that stale
// snapshot: an `up` after `secrets` died in preflightSecrets because its settings.env had no
// token yet. The scenarios below drive the real apply()/runSteps over a real createContext() —
// stubbed only at the transport/docker layer, the seam a hand-built Context cannot reach.


{
  const { deployment, goodChecksums, goodPrompts } = await setupFixtureDeployment();
  try {
    // Deliberately no OPENCLAW_GATEWAY_TOKEN: the run must install it from the store mid-flight.
    await writeFile(resolve(deployment, ".env"), [
      "OC_DATA_DIR=/srv/clawforge/data",
      "OPENCLAW_GATEWAY_PORT=18789",
      "OC_COMPOSE_PROJECT=refresh-check",
      "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable",
      "",
    ].join("\n"), "utf8");
    await mkdir(resolve(deployment, "secrets"), { recursive: true });
    await writeFile(resolve(deployment, "secrets", "local.env"), "OPENCLAW_GATEWAY_TOKEN=stored-refresh-token-value\nZAI_API_KEY=zai-refresh-key-value\n", "utf8");

    const state: RefreshState = { files: new Map(), composeEnvWrites: [], dockerCalls: [], running: false };
    const ctx = await createContext({
      transport: refreshCheckTransport({ liveConfig: refreshLiveConfig(), mirrorChecksums: goodChecksums, prompts: goodPrompts }, state),
      service: { name: "gateway" },
      settings: () => ({ OC_APP_COMPUTED: "from-app-definition" }),
    });
    check("the process-start context predates the store (the bug's precondition)", ctx.settings.env.OPENCLAW_GATEWAY_TOKEN === undefined, true);

    let machine = "";
    let threw: unknown;
    await withOutputSink(() => {}, async () => {
      try { await apply(ctx, []); } catch (error) { threw = error; }
    }, (chunk) => { machine += chunk; });
    check("the whole run does not throw", threw === undefined, true);
    const outcome = JSON.parse(machine) as ApplyOutcome;
    // A stopped instance with SECRET_MISSING + GATEWAY_DOWN plans exactly these two — which
    // also pins that no recovery step leaked in. Without the refresh the `up` step dies in
    // preflightSecrets: its stale settings.env has no token.
    check("secrets then up both ran — the second on the refreshed context", outcome.steps.map((step) => [step.id, step.status]), [["secrets", "done"], ["up", "done"]]);
    check("and the confirming inspection finds the instance healthy", outcome.healthy, true);
    check("the run is recorded under one operation id", typeof outcome.operationId === "string" && outcome.operationId !== "", true);

    check("the secrets step really wrote the token into the deployment .env", (await readFile(resolve(deployment, ".env"), "utf8")).includes("OPENCLAW_GATEWAY_TOKEN=stored-refresh-token-value"), true);
    // #withEnvFile writes compose.env immediately before each docker exec, so the write whose
    // index equals the number of compose calls before the "up" call is what `up` interpolated.
    const upCall = state.dockerCalls.findIndex((args) => args.includes("up"));
    const upEnv = state.composeEnvWrites[state.dockerCalls.slice(0, upCall).filter((args) => args[0] === "compose").length];
    check("the up step's compose env carries the freshly installed token", upEnv?.includes("stored-refresh-token-value") ?? false, true);
    check("and the app-computed variable a bare .env re-read would drop", upEnv?.includes("OC_APP_COMPUTED") ?? false, true);
    check("the env composed before the rewrite had no token — the context was stale", state.composeEnvWrites[0]?.includes("stored-refresh-token-value") ?? true, false);

    let recordJson = "";
    await withOutputSink(() => {}, async () => { await operations(ctx, [outcome.operationId, "--json"]); }, (chunk) => { recordJson += chunk; });
    const record = JSON.parse(recordJson) as OperationRecord;
    check("operations reads the run back as succeeded", record.outcome, "succeeded");
    check("its recorded steps are the run's steps, in order", record.steps.map((step) => [step.id, step.status]), [["secrets", "done"], ["up", "done"]]);
  } finally {
    // createContext pins OC_COMPOSE_PROJECT process-wide; the checks share one process.
    useComposeProjectOverride(undefined);
    await teardownFixtureDeployment(deployment);
  }
}

{
  const { deployment, goodChecksums, goodPrompts } = await setupFixtureDeployment();
  try {
    // Half-filled .env: no OPENCLAW_GATEWAY_PORT at all (the file the operator lost part of),
    // and a dataDir the container disagrees with. The token is already here — the steps below
    // are about the target move, not about secrets.
    await writeFile(resolve(deployment, ".env"), [
      "OC_DATA_DIR=/srv/clawforge/data",
      "OC_COMPOSE_PROJECT=refresh-check",
      "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable",
      "OPENCLAW_GATEWAY_TOKEN=env-refresh-token-value",
      "",
    ].join("\n"), "utf8");
    await mkdir(resolve(deployment, "secrets"), { recursive: true });
    await writeFile(resolve(deployment, "secrets", "local.env"), "OPENCLAW_GATEWAY_TOKEN=stored-refresh-token-value\nZAI_API_KEY=zai-refresh-key-value\n", "utf8");

    const state: RefreshState = {
      files: new Map(),
      composeEnvWrites: [],
      dockerCalls: [],
      running: true,
      facts: {
        Image: "sha256:fixture-image",
        State: { Running: true },
        Mounts: [{ Destination: "/home/node/.openclaw", Source: "/srv/clawforge/data-actual/config" }],
        NetworkSettings: { Ports: { "18789/tcp": [{ HostPort: "18790" }] } },
        Config: { Labels: { "com.docker.compose.project": "refresh-check", Image: "ghcr.io/openclaw/openclaw:extended-stable" } },
      },
    };
    state.files.set(`${DATA}/config/.env`, "ZAI_API_KEY=zai-b-key-value\n");
    const ctx = await createContext({
      transport: refreshCheckTransport({
        liveConfig: refreshLiveConfig({ gateway: { mode: "remote", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } } }),
        mirrorChecksums: goodChecksums,
        prompts: goodPrompts,
      }, state),
      service: { name: "gateway" },
      settings: () => ({ OC_APP_COMPUTED: "from-app-definition" }),
    });
    check("the run starts on the coordinates the plan and lock were taken for", ctx.settings.dataDir, "/srv/clawforge/data");

    // Planning no longer adds an executable recover-env for a diverged .env (P2-03, round 3):
    // whether the container's facts or the file's are authoritative is the operator's call, so
    // the plan names both directions instead of picking one. What this scenario pins is the
    // machinery UNDER that decision — a step that does write .env re-derives the Context, and
    // a step that moves the target stops the run — driven with the steps such a run sees. The
    // recover-env runner here is the real one, and the divergence is shaped so the bare
    // (safe) form still fires it: the port is MISSING from the file, which is the one case a
    // planned recovery fills; the dataDir both sides carry differently is left alone.
    const actions: PlanAction[] = [
      { id: "recover-env", summary: "recover-env", command: "./clawforge recover-env", because: ["ENV_STALE"] },
      { id: "apply-config", summary: "apply-config", command: "./clawforge apply-config", because: ["CONFIG_DRIFT"] },
      { id: "restart", summary: "restart", command: "./clawforge restart", because: ["CONFIG_DRIFT"] },
    ];

    const journal = await Journal.open(ctx, "apply", "refresh-check");
    let steps: StepOutcome[] = [];
    let threw: unknown;
    await withOutputSink(() => {}, async () => {
      try {
        steps = await runSteps(ctx, actions, journal, { current: ctx });
      } catch (error) {
        threw = error;
        if (error instanceof TargetChangedError) steps = error.outcomes;
      }
      await journal.close(
        threw === undefined ? "succeeded" : "failed",
        threw instanceof TargetChangedError
          ? `stopped after "${threw.stepId}": the deployment target changed (${threw.changes.join(", ")})`
          : undefined,
      );
    });

    const message = threw instanceof Error ? threw.message : "";
    check("the run stops after the recovery moved the target", threw instanceof TargetChangedError, true);
    check("it points at a fresh apply", [message.includes("changed the deployment target"), message.includes("gatewayPort"), message.includes("Re-run ./clawforge apply")], [true, true, true]);
    check("the recovery ran; everything planned for the old target is blocked", steps.map((step) => [step.id, step.status]), [["recover-env", "done"], ["apply-config", "blocked"], ["restart", "blocked"]]);
    check("each blocked step names the moved target", [steps[1].detail?.includes("target changed"), steps[1].detail?.includes("gatewayPort")], [true, true]);

    const envNow = await readFile(resolve(deployment, ".env"), "utf8");
    check("the missing port fact is filled from the container — the unambiguous case", envNow.includes("OPENCLAW_GATEWAY_PORT=18790"), true);
    check("the diverged dataDir is NOT written over — that direction is the operator's", envNow.includes("OC_DATA_DIR=/srv/clawforge/data-actual"), false);
    check("and the file keeps the dataDir it started with", envNow.includes("OC_DATA_DIR=/srv/clawforge/data"), true);
    check("the token line passes through untouched", envNow.includes("OPENCLAW_GATEWAY_TOKEN=env-refresh-token-value"), true);
    check("nothing after the recovery executed against any coordinates", state.dockerCalls.every((args) => !(args.includes("up") || args.includes("restart"))), true);

    // The journal was written under the ORIGINAL dataDir path, so the original ctx reads it.
    let recordJson = "";
    await withOutputSink(() => {}, async () => { await operations(ctx, [journal.id, "--json"]); }, (chunk) => { recordJson += chunk; });
    const record = JSON.parse(recordJson) as OperationRecord;
    check("operations reads the stopped run back as failed", record.outcome, "failed");
    check("and its note says why", record.note?.includes("the deployment target changed") ?? false, true);
  } finally {
    useComposeProjectOverride(undefined);
    await teardownFixtureDeployment(deployment);
  }
}

// --- composeProject is a target coordinate, pinned directly -----------------------------------
//
// The compose-project branch in refreshContext's targetChanges is a three-line one-off next
// to the tidy TARGET_FIELDS array — exactly the shape a cleanup deletes, and a changed
// Compose project is a different set of containers, as much a different target as a changed
// dataDir. Nothing else in the run machinery is needed for that claim, so it is pinned on
// the one function that carries it, with a before/after .env differing in that one fact.

{
  const { deployment } = await setupFixtureDeployment();
  try {
    const envBody = (project: string) => [
      "OC_DATA_DIR=/srv/clawforge/data",
      "OPENCLAW_GATEWAY_PORT=18789",
      `OC_COMPOSE_PROJECT=${project}`,
      "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable",
      "",
    ].join("\n");
    await writeFile(resolve(deployment, ".env"), envBody("refresh-check"), "utf8");
    const ctx = await createContext({
      transport: refreshCheckTransport({ liveConfig: refreshLiveConfig(), mirrorChecksums: {}, prompts: {} }, { files: new Map(), composeEnvWrites: [], dockerCalls: [], running: false }),
      service: { name: "gateway" },
    });
    await writeFile(resolve(deployment, ".env"), envBody("refresh-check-actual"), "utf8");
    const moved = await refreshContext(ctx);
    check("a refresh sees the rewritten project name", moved?.changed, ["OC_COMPOSE_PROJECT"]);
    check("and counts it as a moved target, like a changed dataDir", moved?.targetChanges, ["composeProject"]);

    // Refreshing from the REFRESHED context: the creation record must chain through
    // refreshContext too, or the second refresh would find nothing to re-derive. The
    // comparison is always against the context handed in, so moving back is itself a
    // move — only the settled context, refreshed with the file left alone, is none.
    await writeFile(resolve(deployment, ".env"), envBody("refresh-check"), "utf8");
    const settled = await refreshContext(moved!.context);
    check("refreshing back onto the original name moves the target again", settled?.targetChanges, ["composeProject"]);
    const stable = await refreshContext(settled!.context);
    check("and a refresh with nothing rewritten is no target change", stable?.targetChanges, []);
  } finally {
    useComposeProjectOverride(undefined);
    await teardownFixtureDeployment(deployment);
  }
}

process.stderr.write(failed === 0 ? "all apply checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
