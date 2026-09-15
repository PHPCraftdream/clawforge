// `./clawforge inspect` — matching-instance baseline, JSON5/prospective-secret handling, the
// set-requirement image check, and CONFIG_DRIFT/SECRET_MISSING/RESTART_REQUIRED findings.
// Split out of inspect.check.ts; see fixture.ts for the shared stub and on-disk
// deployment, inspect-recipes.check.ts and inspect-lock.check.ts for the rest.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gatherInspection, renderJson } from "#framework/commands/orchestration/inspect/gather.ts";
import { setupFixtureDeployment, teardownFixtureDeployment, codes, CONFIG_FILE } from "./fixture.ts";
import type { Context } from "#framework/core/context.ts";

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

const { deployment, goodChecksums, goodPrompts, stubContext } = await setupFixtureDeployment();

try {
  // --- the instance is what the repository says ----------------------------------------

  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }),
    );
    check("a matching instance reports no problems at all", inspection.problems, []);
    check("and is reported healthy", renderJson(inspection).healthy, true);
    check("the declaration is read from the deployment", inspection.declared.recipes, ["demo"]);
    check("the live values it compared are reported too", inspection.observed.config["gateway.mode"], "local");
    check("the digest is recorded, not just the tag", inspection.observed.imageDigest, "ghcr.io/openclaw/openclaw@sha256:abc");
    check("versions are answered", inspection.observed.openclawVersion, "OpenClaw 2026.6.34");
  }

  {
    // The LIVE openclaw.json is OpenClaw's own JSON5 gateway format (docs.openclaw.ai/
    // gateway/configuration) — before the fix, observeConfig() read it with plain JSON.parse,
    // whose thrown SyntaxError was caught and reported as a false CONFIG_DRIFT ("could not be
    // read or parsed") for a perfectly valid, matching JSON5 config. Run against the clean,
    // unmutated fixture state (before any later case rewrites recipe files on disk).
    const base = stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums });
    const rawJson5Config =
      '{\n  // a comment plain JSON.parse rejects outright\n  "gateway": { "mode": "local", "auth": { "token": { "source": "env", "id": "OPENCLAW_GATEWAY_TOKEN" } }, },\n' +
      '  "agents": { "defaults": { "model": { "primary": "zai/glm-5.3-flash" } } },\n' +
      '  "models": { "providers": { "zai": {} } },\n}\n';
    const ctx = {
      ...base,
      transport: {
        ...base.transport,
        readFile: async (path: string) => (path === CONFIG_FILE ? rawJson5Config : base.transport.readFile(path)),
      },
    } as unknown as Context;
    const inspection = await gatherInspection(ctx);
    check("a JSON5-syntax live config (comment) is not reported as a false CONFIG_DRIFT", codes(inspection.problems), []);
    check("and its values are actually read, not just tolerated", inspection.observed.config["gateway.mode"], "local");
  }

  {
    // A SecretRef the declaration is about to add is a real requirement before it has ever
    // reached the live config — before the fix, the secrets check only ever asked the LIVE
    // config, so a new provider declared in config/desired-state.json (with no apiKey set,
    // and no NEWPROV_API_KEY in the target's config/.env either) produced no SECRET_MISSING
    // at all, and plan.ts's "secrets" step was never scheduled alongside the CONFIG_DRIFT
    // step that was about to write that provider into the live config.
    const desiredStatePath = resolve(deployment, "config", "desired-state.json");
    const validDesiredState = await readFile(desiredStatePath, "utf8");
    const declaredWithNewProvider = JSON.parse(validDesiredState) as unknown[];
    declaredWithNewProvider.push({ path: "models.providers.newprov", value: {} });
    await writeFile(desiredStatePath, JSON.stringify(declaredWithNewProvider));
    try {
      const inspection = await gatherInspection(
        stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }),
      );
      const secret = inspection.problems.find((entry) => entry.code === "SECRET_MISSING" && entry.detail.includes("NEWPROV_API_KEY"));
      check("a provider only the DECLARATION adds is a SECRET_MISSING finding before it ever reaches the live config", secret !== undefined, true);
    } finally {
      await writeFile(desiredStatePath, validDesiredState);
    }
  }

  {
    // The set-requirement check (readInstalledSet + requirementProblems) must compare
    // against the RUNNING CONTAINER's actual image, not ctx.runtime.imageReference() — the
    // same "stale local tag" scenario apply --set's own pre/post-checks already learned not
    // to trust (task #172): a container running digest B, a local tag re-pulled and now
    // resolving to digest A, imageReference() reporting A (a false match), only
    // runningImageIdentity() (what the fix uses) seeing the real, still-running B.
    const requiredImage = `ghcr.io/openclaw/openclaw@sha256:${"a".repeat(64)}`;
    const actualRunningImage = `ghcr.io/openclaw/openclaw@sha256:${"b".repeat(64)}`;
    const installedSetRecord = {
      id: "c".repeat(64),
      name: "demo-set",
      installedAt: "2026-01-01T00:00:00.000Z",
      requires: { framework: "0.1.0", image: requiredImage },
    };
    const base = stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums });
    const installedSetPath = "/srv/clawforge/data/clawforge-installed-set.json";
    const ctx = {
      ...base,
      transport: {
        ...base.transport,
        readFile: async (path: string) => (path === installedSetPath ? JSON.stringify(installedSetRecord) : base.transport.readFile(path)),
      },
      runtime: {
        ...base.runtime,
        imageReference: async () => requiredImage,
        runningImageIdentity: async () => ({ imageId: "actual-img", digests: [actualRunningImage], containerId: "container-1" }),
      },
    } as unknown as Context;
    const inspection = await gatherInspection(ctx);
    check(
      "a stale local tag must not fool the set-requirement check — the running container is what matters",
      codes(inspection.problems).includes("SET_REQUIREMENT_UNMET"),
      true,
    );
  }

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
    check("and the detail names both values", drift?.detail, 'gateway.mode is "remote", declared "local"');
    check("the remedy is the one command that fixes it", drift?.nextAction, "./clawforge apply");
  }

  {
    // No <data>/config/.env at all: the provider key has nowhere to come from.
    const inspection = await gatherInspection(stubContext({ mirrorChecksums: goodChecksums }));
    const secret = inspection.problems.find((entry) => entry.code === "SECRET_MISSING");
    check("a missing provider key is found", secret?.detail.includes("ZAI_API_KEY"), true);
    check("and it says where the value belongs", secret?.detail.includes("<data>/config/.env"), true);
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

process.stderr.write(failed === 0 ? "all inspect drift checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
