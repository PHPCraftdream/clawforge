// `./clawforge provision-agent <recipe>` — wires a recipe's MCP server to a dedicated OpenClaw
// agent: an isolated agent with its own workspace prompt files, the recipe's stdio MCP
// server registered against it, and (optionally) a cron job that sends the agent a
// recurring message.
//
// Convention a recipe opts into by adding an `agent/` subdirectory next to its existing
// files:
//   recipes/<name>/agent/config.json    identifiers + optional cron schedule (see below)
//   recipes/<name>/agent/*.md           copied verbatim as the new agent's workspace files
//   recipes/<name>/agent/cron-message.txt   optional — enables the cron job if present
//   recipes/<name>/server.ts            the recipe's own stdio MCP server (unchanged)
// Everything under recipes/<name>/ except agent/ is mirrored into the agent's data mount
// so the container can spawn recipes/<name>/server.ts; agent/ itself stays host-side, read
// once to build the workspace files and cron job below.
//
// config.json shape:
//   {
//     "agentId": string,            // OpenClaw agent id to create
//     "mcpServerName": string,      // name the MCP server is registered under
//     "cronJobName"?: string,       // required only if cron-message.txt exists
//     "cronSchedule"?: string,      // 5-field cron expression, default: daily off-peak
//     "cronTimeoutSeconds"?: number // default: 900
//   }
//
// Re-runnable by design, same spirit as apply-config: workspace prompt files and the
// mirrored recipe data are declared state and get rewritten every run; the agent's own
// accumulated files under its workspace's memory/ are never touched here.

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, die } from "../../core/log.ts";
import type { Context } from "../../core/context.ts";
import { recipesDir } from "../../runtime/deployment.ts";
import { containerPaths } from "../../runtime/mounts.ts";
import { safeName } from "../../core/names.ts";
import { openclawCli, openclawCliJson } from "../../service/openclaw-cli.ts";
import { takeLock, lockHeldHere } from "../../runtime/instance-lock.ts";
import { newOperationId } from "../../service/operations.ts";
import { readLedger, recordOwned, forgetOwned, ownerOf, updateOwnedPromptFiles } from "../../set/ownership/ledger.ts";
import type { Ledger } from "../../set/ownership/ledger.ts";
import type { OwnedKind } from "../../set/ownership/ledger.ts";
import { readInstalledSet } from "../../set/artifacts/install.ts";
import { setSourceDir } from "../../set/artifacts/source.ts";
import { setManifestId } from "../../set/artifacts/model.ts";

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
 *  anything under a top-level directory named `excludeDir`. Pure and local-filesystem-only:
 *  recipe content lives beside the tooling, never on the deployment's target, same boundary
 *  tools/framework/service/recipe.ts already draws for recipe.json. */
export async function collectRecipeFiles(dir: string, excludeDir: string): Promise<string[]> {
  async function walk(current: string, base: string): Promise<string[]> {
    const entries = await readdir(current, { withFileTypes: true });
    const paths: string[] = [];
    for (const entry of entries) {
      if (base === "" && entry.name === excludeDir) continue;
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        paths.push(...(await walk(full, base === "" ? entry.name : `${base}/${entry.name}`)));
      } else {
        paths.push(base === "" ? entry.name : `${base}/${entry.name}`);
      }
    }
    return paths;
  }
  return walk(dir, "");
}

/** Exported so `inspect` compares the SAME declaration provisioning acts on: two readers of
 *  one config.json, each with its own defaults, is how an inspection comes to disagree with
 *  the command it is supposed to be checking. */
