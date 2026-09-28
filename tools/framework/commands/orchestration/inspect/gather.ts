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
// Split into several files under this directory, purely organisational: helpers.ts (pure
// pieces), declared.ts (declaredState/recipeExpectations, what this repository declares),
// drift.ts (observeConfig/observeConnectionFacts/observeSecretStore, the declared-vs-target
// comparisons), live.ts (observeLive, what the target reports with no declared counterpart),
// and this one, gather.ts (gatherInspection, the CLI surface). Every export here keeps its
// name and signature — apply.ts, plan.ts and the checks all import from "./inspect/gather.ts"
// (or the barrel-free direct path, since there is no index.ts here).

import { log, info, warn, reportBlocking } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { desiredStateFile } from "#src/runtime/deployment.ts";
import { NotBootstrapped } from "#src/runtime/runtime.ts";
import { requirementsForConfig, statusForRequirements, collectConfiguredProviders } from "#src/service/secrets.ts";
import { compareLock, readLock, currentComposition } from "#src/commands/management/lock.ts";
import { pluginsForLock, skillsForLock } from "#src/commands/management/extensions.ts";
import { readInstalledSet, requirementProblems, runningDigests, matchRequiredDigest } from "#src/set/artifacts/install.ts";
import {
  problem,
  unreachableProblem,
  blockingProblems,
  isHealthy,
  nextActions,
} from "#src/service/inspection.ts";
import type { Problem, Inspection, SecretStoreObservation } from "#src/service/inspection.ts";
import type { SecretStatus } from "#src/service/secrets.ts";
import { TransportUnreachableError } from "#src/runtime/transport/transport.ts";
import type { Context } from "#src/core/context.ts";
import { prospectiveConfig, readLiveConfigForProspective, frameworkVersion } from "./helpers.ts";
import { declaredState, observeDeclarationFile } from "./declared.ts";
import { observeConfig, observeConnectionFacts, observeSecretStore } from "./drift.ts";
import { observeLive } from "./live.ts";
import { runSecurityAudit } from "#src/security/audit.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";

/** Shared by inspect and doctor: both take only --json. */
export const JSON_ONLY_ARGUMENTS: CommandArgument[] = [
  { name: "json", description: "Emit the whole inspection as JSON", kind: "flag" },
];

/** gatherInspection's own opt-in extras — additions no default caller needs, so a caller
 *  that never passes this second argument gets exactly the inspection it always did. */
export interface GatherInspectionOptions {
  /** Also gather `channels status --json`, in the same batched CLI call observeLive already
   *  makes for agents/mcp/cron/plugins/skills, and expose the parsed answer as
   *  observed.channels. `./clawforge watch check` is the only caller that sets this — its own
   *  channel findings used to cost a one-off CLI container every cron cycle; inspect, doctor,
   *  plan and apply never set it, so their own output is unchanged. */
  readonly channels?: boolean;
}

/** The whole picture. Exported because doctor, plan and apply all read it rather than
 *  gathering their own — three gatherers would be three answers to one question.
 *
 *  declaredState() runs outside the try below on purpose: it never touches the target
 *  (declared.ts's own header), so it is available even when the target is not — the
 *  TARGET_UNREACHABLE inspection still names what this repository declares, the same as
 *  the NOT_BOOTSTRAPPED one a few lines down does. */
export async function gatherInspection(ctx: Context, options?: GatherInspectionOptions): Promise<Inspection> {
  const problems: Problem[] = [];
  const declared = await declaredState(ctx, problems);
  try {
    return await gatherReachedInspection(ctx, declared, problems, options);
  } catch (error) {
    if (!(error instanceof TransportUnreachableError)) throw error;
    return {
      declared,
      observed: { running: false, probes: {}, config: {}, secrets: [], agents: [], mcpServers: [], cronJobs: [], foreignObjects: [] },
      problems: [...problems, unreachableProblem(error)],
    };
  }
}

/** observeConfig()'s own return shape, named here so the preflight/running split below can
 *  pass it along without re-stating the inline object type at every boundary. */
interface ConfigState {
  readonly config: Record<string, unknown>;
  readonly mtimeMs?: number;
}

/** Everything gatherReachedInspection needs before it can even tell whether the instance is
 *  running: isRunning() itself, the image-pin check, secrets against the prospective config,
 *  the provider check, and the two target reads (secret store, live config on disk) that are
 *  no more expensive to take on a stopped instance than a running one. */
