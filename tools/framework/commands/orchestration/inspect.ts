// `./clawforge inspect [--json]` — what this deployment declares, what the instance actually is,
// and where the two disagree. `./clawforge doctor` lives here too: it is the same inspection read
// for its problems rather than its inventory, and a second gatherer would eventually give a
// second answer to one question.
//
// The information already existed, spread across `status` (containers and probes),
// `secrets` (what is missing), `provision-agent` (what a recipe expects) and a few CLI
// calls nobody should have to remember. Spread out, it is only useful to someone who
// already knows which question to ask. Gathered, it answers the one question a coder
// actually has — is this instance what the repository says it is — in a form an agent can
// branch on rather than read.
//
// Read-only, deliberately and completely: nothing here writes, starts, restarts or
// registers anything. That is what makes it safe to call before deciding to act, which is
// the whole point of having it. `plan` turns its findings into actions; `apply` executes
// them.
//
// Cost: the live agent/MCP/cron lists come from OpenClaw's own CLI, which is a container
// per call. `./clawforge cli-start` makes those execs instead, and the difference is several
// seconds per inspect.

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, warn, die } from "../../core/log.ts";
import { emit, isCaptured } from "../../core/output.ts";
import { frameworkRoot } from "../../core/env.ts";
import { deploymentName, desiredStateFile, recipesDir } from "../../runtime/deployment.ts";
import { status as secretStatus } from "../../service/secrets.ts";
import { openclawCliJson, openclawCli } from "../../service/openclaw-cli.ts";
import { recipeFileChecksums, agentBundleChecksums } from "../../service/checksums.ts";
import { compareLock, readLock, currentComposition } from "../management/lock.ts";
import { readInstalledSet, requirementProblems } from "../../set/artifacts/install.ts";
import { readLedger, orphanedBy, foreign } from "../../set/ownership/ledger.ts";
import type { DeclaredOwnership } from "../../set/ownership/ledger.ts";
import {
  recipeMirrorTargetDir,
  agentWorkspaceTargetDir,
  loadRecipeAgentBundle,
  cronJobMatches,
  mcpServerMatches,
} from "../management/provision-agent.ts";
import type { RecipeAgentBundle, AgentConfig, CronJob } from "../management/provision-agent.ts";
import {
  problem,
  blockingProblems,
  isHealthy,
  nextActions,
} from "../../service/inspection.ts";
import type { Problem, Inspection, DeclaredState, ObservedState } from "../../service/inspection.ts";
import type { Context } from "../../core/context.ts";

const PROBE_ENDPOINTS = ["healthz", "startupz", "readyz"];

/** A recipe's agent bundle, in the fields inspect compares against the instance. Parsed
 *  loosely on purpose: this is reading someone else's declaration to report on it, not
 *  validating it — provision-agent owns the validation and says so properly. */
interface RecipeExpectation {
  readonly recipe: string;
  readonly bundle: RecipeAgentBundle;
}

