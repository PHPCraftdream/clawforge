// Pure declaration pieces for `./clawforge provision-agent`: the agent/config.json shape,
// path builders, and the argv/comparison functions used both to REGISTER an agent/MCP
// server/cron job and to check whether one already matches. Split out of
// provision-agent.ts, which is the most fanned-out file in the codebase for selective
// imports (install.ts, set.ts, inspect/, several checks) — every export here keeps its
// name, so provision-agent.ts's own barrel re-export means none of those import sites
// need to change.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { die } from "#src/core/log.ts";
import { recipesDir } from "#src/runtime/deployment.ts";
import { containerPaths } from "#src/runtime/mounts.ts";
import { safeName } from "#src/core/names.ts";
import { collectPortableAgentBundleFiles, collectPortableRecipeFiles } from "#src/security/recipe-portable-content.ts";

const DEFAULT_CRON_SCHEDULE = "17 3 * * *"; // daily, off-peak, off the :00/:30 pileup minutes
const DEFAULT_CRON_TIMEOUT_SECONDS = 900;

export interface AgentConfig {
  readonly agentId: string;
  readonly mcpServerName: string;
  readonly cronJobName?: string;
  readonly cronSchedule: string;
  readonly cronTimezone?: string;
  readonly cronTimeoutSeconds: number;
}

export interface RecipeAgentBundle {
  readonly recipeDir: string;
  readonly config: AgentConfig;
  readonly promptFiles: Record<string, string>;
  readonly cronMessage?: string;
}

export function parseAgentConfig(raw: unknown): AgentConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) die("agent/config.json must be an object");
  const obj = raw as Partial<Record<keyof AgentConfig, unknown>>;
  if (typeof obj.agentId !== "string" || obj.agentId === "") die("agent/config.json: \"agentId\" must be a non-empty string");
  if (typeof obj.mcpServerName !== "string" || obj.mcpServerName === "") die("agent/config.json: \"mcpServerName\" must be a non-empty string");
  if (obj.cronJobName !== undefined && (typeof obj.cronJobName !== "string" || obj.cronJobName === "")) {
    die("agent/config.json: \"cronJobName\" must be a non-empty string when present");
  }
  // These values become path segments, OpenClaw identifiers and plan arguments. Keep the
  // same portable name contract as recipes/deployments so a declaration cannot escape the
  // workspace or produce an ambiguous copy-paste removal command.
  safeName("agent", obj.agentId);
  safeName("MCP server", obj.mcpServerName);
  if (obj.cronJobName !== undefined) safeName("cron job", obj.cronJobName);
  if (obj.cronTimezone !== undefined) {
    if (typeof obj.cronTimezone !== "string" || obj.cronTimezone === "") die("cronTimezone must be an IANA timezone");
    try { new Intl.DateTimeFormat("en", { timeZone: obj.cronTimezone }); } catch { die("cronTimezone must be an IANA timezone"); }
  }
  return {
    agentId: obj.agentId as string,
    mcpServerName: obj.mcpServerName as string,
    cronJobName: obj.cronJobName as string | undefined,
    cronSchedule: typeof obj.cronSchedule === "string" && obj.cronSchedule !== "" ? obj.cronSchedule : DEFAULT_CRON_SCHEDULE,
    ...(obj.cronTimezone === undefined ? {} : { cronTimezone: obj.cronTimezone as string }),
    cronTimeoutSeconds: typeof obj.cronTimeoutSeconds === "number" && obj.cronTimeoutSeconds > 0
      ? obj.cronTimeoutSeconds
      : DEFAULT_CRON_TIMEOUT_SECONDS,
  };
}

/** Every regular file under `dir`, recursively, as POSIX-style relative paths — except
 *  anything under a top-level directory named `excludeDir`. A thin delegate to the shared
 *  portable-content policy (security/recipe-portable-content.ts, audit 2026-09-22, P1-03):
 *  declared privateFiles and sensitive-name matches are held back, and the walker holds
 *  nothing back silently — it warns — while a symlink resolving outside the recipe
 *  directory stops the walk instead of being read through. Every caller of this function
 *  (the provision-agent mirror, the checks) gets the policy by not doing anything at all.
 *  Pure and local-filesystem-only: recipe content lives beside the tooling, never on the
 *  deployment's target, same boundary tools/framework/service/recipe.ts already draws for
 *  recipe.json. */
export async function collectRecipeFiles(dir: string, excludeDir: string): Promise<string[]> {
  return (await collectPortableRecipeFiles(dir, { excludeTop: excludeDir === "" ? undefined : excludeDir })).files;
}

