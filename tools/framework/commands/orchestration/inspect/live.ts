// What the target itself reports, with no declared counterpart to compare against: the
// gateway's HTTP probes and runtime health, outbound egress from inside the container, and
// everything OpenClaw's own CLI says it has registered (agents/MCP servers/cron jobs/
// plugins/skills/channels), reconciled against the recipe set's declared ownership and the
// mirrored recipe/agent files' checksums. Split out of observe.ts; see helpers.ts (this same
// directory) for the pure pieces these use, declared.ts for recipeExpectations, and drift.ts
// for the per-facet declared-vs-target comparisons this has no declared side to run.

import { resolve } from "node:path";
import { recipesDir } from "#src/runtime/deployment.ts";
import { openclawCliBatch } from "#src/service/openclaw-cli.ts";
import type { BatchedCliResult } from "#src/service/openclaw-cli.ts";
import { recipeFileChecksums, agentBundleChecksums } from "#src/service/checksums.ts";
import { readLedger, orphanedBy, foreign } from "#src/set/ownership/ledger.ts";
import type { DeclaredOwnership } from "#src/set/ownership/ledger.ts";
import {
  recipeMirrorTargetDir,
  agentWorkspaceTargetDir,
  cronJobMatches,
  mcpServerMatches,
} from "#src/commands/management/provision-agent/index.ts";
import type { CronJob } from "#src/commands/management/provision-agent/index.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem, DeclaredState, ObservedState, EgressObservation, ChannelsStatusResponse } from "#src/service/inspection.ts";
import {
  PLUGINS_LIST_ARGS,
  SKILLS_LIST_ARGS,
  parsePluginsList,
  parseSkillsList,
} from "#src/commands/management/extensions.ts";
import type { PluginListEntry, SkillListEntry } from "#src/commands/management/extensions.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { EGRESS_EXEC_TIMEOUT_MS, EGRESS_PROBE_SCRIPT } from "./egress-probe.ts";
import { cronDifferences, egressEndpoints, redactEndpoint } from "./helpers.ts";
import { recipeExpectations } from "./declared.ts";
import type { Context } from "#src/core/context.ts";

const PROBE_ENDPOINTS = ["healthz", "startupz", "readyz"];

// The compose service inspect observes, named literally the way config.ts, provider.ts,
// accept.ts and smoke.ts already name it for their own execs into the same container.
const GATEWAY_SERVICE = "gateway";

// The target directory travels as a positional parameter and is never pasted into this
// text: JSON.stringify's double quotes do not make a path safe — inside them a POSIX shell
// still runs $(…), backticks and $VAR, which let a hostile directory name execute as the
// transport user during this read-only call, and the failed cd then checksummed whatever
// tree the shell landed in. The path is data at every shell — same shape as PROBE_SCRIPT in
// security/private-file.ts. Without its argument the script fails instead of checksumming a
// guessed directory. Git for Windows needs drive paths converted for its shell; cygpath -w
// receives only the positional value, whether its separators are slash or backslash.
const CHECKSUM_SCRIPT =
  'if [ "${1+set}" != set ] || [ -z "$1" ]; then echo NOCHECKSUMDIR >&2; exit 64; fi; ' +
  'dir=$1; case "$dir" in [A-Za-z]:*) if command -v cygpath >/dev/null 2>&1; then dir=$(cygpath -w -- "$dir") || { echo CHECKSUMPATHFAILED >&2; exit 69; }; fi ;; esac; ' +
  'cd -- "$dir" || { echo CHECKSUMCDFAILED >&2; exit 65; }; ' +
  'command -v find >/dev/null || { echo CHECKSUMFINDFAILED >&2; exit 66; }; ' +
  'command -v sha256sum >/dev/null || { echo CHECKSUMSHA256SUMFAILED >&2; exit 67; }; ' +
  'find . -type f -exec sha256sum {} + || { echo CHECKSUMSCANFAILED >&2; exit 68; }';

/** The same checksums for what is actually on the target, computed there — one command for
 *  the whole tree rather than reading every file back over the transport.
 *
 *  An empty listing needs no command; a failed or malformed checksum result is an error. */
