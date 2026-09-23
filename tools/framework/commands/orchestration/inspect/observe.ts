// What `./clawforge inspect` reads: the declared state (from disk) and the observed state
// (from the target). Split out of inspect.ts; see helpers.ts (this same directory) for
// the pure pieces these use, and gather.ts for gatherInspection/inspect/doctor/renderJson/
// renderText.

import { access, lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import JSON5 from "json5";
import { deploymentName, desiredStateFile, envFile, recipesDir, secretStoreFile } from "#src/runtime/deployment.ts";
import { parseEnv } from "#src/core/env.ts";
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
import type { Problem, DeclaredState, ObservedState, EgressObservation, ConnectionFactObservation, SecretStoreObservation } from "#src/service/inspection.ts";
import type { SecretStatus } from "#src/service/secrets.ts";
import {
  CONNECTION_FACTS,
  staleConnectionFacts,
  unrecoverableConnectionFacts,
} from "#src/commands/recover-env/facts.ts";
import type { ConnectionFacts } from "#src/commands/recover-env/facts.ts";
import { DEFAULT_SECRET_STORE } from "#src/commands/management/secrets.ts";
import type { ExecResult } from "#src/runtime/transport.ts";
import { EGRESS_EXEC_TIMEOUT_MS, EGRESS_PROBE_SCRIPT } from "./egress-probe.ts";
import { configValuesEqual, effectiveDeclarationPaths, prospectiveConfig, valueAt, cronDifferences, egressEndpoints, redactEndpoint } from "./helpers.ts";
import type { Context } from "#src/core/context.ts";

const PROBE_ENDPOINTS = ["healthz", "startupz", "readyz"];

// The compose service inspect observes, named literally the way config.ts, provider.ts,
// accept.ts and smoke.ts already name it for their own execs into the same container.
const GATEWAY_SERVICE = "gateway";

/** Parses GNU stat's fractional, timezone-qualified `%y` timestamp. */
function parseStatTimestamp(raw: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))? ([+-]\d{2}:?\d{2})$/.exec(raw.trim());
  if (match === null) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const zoneDigits = zone.replace(":", "");
  const zoneHour = Number(zoneDigits.slice(1, 3));
  const zoneMinute = Number(zoneDigits.slice(3, 5));
  if (
    month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59
  ) return undefined;

  const milliseconds = fraction.slice(0, 3).padEnd(3, "0");
  const parsed = Date.parse(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${milliseconds}${zone}`);
  if (Number.isNaN(parsed)) return undefined;
  // Runtime.startedAt() is exposed in milliseconds and Date.parse truncates finer Docker
  // precision too. Keep both sides at that same resolution to avoid false restarts.
  return parsed;
}

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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return found;
    throw new Error(`${recipesDir()} could not be read: ${(error as Error).message}`);
  }

  for (const recipe of entries.sort()) {
    const agentDir = resolve(recipesDir(), recipe, "agent");
    let stat;
    try {
      stat = await lstat(agentDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // No agent directory: a recipe can be a plain service. Not a finding.
        continue;
      }
      throw error;
    }
    if (!stat.isDirectory()) throw new Error(`${agentDir} is not a directory`);
    // Once the bundle exists, every loader failure must block reconciliation.
    found.push({ recipe, bundle: await loadRecipeAgentBundle(recipe) });
  }
  return found;
}

// The target directory travels as a positional parameter and is never pasted into this
// text: JSON.stringify's double quotes do not make a path safe — inside them a POSIX shell
// still runs $(…), backticks and $VAR, which let a hostile directory name execute as the
// transport user during this read-only call, and the failed cd then checksummed whatever
// tree the shell landed in. The path is data at every shell — same shape as PROBE_SCRIPT in
// security/private-file.ts. Without its argument the script fails instead of checksumming a
// guessed directory.
const CHECKSUM_SCRIPT =
  'if [ "${1+set}" = set ] && [ -n "$1" ]; then ' +
  'cd -- "$1" && find . -type f -exec sha256sum {} +; ' +
  "else echo NOCHECKSUMDIR >&2; exit 64; fi";

/** The same checksums for what is actually on the target, computed there — one command for
 *  the whole tree rather than reading every file back over the transport.
 *
 *  A tree that lists as empty is answered before any command runs, so a nonzero exit here
 *  can only mean a tree that listed as non-empty whose checksums could not be computed. {}
 *  then reads as drift in both callers — every declared file differs or is missing — which
 *  is loud, where an agreement would have been silent. */
async function targetFileChecksums(ctx: Context, dir: string): Promise<Record<string, string>> {
  const listed = await ctx.transport.listFiles(dir);
  if (listed.length === 0) return {};

  const result = await ctx.transport.exec("sh", ["-c", CHECKSUM_SCRIPT, "sh", dir], {
    allowFailure: true,
  });
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
    for (const entry of declared.config) config[entry.path] = valueAt(parsed, entry.path);
    const target = prospectiveConfig(parsed, declared.config);
    for (const entry of effectiveDeclarationPaths(declared.config)) {
      const actual = valueAt(parsed, entry.path);
      const desired = valueAt(target, entry.path);
      if (!configValuesEqual(actual, desired)) {
        problems.push(
          problem("CONFIG_DRIFT", `${entry.path} is ${JSON.stringify(actual)}, declared ${JSON.stringify(desired)}`),
        );
      }
    }
    const stamp = await ctx.transport.exec("stat", ["-c", "%y", configFile], { allowFailure: true });
    if (stamp.code === 0) {
      mtimeMs = parseStatTimestamp(stamp.stdout);
    }
  } catch {
    // A deployment that has never been bootstrapped has no configuration at all, which is
    // not drift — there is nothing to have drifted from. Only a file that exists and cannot
    // be understood is a finding.
    //
    // exists() itself now throws when the CHECK could not run (an unreachable target, rather
    // than an answer) — caught here rather than allowed to escape: inspect answers whatever
    // it can see, and a target it cannot reach at all is a finding of its own, not a reason
    // to abandon every other observation already gathered.
    let present: boolean;
    try {
      present = await ctx.transport.exists(configFile);
    } catch (error) {
      problems.push(problem("CONFIG_DRIFT", `${configFile} could not be reached: ${(error as Error).message}`));
      present = false;
    }
    if (present) {
      problems.push(problem("CONFIG_DRIFT", `${configFile} could not be read or parsed`));
    }
  }

  return { config, mtimeMs };
}

/** The deployment .env's connection facts against the running container — the same
 *  comparison recover-env reports on and --adopt-runtime resolves (staleConnectionFacts), surfaced instead of waiting
 *  to be asked. Below the not-running early return in gatherInspection: the facts come
 *  from a running container, and without one there is nothing to compare against.
 *
 *  The finding names WHICH variable drifted and never a value, not even a non-secret one:
 *  .env mixes a real secret (OPENCLAW_GATEWAY_TOKEN) with these plumbing facts, so nothing
 *  parsed from that file is printable beyond the four names. */
export async function observeConnectionFacts(
  ctx: Context,
  problems: Problem[],
): Promise<ConnectionFactObservation[] | undefined> {
  // Optional on the runtime contract, the way execCommand is: a runtime that cannot
  // introspect its container is not asked, and skipping is its honest answer.
  if (typeof ctx.runtime.runningConnectionFacts !== "function") return undefined;
  const facts: ConnectionFacts | undefined = await ctx.runtime.runningConnectionFacts();
  // Not running, or the container could not be inspected: a gap, not a verdict.
  if (facts === undefined) return undefined;
  let raw: string;
  try {
    raw = await readFile(envFile(), "utf8");
  } catch {
    // No .env — nothing to compare against; the fresh-clone shape, not a finding.
    return undefined;
  }
  const current = parseEnv(raw);
  // The comparison itself comes from facts.ts — recover-env acts on exactly it, so
  // inspect and recover-env cannot disagree about what counts as stale.
  const stale = new Set(staleConnectionFacts(facts, current).map((entry) => entry.name));
  const unrecovered = new Set(unrecoverableConnectionFacts(facts).map((entry) => entry.name));
  const observations: ConnectionFactObservation[] = CONNECTION_FACTS.map((fact) => ({
    name: fact.name,
    state: unrecovered.has(fact.name) ? "unrecovered" : stale.has(fact.name) ? "stale" : "match",
  }));
  for (const name of stale) {
    problems.push(problem("ENV_STALE", `${name} in ${envFile()} differs from the running container`));
  }
  return observations;
}

/** The deployment's default local store against the values the target holds. Watched only
 *  when a store file exists, and only the default one (inspect takes no store name):
 *  bootstrap puts values on the target without ever creating a store, so an absent store
 *  is how every healthy deployment starts out, not evidence of loss — and there is no way
 *  to tell it from a lost one. A store that EXISTS missing a required name is unambiguous:
 *  the workflow is in use, and that value has no local copy. Names checked are the same
 *  required set SECRET_MISSING reports, and only names the target still holds — the
 *  target-absent ones are SECRET_MISSING's business, and `secrets --dump` recovers from
 *  the target, not from nowhere. */
export async function observeSecretStore(
  ctx: Context,
  secrets: readonly SecretStatus[],
  problems: Problem[],
): Promise<SecretStoreObservation | undefined> {
  const store = secretStoreFile(DEFAULT_SECRET_STORE);
  let raw: string;
  try {
    raw = await readFile(store, "utf8");
  } catch {
    return undefined;
  }
  const values = parseEnv(raw);
  const missing = secrets.filter(
    (entry) => entry.required && entry.present && (values[entry.name] ?? "").trim() === "",
  );
  for (const entry of missing) {
    problems.push(problem("STORE_INCOMPLETE", `${entry.name} (${entry.usedBy}) is present on the target but has no value in ${store}`));
  }
  return { file: store, missing: missing.map((entry) => entry.name) };
}

/** The declaration's own existence. A fact about the folder, and only a finding while an
 *  instance is running to be re-declared — the caller gates it below the not-running
 *  early return, which is what the code's name claims ("missing" for WHOM). */
export async function observeDeclarationFile(problems: Problem[]): Promise<void> {
  const absent = await access(desiredStateFile()).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      // Unreadable for any other reason: declaredState()'s own read already reports it,
      // and a second finding for the same file would read as two problems.
      if (error.code === "ENOENT") return true;
      return false;
    },
  );
  if (absent) {
    problems.push(
      problem("DECLARATION_MISSING", `${desiredStateFile()} does not exist — a running instance nobody can re-declare from this repository`),
    );
  }
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

  // The outbound counterpart of the probes above, from the one vantage they lack.
  const egress = await observeEgress(ctx, liveConfig, problems);

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

  return { probes, health, egress, agents, mcpServers, cronJobs, foreignObjects, openclawVersion };
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