/** Exported so `inspect` compares the SAME declaration provisioning acts on: two readers of
 *  one config.json, each with its own defaults, is how an inspection comes to disagree with
 *  the command it is supposed to be checking.
 *
 *  Reads through the SAME canonical walker as the set manifest and agentBundleChecksums
 *  (audit 2026-09-23, P1-03): a raw `readdir`+`readFile` here used to bypass the
 *  portable-content policy entirely, so `privateFiles: ["agent/private.md"]` kept the file
 *  out of the manifest and the checksum map while direct provisioning copied it into the
 *  agent's workspace anyway, and a public-named symlink was read straight through with no
 *  containment check. The walk runs once, before any file is read, so containment and
 *  exclusion are both settled before a single byte moves. The walk root itself is vetted
 *  the same way (round 6, P1-05): an `agent/` that is itself a link out of the recipe — or
 *  one that does not resolve — refuses provisioning exactly as an escaping child link
 *  does, while a plainly absent agent/ stays the honest "no bundle" case. config.json and — when the recipe
 *  declares a cron job — cron-message.txt are treated as mandatory: if the policy holds
 *  either back, provisioning refuses instead of silently reading it anyway or silently
 *  dropping the cron job the recipe declared. */
export async function loadRecipeAgentBundle(recipeName: string): Promise<RecipeAgentBundle> {
  const recipeDir = resolve(recipesDir(), recipeName);
  const agentDir = resolve(recipeDir, "agent");

  const walked = await collectPortableAgentBundleFiles(recipeDir);
  if (walked === undefined) {
    die(`recipe "${recipeName}" has no agent bundle — expected recipes/${recipeName}/agent/config.json`);
  }
  const { files, excluded } = walked;
  // `files` is walk-root-relative (bare "config.json"); `excluded` is recipe-relative
  // ("agent/config.json") — collectPortableRecipeFiles applies the policy against the
  // recipe-relative path even when walkRoot is the agent/ subdirectory. Look up with the
  // same prefix `excluded` actually carries, or a declared-private mandatory file (config.json,
  // cron-message.txt) never matches and the refusal below never fires.
  const reasonFor = (name: string): string | undefined => excluded.find((entry) => entry.path === `agent/${name}`)?.reason;

  const configExcluded = reasonFor("config.json");
  if (configExcluded !== undefined) {
    die(`recipe "${recipeName}": agent/config.json is excluded by the portable-content policy (${configExcluded}) — the agent bundle cannot be provisioned`);
  }
  if (!files.includes("config.json")) {
    die(`recipe "${recipeName}" has no agent bundle — expected recipes/${recipeName}/agent/config.json`);
  }
  let configRaw: string;
  try {
    configRaw = await readFile(resolve(agentDir, "config.json"), "utf8");
  } catch (error) {
    throw new Error(`recipe "${recipeName}" agent/config.json could not be read: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(configRaw!);
  } catch (error) {
    throw new Error(`recipe "${recipeName}" agent/config.json is not valid JSON: ${(error as Error).message}`);
  }
  const config = parseAgentConfig(parsed);

  // Top-level *.md only, exactly as the previous non-recursive readdir did — a file the
  // walker already excluded (declared private or sensitive-named) never reaches `files`, so
  // it never reaches promptFiles or the workspace it gets written to.
  const promptFiles: Record<string, string> = {};
  for (const rel of files) {
    if (rel.includes("/") || !rel.endsWith(".md")) continue;
    promptFiles[rel] = await readFile(resolve(agentDir, rel), "utf8");
  }

  const cronExcluded = reasonFor("cron-message.txt");
  let cronMessage: string | undefined;
  if (files.includes("cron-message.txt")) {
    cronMessage = (await readFile(resolve(agentDir, "cron-message.txt"), "utf8")).trim();
  } else if (cronExcluded !== undefined) {
    die(`recipe "${recipeName}": agent/cron-message.txt is excluded by the portable-content policy (${cronExcluded}) — a declared-private or sensitive-named cron message cannot be provisioned`);
  }
  if (cronMessage !== undefined && config.cronJobName === undefined) {
    die(`recipe "${recipeName}": agent/cron-message.txt exists but config.json has no "cronJobName"`);
  }

  return { recipeDir, config, promptFiles, cronMessage };
}

export function agentWorkspaceTargetDir(dataDir: string, agentId: string): string {
  return `${dataDir}/workspace/${agentId}`;
}

function agentWorkspaceContainerDir(agentId: string): string {
  return `${containerPaths.workspace}/${agentId}`;
}

export function recipeMirrorTargetDir(dataDir: string, recipeName: string): string {
  return `${dataDir}/workspace/mcp-${recipeName}`;
}

/** Where the recipe's own MCP server lives from inside the container — the path the gateway
 *  spawns. Exported so acceptance checks start the same file the instance would, rather than
 *  a second guess at where it ended up. */
export function recipeServerContainerPath(recipeName: string): string {
  return `${containerPaths.workspace}/mcp-${recipeName}/server.ts`;
}

export function agentsAddArgv(config: AgentConfig): string[] {
  return ["agents", "add", config.agentId, "--workspace", agentWorkspaceContainerDir(config.agentId), "--non-interactive", "--json"];
}

/** The command and args a recipe's MCP server registration should run — the one place both
 *  mcpAddArgv() (what registers it) and mcpServerMatches() (what checks it is still that)
 *  read from, so they cannot drift apart from each other. */
export function mcpServerSpec(recipeName: string): { command: string; args: string[] } {
  return { command: "node", args: ["--experimental-strip-types", recipeServerContainerPath(recipeName)] };
}

export function mcpAddArgv(config: AgentConfig, recipeName: string): string[] {
  const spec = mcpServerSpec(recipeName);
  return [
    "mcp", "add", config.mcpServerName,
    "--command", spec.command,
    ...spec.args.flatMap((arg) => ["--arg", arg]),
    "--parallel",
    "--no-probe",
  ];
}

/** Whether a live "mcp list --json" entry still launches the recipe's own server. Per
 *  OpenClaw's own registry (docs.openclaw.ai/cli/mcp/registry), a stdio entry carries its
 *  launch command under "command" and "args" — exactly what mcpAddArgv() sends via
 *  --command/--arg. A name being registered at all says nothing about whether it still
 *  points at a working command; this is what lets ensureMcpServer() tell "present and
 *  correct" apart from "present and broken". */
export function mcpServerMatches(entry: { command?: unknown; args?: unknown; enabled?: unknown } | undefined, recipeName: string): boolean {
  if (entry === undefined) return false;
  // OpenClaw excludes a disabled entry from tool discovery entirely (docs.openclaw.ai/cli/
  // mcp/registry) — a correctly-commanded but disabled registration is exactly as broken,
  // from an agent's point of view, as one that was never registered at all. Only an explicit
  // false counts as disabled; absent or true stays enabled, the conservative default.
  if (entry.enabled === false) return false;
  const spec = mcpServerSpec(recipeName);
  if (entry.command !== spec.command) return false;
  if (!Array.isArray(entry.args) || entry.args.length !== spec.args.length) return false;
  return entry.args.every((value, index) => value === spec.args[index]);
}

export function cronAddArgv(config: AgentConfig, cronMessage: string): string[] {
  return [
    "cron", "add",
    "--name", config.cronJobName!,
    "--agent", config.agentId,
    "--cron", config.cronSchedule,
    ...(config.cronTimezone === undefined ? [] : ["--tz", config.cronTimezone]),
    "--session", "isolated",
    "--expect-final",
    // The job's product is whatever it writes in its own workspace, not a chat reply. Left
    // on the default (announce -> "last" channel) it fail-closes on every run of a
    // deployment with no messaging channel configured.
    "--no-deliver",
    "--timeout-seconds", String(config.cronTimeoutSeconds),
    "--message", cronMessage,
    "--json",
  ];
}

export function cronRmArgv(jobId: string): string[] {
  return ["cron", "rm", jobId, "--json"];
}

export function agentsDeleteArgv(agentId: string): string[] {
  return ["agents", "delete", agentId, "--force", "--json"];
}

export function mcpUnsetArgv(name: string): string[] {
  return ["mcp", "unset", name];
}

/** A cron job as `cron list --json` reports it, in the fields this command declares. */
export interface CronJob {
  id: string;
  name?: string;
  agentId?: string;
  enabled?: boolean;
  schedule?: { expr?: string; tz?: string };
  sessionTarget?: string;
  payload?: { message?: string; timeoutSeconds?: number };
  delivery?: { mode?: string };
}

/** Whether a live job still matches what the recipe declares. Only the declared fields are
 *  compared: everything else in a job (its id, run history, next run time) is state the
 *  gateway owns, and comparing it would make every run look like drift.
 *
 *  A disabled job is not a match even when every other field agrees — --all (see
 *  ensureCronJob's own comment, provision-agent-reconcile.ts) is what makes it visible here
 *  at all, not what makes it count as working. Only an explicit false counts as disabled,
 *  the same conservative default mcpServerMatches already uses for its own "enabled" field. */
export function cronJobMatches(job: CronJob, config: AgentConfig, cronMessage: string): boolean {
  return job.enabled !== false
    && job.agentId === config.agentId
    && job.schedule?.expr === config.cronSchedule
    && (config.cronTimezone === undefined || job.schedule?.tz === config.cronTimezone)
    && job.sessionTarget === "isolated"
    && job.payload?.message === cronMessage
    && job.payload?.timeoutSeconds === config.cronTimeoutSeconds
    && job.delivery?.mode === "none";
}
