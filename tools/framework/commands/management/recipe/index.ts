// `./clawforge recipe` — deploying third-party services next to the instance.
//
// Each recipe runs as its own compose project, so nothing here can disturb the gateway.
// Building happens on the target: a Rust or Go build from scratch takes minutes, and the
// output is streamed rather than swallowed — silent waiting looks like a hang.

import { cp, access } from "node:fs/promises";
import { register } from "node:module";
import { basename, relative, resolve } from "node:path";
import { log, info, warn, die } from "#src/core/log.ts";
import { pathToFileURL } from "node:url";
import { dependencyGraphChecksum } from "./hook-graph.ts";
import type { Context } from "#src/core/context.ts";
import {
  listAgentBundleRecipes,
  listBrokenRecipes,
  listRecipes,
  loadRecipe,
  projectName,
  recipesDirectory,
  type Recipe,
  type RecipeReadiness,
} from "#src/service/recipe.ts";
import { SENSITIVE_RECIPE_NAME, declaredPortablePrivateFiles, excludesPortablePath } from "#src/security/recipe-portable-content.ts";
import { safeName } from "#src/core/names.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import type { Stack, StackServiceState } from "#src/runtime/runtime.ts";
import { isCaptured, shouldFollow, emit } from "#src/core/output.ts";
import { takeTail } from "../../lifecycle/lifecycle.ts";

/** The action a bare `recipe` runs. */
export const RECIPE_DEFAULT_ACTION = "list";

/** Actions that only report. One definition for the dispatcher below and the MCP gate's
 *  readOnlyWhen — which is asked from built argv, where an omitted action is no longer
 *  visibly the default — so the two cannot disagree about bare `recipe` again: the gate
 *  once demanded a confirmation the console would never have asked for.
 *
 *  verify is deliberately absent, though the action is usually a probe: it runs the recipe's
 *  own verify.ts with the same Context prepare.ts gets, and prepare may mutate the target,
 *  so the framework has no way to know a given hook is read-only. Listing it here let an
 *  unconfirmed verify reach the target AND be reported as changed:false on the strength of
 *  its name alone. It gates like onboard, and its envelope only says changed:false when the
 *  hook's own JSON says so. The instance-lock gate in recipe() reads this same set, so the
 *  MCP gate and the lock cannot disagree about a future action. */
const RECIPE_READ_ONLY_ACTIONS: readonly string[] = [RECIPE_DEFAULT_ACTION, "status", "logs"];

/** Every action the dispatcher knows, in the order the usage message names them. Checked
 *  before the lock gate so an unknown action dies as a typo, not as a lock failure. */
const RECIPE_ACTIONS: readonly string[] = ["list", "import", "verify", "onboard", "diagnose", "install", "remove", "status", "logs"];

export function recipeActionIsReadOnly(argv: string[]): boolean {
  return RECIPE_READ_ONLY_ACTIONS.includes(argv[0] ?? RECIPE_DEFAULT_ACTION);
}

function describe(recipe: Recipe): void {
  const state = recipe.enabled ? "" : "  [disabled]";
  info(`${recipe.name.padEnd(16)} ${recipe.description}${state}`);
  if (!recipe.enabled && recipe.disabledReason !== undefined) {
    info(`${"".padEnd(16)} ${recipe.disabledReason}`);
  }
  if (recipe.source !== undefined) info(`${"".padEnd(16)} source: ${recipe.source}`);
  for (const port of recipe.ports ?? []) {
    const suffix = port.description === undefined ? "" : ` (${port.description})`;
    info(`${"".padEnd(16)} port ${port.host} -> ${port.container}${suffix}`);
  }
}

async function stackFor(ctx: Context, name: string) {
  const recipe = await loadRecipe(name);
  return { recipe, stack: ctx.runtime.stack(projectName(deploymentName(), name), recipe.definitionPath) };
}

/** Installed recipes whose Compose stacks are currently running, via the same probe
 *  `recipe status` answers from: one Stack.isRunning() per recipe, which fails soft —
 *  an uninstalled or unreachable stack reads as "not running", never a throw. The
 *  tolerant listRecipes() read is deliberate: this names sidecars for a warning, and
 *  a broken manifest must not break the command carrying the warning (the listing's
 *  rule). Readers: backup and restore, which cannot stop another project's containers
 *  and so must say which stacks their consistency guarantee leaves out (audit
 *  2026-09-22 round 2, P2-04). */
export async function runningRecipeStacks(ctx: Context): Promise<Recipe[]> {
  const running: Recipe[] = [];
  for (const recipe of await listRecipes()) {
    const stack = ctx.runtime.stack(projectName(deploymentName(), recipe.name), recipe.definitionPath);
    if (await stack.isRunning()) running.push(recipe);
  }
  return running;
}