async function targetFileChecksums(ctx: Context, dir: string): Promise<Record<string, string>> {
  const listed = await ctx.transport.listFiles(dir);
  if (listed.length === 0) return {};

  const result = await ctx.transport.exec("sh", ["-c", CHECKSUM_SCRIPT, "sh", dir], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`could not checksum target files (exit ${result.code})${detail === "" ? "" : `: ${detail}`}`);
  }

  return parseChecksumOutput(result.stdout);
}

/** Parses GNU sha256sum's text and Windows binary-mode filename markers. */
export function parseChecksumOutput(stdout: string): Record<string, string> {
  const checksums: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) [ *]\.\/(.+)$/.exec(line);
    if (match === null) throw new Error("target returned malformed checksum output");
    checksums[match[2]] = match[1];
  }
  return checksums;
}

/** Probes the outbound endpoints the live configuration names, from inside the gateway
 *  container. Returns the observations, or undefined when there is nothing to probe or the
 *  probe itself could not run — an absent answer is a gap, never a quiet "all reachable". */
async function observeEgress(
  ctx: Context,
  liveConfig: unknown,
  problems: Problem[],
): Promise<EgressObservation[] | undefined> {
  const endpoints = egressEndpoints(liveConfig);
  // execCommand is optional on the runtime contract, the way runningConnectionFacts is: a
  // runtime that cannot exec into the container cannot be asked from inside, and skipping
  // is its honest answer.
  if (endpoints.length === 0 || ctx.runtime.execCommand === undefined) return undefined;

  let result: ExecResult;
  try {
    result = await ctx.runtime.execCommand(
      GATEWAY_SERVICE,
      "node",
      ["-e", EGRESS_PROBE_SCRIPT],
      {
        input: JSON.stringify(endpoints.map((endpoint) => endpoint.url)),
        allowFailure: true,
        // The script bounds each endpoint, but a deadline the child can ignore — a hung
        // resolver holding a getaddrinfo thread, a wedged docker/WSL client before node
        // even starts — needs a bound of its own: the whole exec, killed by the transport.
        timeoutMs: EGRESS_EXEC_TIMEOUT_MS,
      },
    );
  } catch {
    // HelperNotRunning and every other exec failure included: the container's state is the
    // other findings' business (health, probes), and this one must not take inspect down.
    return undefined;
  }
  if (result.code !== 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  // One answer per asked endpoint, in order, or the probe is broken — and a broken probe
  // must not be read as a verdict about any endpoint.
  if (!Array.isArray(parsed) || parsed.length !== endpoints.length) return undefined;

  const observations: EgressObservation[] = [];
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index];
    const answer = parsed[index] as { url?: unknown; state?: unknown; detail?: unknown };
    const state = answer?.state;
    if (answer?.url !== endpoint.url || (state !== "ok" && state !== "dns" && state !== "unreachable" && state !== "invalid" && state !== "timeout")) {
      return undefined;
    }
    const display = redactEndpoint(endpoint.url);
    const detail = typeof answer.detail === "string" ? answer.detail : undefined;
    const unreachable = state === "dns"
      ? `${display} (${endpoint.path}) does not resolve from inside the "${GATEWAY_SERVICE}" container`
      : state === "invalid"
        ? `${display} (${endpoint.path}) is not a usable URL`
        : state === "timeout"
          ? `${display} (${endpoint.path}) gave no answer within the egress probe's whole deadline`
          : `${display} (${endpoint.path}) resolves from inside the "${GATEWAY_SERVICE}" container but does not answer`;
    if (state !== "ok") {
      problems.push(problem("EGRESS_UNREACHABLE", detail === undefined ? unreachable : `${unreachable} (${detail})`));
    }
    const observation: EgressObservation = { path: endpoint.path, endpoint: display, state, detail };
    observations.push(observation);
  }
  return observations;
}

