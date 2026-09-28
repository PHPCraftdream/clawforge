// Implementations of the individual `./clawforge recipe <action>` actions. index.ts's
// recipe() picks the action, gates it through the instance lock, then calls runRecipeAction
// here to dispatch to one of these.

import { cp, access } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { dieUnknownAction } from "#src/core/arguments.ts";
import type { Context } from "#src/core/context.ts";
import {
  loadRecipe,
  projectName,
  recipesDirectory,
  type Recipe,
  type RecipeReadiness,
} from "#src/service/recipe.ts";
import { SENSITIVE_RECIPE_NAME, declaredPortablePrivateFiles, excludesPortablePath } from "#src/security/privacy/recipe-portable-content.ts";
import { safeName } from "#src/core/names.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { sleep, type Stack, type StackServiceState } from "#src/runtime/runtime.ts";
import { isCaptured, shouldFollow, emit } from "#src/core/io/output.ts";
import { takeTail } from "../../lifecycle/lifecycle.ts";
import { importHookModule } from "./hook-runtime.ts";

/** Every action the dispatcher knows, in the order the usage message names them. Checked
 *  by index.ts's recipe() before the lock gate so an unknown action dies as a typo, not as
 *  a lock failure. */
export const RECIPE_ACTIONS: readonly string[] = ["list", "import", "verify", "onboard", "diagnose", "install", "remove", "status", "logs"];

async function stackFor(ctx: Context, name: string) {
  const recipe = await loadRecipe(name);
  return { recipe, stack: ctx.runtime.stack(projectName(deploymentName(), name), recipe.definitionPath) };
}

/** Loads app-owned hooks without teaching the framework what the recipe means. */
async function loadRecipeHooks(spec: Recipe): Promise<Record<string, unknown>> {
  if (spec.preparePath === undefined) return {};
  return importHookModule(spec.preparePath);
}

async function prepareRecipe(ctx: Context, spec: Recipe): Promise<Record<string, unknown>> {
  const loaded = await loadRecipeHooks(spec);
  const prepare = loaded.prepare ?? loaded.default;
  if (spec.preparePath !== undefined && typeof prepare !== "function") {
    die(`recipe "${spec.name}" prepare.ts must export prepare(ctx, recipe)`);
  }
  if (typeof prepare === "function") await prepare(ctx, spec);
  return loaded;
}

/** Loads and runs one of the recipe's own hooks, returning its JSON payload rather than
 *  printing it — the part runRecipeHook and diagnose's verify probe both need, without
 *  diagnose inheriting runRecipeHook's die()-on-failure (a broken verify.ts is itself
 *  diagnostic information, not a reason to refuse the rest of the report). */
async function loadHookResult(ctx: Context, spec: Recipe, kind: "verify" | "onboard"): Promise<unknown> {
  const path = kind === "verify" ? spec.verifyPath : spec.onboardPath;
  if (path === undefined) throw new Error(`recipe "${spec.name}" has no ${kind}.ts hook`);
  const loaded = await importHookModule(path);
  const hook = loaded[kind] ?? loaded.default;
  if (typeof hook !== "function") throw new Error(`recipe "${spec.name}" ${kind}.ts must export ${kind}(ctx, recipe)`);
  const result = await hook(ctx, spec);
  return result === undefined ? { ok: true } : result;
}