async function recipeExpectations(): Promise<RecipeExpectation[]> {
  const found: RecipeExpectation[] = [];
  let entries: string[];
  try {
    entries = (await readdir(recipesDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return found;
  }

  for (const recipe of entries.sort()) {
    try {
      // The same loader provision-agent uses, defaults and all. Reading config.json a second
      // way here is how the inspection came to compare less than the reconciliation does —
      // it knew the job's name and schedule and nothing else about the contract.
      found.push({ recipe, bundle: await loadRecipeAgentBundle(recipe) });
    } catch {
      // No agent bundle: a recipe can be a plain service. Not a finding.
    }
  }
  return found;
}

/** The same checksums for what is actually on the target, computed there — one command for
 *  the whole tree rather than reading every file back over the transport. */
async function targetFileChecksums(ctx: Context, dir: string): Promise<Record<string, string>> {
  const listed = await ctx.transport.listFiles(dir);
  if (listed.length === 0) return {};

  const result = await ctx.transport.exec(
    "sh",
    ["-c", `cd ${JSON.stringify(dir)} && find . -type f -exec sha256sum {} +`],
    { allowFailure: true },
  );
  if (result.code !== 0) return {};

  const checksums: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\.\/(.+)$/.exec(line.trim());
    if (match !== null) checksums[match[2]] = match[1];
  }
  return checksums;
}

/** Field by field, so the reader is not left to diff a cron job themselves. Mirrors exactly
 *  what cronJobMatches compares — it decides, this only explains its verdict. */
function cronDifferences(job: CronJob, config: AgentConfig, cronMessage: string): string[] {
  const differences: string[] = [];
  if (job.agentId !== config.agentId) differences.push(`agent is ${job.agentId ?? "(none)"}, declared ${config.agentId}`);
  if (job.schedule?.expr !== config.cronSchedule) differences.push(`runs at ${job.schedule?.expr ?? "(none)"}, declared ${config.cronSchedule}`);
  if (config.cronTimezone !== undefined && job.schedule?.tz !== config.cronTimezone) differences.push(`timezone is ${job.schedule?.tz ?? "(host default)"}, declared ${config.cronTimezone}`);
  if (job.sessionTarget !== "isolated") differences.push(`session is ${job.sessionTarget ?? "(none)"}, declared isolated`);
  if (job.payload?.message !== cronMessage) differences.push("the message differs from agent/cron-message.txt");
  if (job.payload?.timeoutSeconds !== config.cronTimeoutSeconds) {
    differences.push(`timeout is ${job.payload?.timeoutSeconds ?? "(none)"}s, declared ${config.cronTimeoutSeconds}s`);
  }
  if (job.delivery?.mode !== "none") differences.push(`delivery is ${job.delivery?.mode ?? "(none)"}, declared none`);
  return differences;
}

function valueAt(config: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], config);
}

async function frameworkVersion(): Promise<string | undefined> {
  // Source mode puts package.json next to this file's directory; the built package puts it
  // one level up from dist/. Asked for rather than assumed, same reasoning as clientEntry().
  for (const candidate of [resolve(frameworkRoot, "package.json"), resolve(frameworkRoot, "..", "package.json")]) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "@clawforge/framework") return parsed.version;
    } catch {
      // Try the next one.
    }
  }
  return undefined;
}

async function declaredState(ctx: Context): Promise<DeclaredState> {
  let config: { path: string; value: unknown }[] = [];
  try {
    const parsed = JSON.parse(await readFile(desiredStateFile(), "utf8")) as { path: string; value?: unknown }[];
    config = parsed.map((entry) => ({ path: entry.path, value: entry.value }));
  } catch {
    // A deployment with no desired state declares nothing about the config. Reported as an
    // empty declaration rather than as a failure: inspect must still work.
  }

  return {
    deployment: deploymentName(),
    config,
    image: ctx.settings.image,
    recipes: (await recipeExpectations()).map((entry) => entry.recipe),
  };
}

/** The declared settings against their live values, and when the file was last written.
 *
 *  Deliberately outside the "is it running" branch. openclaw.json is a file on the target,
 *  readable whether or not anything is serving — and skipping the comparison because the
 *  gateway is down produced a plan of just [up], which then started the instance on a
 *  configuration nobody had applied. The command reported success, the journal said
 *  succeeded, and the declaration was not in force. A comparison that works without the
 *  gateway must not be gated on the gateway. */