export async function observeLive(
  ctx: Context,
  declared: DeclaredState,
  problems: Problem[],
  configMtimeMs: number | undefined,
  liveConfig: unknown,
  // watch check's own opt-in (gatherInspection's `channels` option): adds `channels status
  // --json` to the same batch below instead of a second one-off container. inspect/doctor/
  // plan/apply never pass true, so their own batch — and everything derived from it — is
  // unchanged.
  includeChannels = false,
): Promise<Partial<ObservedState> & { plugins: PluginListEntry[]; skills: SkillListEntry[] }> {
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

  // The outbound counterpart of the probes above, from the one vantage they lack.
  const egress = await observeEgress(ctx, liveConfig, problems);

  // --- what OpenClaw itself has registered ----------------------------------------------
  // One container for all six reads (four lists plus --version) instead of one each: every
  // `docker compose run --rm` pays Compose's create/destroy cost again (~5-7s,
  // docker-compose.yml's own note on cli-helper), and paying that four times over for one
  // inspection was the dominant cost doctor/plan measured — trimming wsl.exe spawn counts
  // elsewhere did not move their wall time, this does. Plugins/skills ride along in the same
  // container rather than a second one, for the same reason (commands/management/extensions.ts).
  const batchCommands: string[][] = [
    ["agents", "list", "--json"],
    ["mcp", "list", "--json"],
    ["cron", "list", "--json"],
    ["--version"],
    [...PLUGINS_LIST_ARGS],
    [...SKILLS_LIST_ARGS],
  ];
  // Appended, never inserted: every index above is read positionally just below, and an
  // insertion would shift them all.
  const channelsIndex = includeChannels ? batchCommands.push(["channels", "status", "--json"]) - 1 : undefined;
  const batchResults = await openclawCliBatch(ctx, batchCommands);
  const [agentsResult, mcpResult, cronResult, versionResult, pluginsResult, skillsResult] = batchResults;
  const channels = channelsIndex === undefined ? undefined : parseChannelsStatus(batchResults[channelsIndex]);
  const agents = parseJsonOrEmpty(agentsResult, (parsed) =>
    (parsed as Array<{ id?: string }>).map((entry) => entry.id ?? "").filter((id) => id !== ""));
  // The full entries, not just names: a server present under the wrong command (or
  // disabled) is registered but broken, and the per-recipe check below needs to tell that
  // apart from genuinely missing — mcpServerMatches() is the same comparison
  // provision-agent's own reconciliation already uses.
  const mcpServerEntries = parseJsonOrEmpty(mcpResult, (parsed) =>
    Object.entries(parsed as Record<string, { command?: unknown; args?: unknown; enabled?: unknown }>));
  const mcpServers = mcpServerEntries.map(([name]) => name);
  // Whole jobs, not flattened names: the declared contract is the message, the timeout, the
  // session target and the delivery mode as well as the schedule, and a job compared on two
  // of those can differ in every other one while reporting no drift at all.
  const liveJobs = parseJsonOrEmpty(cronResult, (parsed) =>
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

  const openclawVersionLine = versionResult.code === 0 ? versionResult.stdout.trim().split("\n")[0] : "";
  const openclawVersion = openclawVersionLine === "" ? undefined : openclawVersionLine;

  // Raw (unfiltered, un-normalised) — gather.ts turns these into the same shape the lock
  // records (pluginsForLock/skillsForLock) before comparing, so this function stays a plain
  // read of what OpenClaw itself reports.
  const plugins = parsePluginsList(pluginsResult);
  const skills = parseSkillsList(skillsResult);

  return { probes, health, egress, agents, mcpServers, cronJobs, foreignObjects, openclawVersion, plugins, skills, channels };
}

/** One batched call's `--json` list, or an empty one when that command failed. A failing
 *  list must not take the whole inspection down: the finding a coder needs is usually
 *  elsewhere, and an inspection that refuses to answer is worse than one with a gap in it. */
function parseJsonOrEmpty<T>(result: BatchedCliResult, extract: (parsed: unknown) => T[]): T[] {
  if (result.code !== 0) return [];
  try {
    return extract(JSON.parse(result.stdout));
  } catch {
    return [];
  }
}

/** `channels status --json`'s own batched read, only ever attempted when includeChannels
 *  opted in above. Absent, not an empty shape, on any failure — the same gap-not-verdict
 *  reading watch/health.ts's channelFindings() already relies on for a failed CLI call. */
function parseChannelsStatus(result: BatchedCliResult): ChannelsStatusResponse | undefined {
  if (result.code !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as ChannelsStatusResponse;
  } catch {
    return undefined;
  }
}
