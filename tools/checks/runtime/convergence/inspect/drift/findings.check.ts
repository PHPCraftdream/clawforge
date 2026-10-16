// `./clawwright inspect` — one finding per situation: a stopped instance, CONFIG_DRIFT,
// SECRET_MISSING, PROVIDER_MISSING, RESTART_REQUIRED (with its fractional-mtime edge cases) and
// RECIPE_MIRROR_DRIFT for prompts. See ../fixture.ts for the shared stub.

import { gatherInspection, renderJson } from "#framework/commands/orchestration/inspect/gather.ts";
import { planActions } from "#framework/commands/orchestration/plan.ts";
import { setupFixtureDeployment, teardownFixtureDeployment, codes } from "#checks/runtime/convergence/inspect/fixture.ts";
import { check, finish } from "#checks/kit/harness.ts";

const { deployment, goodChecksums, goodPrompts, stubContext } = await setupFixtureDeployment();

// The scenarios are independent — each builds its own stub Context and gatherInspection only
// reads the fixture's on-disk deployment, never writes it — so they run concurrently. What
// overlaps is the product's lazy module loading behind the first gathers; check() writes whole
// lines and never throws, so interleaved output changes order only.
const scenarios: (() => Promise<void>)[] = [
  async () => {
    // --- one finding per situation ---

    const inspection = await gatherInspection(stubContext({ running: false }));
    check("a stopped instance reports being down", codes(inspection.problems).includes("GATEWAY_DOWN"), true);
    // The value of the single clear finding: nothing that NEEDS the instance is attempted,
    // so the reader is not handed a dozen consequences of the one cause.
    check("and nothing that needs it is attempted", codes(inspection.problems), ["GATEWAY_DOWN", "SECRET_MISSING"]);
    check("a stopped instance is not healthy", renderJson(inspection).healthy, false);

    // But the configuration IS compared: openclaw.json is a file on the target, readable
    // whether or not anything is serving. Skipping it because the gateway was down produced
    // a plan of just [up], which started the instance on a configuration nobody had applied
    // — and apply then reported success.
    const drifted = await gatherInspection(
      stubContext({
        running: false,
        targetEnv: "ZAI_API_KEY=k\n",
        liveConfig: {
          gateway: { mode: "remote", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
          agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
        },
      }),
    );
    check("drift is found on a stopped instance too", codes(drifted.problems), ["CONFIG_DRIFT", "GATEWAY_DOWN"]);
    check("and the live values are reported", drifted.observed.config["gateway.mode"], "remote");

    const configDrift = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        liveConfig: {
          gateway: { mode: "remote", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
          agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
        },
      }),
    );
    const drift = configDrift.problems.find((entry) => entry.code === "CONFIG_DRIFT");
    check("exactly the changed setting is reported", configDrift.problems.length, 1);
    check("a differing declared value is drift", drift !== undefined, true);
    check("the detail names only the path and mismatch", drift?.detail, "configuration differs at gateway.mode");
    check("the remedy is the one command that fixes it", drift?.nextAction, "./clawwright apply");

    // No <data>/config/.env at all: the provider key has nowhere to come from.
    const noEnv = await gatherInspection(stubContext({ mirrorChecksums: goodChecksums }));
    const secret = noEnv.problems.find((entry) => entry.code === "SECRET_MISSING");
    check("a missing provider key is found", secret?.detail.includes("ZAI_API_KEY"), true);
    check("and it says where the value belongs", secret?.detail.includes("<data>/config/.env"), true);
  },

  async () => {
    // --- no model provider configured at all ---

    // "OpenClaw is up" after a bootstrap with no provider key: the gateway container runs
    // and answers every probe, but an agent cannot answer a single prompt. Read from the
    // live config the way secrets.ts's own collectConfiguredProviders does, not guessed
    // from which env vars happen to be set.
    const noneConfigured = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        liveConfig: {
          gateway: { mode: "local", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
          agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
          models: { providers: {} },
        },
      }),
    );
    check("no provider configured is reported", codes(noneConfigured.problems), ["PROVIDER_MISSING"]);
    const finding = noneConfigured.problems.find((entry) => entry.code === "PROVIDER_MISSING");
    check("it is a warning — detection cannot see env-keyed, subscription or CLI-backend providers", finding?.severity, "warning");
    check("the remedy is configure-provider", finding?.nextAction, "./clawwright configure-provider");

    // A provider named only through auth.profiles (never models.providers) still counts —
    // collectConfiguredProviders() reads both, and this must not re-derive its own guess.
    const viaProfiles = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        liveConfig: {
          gateway: { mode: "local", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
          agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
          models: { providers: {} },
          auth: { profiles: { "my-zai": { provider: "zai" } } },
        },
      }),
    );
    check("a provider named only through auth.profiles is still configured", codes(viaProfiles.problems).includes("PROVIDER_MISSING"), false);

    // The default fixture config already declares models.providers.zai — the ordinary,
    // configured case must never carry this finding.
    const configured = await gatherInspection(stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }));
    check("a configured provider carries no PROVIDER_MISSING", codes(configured.problems).includes("PROVIDER_MISSING"), false);
  },

  async () => {
    // --- RESTART_REQUIRED and its fractional-mtime edge cases ---

    // Configuration written after the instance started: correct on disk, not yet in force.
    const newer = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, startedAtMs: 1_000_000, configMtimeSeconds: 2_000 }),
    );
    check("config newer than the running instance asks for a restart", codes(newer.problems), ["RESTART_REQUIRED"]);
    check("the remedy is restart, not up", newer.problems[0]?.nextAction, "./clawwright restart");

    const afterFractional = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.100Z"),
      configMtimeOutput: "2026-09-16 12:00:00.900000000 +0000",
    }));
    check("fractional mtime after startup in the same second requires restart", codes(afterFractional.problems), ["RESTART_REQUIRED"]);
    check("the plan includes restart for a fractional mtime", planActions(afterFractional).map((action) => action.id), ["restart"]);

    const beforeFractional = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.900Z"),
      configMtimeOutput: "2026-09-16 12:00:00.100000000 +0000",
    }));
    check("fractional mtime before startup in the same second is already in force", codes(beforeFractional.problems), []);

    const equalFractional = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.900Z"),
      configMtimeOutput: "2026-09-16 12:00:00.900000000 +0000",
    }));
    check("equal fractional mtime and startup time does not require restart", codes(equalFractional.problems), []);

    const tzFractional = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T10:00:00.500Z"),
      configMtimeOutput: "2026-09-16 12:00:00.600000000 +0200",
    }));
    check("fractional mtime honors its explicit timezone", codes(tzFractional.problems), ["RESTART_REQUIRED"]);

    const malformed = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.100Z"),
      configMtimeOutput: "not a stat timestamp",
    }));
    check("malformed mtime fails safe without a false restart", codes(malformed.problems), []);

    const subMillisecond = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.100900Z"),
      configMtimeOutput: "2026-09-16 12:00:00.100500000 +0000",
    }));
    check("sub-millisecond tails use the runtime's millisecond precision", codes(subMillisecond.problems), []);

    const invalidCalendar = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.100Z"),
      configMtimeOutput: "2026-02-31 12:00:00.900000000 +0000",
    }));
    check("invalid calendar mtime fails safe without a false restart", codes(invalidCalendar.problems), []);

    const older = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, startedAtMs: 5_000_000, configMtimeSeconds: 2_000 }),
    );
    check("config older than the start is already in force", codes(older.problems), []);
  },

  async () => {
    // --- RECIPE_MIRROR_DRIFT for prompts ---

    // Top-level state and a user note are not owned prompts. They must not create a
    // permanent drift finding when provisioning intentionally preserves them.
    const foreign = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        workspaceChecksums: { ...goodPrompts, "MEMORY.md": "1".repeat(64), "custom.md": "2".repeat(64) },
      }),
    );
    check("foreign top-level markdown remains state, not recipe drift", foreign.problems.some((entry) => entry.code === "RECIPE_MIRROR_DRIFT"), false);

    // A withdrawn file that this agent creation recorded is different: it is actionable drift
    // and the next provisioning run can remove exactly that file.
    const withdrawnCase = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        workspaceChecksums: { ...goodPrompts, "withdrawn.md": "3".repeat(64) },
        managedPromptFiles: ["AGENTS.md", "withdrawn.md"],
      }),
    );
    const withdrawn = withdrawnCase.problems.find((entry) => entry.code === "RECIPE_MIRROR_DRIFT");
    check("a withdrawn owned prompt is reported as drift", withdrawn?.detail.includes("withdrawn.md"), true);
  },
];

try {
  await Promise.all(scenarios.map((run) => run()));
} finally {
  await teardownFixtureDeployment(deployment);
}
finish("inspect drift findings");