async function gatherPreflight(
  ctx: Context,
  declared: Inspection["declared"],
  problems: Problem[],
): Promise<{
  running: boolean;
  notBootstrapped: NotBootstrapped | undefined;
  liveConfig: unknown;
  secrets: SecretStatus[];
  secretStore: SecretStoreObservation | undefined;
  configState: ConfigState;
}> {
  // isRunning() shells out to compose, which needs somewhere to write its own private env
  // file beside the data directory — and on a deployment nobody has bootstrapped yet, that
  // data directory does not exist, so creating a place beside it is exactly the mkdir a
  // still-root-owned parent refuses. NotBootstrapped is DockerRuntime's own way of saying so
  // (runtime-docker.ts's #withEnvFile) instead of a raw transport error; caught here
  // rather than left to crash a read-only command, and reported as its own finding rather
  // than folded into GATEWAY_DOWN — "./clawforge up" is not a working remedy pre-bootstrap.
  let running: boolean;
  let notBootstrapped: NotBootstrapped | undefined;
  try {
    running = await ctx.runtime.isRunning();
  } catch (error) {
    if (!(error instanceof NotBootstrapped)) throw error;
    running = false;
    notBootstrapped = error;
  }

  // A pure fact about this deployment's OWN .env — no runtime call needed, so it costs
  // nothing to check even here. Skipped pre-bootstrap the same way PROVIDER_MISSING is below:
  // a deployment with nothing on the target yet has NOT_BOOTSTRAPPED naming the one remedy
  // that applies, and ./clawforge upgrade (this finding's own remedy) needs a running instance
  // to roll back to. A digest never moves; a tag can, and is shared with every other
  // deployment on this Docker daemon that names it.
  if (notBootstrapped === undefined && !declared.image.includes("@sha256:")) {
    problems.push(problem("IMAGE_UNPINNED", `OPENCLAW_IMAGE is "${declared.image}", a tag rather than a digest`));
  }

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
    // A transport failure here is TARGET_UNREACHABLE, not a bad declared path — rethrown so
    // the outer catch in gatherInspection() reports it as what it actually is.
    if (error instanceof TransportUnreachableError) throw error;
    problems.push(problem("CONFIG_DRIFT", `${desiredStateFile()} declares an unsafe configuration path: ${(error as Error).message}`));
    prospective = liveConfig;
  }
  const secrets = await statusForRequirements(ctx, await requirementsForConfig(ctx, prospective));
  for (const secret of secrets) {
    if (secret.required && !secret.present) {
      problems.push(problem("SECRET_MISSING", `${secret.name} (${secret.usedBy}) is not set in ${secret.location === "repo-env" ? ".env" : "<data>/config/.env"}`));
    }
  }

  // The same config secrets --apply and provision-agent already read providers from
  // (collectConfiguredProviders), not a guess from environment variable names: a bootstrap
  // with no provider key ends "OpenClaw is up" and doctor "nothing blocking" while every
  // agent turn fails at the first model call — a gap this loop's own SECRET_MISSING
  // above never reports, because a provider's apiKey is inferred from the configured id, and
  // with no id configured at all there is no requirement yet to be missing. Skipped pre-
  // bootstrap (notBootstrapped): configure-provider needs config/.env on the target, which
  // does not exist yet, and NOT_BOOTSTRAPPED above already names the one remedy that applies.
  if (notBootstrapped === undefined && collectConfiguredProviders(prospective).length === 0) {
    problems.push(problem("PROVIDER_MISSING", "models.providers declares no provider, and no auth.profiles entry names one either"));
  }

  // The operator side reads while the instance is down, and matters most then: the store
  // is the only place a stopped instance's values can still be re-read from, since the
  // container that carries repo-env values is gone.
  const secretStore = await observeSecretStore(ctx, secrets, problems);

  // Read whether or not anything is serving: the declaration is compared against a file on
  // the target, and a stopped instance is exactly when someone is about to start one.
  const configState = await observeConfig(ctx, declared, problems);

  return { running, notBootstrapped, liveConfig, secrets, secretStore, configState };
}

/** Everything that needs an actually-running instance to answer: declaration/connection
 *  facts, the live observation (agents/mcp/cron/plugins/skills/health), the image-digest
 *  comparison, the installed-set requirement check and the lock comparison — assembled into
 *  the final Inspection. Split out of gatherReachedInspection so that function stays a short
 *  dispatch between "not running" and this. */