async function runRecipeHook(ctx: Context, spec: Recipe, kind: "verify" | "onboard"): Promise<void> {
  let payload: unknown;
  try {
    payload = await loadHookResult(ctx, spec, kind);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  if (isCaptured()) emit(`${JSON.stringify(payload)}\n`);
  else log(`${spec.name} ${kind}: ${JSON.stringify(payload)}`);
}

/** Grace period for the implicit readiness check on a recipe with no `readiness` declared —
 *  long enough to catch a container that starts and exits moments later (the gap the old
 *  immediate-after-`up` check missed entirely), short enough that a plain recipe's install
 *  never waits on a service it never described. The same window is also the minimum a stack
 *  must HOLD a ready verdict before install believes it, declared readiness or not: the
 *  first ready answer says nothing about the next moment, and a container that reports
 *  running for one poll and crashes before the next must fail. */
const DEFAULT_READINESS_GRACE_MS = 5000;

/** Default timeout for a recipe that declares readiness but not its own timeoutMs — long
 *  enough for a real healthcheck (a database's first boot, say) to turn healthy. */
const DEFAULT_DECLARED_READINESS_TIMEOUT_MS = 120_000;

const READINESS_POLL_INTERVAL_MS = 500;

interface RecipeReadinessResult {
  readonly status: "ready" | "degraded" | "unknown";
  readonly detail: string;
  readonly services: Record<string, StackServiceState>;
}

/** Which of `required` are missing from `services` entirely, present but not running, or
 *  running with a healthcheck that has not turned healthy. */
function readinessProblems(
  services: Record<string, StackServiceState>,
  required: string[],
): { missing: string[]; notRunning: string[]; unhealthy: string[] } {
  const missing = required.filter((name) => services[name] === undefined);
  const notRunning = required.filter((name) => services[name] !== undefined && !services[name].running);
  const unhealthy = required.filter((name) => {
    const health = services[name]?.health;
    return health !== undefined && health !== "healthy";
  });
  return { missing, notRunning, unhealthy };
}

/** Joins the three problem lists into one readable detail line. */
function readinessProblemDetail(problems: { missing: string[]; notRunning: string[]; unhealthy: string[] }): string {
  return [
    problems.missing.length > 0 ? `missing: ${problems.missing.join(", ")}` : undefined,
    problems.notRunning.length > 0 ? `not running: ${problems.notRunning.join(", ")}` : undefined,
    problems.unhealthy.length > 0 ? `not healthy: ${problems.unhealthy.join(", ")}` : undefined,
  ].filter((entry): entry is string => entry !== undefined).join("; ");
}

/** Bounds one awaited operation to `budgetMs`: a hung service-state probe must not outwait
 *  the readiness deadline that is supposed to bound the whole loop. The underlying
 *  operation keeps running past the timeout — there is no way to
 *  cancel it — but this caller stops waiting on it. */
function bounded<T>(operation: Promise<T>, budgetMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const wait = Math.max(1, budgetMs);
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${wait}ms`)), wait);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Polls the stack's own per-service state until every service that must be up — the
 *  recipe's declared `readiness.services`, or every service compose currently reports for
 *  the project when nothing is declared — is running and (where it declares a healthcheck)
 *  healthy, KEEPS that verdict for the full grace period, or `timeoutMs` runs out. The
 *  first ready answer only starts the observation window: during it the required set stays
 *  frozen at the one that first answered ready, so a default-derived set cannot quietly
 *  lose a member whose container disappears, and any service that leaves the ready state
 *  inside the window fails readiness by name. Each state probe is bounded by its phase's
 *  remaining budget, so a hung probe cannot defeat the deadline. Replaces the old
 *  immediate `isRunning()` probe, which read as ready the instant `up --detach` returned,
 *  before a container had any chance to crash, and which one live sidecar satisfied even
 *  with the recipe's main service down. */
async function waitForRecipeReadiness(stack: Stack, readiness: RecipeReadiness | undefined, timeoutMs: number): Promise<RecipeReadinessResult> {
  const deadline = Date.now() + timeoutMs;
  // Set when the first fully-ready answer lands; the grace floor keeps the window wide
  // enough for at least two confirming polls even if the constants are tuned closer
  // together than they are today.
  const graceMs = Math.max(DEFAULT_READINESS_GRACE_MS, READINESS_POLL_INTERVAL_MS * 2);
  let graceEndsAt: number | undefined;
  let required: string[] | undefined;
  let readyDetail = "";
  let lastServices: Record<string, StackServiceState> = {};

  for (;;) {
    if (graceEndsAt !== undefined && Date.now() >= graceEndsAt) {
      return { status: "ready", detail: readyDetail, services: lastServices };
    }
    const phaseEnd = graceEndsAt ?? deadline;
    let services: Record<string, StackServiceState>;
    try {
      services = await bounded(stack.serviceStates(), phaseEnd - Date.now(), "the service state probe");
    } catch (error) {
      return { status: "unknown", detail: `could not read service state: ${error instanceof Error ? error.message : String(error)}`, services: lastServices };
    }
    lastServices = services;
    // Default derivation reads the COMPLETE listing (serviceStates reports stopped
    // containers too), so a failed service joins the required set instead of shrinking
    // it. Frozen once ready, so a replica that crashes out of the listing mid-grace is
    // reported by name rather than silently dropping out of the requirement set.
    const names = required ?? readiness?.services ?? Object.keys(services);
    if (names.length === 0) {
      if (Date.now() >= phaseEnd) {
        return { status: "unknown", detail: "compose reported no services for this stack", services: lastServices };
      }
    } else {
      const problems = readinessProblems(services, names);
      const ready = problems.missing.length === 0 && problems.notRunning.length === 0 && problems.unhealthy.length === 0;
      if (graceEndsAt === undefined) {
        if (ready) {
          graceEndsAt = Date.now() + graceMs;
          required = names;
          readyDetail = `required service(s) running: ${names.join(", ")}`;
        } else if (Date.now() >= deadline) {
          return { status: "degraded", detail: readinessProblemDetail(problems), services: lastServices };
        }
      } else if (!ready) {
        return {
          status: "degraded",
          detail: `left the ready state during the ${graceMs}ms grace window: ${readinessProblemDetail(problems)}`,
          services: lastServices,
        };
      }
    }
    await sleep(Math.min(READINESS_POLL_INTERVAL_MS, Math.max(0, phaseEnd - Date.now())));
  }
}

async function runImportAction(name: string, rest: string[]): Promise<void> {
  const source = resolve(name);
  const importedName = rest[0] ?? basename(source);
  if (rest.length > 1) die(`unknown argument: ${rest[1]}`);
  safeName("recipe", importedName);
  try { await access(resolve(source, "recipe.json")); } catch { die(`recipe source has no recipe.json: ${source}`); }
  const destination = resolve(recipesDirectory(), importedName);
  try {
    await access(destination);
    die(`recipe "${importedName}" already exists at ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Two exclusion sources, neither trusted to know the other's files. The regex is a
  // name-shape heuristic over the framework's own credential conventions and nothing
  // more; the files of a particular application are excluded because the source's own
  // recipe.json declares them under privateFiles — the application naming its files the
  // way only it can. Neither is a guarantee: a credential under any other name is copied
  // unless declared, and the enforced promise about a recipe's private files is the
  // target-side privatePaths policy, never a filter over file names here. The
  // declaration is read strictly — a manifest that exists but cannot be read stops the
  // import rather than reading as "nothing declared": a quiet-empty failure would walk
  // a private file into a share archive. Application-specific names live in
  // declarations, not hardcoded in the dispatcher. The regex and the boundary matcher
  // live in the shared portable-content policy (security/recipe-portable-content.ts) — the single
  // implementation that set build, the provision-agent mirror and
  // deploy read too, so no carrier of recipe bytes can drift from this answer.
  const declared = await declaredPortablePrivateFiles(source).catch((error: unknown) =>
    die(error instanceof Error ? error.message : String(error)),
  );
  const excluded = (path: string): boolean =>
    SENSITIVE_RECIPE_NAME.test(path) || excludesPortablePath(path, declared);
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (entry) => !excluded(relative(source, entry).replaceAll("\\", "/")),
  });
  log(`imported recipe "${importedName}"`);
  info(`source: ${source}`);
  info(`destination: ${destination}`);
}