async function observeConfig(
  ctx: Context,
  declared: DeclaredState,
  problems: Problem[],
): Promise<{ config: Record<string, unknown>; mtimeMs?: number }> {
  const config: Record<string, unknown> = {};
  const configFile = `${ctx.settings.dataDir}/config/openclaw.json`;
  let mtimeMs: number | undefined;

  try {
    const parsed = JSON.parse(await ctx.transport.readFile(configFile)) as unknown;
    for (const entry of declared.config) {
      const actual = valueAt(parsed, entry.path);
      config[entry.path] = actual;
      if (JSON.stringify(actual) !== JSON.stringify(entry.value)) {
        problems.push(
          problem("CONFIG_DRIFT", `${entry.path} is ${JSON.stringify(actual)}, declared ${JSON.stringify(entry.value)}`),
        );
      }
    }
    const stamp = await ctx.transport.exec("stat", ["-c", "%Y", configFile], { allowFailure: true });
    if (stamp.code === 0) {
      const seconds = Number.parseInt(stamp.stdout.trim(), 10);
      if (!Number.isNaN(seconds)) mtimeMs = seconds * 1000;
    }
  } catch {
    // A deployment that has never been bootstrapped has no configuration at all, which is
    // not drift — there is nothing to have drifted from. Only a file that exists and cannot
    // be understood is a finding.
    if (await ctx.transport.exists(configFile)) {
      problems.push(problem("CONFIG_DRIFT", `${configFile} could not be read or parsed`));
    }
  }

  return { config, mtimeMs };
}