async function gatherRunningInspection(
  ctx: Context,
  declared: Inspection["declared"],
  problems: Problem[],
  configState: ConfigState,
  liveConfig: unknown,
  secrets: SecretStatus[],
  secretStore: SecretStoreObservation | undefined,
  options: GatherInspectionOptions | undefined,
): Promise<Inspection> {
  // These two need an instance. DECLARATION_MISSING is a fact about the folder, but it is
  // only a finding while something is running to be re-declared — the whole point of its
  // name — and the facts ENV_STALE compares against exist only in a running container.
  await observeDeclarationFile(problems);
  const connectionFacts = await observeConnectionFacts(ctx, problems);

  const live = await observeLive(ctx, declared, problems, configState.mtimeMs, liveConfig, options?.channels === true);

  // One read of the runtime's own identity, shared below by the set-requirement match and
  // the displayed digest: two separate live queries for one inspection asked the runtime
  // (a container inspect, not a free read) about the same fact twice.
  const runningDigestList = await runningDigests(ctx);

  // The mirror image of the requirement match's own caution just above: THERE, resolving the
  // tag locally would wrongly answer for a container never recreated onto what it now points
  // to. HERE, that is exactly the fact worth surfacing — asked only for a tag
  // still in force (a digest is content-addressed and cannot move) and only while running
  // (nothing to compare a stopped container's digest against), so a pinned deployment pays for
  // this extra `docker image inspect` never at all.
  if (!declared.image.includes("@sha256:") && runningDigestList.length > 0) {
    const localTagDigest = await ctx.runtime.imageReference();
    if (
      localTagDigest !== undefined &&
      !runningDigestList.some((digest) => digest.split("@").at(-1) === localTagDigest.split("@").at(-1))
    ) {
      problems.push(
        problem(
          "IMAGE_TAG_MOVED",
          `the local tag "${declared.image}" now resolves to ${localTagDigest}, but the running container is ${runningDigestList[0]} — ` +
            "the next recreate (up, restart after compose changes, apply) would switch images",
        ),
      );
    }
  }

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
        // the hard way; this check never did.
        { framework: await frameworkVersion(), imageDigest: matchRequiredDigest(runningDigestList, installedManifest) },
      ),
    );
  }

  // Last, and only when the instance is up: the lock pins the image digest, which cannot be
  // read from a stopped instance, and a lock comparison against half an observation would
  // report differences that are only missing information.
  //
  // Plugins/skills are folded in here rather than fetched by currentComposition() itself:
  // `live` already carries them from observeLive's own batched read (openclawCliBatch, above)
  // and a second fetch would spend a second container on the same question — exactly what
  // that batching exists to avoid (openclaw-cli.ts, commands/management/extensions.ts).
  const composition = await currentComposition(ctx);
  problems.push(
    ...compareLock(await readLock(), {
      ...composition,
      plugins: pluginsForLock(live.plugins),
      skills: skillsForLock(live.skills),
    }),
  );

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
      // above learned this the hard way: a `docker pull` moves the local tag's
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
      channels: live.channels,
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

async function gatherReachedInspection(
  ctx: Context,
  declared: Inspection["declared"],
  problems: Problem[],
  options: GatherInspectionOptions | undefined,
): Promise<Inspection> {
  const { running, notBootstrapped, liveConfig, secrets, secretStore, configState } = await gatherPreflight(ctx, declared, problems);

  if (!running) {
    problems.push(
      notBootstrapped !== undefined
        ? problem("NOT_BOOTSTRAPPED", notBootstrapped.message)
        : problem("GATEWAY_DOWN", `no running container for deployment "${declared.deployment}"`),
    );
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

  return gatherRunningInspection(ctx, declared, problems, configState, liveConfig, secrets, secretStore, options);
}

export async function inspect(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = parseDeclaredArgs(JSON_ONLY_ARGUMENTS, args).json === true;

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

/** One problem line, prefixed by what its severity actually earns — `blocking:` rather than
 *  `warning:` for one that fails the run — so a blocking finding never reads as merely worth
 *  noting. Shared by doctor() and renderText() so the two never drift apart on it. */
export function printProblem(entry: Problem): void {
  (entry.severity === "blocking" ? reportBlocking : warn)(`${entry.code}  ${entry.detail}`);
  info(`  → ${entry.nextAction}`);
}

/** `./clawforge doctor` — the same inspection, answered as "is anything wrong, and what do I run".
 *
 *  Exits non-zero when something blocking was found, because that is the only part of the
 *  answer a script or a CI step can act on without reading the text. Warnings do not fail
 *  it: an instance with no lock file works, and a command that fails on everything it has
 *  an opinion about stops being consulted. */
export async function doctor(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = parseDeclaredArgs(JSON_ONLY_ARGUMENTS, args).json === true;

  const inspection = await gatherInspection(ctx);
  // The security gate: only doctor and accept run it — a container exec per audit, twice —
  // so its findings are merged in here rather than gathered inside gatherInspection() itself.
  const security = await runSecurityAudit(ctx);
  const problems = [...inspection.problems, ...security.problems];
  const blocking = blockingProblems(problems);
  const warnings = problems.filter((entry) => entry.severity === "warning");

  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          deployment: inspection.declared.deployment,
          healthy: isHealthy(inspection) && blockingProblems(security.problems).length === 0,
          problems,
          security: security.findings,
          nextActions: nextActions(problems),
        },
        null,
        2,
      )}\n`,
    );
  } else if (problems.length === 0) {
    log(`${inspection.declared.deployment} is what this repository declares`);
    info(`state  running (${inspection.observed.health ?? "unknown"})`);
  } else {
    // Reported before the failure below, not instead of it: a reader who only sees "3
    // problems" learns nothing, and the whole point of the codes is that they travel.
    log(`${inspection.declared.deployment}: ${blocking.length} blocking, ${warnings.length} warning(s)`);
    for (const entry of problems) printProblem(entry);
    const suppressed = security.findings.filter((finding) => finding.suppressed);
    for (const finding of suppressed) {
      info(`SUPPRESSED  ${finding.source} ${finding.checkId}: ${finding.message} (${finding.suppressedReason})`);
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
  for (const entry of problems) printProblem(entry);
}