async function runVerifyAction(ctx: Context, name: string): Promise<void> {
  const { recipe: spec } = await stackFor(ctx, name);
  await runRecipeHook(ctx, spec, "verify");
}

async function runOnboardAction(ctx: Context, name: string): Promise<void> {
  const { recipe: spec } = await stackFor(ctx, name);
  await runRecipeHook(ctx, spec, "onboard");
}

async function runDiagnoseAction(ctx: Context, name: string, rest: string[]): Promise<void> {
  const { recipe: spec, stack } = await stackFor(ctx, name);
  const running = await stack.isRunning();
  // Every service in the recipe's own compose project, not just one — a multi-container
  // recipe (a sidecar in front of another sidecar, say) needs all of them in one place to
  // correlate a failure that spans the two, the way cross-referencing separate `docker
  // logs` calls by hand does today.
  const logs = await stack.readLogs(takeTail(rest).tail ?? "50");

  let verify: unknown;
  let verifyError: string | undefined;
  if (spec.verifyPath === undefined) {
    verifyError = "no verify.ts hook";
  } else {
    try {
      verify = await loadHookResult(ctx, spec, "verify");
    } catch (error) {
      verifyError = error instanceof Error ? error.message : String(error);
    }
  }

  const report = { recipe: name, enabled: spec.enabled, running, verify, verifyError, logs };
  if (isCaptured()) {
    emit(`${JSON.stringify(report)}\n`);
    return;
  }
  log(`${name} diagnose`);
  info(`enabled: ${spec.enabled}`);
  info(`running: ${running}`);
  if (verifyError !== undefined) warn(`verify: ${verifyError}`);
  else info(`verify: ${JSON.stringify(verify)}`);
  info("recent logs (every service in the recipe's own stack):");
  info(logs);
}