export async function loadRecipeAgentBundle(recipeName: string): Promise<RecipeAgentBundle> {
  const recipeDir = resolve(recipesDir(), recipeName);
  const agentDir = resolve(recipeDir, "agent");

  let configRaw: string;
  try {
    configRaw = await readFile(resolve(agentDir, "config.json"), "utf8");
  } catch {
    die(`recipe "${recipeName}" has no agent bundle — expected recipes/${recipeName}/agent/config.json`);
  }
  const config = parseAgentConfig(JSON.parse(configRaw!));

  const promptFiles: Record<string, string> = {};
  for (const name of await readdir(agentDir)) {
    if (!name.endsWith(".md")) continue;
    promptFiles[name] = await readFile(resolve(agentDir, name), "utf8");
  }

  let cronMessage: string | undefined;
  try {
    cronMessage = (await readFile(resolve(agentDir, "cron-message.txt"), "utf8")).trim();
  } catch {
    cronMessage = undefined;
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

/** Mirrors the recipe's runtime files onto the target, deletions included.
 *
 *  Copying without deleting would not be a mirror: a page removed from the recipe stays on
 *  the target forever, the recipe's MCP server keeps serving it, and the agent keeps
 *  answering from instructions that were withdrawn — the failure is silent and reads like
 *  the agent inventing things.
 *
 *  Only this directory is mirrored. The agent's workspace is deliberately not: its prompt
 *  files are declared state, but the agent's own memory/ sits beside them, and "delete what
 *  the recipe does not declare" applied there would erase exactly what the agent is meant to
 *  accumulate. Emptied subdirectories are left in place — they hold nothing, and removing a
 *  directory is a much sharper tool than removing a file it once contained.
 *
 *  Returns what changed so the command can report it: a silent deletion is not much better
 *  than no deletion. */
export async function syncRecipeFiles(
  ctx: Context,
  recipeName: string,
  recipeDir: string,
): Promise<{ written: number; removed: string[] }> {
  const relPaths = await collectRecipeFiles(recipeDir, "agent");
  const targetDir = recipeMirrorTargetDir(ctx.settings.dataDir, recipeName);

  // Read before writing: afterwards the two sets overlap by construction and the answer is
  // the same, but this way the listing is of the state the previous run actually left.
  const alreadyThere = await ctx.transport.listFiles(targetDir);

  const dirs = new Set(relPaths.map((rel) => rel.slice(0, rel.lastIndexOf("/"))).filter((dir) => dir !== ""));
  await ctx.transport.mkdirp(targetDir);
  for (const dir of dirs) await ctx.transport.mkdirp(`${targetDir}/${dir}`);
  for (const rel of relPaths) {
    const content = await readFile(resolve(recipeDir, ...rel.split("/")), "utf8");
    await ctx.transport.writeFile(`${targetDir}/${rel}`, content);
  }

  const declared = new Set(relPaths);
  const removed = alreadyThere.filter((rel) => !declared.has(rel)).sort();
  for (const rel of removed) await ctx.transport.remove(`${targetDir}/${rel}`);

  return { written: relPaths.length, removed };
}

export async function writeWorkspacePromptFiles(
  ctx: Context,
  config: AgentConfig,
  promptFiles: Record<string, string>,
  managedPromptFiles: readonly string[] = [],
): Promise<void> {
  const targetDir = agentWorkspaceTargetDir(ctx.settings.dataDir, config.agentId);
  const existing = await ctx.transport.listFiles(targetDir);
  const declared = new Set(Object.keys(promptFiles));
  const managed = new Set(managedPromptFiles);
  // Keep nested state (especially memory/) and all files with no ownership proof untouched.
  // Only a top-level markdown file this agent creation recorded can be withdrawn safely.
  for (const rel of existing) {
    if (!rel.includes("/") && rel.endsWith(".md") && !declared.has(rel) && managed.has(rel)) {
      await ctx.transport.remove(`${targetDir}/${rel}`);
    }
  }
  await ctx.transport.mkdirp(targetDir);
  for (const [name, content] of Object.entries(promptFiles)) {
    await ctx.transport.writeFile(`${targetDir}/${name}`, content);
  }
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
  schedule?: { expr?: string; tz?: string };
  sessionTarget?: string;
  payload?: { message?: string; timeoutSeconds?: number };
  delivery?: { mode?: string };
}

/** Whether a live job still matches what the recipe declares. Only the declared fields are
 *  compared: everything else in a job (its id, run history, next run time) is state the
 *  gateway owns, and comparing it would make every run look like drift. */
export function cronJobMatches(job: CronJob, config: AgentConfig, cronMessage: string): boolean {
  return job.agentId === config.agentId
    && job.schedule?.expr === config.cronSchedule
    && (config.cronTimezone === undefined || job.schedule?.tz === config.cronTimezone)
    && job.sessionTarget === "isolated"
    && job.payload?.message === cronMessage
    && job.payload?.timeoutSeconds === config.cronTimeoutSeconds
    && job.delivery?.mode === "none";
}

export async function ensureAgent(ctx: Context, config: AgentConfig): Promise<boolean> {
  const agents = await openclawCliJson<Array<{ id: string }>>(ctx, ["agents", "list", "--json"]);
  if (agents.some((agent) => agent.id === config.agentId)) return false;
  await openclawCli(ctx, agentsAddArgv(config));
  return true;
}

/** Reconciled the same way ensureCronJob() already is: a registration present under a
 *  command that no longer matches the recipe (hand-edited, or left over from a renamed
 *  server.ts) is replaced rather than left broken and silently reported as fine. */
export async function ensureMcpServer(ctx: Context, config: AgentConfig, recipeName: string): Promise<"created" | "replaced" | "unchanged"> {
  const servers = await openclawCliJson<Record<string, { command?: unknown; args?: unknown }>>(ctx, ["mcp", "list", "--json"]);
  const existing = servers[config.mcpServerName];
  if (existing !== undefined) {
    if (mcpServerMatches(existing, recipeName)) return "unchanged";
    log(`MCP server "${config.mcpServerName}" is registered with a different command than the recipe declares — replacing it`);
    await openclawCli(ctx, mcpUnsetArgv(config.mcpServerName));
    await openclawCli(ctx, mcpAddArgv(config, recipeName));
    return "replaced";
  }
  await openclawCli(ctx, mcpAddArgv(config, recipeName));
  return "created";
}

/** Reconciled rather than merely created: a job whose schedule, message, timeout or
 *  delivery no longer matches the recipe is removed and added again. Editing a recipe and
 *  re-running would otherwise leave the old job in place, which is the opposite of what
 *  every other declared-state command here does. Replacement is opt-in because a job with no
 *  ledger entry is foreign; the top-level provision path passes ownership explicitly. */
export async function ensureCronJob(
  ctx: Context,
  config: AgentConfig,
  cronMessage: string,
  options: { readonly allowUpdate?: boolean } = {},
): Promise<"created" | "updated" | "unchanged"> {
  const listed = await openclawCliJson<{ jobs: CronJob[] }>(ctx, ["cron", "list", "--json"]);
  const existing = listed.jobs.find((job) => job.name === config.cronJobName);

  if (existing !== undefined) {
    if (cronJobMatches(existing, config, cronMessage)) return "unchanged";
    if (options.allowUpdate !== true) {
      throw new Error(
        `cron job "${config.cronJobName}" already exists but is not owned by this framework; ` +
          "refusing to replace a foreign job",
      );
    }
    log(`cron job "${config.cronJobName}" no longer matches the recipe — replacing it`);
    await openclawCli(ctx, cronRmArgv(existing.id));
    await openclawCli(ctx, cronAddArgv(config, cronMessage));
    return "updated";
  }

  await openclawCli(ctx, cronAddArgv(config, cronMessage));
  return "created";
}

/** Refuse a name collision before mirroring files or writing prompts. An OpenClaw object
 * without a ledger entry is foreign, even if it happens to have the same shape as this
 * recipe: silently adopting it would make a later rename/delete destructive. An entry for
 * another recipe is a collision too. The lock makes this check and the following writes one
 * operation, so a second provision cannot change the answer between them. */
async function assertObjectNamesAvailable(
  ctx: Context,
  recipeName: string,
  bundle: RecipeAgentBundle,
  ledger: Ledger,
): Promise<void> {
  const declared: { kind: "agent" | "mcp-server" | "cron-job"; name: string }[] = [
    { kind: "agent", name: bundle.config.agentId },
    { kind: "mcp-server", name: bundle.config.mcpServerName },
  ];
  if (bundle.config.cronJobName !== undefined && bundle.cronMessage !== undefined) {
    declared.push({ kind: "cron-job", name: bundle.config.cronJobName });
  }

  for (const entry of declared) {
    const owner = ownerOf(ledger, entry.kind, entry.name);
    if (owner !== undefined && owner.recipe !== recipeName) {
      throw new Error(
        `${entry.kind} "${entry.name}" is owned by recipe "${owner.recipe}"; ` +
          `refusing to use it for another recipe`,
      );
    }
  }

  const agents = await openclawCliJson<Array<{ id?: string }>>(ctx, ["agents", "list", "--json"]);
  if (agents.some((agent) => agent.id === bundle.config.agentId) && ownerOf(ledger, "agent", bundle.config.agentId) === undefined) {
    throw new Error(`agent "${bundle.config.agentId}" already exists but is not owned by this framework; refusing to adopt it`);
  }
  const servers = await openclawCliJson<Record<string, unknown>>(ctx, ["mcp", "list", "--json"]);
  if (Object.prototype.hasOwnProperty.call(servers, bundle.config.mcpServerName) && ownerOf(ledger, "mcp-server", bundle.config.mcpServerName) === undefined) {
    throw new Error(`MCP server "${bundle.config.mcpServerName}" already exists but is not owned by this framework; refusing to adopt it`);
  }
  if (bundle.config.cronJobName !== undefined && bundle.cronMessage !== undefined) {
    const listed = await openclawCliJson<{ jobs?: CronJob[] }>(ctx, ["cron", "list", "--json"]);
    if ((listed.jobs ?? []).some((job) => job.name === bundle.config.cronJobName) && ownerOf(ledger, "cron-job", bundle.config.cronJobName) === undefined) {
      throw new Error(`cron job "${bundle.config.cronJobName}" already exists but is not owned by this framework; refusing to adopt it`);
    }
  }
}

/** During `apply --set`, the artifact source is active before provisioning runs but the
 * target's installed-set marker is written only after the whole apply succeeds. Read the
 * active artifact id here so objects created mid-run are attributed to the set that actually
 * created them, rather than to the previous set. Working-tree runs keep the installed marker. */
async function activeSetId(ctx: Context): Promise<string | undefined> {
  const source = setSourceDir();
  if (source !== undefined) {
    try {
      const manifest = JSON.parse(await readFile(resolve(source, "set.json"), "utf8"));
      return setManifestId(manifest);
    } catch {
      // The source wrapper validates set.json before entering an apply. Keep the fallback for
      // direct callers and test contexts that use a source directory without an artifact.
    }
  }
  return (await readInstalledSet(ctx))?.id;
}

/** Removes an object this framework created and stops tracking it — the inverse of
 *  `ensureAgent`/`ensureMcpServer`/`ensureCronJob`. Called for an object the ledger says is
 *  ours but whose recipe no longer declares it (dropped, or renamed): never for an object
 *  the ledger does not know about, which is the boundary `orphanedBy` already draws before
 *  this is reached.
 *
 *  A cron job is looked up by its declared name first: the ledger and a recipe's config.json
 *  both name a job by that, but OpenClaw's own `cron rm` takes the id `cron list` assigns,
 *  the same indirection `ensureCronJob` already goes through to reconcile one. */
export async function removeOwnedObject(ctx: Context, kind: OwnedKind, name: string): Promise<void> {
  const ledger = await readLedger(ctx);
  if (ownerOf(ledger, kind, name) === undefined) {
    throw new Error(`${kind} "${name}" is not recorded as owned by this framework; refusing to remove it`);
  }

  const ignoreAlreadyAbsent = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/not found|does not exist|unknown (?:agent|server|job)/i.test(detail)) throw error;
  };

  if (kind === "agent") {
    try {
      await openclawCli(ctx, agentsDeleteArgv(name));
    } catch (error) {
      ignoreAlreadyAbsent(error);
    }
  } else if (kind === "mcp-server") {
    try {
      await openclawCli(ctx, mcpUnsetArgv(name));
    } catch (error) {
      ignoreAlreadyAbsent(error);
    }
  } else {
    const listed = await openclawCliJson<{ jobs: CronJob[] }>(ctx, ["cron", "list", "--json"]);
    const existing = listed.jobs.find((job) => job.name === name);
    if (existing !== undefined) await openclawCli(ctx, cronRmArgv(existing.id));
  }
  await forgetOwned(ctx, kind, name);
}

