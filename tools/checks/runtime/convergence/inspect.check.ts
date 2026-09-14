// `./clawforge inspect` — every finding it can report, provoked deliberately.
//
// The command's value is that a coder trusts it instead of checking four things by hand, so
// what needs proving is not that it runs but that each situation produces its own code, and
// that a healthy instance produces none of them. A stubbed Context stands in for the target:
// the declaration side is a real temp deployment on disk, since that half is read with
// node:fs and is exactly what a coder edits.

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gatherInspection, renderJson, doctor } from "../../../framework/commands/orchestration/inspect.ts";
import { recipeFileChecksums, agentBundleChecksums } from "../../../framework/service/checksums.ts";
import { mcpServerSpec } from "../../../framework/commands/management/provision-agent.ts";
import { currentComposition, lockFile } from "../../../framework/commands/management/lock.ts";
import { useDeployment } from "../../../framework/runtime/deployment.ts";
import { monorepoRoot } from "../../../framework/core/env.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import type { Context } from "../../../framework/core/context.ts";
import type { ExecResult } from "../../../framework/runtime/transport.ts";

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

const DATA = "/srv/clawforge/data";
const CONFIG_FILE = `${DATA}/config/openclaw.json`;
const MIRROR = `${DATA}/workspace/mcp-demo`;

/** The instance as the stub presents it. Every field has a working default, so each case
 *  below states only the one thing it is about. */
interface TargetSpec {
  running?: boolean;
  health?: string;
  probes?: Record<string, number>;
  liveConfig?: Record<string, unknown>;
  targetEnv?: string;
  configMtimeSeconds?: number;
  startedAtMs?: number;
  agents?: string[];
  /** Registered under a command/args matching mcpServerSpec("demo") — the recipe this whole
   *  fixture declares — unless overridden via mcpServerEntries. */
  mcpServers?: string[];
  /** Explicit override for a server's registered command/args/enabled, for the drift cases. */
  mcpServerEntries?: Record<string, { command?: unknown; args?: unknown; enabled?: unknown }>;
  cronJobs?: Record<string, unknown>[];
  mirrorChecksums?: Record<string, string>;
  /** What the agent's workspace holds — its prompt files as the target reports them. */
  workspaceChecksums?: Record<string, string>;
  /** Prompt files the ownership ledger says this agent previously installed. */
  managedPromptFiles?: string[];
}