async function observeLive(
  ctx: Context,
  declared: DeclaredState,
  problems: Problem[],
  configMtimeMs: number | undefined,
): Promise<Partial<ObservedState>> {
  const probes: Record<string, number> = {};
  for (const endpoint of PROBE_ENDPOINTS) {
    try {
      probes[endpoint] = await ctx.runtime.probe(endpoint);
    } catch {
      probes[endpoint] = 0;
    }
  }
  const failedProbes = Object.entries(probes).filter(([, code]) => code !== 200);

  // Both criteria are read, because they can disagree and that disagreement is what
  // uncovered a broken healthcheck on this deployment before. They are not equal, though:
  //
  //   "unhealthy"/"missing"  the runtime has decided. A finding whatever the probes say.
  //   "starting"             the healthcheck's grace period — genuinely not known yet, and
  //                          the state every container passes through on the way up. An
  //                          inspection right after a restart used to report it as a fault,
  //                          which is a false alarm on a working instance, and a report
  //                          that cries wolf stops being read. The probes decide instead:
  //                          answering means it is serving, whatever the runtime has got
  //                          around to concluding.
  //   "healthy"/"none"       trusted, but still only as far as the probes agree.
  const health = await ctx.runtime.health();
  const probeDetail = failedProbes.map(([name, code]) => `${name} answered ${code}`).join(", ");

  if (health === "unhealthy" || health === "missing") {
    problems.push(
      problem(
        "GATEWAY_UNHEALTHY",
        `the runtime reports the container "${health}"${failedProbes.length === 0 ? ", though the HTTP probes answer" : `, and ${probeDetail}`}`,
      ),
    );
  } else if (failedProbes.length > 0) {
    problems.push(
      problem(
        "GATEWAY_UNHEALTHY",
        `the runtime reports the container "${health}" but ${probeDetail}`,
      ),
    );
  }

  // Correct on disk is not the same as in force: this instance reads its configuration at
  // startup only.
  const startedAt = await ctx.runtime.startedAt();
  if (startedAt !== undefined && configMtimeMs !== undefined && configMtimeMs > startedAt) {
    problems.push(
      problem(
        "RESTART_REQUIRED",
        `${ctx.settings.dataDir}/config/openclaw.json was written ${new Date(configMtimeMs).toISOString()}, after the instance started ${new Date(startedAt).toISOString()}`,
      ),
    );
  }

  // --- what OpenClaw itself has registered ----------------------------------------------
  const agents = await listOrEmpty(ctx, ["agents", "list", "--json"], (parsed) =>
    (parsed as Array<{ id?: string }>).map((entry) => entry.id ?? "").filter((id) => id !== ""));
  // The full entries, not just names: a server present under the wrong command (or
  // disabled) is registered but broken, and the per-recipe check below needs to tell that
  // apart from genuinely missing — mcpServerMatches() is the same comparison
  // provision-agent's own reconciliation already uses.
  const mcpServerEntries = await listOrEmpty(ctx, ["mcp", "list", "--json"], (parsed) =>
    Object.entries(parsed as Record<string, { command?: unknown; args?: unknown; enabled?: unknown }>));
  const mcpServers = mcpServerEntries.map(([name]) => name);
  // Whole jobs, not flattened names: the declared contract is the message, the timeout, the
  // session target and the delivery mode as well as the schedule, and a job compared on two
  // of those can differ in every other one while reporting no drift at all.
  const liveJobs = await listOrEmpty(ctx, ["cron", "list", "--json"], (parsed) =>
    ((parsed as { jobs?: CronJob[] }).jobs ?? []));
  const cronJobs = liveJobs
    .map((job) => (job.schedule?.expr === undefined ? (job.name ?? "") : `${job.name ?? ""}@${job.schedule.expr}`))
    .filter((name) => name !== "");

  // What this framework can show it created, against what every recipe in the set currently
  // declares. An object recorded for a recipe that no longer exists, or that now names a
  // different agent/server/job (a rename), is orphaned; anything present that the ledger
  // never recorded is somebody else's and only ever reported, never proposed for removal.
  const expectations = await recipeExpectations();
  const declaredOwnership: DeclaredOwnership[] = expectations.flatMap(({ recipe, bundle }) => {
    const entries: DeclaredOwnership[] = [
      { kind: "agent", name: bundle.config.agentId, recipe },
      { kind: "mcp-server", name: bundle.config.mcpServerName, recipe },
    ];
    if (bundle.config.cronJobName !== undefined && bundle.cronMessage !== undefined) entries.push({ kind: "cron-job", name: bundle.config.cronJobName, recipe });
    return entries;
  });
  const ledger = await readLedger(ctx);
  for (const owned of orphanedBy(ledger, declaredOwnership)) {
    const memoryNote = owned.kind === "agent" ? " — removing it would also prune its workspace and memory" : "";
    problems.push(
      problem(
        "SET_OBJECT_ORPHANED",
        `${owned.kind} "${owned.name}" was created for recipe "${owned.recipe}", which the set no longer declares this way${memoryNote}`,
        `./clawforge set forget --kind ${owned.kind} --name ${owned.name}`,
      ),
    );
  }
  const foreignObjects = [
    ...foreign(ledger, "agent", agents).map((name) => ({ kind: "agent" as const, name })),
    ...foreign(ledger, "mcp-server", mcpServers).map((name) => ({ kind: "mcp-server" as const, name })),
    ...foreign(ledger, "cron-job", liveJobs.map((job) => job.name ?? "").filter((name) => name !== "")).map((name) => ({ kind: "cron-job" as const, name })),
  ];

  for (const expectation of expectations) {
    const { config, cronMessage } = expectation.bundle;
    const agentId = config.agentId;

    if (!agents.includes(agentId)) {
      problems.push(
        problem("AGENT_MISSING", `recipe "${expectation.recipe}" declares agent "${agentId}", which the instance does not have`, `./clawforge provision-agent ${expectation.recipe}`),
      );
    }
    const registeredServer = mcpServerEntries.find(([name]) => name === config.mcpServerName)?.[1];
    if (registeredServer === undefined) {
      problems.push(
        problem("MCP_SERVER_MISSING", `recipe "${expectation.recipe}" declares MCP server "${config.mcpServerName}", which is not registered`, `./clawforge provision-agent ${expectation.recipe}`),
      );
    } else if (!mcpServerMatches(registeredServer, expectation.recipe)) {
      problems.push(
        problem(
          "MCP_SERVER_MISSING",
          `recipe "${expectation.recipe}" declares MCP server "${config.mcpServerName}", which is registered but does not launch the recipe's server.ts (wrong command, or disabled)`,
          `./clawforge provision-agent ${expectation.recipe}`,
        ),
      );
    }
    if (config.cronJobName !== undefined && cronMessage !== undefined) {
      const live = liveJobs.find((job) => job.name === config.cronJobName);
      if (live === undefined) {
        problems.push(
          problem("CRON_DRIFT", `recipe "${expectation.recipe}" declares cron job "${config.cronJobName}", which does not exist`, `./clawforge provision-agent ${expectation.recipe}`),
        );
      } else if (!cronJobMatches(live, config, cronMessage)) {
        // The same comparison provision-agent reconciles with, so the inspection cannot
        // report agreement about a job that command would immediately replace. Named field
        // by field: "the job differs" leaves the reader to diff it themselves.
        problems.push(
          problem("CRON_DRIFT", `cron job "${config.cronJobName}" differs from the recipe: ${cronDifferences(live, config, cronMessage).join("; ")}`, `./clawforge provision-agent ${expectation.recipe}`),
        );
      }
    }

    // The mirrored recipe files, by content: a page edited in the repository and not yet
    // mirrored is the most ordinary drift there is, and a file-name comparison would miss
    // every instance of it.
    const recipeDir = resolve(recipesDir(), expectation.recipe);
    const localSums = await recipeFileChecksums(recipeDir);
    const targetSums = await targetFileChecksums(ctx, recipeMirrorTargetDir(ctx.settings.dataDir, expectation.recipe));
    const differing = Object.keys(localSums).filter((rel) => localSums[rel] !== targetSums[rel]);
    const extra = Object.keys(targetSums).filter((rel) => localSums[rel] === undefined);

    // The agent's own prompt files, which the mirror does not carry: provision-agent writes
    // them into the agent's workspace instead. Comparing only the mirror meant an edited
    // AGENTS.md changed the agent's behaviour and nothing reported it, so plan scheduled
    // nothing and the old prompt stayed in force.
    {
      const bundle = await agentBundleChecksums(recipeDir);
      const workspace = await targetFileChecksums(ctx, agentWorkspaceTargetDir(ctx.settings.dataDir, agentId));
      const ownedPromptFiles = new Set(
        ledger.objects.find((owned) => owned.kind === "agent" && owned.name === agentId && owned.recipe === expectation.recipe)?.promptFiles ?? [],
      );
      const stalePrompts = Object.keys(bundle)
        .filter((rel) => rel.endsWith(".md"))
        .filter((rel) => bundle[rel] !== workspace[rel]);
      const extraPrompts = Object.keys(workspace)
        .filter((rel) => !rel.includes("/") && rel.endsWith(".md"))
        .filter((rel) => bundle[rel] === undefined && ownedPromptFiles.has(rel));
      if (stalePrompts.length > 0 || extraPrompts.length > 0) {
        const details: string[] = [];
        if (stalePrompts.length > 0) details.push(`older or missing (${stalePrompts.join(", ")})`);
        if (extraPrompts.length > 0) details.push(`withdrawn prompt file(s) still present (${extraPrompts.join(", ")})`);
        problems.push(
          problem(
            "RECIPE_MIRROR_DRIFT",
            `recipe "${expectation.recipe}": agent "${agentId}" has prompt drift: ${details.join("; ")}`,
            `./clawforge provision-agent ${expectation.recipe}`,
          ),
        );
      }
    }

    if (differing.length > 0 || extra.length > 0) {
      const parts: string[] = [];
      if (differing.length > 0) parts.push(`${differing.length} file(s) differ or are missing (${differing.slice(0, 3).join(", ")}${differing.length > 3 ? ", …" : ""})`);
      if (extra.length > 0) parts.push(`${extra.length} file(s) on the target the recipe no longer declares (${extra.slice(0, 3).join(", ")}${extra.length > 3 ? ", …" : ""})`);
      problems.push(
        problem("RECIPE_MIRROR_DRIFT", `recipe "${expectation.recipe}": ${parts.join("; ")}`, `./clawforge provision-agent ${expectation.recipe}`),
      );
    }
  }

  let openclawVersion: string | undefined;
  try {
    const result = await openclawCli(ctx, ["--version"]);
    openclawVersion = result.stdout.trim().split("\n")[0];
  } catch {
    openclawVersion = undefined;
  }

  return { probes, health, agents, mcpServers, cronJobs, foreignObjects, openclawVersion };
}