async function runInstallAction(ctx: Context, name: string, rest: string[]): Promise<void> {
  const { recipe: spec, stack } = await stackFor(ctx, name);

  // Kept in the repository but switched off: refuse rather than start an expensive
  // build nobody asked for. --force-disabled is the deliberate override.
  if (!spec.enabled && !rest.includes("--force-disabled")) {
    warn(`recipe ${spec.name} is disabled`);
    if (spec.disabledReason !== undefined) info(spec.disabledReason);
    die(`install it anyway with: ./clawforge recipe install ${spec.name} --force-disabled`);
  }

  // Variables the recipe declares must exist before the service starts, for the same
  // reason the gateway checks its own: a container that starts and then fails to
  // configure itself is harder to diagnose than a refusal.
  const declared = Object.keys(spec.variables ?? {});
  const absent = declared.filter((variable) => (ctx.settings.env[variable] ?? "") === "");
  if (absent.length > 0) {
    for (const variable of absent) {
      warn(`${variable} is not set — ${spec.variables?.[variable] ?? "required by the recipe"}`);
    }
    die(`add the missing variable(s) to .env, then run this again`);
  }

  const hooks = await prepareRecipe(ctx, spec);

  log(`building ${spec.name} (this compiles from source and can take minutes)`);
  await stack.build();
  log(`starting ${spec.name}`);
  const readinessTimeoutMs = spec.readiness === undefined
    ? DEFAULT_READINESS_GRACE_MS
    : spec.readiness.timeoutMs ?? DEFAULT_DECLARED_READINESS_TIMEOUT_MS;
  // --wait is only requested when the recipe itself declared readiness: without a bound
  // from the recipe, a healthcheck that never turns healthy would otherwise hang install
  // on compose's own unbounded wait.
  await stack.up(
    spec.readiness !== undefined ? { wait: true, timeoutSeconds: Math.ceil(readinessTimeoutMs / 1000) } : undefined,
  );

  // Checked before afterStart, not the instant `up --detach` returns: checking only at
  // that instant would report "running" regardless of a container that starts and
  // crashes moments later, or a multi-service recipe whose main service never comes up
  // while a sidecar does.
  const readiness = await waitForRecipeReadiness(stack, spec.readiness, readinessTimeoutMs);
  const report = { recipe: spec.name, status: readiness.status, detail: readiness.detail, services: readiness.services };

  if (readiness.status !== "ready") {
    if (isCaptured()) emit(`${JSON.stringify(report)}\n`);
    warn(`${spec.name} started but is not ready (${readiness.status}): ${readiness.detail}`);
    info(`diagnose with: ./clawforge recipe diagnose ${spec.name}`);
    die(`recipe ${spec.name} did not reach a ready state — afterStart was skipped`);
  }

  if (typeof hooks.afterStart === "function") await hooks.afterStart(ctx, spec);

  if (isCaptured()) {
    emit(`${JSON.stringify(report)}\n`);
    return;
  }
  log(`${spec.name} is running`);
  for (const port of spec.ports ?? []) {
    info(`port ${port.host} -> ${port.container}${port.description ? ` (${port.description})` : ""}`);
  }
  info("it restarts automatically: restart policy unless-stopped");
}

async function runRemoveAction(ctx: Context, name: string, rest: string[]): Promise<void> {
  const { stack } = await stackFor(ctx, name);
  const removeVolumes = rest.includes("--volumes");
  await stack.down(removeVolumes);
  log(`${name} removed${removeVolumes ? " (including volumes)" : ""}`);
}

async function runStatusAction(ctx: Context, name: string): Promise<void> {
  const { stack } = await stackFor(ctx, name);
  await stack.status();
  info((await stack.isRunning()) ? "running" : "not running");
}

async function runLogsAction(ctx: Context, name: string, rest: string[]): Promise<void> {
  const { stack } = await stackFor(ctx, name);
  // Following runs until interrupted, which nothing but an attended terminal can do:
  // an MCP tool call owes its client one result, and a script or agent shell tool has
  // nothing to interrupt it either. See output.ts's shouldFollow() and lifecycle.ts's
  // logs, which makes the same choice.
  if (!shouldFollow()) {
    emit(await stack.readLogs(takeTail(rest).tail ?? "100"));
    return;
  }
  await stack.followLogs();
}

export async function runRecipeAction(ctx: Context, action: string, name: string, rest: string[]): Promise<void> {
  switch (action) {
    case "import": return runImportAction(name, rest);
    case "verify": return runVerifyAction(ctx, name);
    case "onboard": return runOnboardAction(ctx, name);
    case "diagnose": return runDiagnoseAction(ctx, name, rest);
    case "install": return runInstallAction(ctx, name, rest);
    case "remove": return runRemoveAction(ctx, name, rest);
    case "status": return runStatusAction(ctx, name);
    case "logs": return runLogsAction(ctx, name, rest);
    default:
      dieUnknownAction(action, `unknown action: ${action} (expected list, import, verify, onboard, diagnose, install, remove, status or logs)`, RECIPE_ACTIONS);
  }
}
