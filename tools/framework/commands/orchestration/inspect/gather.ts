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
//
// Split into three files under this directory, purely organisational: helpers.ts (pure
// pieces), observe.ts (declaredState/observeConfig/observeLive, what actually reads the
// target), and this one, gather.ts (gatherInspection, the CLI surface). Every export here
// keeps its name and signature — apply.ts, plan.ts and the checks all import from
// "./inspect/gather.ts" (or the barrel-free direct path, since there is no index.ts here).

import { log, info, warn, die } from "#src/core/log.ts";
import { emit, isCaptured } from "#src/core/output.ts";
import { desiredStateFile } from "#src/runtime/deployment.ts";
import { requirementsForConfig, statusForRequirements } from "#src/service/secrets.ts";
import { compareLock, readLock, currentComposition } from "#src/commands/management/lock.ts";
import { readInstalledSet, requirementProblems, runningDigests, matchRequiredDigest } from "#src/set/artifacts/install.ts";
import {
  problem,
  blockingProblems,
  isHealthy,
  nextActions,
} from "#src/service/inspection.ts";
import type { Problem, Inspection } from "#src/service/inspection.ts";
import type { Context } from "#src/core/context.ts";
import { prospectiveConfig, readLiveConfigForProspective, frameworkVersion } from "./helpers.ts";
import { declaredState, observeConfig, observeLive, observeConnectionFacts, observeSecretStore, observeDeclarationFile } from "./observe.ts";

/** The whole picture. Exported because doctor, plan and apply all read it rather than
 *  gathering their own — three gatherers would be three answers to one question. */
export async function gatherInspection(ctx: Context): Promise<Inspection> {
  const problems: Problem[] = [];
  const declared = await declaredState(ctx, problems);

  const running = await ctx.runtime.isRunning();
  // Asked of the PROSPECTIVE configuration (live + declared overlay), not the live one
  // alone: a SecretRef the declaration is about to add is a real requirement before
  // CONFIG_DRIFT ever gets applied, and plan.ts's "secrets" step is gated on exactly the
  // SECRET_MISSING findings this loop produces.
  //
  // prospectiveConfig() throws on a declared path through "__proto__"/"constructor"/
  // "prototype" (setAt's own guard against polluting the shared Object.prototype) — caught
  // here, not left to crash inspect entirely: a malicious or corrupted desired-state.json is
  // exactly the kind of thing this read-only command exists to report, not to be brought
  // down by, and the live config alone is still a safe answer to fall back to.
  let prospective: unknown;
  let liveConfig: unknown;
  try {
    // One read serves both the prospective merge and the egress endpoints observeLive probes:
    // two reads of the same file per inspection asked the target twice for one answer, and
    // two separate reads could disagree about what is configured.
    liveConfig = await readLiveConfigForProspective(ctx);
    prospective = prospectiveConfig(liveConfig, declared.config);
  } catch (error) {
    problems.push(problem("CONFIG_DRIFT", `${desiredStateFile()} declares an unsafe configuration path: ${(error as Error).message}`));
    prospective = liveConfig;
  }
  const secrets = await statusForRequirements(ctx, await requirementsForConfig(ctx, prospective));
  for (const secret of secrets) {
    if (secret.required && !secret.present) {
      problems.push(problem("SECRET_MISSING", `${secret.name} (${secret.usedBy}) is not set in ${secret.location === "repo-env" ? ".env" : "<data>/config/.env"}`));
    }
  }

  // The operator side reads while the instance is down, and matters most then: the store
  // is the only place a stopped instance's values can still be re-read from, since the
  // container that carries repo-env values is gone.
  const secretStore = await observeSecretStore(ctx, secrets, problems);

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
        secretStore: secretStore,
        agents: [],
        mcpServers: [],
        cronJobs: [],
        foreignObjects: [],
        frameworkVersion: await frameworkVersion(),
      },
      problems,
    };
  }

  // These two need an instance. DECLARATION_MISSING is a fact about the folder, but it is
  // only a finding while something is running to be re-declared — the whole point of its
  // name — and the facts ENV_STALE compares against exist only in a running container.
  await observeDeclarationFile(problems);
  const connectionFacts = await observeConnectionFacts(ctx, problems);

  const live = await observeLive(ctx, declared, problems, configState.mtimeMs, liveConfig);

  // One read of the runtime's own identity, shared below by the set-requirement match and
  // the displayed digest: two separate live queries for one inspection asked the runtime
  // (a container inspect, not a free read) about the same fact twice.
  const runningDigestList = await runningDigests(ctx);

  // Which set is installed here, and whether this machine matches what it required. Read
  // before the lock comparison because it is the more specific answer: a lock says what the
  // composition was pinned to, a set id says what was actually installed.
  const installed = await readInstalledSet(ctx);
  if (installed !== undefined) {
    const installedManifest = { requires: installed.requires } as never;
    problems.push(
      ...requirementProblems(
        installedManifest,
        // matchRequiredDigest() against the already-fetched running digests, not
        // ctx.runtime.imageReference(): the latter resolves whatever the configured image
        // REFERENCE (typically a tag) currently points to locally, which a later `docker
        // pull` moves even when the running container was never recreated and is still on
        // the old digest — apply --set's own pre/post-checks (apply.ts) already learned this
        // the hard way (task #172); this check never did.
        { framework: await frameworkVersion(), imageDigest: matchRequiredDigest(runningDigestList, installedManifest) },
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
      secretStore: secretStore,
      image: ctx.settings.image,
      // The actually-running container's own digest (the same fetch as above, no manifest
      // to prefer against here), not ctx.runtime.imageReference() (whatever the configured
      // image REFERENCE currently resolves to locally) — the SET_REQUIREMENT_UNMET check
      // above learned this the hard way (task #195): a `docker pull` moves the local tag's
      // digest even when the running container was never recreated, and reporting THAT here
      // contradicted the very warning this same inspection had just produced a few lines
      // above it. Deliberately no fallback to imageReference() when nothing was found: an
      // absent answer is more honest than one already known to sometimes be wrong.
      imageDigest: runningDigestList[0],
      frameworkVersion: await frameworkVersion(),
      probes: live.probes ?? {},
      health: live.health,
      egress: live.egress,
      connectionFacts: connectionFacts,
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
  if (observed.egress !== undefined && observed.egress.length > 0) {
    info(`egress     ${observed.egress.map((entry) => `${entry.endpoint} ${entry.state}`).join("  ")}`);
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