/** A `--json` list from OpenClaw's CLI, or an empty one when the call fails. A failing list
 *  must not take the whole inspection down: the finding a coder needs is usually elsewhere,
 *  and an inspection that refuses to answer is worse than one with a gap in it. */
async function listOrEmpty<T>(ctx: Context, args: string[], extract: (parsed: unknown) => T[]): Promise<T[]> {
  try {
    return extract(await openclawCliJson<unknown>(ctx, args));
  } catch {
    return [];
  }
}

/** The whole picture. Exported because doctor, plan and apply all read it rather than
 *  gathering their own — three gatherers would be three answers to one question. */
export async function gatherInspection(ctx: Context): Promise<Inspection> {
  const problems: Problem[] = [];
  const declared = await declaredState(ctx);

  const running = await ctx.runtime.isRunning();
  const secrets = await secretStatus(ctx);
  for (const secret of secrets) {
    if (secret.required && !secret.present) {
      problems.push(problem("SECRET_MISSING", `${secret.name} (${secret.usedBy}) is not set in ${secret.location === "repo-env" ? ".env" : "<data>/config/.env"}`));
    }
  }

  // Read whether or not anything is serving: the declaration is compared against a file on
  // the target, and a stopped instance is exactly when someone is about to start one.
  const configState = await observeConfig(ctx, declared, problems);

  if (!running) {
    problems.push(problem("GATEWAY_DOWN", `no running container for deployment "${declared.deployment}"`));
    return {
      declared,
      observed: {
        running: false,
        probes: {},
        config: configState.config,
        secrets,
        agents: [],
        mcpServers: [],
        cronJobs: [],
        foreignObjects: [],
        frameworkVersion: await frameworkVersion(),
      },
      problems,
    };
  }

  const live = await observeLive(ctx, declared, problems, configState.mtimeMs);

  // Which set is installed here, and whether this machine matches what it required. Read
  // before the lock comparison because it is the more specific answer: a lock says what the
  // composition was pinned to, a set id says what was actually installed.
  const installed = await readInstalledSet(ctx);
  if (installed !== undefined) {
    problems.push(
      ...requirementProblems(
        { requires: installed.requires } as never,
        { framework: await frameworkVersion(), imageDigest: await ctx.runtime.imageReference() },
      ),
    );
  }

  // Last, and only when the instance is up: the lock pins the image digest, which cannot be
  // read from a stopped instance, and a lock comparison against half an observation would
  // report differences that are only missing information.
  problems.push(...compareLock(await readLock(), await currentComposition(ctx)));

  return {
    declared,
    observed: {
      running: true,
      secrets,
      image: ctx.settings.image,
      imageDigest: await ctx.runtime.imageReference(),
      frameworkVersion: await frameworkVersion(),
      probes: live.probes ?? {},
      health: live.health,
      config: configState.config,
      agents: live.agents ?? [],
      mcpServers: live.mcpServers ?? [],
      cronJobs: live.cronJobs ?? [],
      foreignObjects: live.foreignObjects ?? [],
      openclawVersion: live.openclawVersion,
    },
    problems,
  };
}