export async function provisionAgent(ctx: Context, args: string[]): Promise<void> {
  const breakLock = args.includes("--break-lock");
  const [rawName, ...rest] = args.filter((arg) => arg !== "--break-lock");
  if (rawName === undefined) die("usage: ./clawforge provision-agent <recipe>");
  if (rest.length > 0) die(`unknown argument: ${rest[0]}`);
  const recipeName = safeName("recipe", rawName);

  if (!(await ctx.runtime.isRunning())) die("the gateway is not running. Start it with ./clawforge up");

  const bundle = await loadRecipeAgentBundle(recipeName);

  // `apply` calls this as one of its steps and is already holding the lock; nested, the
  // second acquire would refuse the run its own caller started. Taken only when this is the
  // command someone invoked directly.
  const held = lockHeldHere() ? undefined : await takeLock(ctx, `provision-agent ${recipeName}`, newOperationId("provision-agent"), { breakLock });

  try {
    // Read once per run: the set installed here, if any, so every object this run creates
    // records which set asked for it. Existing objects are never adopted into the ledger.
    // Keep these reads inside the finally scope: a target read failure must still release the
    // lock acquired immediately above.
    const ledger = await readLedger(ctx);
    const setId = await activeSetId(ctx);
    await assertObjectNamesAvailable(ctx, recipeName, bundle, ledger);
    const mirror = await syncRecipeFiles(ctx, recipeName, bundle.recipeDir);
    const previousOwner = ownerOf(ledger, "agent", bundle.config.agentId);
    await writeWorkspacePromptFiles(ctx, bundle.config, bundle.promptFiles, previousOwner?.promptFiles ?? []);

    const agentCreated = await ensureAgent(ctx, bundle.config);
    if (agentCreated) {
      await recordOwned(ctx, {
        kind: "agent",
        name: bundle.config.agentId,
        recipe: recipeName,
        setId,
        promptFiles: Object.keys(bundle.promptFiles),
      });
    } else {
      await updateOwnedPromptFiles(ctx, bundle.config.agentId, Object.keys(bundle.promptFiles));
    }
    const mcpState = await ensureMcpServer(ctx, bundle.config, recipeName);
    if (mcpState !== "unchanged") await recordOwned(ctx, { kind: "mcp-server", name: bundle.config.mcpServerName, recipe: recipeName, setId });
    const cronState = bundle.cronMessage === undefined
      ? undefined
      : await ensureCronJob(ctx, bundle.config, bundle.cronMessage, {
        allowUpdate: ownerOf(ledger, "cron-job", bundle.config.cronJobName!) !== undefined,
      });
    if (cronState === "created") {
      await recordOwned(ctx, { kind: "cron-job", name: bundle.config.cronJobName!, recipe: recipeName, setId });
    }
    reportProvisioned(ctx, bundle, recipeName, mirror, agentCreated, mcpState, cronState);
  } finally {
    await held?.release();
  }
}

