// `./clawforge apply` must not undo an operator's .env edit (P2-03, round 3).
//
// The operator changes OPENCLAW_GATEWAY_PORT in .env and runs apply WITHOUT any recovery
// step. The container still answers with the old port, so the inspection reports ENV_STALE —
// and the plan must treat that as advice, never as a step that writes the container's facts
// back over the edit. Driven end to end through the real apply() and createContext(), with
// the transport and docker answers stubbed; the only real files are the fixture deployment's.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { apply } from "#framework/commands/orchestration/apply.ts";
import type { ApplyOutcome } from "#framework/commands/orchestration/apply.ts";
import { createContext } from "#framework/core/context.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { useComposeProjectOverride } from "#framework/runtime/deployment.ts";
import { currentComposition, lockFile } from "#framework/commands/management/lock.ts";
import { mountPoints } from "#framework/runtime/mounts.ts";
import { setupFixtureDeployment, teardownFixtureDeployment, DATA } from "../convergence/inspect/fixture.ts";
import { refreshCheckTransport, refreshLiveConfig } from "./apply-driver.ts";
import type { RefreshState } from "./apply-driver.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== "object" || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

{
  const { deployment, goodChecksums, goodPrompts, stubContext } = await setupFixtureDeployment();
  try {
    // The operator's deliberate edit: the port moved and the container has not caught up.
    const operatorEnv = [
      "OC_DATA_DIR=/srv/clawforge/data",
      "OPENCLAW_GATEWAY_PORT=18789",
      "OC_COMPOSE_PROJECT=refresh-check",
      "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable",
      "OPENCLAW_GATEWAY_TOKEN=operator-edit-token-value",
      "",
    ].join("\n");
    await writeFile(resolve(deployment, ".env"), operatorEnv, "utf8");
    await mkdir(resolve(deployment, "secrets"), { recursive: true });
    await writeFile(resolve(deployment, "secrets", "local.env"), "OPENCLAW_GATEWAY_TOKEN=stored-operator-edit-token\nZAI_API_KEY=zai-edit-key-value\n", "utf8");
    // A declaration that provokes CONFIG_DRIFT, so the run has real executable steps and is
    // not the nothing-to-apply fast path.
    await writeFile(
      resolve(deployment, "config", "desired-state.json"),
      JSON.stringify([{ path: "gateway.mode", value: "remote" }, { path: "agents.defaults.model.primary", value: "zai/glm-5.3-flash" }]),
      "utf8",
    );
    // The lock pins a checksum of the declaration, and this scenario edited it — re-pin it so the
    // run is about the .env divergence and the drift, not about a lock warning nobody is testing here.
    await writeFile(lockFile(), `${JSON.stringify(await currentComposition(stubContext({})), null, 2)}\n`, "utf8");

    const state: RefreshState = {
      files: new Map(),
      composeEnvWrites: [],
      dockerCalls: [],
      running: true,
      // Everything matches the edit but the port — the container still carries the old one.
      facts: {
        Image: "sha256:fixture-image",
        State: { Running: true },
        Mounts: [{ Destination: "/home/node/.openclaw", Source: "/srv/clawforge/data/config" }],
        NetworkSettings: { Ports: { "18789/tcp": [{ HostPort: "18790" }] } },
        Config: { Labels: { "com.docker.compose.project": "refresh-check", Image: "ghcr.io/openclaw/openclaw:extended-stable" } },
      },
    };
    state.files.set(`${DATA}/config/.env`, "ZAI_API_KEY=zai-edit-key-value\n");

    const liveConfig = refreshLiveConfig();
    const ctx = await createContext({
      transport: refreshCheckTransport({ liveConfig, mirrorChecksums: goodChecksums, prompts: goodPrompts }, state, {
        onStagedConfig: (payload) => {
          for (const op of JSON.parse(payload) as { path: string; value: unknown }[]) setAtPath(liveConfig, op.path, op.value);
        },
      }),
      service: { name: "gateway" },
      // The real app's mounts, so the staged declaration path has a container path to travel to.
      mounts: (dataDir: string) => mountPoints(dataDir),
      settings: () => ({ OC_APP_COMPUTED: "from-app-definition" }),
    });

    let machine = "";
    let threw: unknown;
    await withOutputSink(() => {}, async () => {
      try { await apply(ctx, []); } catch (error) { threw = error; }
    }, (chunk) => { machine += chunk; });

    check("the whole run does not throw", threw === undefined, true);
    const outcome = JSON.parse(machine) as ApplyOutcome;
    check(
      "the plan treated the diverged .env as advice, not as a recovery step",
      JSON.stringify(outcome.steps.map((step) => [step.id, step.status])),
      JSON.stringify([["recover-env", "advisory"], ["apply-config", "done"], ["restart", "done"]]),
    );
    check("the advisory step is recorded with its reason", outcome.steps[0].detail, "advisory: for you to do, not this command");
    const envAfter = await readFile(resolve(deployment, ".env"), "utf8");
    check("apply never touched .env at all — the operator's edit is byte-identical", envAfter, operatorEnv);
    check("the operator's port survives apply", envAfter.includes("OPENCLAW_GATEWAY_PORT=18789"), true);
    check("the container's old port never lands in the file", envAfter.includes("18790"), false);
    check("the confirming inspection reports the instance healthy", outcome.healthy, true);
    check("the run is recorded under one operation id", typeof outcome.operationId === "string" && outcome.operationId !== "", true);
  } finally {
    useComposeProjectOverride(undefined);
    await teardownFixtureDeployment(deployment);
  }
}

process.stderr.write(failed === 0 ? "all operator-edit checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