/** App-owned hook modules, cached against the checksum of the hook's whole local import
 *  graph.
 *
 *  `import()` answers from the process-wide module map keyed by URL, so in a long-lived
 *  process — every MCP session — re-importing the same hook file returned the first load
 *  forever: a hook edited on disk kept running its previous code on the next tool call,
 *  while a freshly started CLI process picked the new one up (audit 2026-09-22 round 3,
 *  P2-04). A relative import graph made that worse — editing a helper without touching
 *  prepare.ts/verify.ts left a session running the helper's old code (round 4, P2-06) —
 *  so the gate that decides whether a reload is due hashes the whole local import graph,
 *  not just the entry file: dependencyGraphChecksum below.
 *
 *  The graph checksum decides *whether* a reload is due; a versioned URL decides *what
 *  gets re-executed*. importHookModule imports the hook's real file URL with that
 *  checksum as a `?g=` query parameter (`file://…/prepare.ts?g=<checksum>`), and the
 *  resolve hook in ./hook-loader.ts re-stamps the same version onto every
 *  specifier the graph reaches through relative resolution. Because the checksum is
 *  computed before the import, the version is known up front — every module in the
 *  graph, cycles included, carries it, so a change anywhere changes every versioned URL
 *  at once and Node re-executes the whole graph, while an unchanged graph answers from
 *  this map without importing at all.
 *
 *  Hooks execute from their real location, so nothing about resolution changes for the
 *  recipe author: bare imports (`@clawforge/framework/private-config`, the recipe app's
 *  own dependencies) and `#imports` resolve against the recipe's own package scope,
 *  `import.meta.url` points at the real file, and sibling assets sit where relative
 *  reads expect them. Nothing is copied to temp storage, so there is no shared cache
 *  directory to win a race against, no pre-existing file to silently adopt, and no
 *  bytes of framework-controlled temp state at all (audit 2026-09-23 round 6, P1-08,
 *  P2-01; the copy machinery this replaces also deadlocked on genuine A→B→A cycles —
 *  P2-02 — which ESM now handles natively). */
const hookModules = new Map<string, { checksum: string; loaded: Record<string, unknown> }>();

/** Query parameter carrying the hook graph's checksum on every versioned hook URL. */
const HOOK_GRAPH_VERSION_PARAM = "g";

const HOOK_IMPORT_TIMEOUT_MS_DEFAULT = 30_000;

/** The deadline is a backstop against evaluation that never settles — the loader's own
 *  promise graph cannot deadlock anymore (there is none), but a hook's top-level await
 *  still could, and a hung import means a hung MCP call holding the instance lock. The
 *  environment override exists so a check can exercise the timeout path in seconds
 *  instead of half a minute. */
function hookImportTimeoutMs(): number {
  const override = Number(process.env.CLAWFORGE_HOOK_IMPORT_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : HOOK_IMPORT_TIMEOUT_MS_DEFAULT;
}

let hookResolveHooksRegistered = false;

export async function importHookModule(path: string): Promise<Record<string, unknown>> {
  const checksum = await dependencyGraphChecksum(path);
  const cached = hookModules.get(path);
  if (cached?.checksum === checksum) return cached.loaded;
  if (!hookResolveHooksRegistered) {
    register(new URL("./hook-loader.ts", import.meta.url).href, import.meta.url);
    hookResolveHooksRegistered = true;
  }
  const versionedURL = `${pathToFileURL(path).href}?${HOOK_GRAPH_VERSION_PARAM}=${checksum}`;
  const evaluation = import(versionedURL) as Promise<Record<string, unknown>>;
  // If the deadline ever wins the race the evaluation is still pending in the background;
  // a rejection from it must not surface as an unhandled rejection and crash the process.
  evaluation.catch(() => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `recipe hook ${path}: module evaluation did not settle within ${hookImportTimeoutMs()}ms — ` +
                "the hook's top-level code (a top-level await across its relative imports, typically) never resolves",
            ),
          );
        }, hookImportTimeoutMs());
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
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
 *  running for one poll and crashes before the next must fail (audit 2026-09-23, P2-09). */
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
 *  the readiness deadline that is supposed to bound the whole loop (audit 2026-09-23,
 *  P2-09). The underlying operation keeps running past the timeout — there is no way to
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
 *  with the recipe's main service down (audit 2026-09-23, P2-04; grace window and probe
 *  bound: P2-09). */
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
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(READINESS_POLL_INTERVAL_MS, Math.max(0, phaseEnd - Date.now()))));
  }
}