export async function inspect(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = args.includes("--json");
  for (const arg of args) {
    if (arg !== "--json") die(`unknown argument: ${arg}`);
  }

  const inspection = await gatherInspection(ctx);

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(renderJson(inspection), null, 2)}\n`);
    return;
  }

  renderText(inspection);
}

/** The machine-readable answer. Its own shape rather than the Inspection struct verbatim:
 *  what a caller needs first is the verdict and what to do about it, and burying those under
 *  the raw observation would make every consumer compute them again — differently. */
export function renderJson(inspection: Inspection): Record<string, unknown> {
  return {
    deployment: inspection.declared.deployment,
    healthy: isHealthy(inspection),
    problems: inspection.problems,
    nextActions: nextActions(inspection.problems),
    declared: inspection.declared,
    observed: inspection.observed,
  };
}

/** `./clawforge doctor` — the same inspection, answered as "is anything wrong, and what do I run".
 *
 *  Exits non-zero when something blocking was found, because that is the only part of the
 *  answer a script or a CI step can act on without reading the text. Warnings do not fail
 *  it: an instance with no lock file works, and a command that fails on everything it has
 *  an opinion about stops being consulted. */
export async function doctor(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = args.includes("--json");
  for (const arg of args) {
    if (arg !== "--json") die(`unknown argument: ${arg}`);
  }

  const inspection = await gatherInspection(ctx);
  const blocking = blockingProblems(inspection.problems);
  const warnings = inspection.problems.filter((entry) => entry.severity === "warning");

  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          deployment: inspection.declared.deployment,
          healthy: isHealthy(inspection),
          problems: inspection.problems,
          nextActions: nextActions(inspection.problems),
        },
        null,
        2,
      )}\n`,
    );
  } else if (inspection.problems.length === 0) {
    log(`${inspection.declared.deployment} is what this repository declares`);
    info(`state  running (${inspection.observed.health ?? "unknown"})`);
  } else {
    // Reported before the failure below, not instead of it: a reader who only sees "3
    // problems" learns nothing, and the whole point of the codes is that they travel.
    log(`${inspection.declared.deployment}: ${blocking.length} blocking, ${warnings.length} warning(s)`);
    for (const entry of inspection.problems) {
      warn(`${entry.code}  ${entry.detail}`);
      info(`  → ${entry.nextAction}`);
    }
    if (blocking.length === 0) info("nothing blocking — the instance is doing its job");
  }

  if (blocking.length > 0) {
    throw new Error(
      `${blocking.length} blocking problem(s): ${blocking.map((entry) => entry.code).join(", ")}. ` +
        `Next: ${nextActions(blocking).join(", ")}`,
    );
  }
}

