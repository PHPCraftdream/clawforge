// `./clawforge apply` keeping up with its own .env rewrites: a composite run re-derives its
// Context after recover-env / secrets --apply, stops when a step moves the deployment target,
// and refreshContext() counts a changed Compose project as a moved target.

import { runSteps, TargetChangedError } from "#framework/commands/orchestration/apply.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import type { ApplyOutcome, StepOutcome } from "#framework/commands/orchestration/apply.ts";
import type { PlanAction } from "#framework/commands/orchestration/plan.ts";
import { Journal } from "#framework/service/operations.ts";
import type { OperationRecord } from "#framework/service/operations.ts";
import { useComposeProjectOverride } from "#framework/runtime/deployment.ts";
import { setupFixtureDeployment, teardownFixtureDeployment, DATA } from "#checks/runtime/convergence/inspect/fixture.ts";
import { refreshCheckTransport, refreshLiveConfig } from "#checks/runtime/connection-facts/apply-driver.ts";
import type { RefreshState } from "#checks/runtime/connection-facts/apply-driver.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createContext, refreshContext } from "#framework/core/context.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";

// --- a composite run keeps up with its own .env rewrites ---------------------------------------
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
      try { await orchestrationCommands.apply.run(ctx, []); } catch (error) { threw = error; }
    }, (chunk) => { machine += chunk; });
    check("the whole run does not throw", threw === undefined, true);
    const outcome = JSON.parse(machine) as ApplyOutcome;
    // A stopped instance with SECRET_MISSING + GATEWAY_DOWN plans exactly these two
    // executable steps — which also pins that no recovery step leaked in. Without the
    // refresh the `up` step dies in preflightSecrets: its stale settings.env has no token.
    // The fixture's own OPENCLAW_IMAGE names a tag rather than a digest, so IMAGE_UNPINNED
    // is real too, and this transport's `test` always answers "does not exist" (line ~100
    // above), so the backup directory reads as never created too — BACKUP_MISSING is real
    // the same way. Both recorded as their own advisory step, run for nothing.
    check("secrets then up both ran — the second on the refreshed context", outcome.steps.map((step) => [step.id, step.status]), [["secrets", "done"], ["up", "done"], ["problem:IMAGE_UNPINNED", "advisory"], ["problem:BACKUP_MISSING", "advisory"]]);
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
    await withOutputSink(() => {}, async () => { await orchestrationCommands.operations.run(ctx, [outcome.operationId, "--json"]); }, (chunk) => { recordJson += chunk; });
    const record = JSON.parse(recordJson) as OperationRecord;
    check("operations reads the run back as succeeded", record.outcome, "succeeded");
    check("its recorded steps are the run's steps, in order", record.steps.map((step) => [step.id, step.status]), [["secrets", "done"], ["up", "done"], ["problem:IMAGE_UNPINNED", "advisory"], ["problem:BACKUP_MISSING", "advisory"]]);
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

    // Planning no longer adds an executable recover-env for a diverged .env:
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
    await withOutputSink(() => {}, async () => { await orchestrationCommands.operations.run(ctx, [journal.id, "--json"]); }, (chunk) => { recordJson += chunk; });
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

finish("apply refresh");