function reportProvisioned(
  ctx: Context,
  bundle: RecipeAgentBundle,
  recipeName: string,
  mirror: { written: number; removed: string[] },
  agentCreated: boolean,
  mcpState: "created" | "replaced" | "unchanged",
  cronState: "created" | "updated" | "unchanged" | undefined,
): void {

  log(`agent "${bundle.config.agentId}" provisioned from recipe "${recipeName}"`);
  info(`  agent  ${bundle.config.agentId}          ${agentCreated ? "created" : "already present"}`);
  info(`  mcp    ${bundle.config.mcpServerName}  ${mcpState}`);
  if (cronState !== undefined) {
    info(`  cron   ${bundle.config.cronJobName}    ${cronState} (${bundle.config.cronSchedule})`);
  }
  info(`workspace prompt files refreshed at ${agentWorkspaceTargetDir(ctx.settings.dataDir, bundle.config.agentId)}`);
  info(
    `recipe files mirrored to ${recipeMirrorTargetDir(ctx.settings.dataDir, recipeName)} ` +
      `(${mirror.written} file(s)${mirror.removed.length === 0 ? "" : `, ${mirror.removed.length} removed`})`,
  );
  for (const rel of mirror.removed) info(`  removed  ${rel}`);
  info(`try it: ./clawforge cli agent --agent ${bundle.config.agentId} -m "hello"`);
}