function renderText(inspection: Inspection): void {
  const { declared, observed, problems } = inspection;

  log(`deployment ${declared.deployment}`);
  info(`state      ${observed.running ? `running (${observed.health ?? "unknown"})` : "not running"}`);
  if (observed.image !== undefined) info(`image      ${observed.image}`);
  if (observed.imageDigest !== undefined) info(`digest     ${observed.imageDigest}`);
  if (observed.frameworkVersion !== undefined) info(`framework  ${observed.frameworkVersion}`);
  if (observed.openclawVersion !== undefined) info(`openclaw   ${observed.openclawVersion}`);
  if (Object.keys(observed.probes).length > 0) {
    info(`probes     ${Object.entries(observed.probes).map(([name, code]) => `${name} ${code}`).join("  ")}`);
  }

  log("declared vs live");
  info(`config     ${declared.config.length} declared setting(s), ${problems.filter((entry) => entry.code === "CONFIG_DRIFT").length} drifted`);
  info(`secrets    ${observed.secrets.filter((entry) => entry.present).length}/${observed.secrets.length} present`);
  info(`recipes    ${declared.recipes.length === 0 ? "(none)" : declared.recipes.join(", ")}`);
  if (observed.agents.length > 0) info(`agents     ${observed.agents.join(", ")}`);
  if (observed.mcpServers.length > 0) info(`mcp        ${observed.mcpServers.join(", ")}`);
  if (observed.cronJobs.length > 0) info(`cron       ${observed.cronJobs.join(", ")}`);
  if (observed.foreignObjects.length > 0) {
    info(`foreign    ${observed.foreignObjects.map((entry) => `${entry.kind}:${entry.name}`).join(", ")} (not created by this framework — never touched)`);
  }

  if (problems.length === 0) {
    log("no problems found");
    return;
  }

  log(`${problems.length} problem(s), ${blockingProblems(problems).length} blocking`);
  for (const entry of problems) {
    warn(`${entry.code}  ${entry.detail}`);
    info(`  → ${entry.nextAction}`);
  }
}
