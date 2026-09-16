// Shared fixture for the inspect.check.ts split (drift/recipes/lock.check.ts, this same
// directory): the stubbed Context and the real on-disk deployment every one of those
// files needs.
//
// Not `check`/`failed` — module state shared across check files that run in the same
// process (tools/checks/run.ts imports them one after another) would let one file's
// failure count leak into another's. Each check file keeps its own trivial copy of those
// instead. Not a module-level `goodPrompts` either, for the same reason: stubContext is
// built fresh per `setupFixtureDeployment()` call, closed over THAT call's own
// goodPrompts, so nothing here is shared mutable state between files.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recipeFileChecksums, agentBundleChecksums } from "#framework/service/checksums.ts";
import { mcpServerSpec } from "#framework/commands/management/provision-agent/index.ts";
import { currentComposition, lockFile } from "#framework/commands/management/lock.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

export const DATA = "/srv/clawforge/data";
export const CONFIG_FILE = `${DATA}/config/openclaw.json`;
export const MIRROR = `${DATA}/workspace/mcp-demo`;

/** The instance as the stub presents it. Every field has a working default, so each case
 *  below states only the one thing it is about. */
export interface TargetSpec {
  running?: boolean;
  health?: string;
  probes?: Record<string, number>;
  liveConfig?: Record<string, unknown>;
  targetEnv?: string;
  configMtimeSeconds?: number;
  configMtimeOutput?: string;
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

/** The cron job as the declaration below would have created it — every field the
 *  reconciliation compares, so a case that says nothing about cron provokes no drift. */
export function matchingJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

export function json(value: unknown): ExecResult {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

export function codes(problems: readonly { code: string }[]): string[] {
  return problems.map((entry) => entry.code).sort();
}

/** Builds a stubContext() bound to one fixture deployment's own goodPrompts default —
 *  what a case that says nothing about the workspace checksums falls back to. */
function makeStubContext(goodPrompts: Record<string, string>): (spec: TargetSpec) => Context {
  return function stubContext(spec: TargetSpec): Context {
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
            const output = spec.configMtimeOutput ?? new Date(seconds * 1000).toISOString().replace("T", " ").replace("Z", " +0000");
            return { code: 0, stdout: `${output}\n`, stderr: "" };
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
        async runningImageIdentity(): Promise<{ imageId: string; digests: string[]; containerId: string }> {
          return { imageId: "img", digests: ["ghcr.io/openclaw/openclaw@sha256:abc"], containerId: "container-1" };
        },
        async startedAt(): Promise<number> {
          return spec.startedAtMs ?? 5_000_000;
        },
        async runOneOff(_service: string, args: string[]): Promise<ExecResult> {
          const key = args.slice(0, 2).join(" ");
          if (key === "agents list") return json((spec.agents ?? ["main", "onboarding"]).map((id) => ({ id })));
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
  };
}

export interface FixtureDeployment {
  readonly deployment: string;
  readonly goodChecksums: Record<string, string>;
  readonly goodPrompts: Record<string, string>;
  readonly stubContext: (spec: TargetSpec) => Context;
}

/** A real deployment on disk for the declaration side (read with node:fs, exactly what a
 *  coder edits), plus a stubContext() bound to it and a lock file matching its composition
 *  written through the real code path — otherwise the fixture and the command could
 *  disagree about the format and the checks would still pass. Without it every case would
 *  carry a LOCK_MISSING warning, pure noise in cases about something else. */
export async function setupFixtureDeployment(): Promise<FixtureDeployment> {
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-inspect-check-"));
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
  const goodChecksums = await recipeFileChecksums(resolve(deployment, "recipes", "demo"));
  // Only the .md files reach the agent's workspace; config.json and cron-message.txt are read
  // by provision-agent itself and never written there.
  const goodPrompts = Object.fromEntries(
    Object.entries(await agentBundleChecksums(resolve(deployment, "recipes", "demo"))).filter(([rel]) => rel.endsWith(".md")),
  );
  const stubContext = makeStubContext(goodPrompts);

  await writeFile(
    lockFile(),
    `${JSON.stringify(await currentComposition(stubContext({})), null, 2)}\n`,
    "utf8",
  );

  return { deployment, goodChecksums, goodPrompts, stubContext };
}

export async function teardownFixtureDeployment(deployment: string): Promise<void> {
  await rm(deployment, { recursive: true, force: true });
  // The active deployment is process-wide and the checks share one process: leave it where
  // the other check files expect to find it rather than pointing at a directory just deleted.
  useDeployment(resolve(monorepoRoot, "apps", "example app"));
}