export async function recipe(ctx: Context, args: string[]): Promise<void> {
  const [action, name, ...rest] = args;

  if (action === undefined || action === RECIPE_DEFAULT_ACTION) {
    const recipes = await listRecipes();
    // A recipe directory can also be an agent/MCP bundle — no recipe.json, so listRecipes
    // drops it and inspect reports it. Answering "no recipes yet" over one sent an operator
    // reading code to explain a discrepancy their own deployment showed.
    const bundles = await listAgentBundleRecipes();
    // A recipe.json that exists but fails to load (bad shape, invalid ports/variables — the
    // P3-01 case). listRecipes() drops these so one broken manifest cannot take the working
    // recipes down with it; this is the other half — the same manifest still gets a named,
    // visible entry in the catalog instead of quietly not existing.
    const broken = await listBrokenRecipes();
    if (recipes.length === 0 && bundles.length === 0 && broken.length === 0) {
      info("no recipes yet — add one under recipes/<name>/");
      return;
    }
    if (recipes.length === 0 && broken.length === 0) {
      info("no service recipes yet — `recipe install` needs a recipes/<name>/recipe.json");
    } else if (recipes.length > 0) {
      log("available recipes");
      for (const entry of recipes) describe(entry);
      info("");
      info("install with: ./clawforge recipe install <name>");
    }
    for (const name of bundles) {
      info(`${name.padEnd(16)} agent/MCP bundle — not installable; visible with ./clawforge inspect, provisioned with ./clawforge provision-agent`);
    }
    for (const entry of broken) {
      warn(`${entry.name.padEnd(16)} broken recipe.json: ${entry.error}`);
    }
    return;
  }

  if (name === undefined) die(`usage: ./clawforge recipe ${action} <name>`);

  if (!RECIPE_ACTIONS.includes(action)) {
    die(`unknown action: ${action} (expected ${RECIPE_ACTIONS.join(", ")})`);
  }

  // One classification for MCP's confirmation gate and for the instance lock, so a future
  // action cannot be mutating for one and read-only for the other. The single exception is
  // `import`: it copies into the repository's recipes/ directory, never touches the target,
  // and taking a lock would make it the one recipe action that cannot run before bootstrap
  // has prepared the lock home. install holds the lock across the whole from-source build —
  // minutes, on purpose: a build finishing while restore is moving the tree is the
  // interleaving the lock exists to prevent. A caller that already holds the lock (an
  // orchestration step running this as its own) rides it instead of refusing — guarded() is
  // the nesting-safe shape every other mutating command uses (instance-lock.ts).
  if (action !== "import" && !recipeActionIsReadOnly([action])) {
    return guarded(ctx, `recipe ${action} ${name}`, args, () => runRecipeAction(ctx, action, name, rest));
  }
  return runRecipeAction(ctx, action, name, rest);
}

async function runRecipeAction(ctx: Context, action: string, name: string, rest: string[]): Promise<void> {
  switch (action) {
    case "import": {
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
      // import rather than reading as "nothing declared", the quiet-empty failure that once
      // walked a private file into a share archive (audit 2026-09-21, P1-01); the
      // application-specific names the dispatcher used to hardcode moved into declarations
      // in the same change that added the field, so no currently excluded name lost its
      // exclusion. The regex and the boundary matcher now live in the shared
      // portable-content policy (security/recipe-portable-content.ts, audit 2026-09-22,
      // P1-03) — the single implementation that set build, the provision-agent mirror and
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
      return;
    }

    case "verify": {
      const { recipe: spec } = await stackFor(ctx, name);
      await runRecipeHook(ctx, spec, "verify");
      return;
    }

    case "onboard": {
      const { recipe: spec } = await stackFor(ctx, name);
      await runRecipeHook(ctx, spec, "onboard");
      return;
    }

    // Not in RECIPE_READ_ONLY_ACTIONS, for the same reason "verify" itself is not: it runs
    // the recipe's own verify.ts, which the framework cannot know is actually read-only.
    case "diagnose": {
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
      return;
    }

    case "install": {
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

      // Checked before afterStart, not the instant `up --detach` returns: a container that
      // starts and crashes moments later, or a multi-service recipe whose main service never
      // came up while a sidecar did, used to be reported "running" regardless (audit
      // 2026-09-23, P2-04).
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
      return;
    }

    case "remove": {
      const { stack } = await stackFor(ctx, name);
      const removeVolumes = rest.includes("--volumes");
      await stack.down(removeVolumes);
      log(`${name} removed${removeVolumes ? " (including volumes)" : ""}`);
      return;
    }

    case "status": {
      const { stack } = await stackFor(ctx, name);
      await stack.status();
      info((await stack.isRunning()) ? "running" : "not running");
      return;
    }

    case "logs": {
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
      return;
    }

    default:
      die(`unknown action: ${action} (expected list, import, verify, onboard, diagnose, install, remove, status or logs)`);
  }
}
