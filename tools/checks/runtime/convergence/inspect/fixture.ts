// Shared fixture for the inspect.check.ts split (drift/recipes/lock.check.ts, this same
// directory): the stubbed Context and the real on-disk deployment every one of those
// files needs.
//
// No check()/failed helper here — each check file runs in its own process (kit/run.ts) and
// imports the shared one from kit/harness.ts instead. Not a module-level `goodPrompts`
// either, for a different reason: stubContext is built fresh per `setupFixtureDeployment()`
// call, closed over THAT call's own goodPrompts, so nothing here is shared mutable state
// between files.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recipeFileChecksums, agentBundleChecksums } from "#framework/service/checksums.ts";
import { formatBatchStub } from "#framework/service/openclaw-cli.ts";
import { mcpServerSpec } from "#framework/commands/management/provision-agent/index.ts";
import { currentComposition, lockFile } from "#framework/commands/management/lock.ts";
import type { PluginListEntry, SkillListEntry } from "#framework/commands/management/extensions.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { backupArchiveName } from "#framework/service/archive/index.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";

export const DATA = "/srv/clawforge/data";
export const CONFIG_FILE = `${DATA}/config/openclaw.json`;
export const MIRROR = `${DATA}/workspace/mcp-demo`;
export const BACKUP_DIR = "/srv/clawforge/backups";

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
  /** A failed container or one failed command inside an otherwise complete batch. */
  batchFailure?: "throw" | "exit";
  batchSlotFailures?: readonly string[];
  /** `plugins list --json`'s entries, defaulting to none — a case that says nothing about
   *  plugins provokes no PLUGIN_DRIFT, same reasoning as agents/mcpServers above. */
  plugins?: PluginListEntry[];
  /** `skills list --json`'s entries, same default. */
  skills?: SkillListEntry[];
  /** `channels status --json`'s own channelAccounts shape — only fetched, and only added to
   *  the batch, when a case calls gatherInspection with `{ channels: true }`. Left undefined
   *  by default so that command's own script line is left unmatched, the same "gap, not a
   *  verdict" a real CLI failure would leave — the case a case that says nothing about
   *  channels means "the CLI call itself failed", not "no channels configured". */
  channelsStatus?: Record<string, unknown>;
  mirrorChecksums?: Record<string, string>;
  /** What the agent's workspace holds — its prompt files as the target reports them. */
  workspaceChecksums?: Record<string, string>;
  /** Prompt files the ownership ledger says this agent previously installed. */
  managedPromptFiles?: string[];
  /** Overrides the deployment's data directory — for checks that need a hostile (shell-
   *  metacharacter) name inside the paths the target commands are built from. */
  dataDir?: string;
  /** Overrides ctx.settings.image — a bare tag exercises IMAGE_UNPINNED (and, paired with
   *  localImageDigest/runningDigest below, IMAGE_TAG_MOVED). Defaults to a digest, so a case
   *  that says nothing about the image provokes neither finding. */
  image?: string;
  /** What imageReference() answers for the LOCAL tag's current resolution — the fact
   *  IMAGE_TAG_MOVED compares against runningDigest below. Defaults to the same digest as
   *  runningDigest, i.e. "the tag has not moved". */
  localImageDigest?: string;
  /** What runningImageIdentity() reports as the running container's own digest. Defaults to
   *  the fixture's fixed digest — drift.check.ts's own assertions pin that literal value. */
  runningDigest?: string;
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
    // Every path below derives from the case's own data directory, so a hostile override
    // stays consistent with what the code under test derives from ctx.settings.dataDir.
    const dataDir = spec.dataDir ?? DATA;
    const configFile = `${dataDir}/config/openclaw.json`;
    const envFile = `${dataDir}/config/.env`;
    const ledgerFile = `${dataDir}/clawforge-managed.json`;
    const mirrorDir = `${dataDir}/workspace/mcp-demo`;
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
        dataDir,
        // A digest by default: the fixture models an already-pinned deployment (what
        // bootstrap now leaves behind), so a case that says nothing about the
        // image provokes neither IMAGE_UNPINNED nor IMAGE_TAG_MOVED. folder.check.ts's own
        // image-pinning section overrides this to exercise both.
        image: spec.image ?? `ghcr.io/openclaw/openclaw@sha256:${"a".repeat(64)}`,
        backupDir: BACKUP_DIR,
        env: { OPENCLAW_GATEWAY_TOKEN: "a-token-value" },
      },
      transport: {
        description: "local",
        async exists(path: string): Promise<boolean> {
          if (path === configFile) return true;
          if (path === envFile) return spec.targetEnv !== undefined;
          return false;
        },
        async readFile(path: string): Promise<string> {
          if (path === configFile) return JSON.stringify(liveConfig);
          if (path === envFile) return spec.targetEnv ?? "";
          if (path === ledgerFile && spec.managedPromptFiles !== undefined) {
            return JSON.stringify({
              version: 1,
              objects: [{ kind: "agent", name: "onboarding", recipe: "demo", promptFiles: spec.managedPromptFiles, createdAt: "2026-01-01T00:00:00.000Z" }],
            });
          }
          throw new Error(`unexpected read: ${path}`);
        },
        async listFiles(dir: string): Promise<string[]> {
          return dir === mirrorDir ? Object.keys(spec.mirrorChecksums ?? {}) : Object.keys(spec.workspaceChecksums ?? goodPrompts);
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
            // The directory arrives as the positional parameter (args[3]); the program text
            // (args[1]) is a constant and must not be searched for the path.
            const wanted = args[3] === mirrorDir ? spec.mirrorChecksums : (spec.workspaceChecksums ?? goodPrompts);
            const lines = Object.entries(wanted ?? {}).map(([rel, sum]) => `${sum}  ./${rel}`);
            return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
          }
          // upkeep.ts's own reads (observeBackupHealth/observeDiskSpace) — every case here is
          // about something else, so both answer as "nothing to report": one fresh full
          // archive (never BACKUP_MISSING/BACKUP_STALE) and ample free space (never DISK_LOW).
          if (command === "find" && args.some((arg) => arg.endsWith(".tar.gz"))) {
            const name = backupArchiveName(deploymentName(), "20260101-000000", "full");
            const nowSeconds = Math.floor(Date.now() / 1000);
            return { code: 0, stdout: `1024\t${nowSeconds}\t${BACKUP_DIR}/${name}\n`, stderr: "" };
          }
          if (command === "df") {
            const paths = args.slice(1);
            const header = "Filesystem     1024-blocks      Used Available Capacity Mounted on";
            const rows = paths.map((path) => `stub               100000000       500 99999500       1% ${path}`);
            return { code: 0, stdout: `${[header, ...rows].join("\n")}\n`, stderr: "" };
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
          return spec.localImageDigest ?? "ghcr.io/openclaw/openclaw@sha256:abc";
        },
        async runningImageIdentity(): Promise<{ imageId: string; digests: string[]; containerId: string }> {
          return { imageId: "img", digests: [spec.runningDigest ?? "ghcr.io/openclaw/openclaw@sha256:abc"], containerId: "container-1" };
        },
        async startedAt(): Promise<number> {
          return spec.startedAtMs ?? 5_000_000;
        },
        async runOneOff(_service: string, args: string[]): Promise<ExecResult> {
          const agentsList = json((spec.agents ?? ["main", "onboarding"]).map((id) => ({ id })));
          const mcpList = json(
            Object.fromEntries((spec.mcpServers ?? ["demo-mcp"]).map((name) => [name, spec.mcpServerEntries?.[name] ?? mcpServerSpec("demo")])),
          );
          const cronListResult = json({ jobs: spec.cronJobs ?? [matchingJob()] });
          const version = { code: 0, stdout: "OpenClaw 2026.6.34\n", stderr: "" };
          const pluginsList = json({ plugins: spec.plugins ?? [] });
          const skillsList = json({ skills: spec.skills ?? [] });

          // observeLive's own batched read (openclawCliBatch): "-c" plus a script is the
          // shape only that call ever passes, never a plain "agents"/"mcp"/"cron" argv. Two
          // different callers batch different command sets (observeLive's six vs lock's own
          // plugins+skills pair, lock.ts's currentComposition) — matched by each generated
          // line's own quoted argv rather than by position or count, so either shape answers
          // correctly regardless of how many commands it asked for.
          if (args[0] === "-c") {
            if (spec.batchFailure === "throw") throw new Error("batch transport failed");
            if (spec.batchFailure === "exit") return { code: 1, stdout: "", stderr: "" };
            const script = args[1] ?? "";
            const known: { needle: string; result: ExecResult }[] = [
              { needle: "'agents' 'list' '--json'", result: agentsList },
              { needle: "'mcp' 'list' '--json'", result: mcpList },
              { needle: "'cron' 'list' '--json'", result: cronListResult },
              { needle: "'--version'", result: version },
              { needle: "'plugins' 'list' '--json'", result: pluginsList },
              { needle: "'skills' 'list' '--json'", result: skillsList },
              ...(spec.channelsStatus === undefined
                ? []
                : [{ needle: "'channels' 'status' '--json'", result: json({ channelAccounts: spec.channelsStatus }) }]),
            ];
            const results = script
              .split("\n")
              .filter((line) => line.includes("node dist/index.js"))
              .map((line) => {
                const matched = known.find((entry) => line.includes(entry.needle));
                return matched !== undefined && spec.batchSlotFailures?.includes(matched.needle)
                  ? { code: 7, stdout: "", stderr: "" }
                  : matched?.result ?? { code: 1, stdout: "", stderr: "" };
              });
            return { code: 0, stdout: formatBatchStub(results), stderr: "" };
          }

          // provision-agent's own reconcile.ts reads these one at a time, unbatched — same
          // responses, kept reachable this way too.
          const key = args.slice(0, 2).join(" ");
          if (key === "agents list") return agentsList;
          if (key === "mcp list") return mcpList;
          if (key === "cron list") return cronListResult;
          if (args[0] === "--version") return version;
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