function stubContext(spec: TargetSpec): Context {
  // Matches the declaration written below, so a case that says nothing about the config
  // provokes no drift and every finding in it is the one that case is about.
  const liveConfig = {
    gateway: { mode: "local", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
    agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
    models: { providers: { zai: {} } },
    ...spec.liveConfig,
  };

  return {
    settings: {
      dataDir: DATA,
      image: "ghcr.io/openclaw/openclaw:extended-stable",
      env: { OPENCLAW_GATEWAY_TOKEN: "a-token-value" },
    },
    transport: {
      async exists(path: string): Promise<boolean> {
        if (path === CONFIG_FILE) return true;
        if (path === `${DATA}/config/.env`) return spec.targetEnv !== undefined;
        return false;
      },
      async readFile(path: string): Promise<string> {
        if (path === CONFIG_FILE) return JSON.stringify(liveConfig);
        if (path === `${DATA}/config/.env`) return spec.targetEnv ?? "";
        if (path === `${DATA}/clawforge-managed.json` && spec.managedPromptFiles !== undefined) {
          return JSON.stringify({
            version: 1,
            objects: [{ kind: "agent", name: "onboarding", recipe: "demo", promptFiles: spec.managedPromptFiles, createdAt: "2026-01-01T00:00:00.000Z" }],
          });
        }
        throw new Error(`unexpected read: ${path}`);
      },
      async listFiles(dir: string): Promise<string[]> {
        return dir === MIRROR ? Object.keys(spec.mirrorChecksums ?? {}) : Object.keys(spec.workspaceChecksums ?? goodPrompts);
      },
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (command === "stat") {
          const seconds = spec.configMtimeSeconds ?? 1_000;
          return { code: 0, stdout: `${seconds}\n`, stderr: "" };
        }
        if (command === "sh" && args[1]?.includes("sha256sum")) {
          // Two trees are asked for now: the recipe's mirror and the agent's workspace.
          // Defaults to the recipe's own prompts, so a case that says nothing about them
          // provokes no prompt drift — same reasoning as the live configuration above.
          const wanted = args[1].includes(MIRROR) ? spec.mirrorChecksums : (spec.workspaceChecksums ?? goodPrompts);
          const lines = Object.entries(wanted ?? {}).map(([rel, sum]) => `${sum}  ./${rel}`);
          return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: {
      async isRunning(): Promise<boolean> {
        return spec.running ?? true;
      },
      async health(): Promise<string> {
        return spec.health ?? "healthy";
      },
      async probe(endpoint: string): Promise<number> {
        return (spec.probes ?? {})[endpoint] ?? 200;
      },
      async imageReference(): Promise<string> {
        return "ghcr.io/openclaw/openclaw@sha256:abc";
      },
      async startedAt(): Promise<number> {
        return spec.startedAtMs ?? 5_000_000;
      },
      async runOneOff(_service: string, args: string[]): Promise<ExecResult> {
        const key = args.slice(0, 2).join(" ");
        if (key === "agents list") return json(( spec.agents ?? ["main", "onboarding"]).map((id) => ({ id })));
        if (key === "mcp list") {
          const names = spec.mcpServers ?? ["demo-mcp"];
          return json(Object.fromEntries(names.map((name) => [name, spec.mcpServerEntries?.[name] ?? mcpServerSpec("demo")])));
        }
        if (key === "cron list") {
          return json({ jobs: spec.cronJobs ?? [matchingJob()] });
        }
        if (args[0] === "--version") return { code: 0, stdout: "OpenClaw 2026.6.34\n", stderr: "" };
        return { code: 0, stdout: "{}", stderr: "" };
      },
    },
  } as unknown as Context;
}

/** The cron job as the declaration below would have created it — every field the
 *  reconciliation compares, so a case that says nothing about cron provokes no drift. */
function matchingJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    name: "demo-refresh",
    agentId: "onboarding",
    schedule: { expr: "17 3 * * *" },
    sessionTarget: "isolated",
    payload: { message: "refresh yourself", timeoutSeconds: 900 },
    delivery: { mode: "none" },
    ...overrides,
  };
}

function json(value: unknown): ExecResult {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function codes(problems: readonly { code: string }[]): string[] {
  return problems.map((entry) => entry.code).sort();
}

// --- a real deployment on disk for the declaration side ---------------------------------

const deployment = await mkdtemp(join(tmpdir(), "clawforge-inspect-check-"));
let goodChecksums: Record<string, string> = {};
let goodPrompts: Record<string, string> = {};

try {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  await writeFile(
    resolve(deployment, "config", "desired-state.json"),
    JSON.stringify([{ path: "gateway.mode", value: "local" }, { path: "agents.defaults.model.primary", value: "zai/glm-5.3-flash" }]),
  );
  await mkdir(resolve(deployment, "recipes", "demo", "agent"), { recursive: true });
  await writeFile(
    resolve(deployment, "recipes", "demo", "agent", "config.json"),
    JSON.stringify({ agentId: "onboarding", mcpServerName: "demo-mcp", cronJobName: "demo-refresh", cronSchedule: "17 3 * * *" }),
  );
  // The agent's prompt: not part of the mirror, but part of what the recipe declares the
  // agent to be — which is the distinction the bundle checksum exists for.
  await writeFile(resolve(deployment, "recipes", "demo", "agent", "AGENTS.md"), "# the agent's instructions\n");
  // The cron message is part of the declared contract too — a job carrying an old one is
  // drift even when its schedule matches, which is what this fixture exists to provoke.
  await writeFile(resolve(deployment, "recipes", "demo", "agent", "cron-message.txt"), "refresh yourself\n");
  await writeFile(resolve(deployment, "recipes", "demo", "server.ts"), "// server\n");
  await mkdir(resolve(deployment, "recipes", "demo", "data"), { recursive: true });
  await writeFile(resolve(deployment, "recipes", "demo", "data", "page.md"), "# page\n");

  useDeployment(deployment);
  goodChecksums = await recipeFileChecksums(resolve(deployment, "recipes", "demo"));
  // Only the .md files reach the agent's workspace; config.json and cron-message.txt are read
  // by provision-agent itself and never written there.
  goodPrompts = Object.fromEntries(
    Object.entries(await agentBundleChecksums(resolve(deployment, "recipes", "demo"))).filter(([rel]) => rel.endsWith(".md")),
  );

  // A lock matching this composition, written through the real code path rather than by
  // hand — otherwise the fixture and the command could disagree about the format and the
  // checks would still pass. Without it every case below would carry a LOCK_MISSING
  // warning, which is correct behaviour and pure noise in cases that are about something
  // else; the lock's own findings get their own cases at the end.
  await writeFile(
    lockFile(),
    `${JSON.stringify(await currentComposition(stubContext({})), null, 2)}\n`,
    "utf8",
  );

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

  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, agents: ["main"], mcpServers: [] }),
    );
    check("a recipe's missing agent and server are both found", codes(inspection.problems), ["AGENT_MISSING", "MCP_SERVER_MISSING"]);
    check(
      "and the remedy names the recipe, not the whole declaration",
      inspection.problems[0]?.nextAction,
      "./clawforge provision-agent demo",
    );
  }

  {
    // Present under the wrong command — not absent — must still be MCP_SERVER_MISSING: a
    // name match alone (the old behaviour) let a broken registration report healthy.
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        mcpServerEntries: { "demo-mcp": { command: "missing-program", args: [] } },
      }),
    );
    const broken = inspection.problems.find((entry) => entry.code === "MCP_SERVER_MISSING");
    check("a registered server with the wrong command is still MCP_SERVER_MISSING", broken !== undefined, true);
    check("saying it is registered but wrong, not absent", broken?.detail.includes("does not launch"), true);
    check("the remedy still names the recipe", broken?.nextAction, "./clawforge provision-agent demo");
    check("the instance is not reported healthy", renderJson(inspection).healthy, false);
  }
  {
    // Disabled — right command, but excluded from tool discovery — is the same finding.
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        mcpServerEntries: { "demo-mcp": { ...mcpServerSpec("demo"), enabled: false } },
      }),
    );
    check("a disabled registration is MCP_SERVER_MISSING too", codes(inspection.problems), ["MCP_SERVER_MISSING"]);
  }

  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, cronJobs: [{ name: "demo-refresh", schedule: { expr: "0 4 * * *" } }] }),
    );
    const cron = inspection.problems.find((entry) => entry.code === "CRON_DRIFT");
    check("a cron job on the wrong schedule is drift", cron?.detail.includes("runs at 0 4 * * *, declared 17 3 * * *"), true);
  }
  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, cronJobs: [] }),
    );
    check("an absent cron job is drift too", codes(inspection.problems), ["CRON_DRIFT"]);
  }

  // The rest of the contract, which used to be invisible: a job whose schedule matches while
  // it carries an old message, or a timeout nobody declared, ran on the instance while the
  // inspection reported nothing and the plan was empty. provision-agent would have replaced
  // it immediately — the two disagreed about what "matches" means.

  {
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        cronJobs: [matchingJob({ payload: { message: "something the recipe no longer says", timeoutSeconds: 900 } })],
      }),
    );
    const cron = inspection.problems.find((entry) => entry.code === "CRON_DRIFT");
    check("an outdated cron message is drift, schedule notwithstanding", cron !== undefined, true);
    check("and the message is named as the difference", cron?.detail.includes("cron-message.txt"), true);
  }

  {
    const inspection = await gatherInspection(
      stubContext({
        targetEnv: "ZAI_API_KEY=k\n",
        mirrorChecksums: goodChecksums,
        cronJobs: [matchingJob({ payload: { message: "refresh yourself", timeoutSeconds: 1 } })],
      }),
    );
    const cron = inspection.problems.find((entry) => entry.code === "CRON_DRIFT");
    check("a timeout nobody declared is drift", cron?.detail.includes("timeout is 1s, declared 900s"), true);
  }

  {
    // Delivery and session target are part of it as well: a job quietly switched to
    // announcing into a chat fail-closes on every run of a deployment with no channel.
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, cronJobs: [matchingJob({ delivery: { mode: "announce" } })] }),
    );
    const cron = inspection.problems.find((entry) => entry.code === "CRON_DRIFT");
    check("a changed delivery mode is drift", cron?.detail.includes("delivery is announce"), true);
  }

  {
    // An edited page that has not been mirrored: the same file name, different content —
    // the case a listing comparison cannot see.
    const edited = { ...goodChecksums, "data/page.md": "0".repeat(64) };
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: edited }),
    );
    const mirror = inspection.problems.find((entry) => entry.code === "RECIPE_MIRROR_DRIFT");
    check("an edited file with an unchanged name is still drift", mirror?.detail.includes("data/page.md"), true);
  }
  {
    // The agent's prompt files do not travel in the mirror — provision-agent writes them into
    // the agent's workspace. Comparing only the mirror meant an edited AGENTS.md changed what
    // the agent does and nothing reported it: plan scheduled no work, apply left the old
    // prompt in force, and every checksum agreed nothing had happened.
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, workspaceChecksums: { "AGENTS.md": "0".repeat(64) } }),
    );
    const stale = inspection.problems.find((entry) => entry.code === "RECIPE_MIRROR_DRIFT");
    check("a prompt older than the recipe is drift", stale?.detail.includes("AGENTS.md"), true);
    check("and it says the agent is the one running it", stale?.detail.includes("agent \"onboarding\""), true);
    check("with the recipe named as the remedy", stale?.nextAction, "./clawforge provision-agent demo");
  }
  {
    const withExtra = { ...goodChecksums, "data/withdrawn.md": "1".repeat(64) };
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: withExtra }),
    );
    const mirror = inspection.problems.find((entry) => entry.code === "RECIPE_MIRROR_DRIFT");
    check("a file the recipe no longer declares is reported as well", mirror?.detail.includes("no longer declares"), true);
  }

  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, health: "unhealthy" }),
    );
    check("the runtime's own verdict is a finding", codes(inspection.problems), ["GATEWAY_UNHEALTHY"]);
  }
  {
    // The grace period every container passes through on the way up. Reported as a fault,
    // every ./clawforge apply would end by announcing a problem on an instance it had just brought
    // back correctly — which is how a report teaches people to ignore it.
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, health: "starting" }),
    );
    check("a container still starting but answering is not a finding", codes(inspection.problems), []);
    check("and it counts as healthy", renderJson(inspection).healthy, true);
  }
  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, health: "starting", probes: { readyz: 503 } }),
    );
    check("one still starting and not answering is a finding", codes(inspection.problems), ["GATEWAY_UNHEALTHY"]);
  }
  {
    // Both criteria are read: a container the runtime calls healthy while a probe does not
    // answer is exactly the disagreement that caught a broken healthcheck here before.
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, probes: { readyz: 503 } }),
    );
    const unhealthy = inspection.problems.find((entry) => entry.code === "GATEWAY_UNHEALTHY");
    check("a failing probe on a healthy container is still a finding", unhealthy?.detail.includes("readyz answered 503"), true);
  }

  // --- the machine-readable answer --------------------------------------------------------

  {
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums, agents: ["main"] }),
    );
    const rendered = renderJson(inspection) as Record<string, unknown>;
    check("the JSON leads with the verdict", rendered.healthy, false);
    check("problems are carried whole", (rendered.problems as unknown[]).length, 1);
    check("and the remedies are a list, not prose to parse", rendered.nextActions, ["./clawforge provision-agent demo"]);
    check("the deployment names itself", rendered.deployment, inspection.declared.deployment);
  }
  // --- doctor: the same inspection, read as a verdict -------------------------------------
  //
  // What matters is the exit, because that is the half a CI step or an agent acts on without
  // reading anything. Blocking fails; a warning must not, or a command that objects to
  // everything stops being consulted.

  async function doctorOutcome(spec: Parameters<typeof stubContext>[0]): Promise<{ failed: boolean; output: string }> {
    let output = "";
    try {
      await withOutputSink(
        (chunk) => {
          output += chunk;
        },
        () => doctor(stubContext(spec), ["--json"]),
      );
      return { failed: false, output };
    } catch {
      return { failed: true, output };
    }
  }

  {
    const clean = await doctorOutcome({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums });
    check("doctor succeeds on an instance with nothing wrong", clean.failed, false);
    check("and still answers with the verdict", (JSON.parse(clean.output) as { healthy: boolean }).healthy, true);
  }
  {
    const broken = await doctorOutcome({ mirrorChecksums: goodChecksums });
    check("a blocking problem fails the command", broken.failed, true);
    const payload = JSON.parse(broken.output) as { problems: { code: string }[]; nextActions: string[] };
    check("the report is produced before it fails, not instead of it", payload.problems.map((entry) => entry.code), ["SECRET_MISSING"]);
    check("and it carries what to run", payload.nextActions, ["./clawforge secrets --apply"]);
  }
  // --- the lock, and the other half of doctor's exit contract ------------------------------
  //
  // LOCK_MISSING is the first warning-severity code an inspection can produce, which makes
  // this the first place the rest of the contract can be shown: a difference worth naming
  // must not fail the command, or a check that objects to everything stops being consulted.

  {
    await rm(lockFile(), { force: true });
    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }),
    );
    check("an unpinned deployment is reported", codes(inspection.problems), ["LOCK_MISSING"]);
    check("as a warning, not a failure", inspection.problems[0]?.severity, "warning");
    check("and the instance is still healthy", renderJson(inspection).healthy, true);

    const outcome = await doctorOutcome({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums });
    check("doctor does not fail on a warning alone", outcome.failed, false);
    check("but still reports it", (JSON.parse(outcome.output) as { problems: { code: string }[] }).problems[0]?.code, "LOCK_MISSING");
  }

  {
    // A recipe edited after the lock was taken: the composition is no longer the one that
    // was pinned, and the file that differs is named rather than counted.
    await writeFile(
      lockFile(),
      `${JSON.stringify(await currentComposition(stubContext({})), null, 2)}\n`,
      "utf8",
    );
    await writeFile(resolve(deployment, "recipes", "demo", "data", "page.md"), "# page, rewritten\n");
    const edited = await recipeFileChecksums(resolve(deployment, "recipes", "demo"));

    const inspection = await gatherInspection(
      stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: edited }),
    );
    const drift = inspection.problems.find((entry) => entry.code === "LOCK_DRIFT");
    check("a recipe edited since the lock is drift from it", drift !== undefined, true);
    check("and the differing file is named", drift?.detail.includes("data/page.md"), true);
  }

  {
    // A desired-state.json that EXISTS but cannot be parsed is a different situation than
    // "no file at all" — before the fix, both were caught by the same catch and silently
    // treated as an empty declaration, so a broken file produced healthy: true with nothing
    // ever saying the declaration itself was unreadable.
    const desiredStatePath = resolve(deployment, "config", "desired-state.json");
    const validDesiredState = await readFile(desiredStatePath, "utf8");
    await writeFile(desiredStatePath, "{broken");
    try {
      const inspection = await gatherInspection(
        stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums }),
      );
      const broken = inspection.problems.find((entry) => entry.detail.includes("desired-state.json"));
      check("a desired-state.json that exists but fails to parse is a finding", broken !== undefined, true);
      check("and it is blocking, not silently empty", broken?.severity, "blocking");
      check("the instance is not reported healthy", renderJson(inspection).healthy, false);
    } finally {
      await writeFile(desiredStatePath, validDesiredState);
    }
  }
} finally {
  await rm(deployment, { recursive: true, force: true });
  // The active deployment is process-wide and the checks share one process: leave it where
  // the other check files expect to find it rather than pointing at a directory just deleted.
  useDeployment(resolve(monorepoRoot, "apps", "example app"));
}

process.stderr.write(failed === 0 ? "all inspect checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
