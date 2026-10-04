// `./clawforge apply` with recovery steps in a real run: the journal and the one operation id,
// the --force refusals of the declaration and store dumps, --dry-run writing nothing, and the
// step renderer apply's dry run shares with `plan`.

import { runSteps } from "#framework/commands/orchestration/apply.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import { planActions, printPlanActions, planSummaryLine } from "#framework/commands/orchestration/plan.ts";
import type { PlanAction } from "#framework/commands/orchestration/plan.ts";
import { declarationExistsRefusal } from "#framework/commands/orchestration/config.ts";
import { storeExistsRefusal } from "#framework/commands/management/secrets.ts";
import { problem } from "#framework/service/inspection.ts";
import { Journal } from "#framework/service/operations.ts";
import type { OperationRecord } from "#framework/service/operations.ts";
import { useDeployment, desiredStateFile, secretStoreFile } from "#framework/runtime/deployment.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "#checks/runtime/convergence/inspect/fixture.ts";
import { mkdir, mkdtemp, readFile, readdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "#framework/core/context.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";

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
    // is the direction-ambiguous case: a planned run must not choose a direction for it.
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
        isRunning: async () => true,
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
    // entirely and never picks the direction for facts both sides carry —
    // which is why a diverged port survives it.
    check("the recovery step really runs and reports done", outcomes[0], { id: "recover-env", status: "done" });
    check("the diverged port is NOT written over — the direction is the operator's, not a planned run's", (await readFile(resolve(deployment, ".env"), "utf8")).includes("OPENCLAW_GATEWAY_PORT=18790"), false);
    check("the file keeps the port it started with", (await readFile(resolve(deployment, ".env"), "utf8")).includes("OPENCLAW_GATEWAY_PORT=9999"), true);
    check("and the token line passes through untouched", (await readFile(resolve(deployment, ".env"), "utf8")).includes("OPENCLAW_GATEWAY_TOKEN=tok-apply-check-value"), true);
    check("the refusal is a failed step, not a silent pass", [outcomes[2].id, outcomes[2].status], ["apply-config-dump", "failed"]);
    check("the refusal names the file and the way past it", [(outcomes[2].detail ?? "").includes(declarationExistsRefusal(desiredStateFile())), (outcomes[2].detail ?? "").includes("--force")], [true, true]);
    check("the refused dump leaves the declaration byte-identical", await readFile(resolve(deployment, "config", "desired-state.json"), "utf8"), declarationBefore);
    check("what did not run is blocked, and says so", outcomes[3], { id: "up", status: "blocked", detail: "an earlier step failed" });

    // One operation id for the whole run, readable back through the operations command.
    let listed = "";
    await withOutputSink((chunk) => { listed += chunk; }, async () => { await orchestrationCommands.operations.run(ctx, [journal.id, "--json"]); });
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
    check("it names the store and --force", [(storeRefusal[0].detail ?? "").includes(storeExistsRefusal(secretStoreFile("local"))), (storeRefusal[0].detail ?? "").includes("--force")], [true, true]);
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
      try { await orchestrationCommands.apply.run(ctx, ["--dry-run"]); } catch { threw = true; }
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

// --- apply --dry-run shares plan's own step renderer --------------------------------------------
//
// The bug this closes: dry-run counted every action, advisory included, as "would run", and
// printed the literal "(you)" with no text for an advisory step, while `plan` printed the
// executable count and the step's own summary for the very same plan. printPlanActions() is
// the one renderer both commands call now (apply.ts's dry-run block and plan.ts's own print),
// so a divergence between the two is no longer possible to write — pinned here directly against
// the renderer, since a captured run always answers dry-run in JSON (below), never this text.

{
  // Unbootstrapped-like: the one step a never-bootstrapped deployment plans, wholly advisory.
  const advisoryText = "this deployment has never been bootstrapped";
  const onlyAdvisory = planActions({
    declared: { deployment: "example", config: [], image: "example/image:tag", recipes: [] },
    observed: { running: false, health: undefined, probes: {}, config: {}, secrets: [], agents: [], mcpServers: [], cronJobs: [], foreignObjects: [] },
    problems: [problem("NOT_BOOTSTRAPPED", advisoryText)],
  });
  let out = "";
  await withOutputSink((chunk) => { out += chunk; }, async () => { printPlanActions(onlyAdvisory); });
  check("an all-advisory plan counts zero executable, not the action count", out.includes(planSummaryLine(1, 0)), true);
  check("and the advisory step's own text is printed, not silently dropped", out.includes(advisoryText), true);
  check("the advisory marker still appears alongside the text", out.includes("(you)"), true);
}

{
  const mixed: PlanAction[] = [
    { id: "secrets", summary: "install the missing secrets on the target", command: "./clawforge secrets --apply", because: ["SECRET_MISSING"] },
    { id: "lock", summary: "review the difference from the lock, then run ./clawforge lock to re-pin it deliberately", because: ["LOCK_DRIFT"], advisory: true },
  ];
  let out = "";
  await withOutputSink((chunk) => { out += chunk; }, async () => { printPlanActions(mixed); });
  check("a mixed plan counts exactly its executable steps", out.includes(planSummaryLine(2, 1)), true);
  check("the executable step's own command is printed", out.includes(mixed[0]?.command ?? ""), true);
  check("the advisory step prints its own text instead of the executable step's command", out.includes(mixed[1]?.summary ?? ""), true);
}

{
  let out = "";
  await withOutputSink((chunk) => { out += chunk; }, async () => { printPlanActions([]); });
  check("an empty plan states zero of zero", out.includes(planSummaryLine(0, 0)), true);
}

finish("apply recovery");
