// What `./clawforge inspect` reads: the declared state (from disk) and the observed state
// (from the target). Split out of inspect.ts; see helpers.ts (this same directory) for
// the pure pieces these use, and gather.ts for gatherInspection/inspect/doctor/renderJson/
// renderText.

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import JSON5 from "json5";
import { deploymentName, desiredStateFile, recipesDir } from "#src/runtime/deployment.ts";
import { openclawCliJson, openclawCli } from "#src/service/openclaw-cli.ts";
import { recipeFileChecksums, agentBundleChecksums } from "#src/service/checksums.ts";
import { readLedger, orphanedBy, foreign } from "#src/set/ownership/ledger.ts";
import type { DeclaredOwnership } from "#src/set/ownership/ledger.ts";
import {
  recipeMirrorTargetDir,
  agentWorkspaceTargetDir,
  loadRecipeAgentBundle,
  cronJobMatches,
  mcpServerMatches,
} from "#src/commands/management/provision-agent/index.ts";
import type { RecipeAgentBundle, CronJob } from "#src/commands/management/provision-agent/index.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem, DeclaredState, ObservedState } from "#src/service/inspection.ts";
import { valueAt, cronDifferences } from "./helpers.ts";
import type { Context } from "#src/core/context.ts";

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

export async function declaredState(ctx: Context, problems: Problem[]): Promise<DeclaredState> {
  let config: { path: string; value: unknown }[] = [];
  let raw: string | undefined;
  try {
    raw = await readFile(desiredStateFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // A directory sitting where the file should be, a permissions error, or anything else
      // that is not "there is genuinely no file" must not be silently treated the same way
      // as a legitimate empty declaration — that is how a broken (or blocked) declaration
      // produced healthy: true with nothing ever saying it could not even be read.
      problems.push(problem("CONFIG_DRIFT", `${desiredStateFile()} could not be read: ${(error as Error).message}`));
    }
    // ENOENT: no file at all. A deployment with no desired state declares nothing about the
    // config — reported as an empty declaration rather than as a failure: inspect must still
    // work.
  }
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as { path: string; value?: unknown }[];
      config = parsed.map((entry) => ({ path: entry.path, value: entry.value }));
    } catch (error) {
      // The file EXISTS and was meant to declare something — silently treating that the same
      // way as "no file at all" is how a broken declaration produced healthy: true and
      // changed: false, with nothing wrong ever reported. Same code and remedy
      // observeConfig() (below) already uses for its own equivalent case, the LIVE config
      // failing to parse.
      problems.push(problem("CONFIG_DRIFT", `${desiredStateFile()} exists but is not valid JSON: ${(error as Error).message}`));
    }
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
export async function observeConfig(
  ctx: Context,
  declared: DeclaredState,
  problems: Problem[],
): Promise<{ config: Record<string, unknown>; mtimeMs?: number }> {
  const config: Record<string, unknown> = {};
  const configFile = `${ctx.settings.dataDir}/config/openclaw.json`;
  let mtimeMs: number | undefined;

  try {
    // JSON5, not JSON: the live config is OpenClaw's own JSON5 gateway format (docs.openclaw.ai/
    // gateway/configuration) — a comment or trailing comma is legitimate there, and plain
    // JSON.parse rejecting it produced a false CONFIG_DRIFT on every run against such a config.
    const parsed = JSON5.parse(await ctx.transport.readFile(configFile)) as unknown;
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

export async function observeLive(
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
