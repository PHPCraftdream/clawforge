// `./clawforge inspect` — one finding per situation: a stopped instance, CONFIG_DRIFT,
// SECRET_MISSING, PROVIDER_MISSING, RESTART_REQUIRED (with its fractional-mtime edge cases) and
// RECIPE_MIRROR_DRIFT for prompts. See ../fixture.ts for the shared stub.

import { gatherInspection, renderJson } from "#framework/commands/orchestration/inspect/gather.ts";
import { planActions } from "#framework/commands/orchestration/plan.ts";
import { setupFixtureDeployment, teardownFixtureDeployment, codes } from "#checks/runtime/convergence/inspect/fixture.ts";
import { check, finish } from "#checks/kit/harness.ts";

const { deployment, goodChecksums, goodPrompts, stubContext } = await setupFixtureDeployment();

try {
  // --- one finding per situation --------------------------------------------------------

  {
    const inspection = await gatherInspection(stubContext({ running: false }));
    check("a stopped instance reports being down", codes(inspection.problems).includes("GATEWAY_DOWN"), true);
    // The value of the single clear finding: nothing that NEEDS the instance is attempted,
    // so the reader is not handed a dozen consequences of the one cause.
    check("and nothing that needs it is attempted", codes(inspection.problems), ["GATEWAY_DOWN", "SECRET_MISSING"]);
    check("a stopped instance is not healthy", renderJson(inspection).healthy, false);
  }

  {
    // But the configuration IS compared: openclaw.json is a file on the target, readable
    // whether or not anything is serving. Skipping it because the gateway was down produced
    // a plan of just [up], which started the instance on a configuration nobody had applied
    // — and apply then reported success.
    const inspection = await gatherInspection(
      stubContext({
        running: false,
        targetEnv: "ZAI_API_KEY=k\n",
        liveConfig: {
          gateway: { mode: "remote", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
          agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
        },
      }),
    );
    check("drift is found on a stopped instance too", codes(inspection.problems), ["CONFIG_DRIFT", "GATEWAY_DOWN"]);
    check("and the live values are reported", inspection.observed.config["gateway.mode"], "remote");
  }

  {
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        liveConfig: {
          gateway: { mode: "remote", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
          agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
        },
      }),
    );
    const drift = inspection.problems.find((entry) => entry.code === "CONFIG_DRIFT");
    check("exactly the changed setting is reported", inspection.problems.length, 1);
    check("a differing declared value is drift", drift !== undefined, true);
    check("the detail names only the path and mismatch", drift?.detail, "gateway.mode differs from the declaration");
    check("the remedy is the one command that fixes it", drift?.nextAction, "./clawforge apply");
  }

  {
    // No <data>/config/.env at all: the provider key has nowhere to come from.
    const inspection = await gatherInspection(stubContext({ mirrorChecksums: goodChecksums }));
    const secret = inspection.problems.find((entry) => entry.code === "SECRET_MISSING");
    check("a missing provider key is found", secret?.detail.includes("ZAI_API_KEY"), true);
    check("and it says where the value belongs", secret?.detail.includes("<data>/config/.env"), true);
  }

  // --- no model provider configured at all -----------------------------------------------

  {
    // "OpenClaw is up" after a bootstrap with no provider key: the gateway container runs
    // and answers every probe, but an agent cannot answer a single prompt. Read from the
    // live config the way secrets.ts's own collectConfiguredProviders does, not guessed
    // from which env vars happen to be set.
    const inspection = await gatherInspection(
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
    check("no provider configured is reported", codes(inspection.problems), ["PROVIDER_MISSING"]);
    const finding = inspection.problems.find((entry) => entry.code === "PROVIDER_MISSING");
    check("it is a warning — detection cannot see env-keyed, subscription or CLI-backend providers", finding?.severity, "warning");
    check("the remedy is configure-provider", finding?.nextAction, "./clawforge configure-provider");
  }

  {
    // A provider named only through auth.profiles (never models.providers) still counts —
    // collectConfiguredProviders() reads both, and this must not re-derive its own guess.
    const inspection = await gatherInspection(
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
    check("a provider named only through auth.profiles is still configured", codes(inspection.problems).includes("PROVIDER_MISSING"), false);
  }

  {
    // The default fixture config already declares models.providers.zai — the ordinary,
    // configured case must never carry this finding.
    const inspection = await gatherInspection(stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }));
    check("a configured provider carries no PROVIDER_MISSING", codes(inspection.problems).includes("PROVIDER_MISSING"), false);
  }

  {
    // Configuration written after the instance started: correct on disk, not yet in force.
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, startedAtMs: 1_000_000, configMtimeSeconds: 2_000 }),
    );
    check("config newer than the running instance asks for a restart", codes(inspection.problems), ["RESTART_REQUIRED"]);
    check("the remedy is restart, not up", inspection.problems[0]?.nextAction, "./clawforge restart");
  }
  {
    const startedAtMs = Date.parse("2026-09-16T12:00:00.100Z");
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs,
      configMtimeOutput: "2026-09-16 12:00:00.900000000 +0000",
    }));
    check("fractional mtime after startup in the same second requires restart", codes(inspection.problems), ["RESTART_REQUIRED"]);
    check("the plan includes restart for a fractional mtime", planActions(inspection).map((action) => action.id), ["restart"]);
  }
  {
    const startedAtMs = Date.parse("2026-09-16T12:00:00.900Z");
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs,
      configMtimeOutput: "2026-09-16 12:00:00.100000000 +0000",
    }));
    check("fractional mtime before startup in the same second is already in force", codes(inspection.problems), []);
  }
  {
    const startedAtMs = Date.parse("2026-09-16T12:00:00.900Z");
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs,
      configMtimeOutput: "2026-09-16 12:00:00.900000000 +0000",
    }));
    check("equal fractional mtime and startup time does not require restart", codes(inspection.problems), []);
  }
  {
    const startedAtMs = Date.parse("2026-09-16T10:00:00.500Z");
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs,
      configMtimeOutput: "2026-09-16 12:00:00.600000000 +0200",
    }));
    check("fractional mtime honors its explicit timezone", codes(inspection.problems), ["RESTART_REQUIRED"]);
  }
  {
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.100Z"),
      configMtimeOutput: "not a stat timestamp",
    }));
    check("malformed mtime fails safe without a false restart", codes(inspection.problems), []);
  }
  {
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.100900Z"),
      configMtimeOutput: "2026-09-16 12:00:00.100500000 +0000",
    }));
    check("sub-millisecond tails use the runtime's millisecond precision", codes(inspection.problems), []);
  }
  {
    const inspection = await gatherInspection(stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      startedAtMs: Date.parse("2026-09-16T12:00:00.100Z"),
      configMtimeOutput: "2026-02-31 12:00:00.900000000 +0000",
    }));
    check("invalid calendar mtime fails safe without a false restart", codes(inspection.problems), []);
  }
  {
    // Top-level state and a user note are not owned prompts. They must not create a
    // permanent drift finding when provisioning intentionally preserves them.
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        workspaceChecksums: { ...goodPrompts, "MEMORY.md": "1".repeat(64), "custom.md": "2".repeat(64) },
      }),
    );
    check("foreign top-level markdown remains state, not recipe drift", inspection.problems.some((entry) => entry.code === "RECIPE_MIRROR_DRIFT"), false);
  }
  {
    // A withdrawn file that this agent creation recorded is different: it is actionable drift
    // and the next provisioning run can remove exactly that file.
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        workspaceChecksums: { ...goodPrompts, "withdrawn.md": "3".repeat(64) },
        managedPromptFiles: ["AGENTS.md", "withdrawn.md"],
      }),
    );
    const withdrawn = inspection.problems.find((entry) => entry.code === "RECIPE_MIRROR_DRIFT");
    check("a withdrawn owned prompt is reported as drift", withdrawn?.detail.includes("withdrawn.md"), true);
  }
  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, startedAtMs: 5_000_000, configMtimeSeconds: 2_000 }),
    );
    check("config older than the start is already in force", codes(inspection.problems), []);
  }
} finally {
  await teardownFixtureDeployment(deployment);
}
finish("inspect drift findings");
