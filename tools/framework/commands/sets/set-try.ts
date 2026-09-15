// `./clawforge set try --set <artifact>` — install a set into a throwaway instance, run whatever
// acceptance it declares, and tear the instance down. One operation instead of several: a
// coder can hand over a set and the answer to "does it actually work" comes back without
// them ever touching their own real deployment to get it.
//
// Reuses the pieces that already exist rather than a second bring-up path: bootstrap's own
// order of operations, --set's own source override, provision-agent's own reconciliation,
// runCheck's own check kinds. What is new here is the throwaway home they run against — a
// deployment directory, a data path and a port nothing else is using — so teardown can only
// ever remove what this operation itself created, never the real instance beside it.

import { mkdir, writeFile, rm, readFile, cp } from "node:fs/promises";
import { join, dirname, relative, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { log, info, warn, die } from "#src/core/log.ts";
import { emit, isCaptured } from "#src/core/output.ts";
import { parseEnv, frameworkRoot } from "#src/core/env.ts";
import { useDeployment, deploymentDir, envFile, composeProjectOverride, useComposeProjectOverride } from "#src/runtime/deployment.ts";
import { createContext } from "#src/core/context.ts";
import type { Context } from "#src/core/context.ts";
import { mountPoints } from "#src/runtime/mounts.ts";
import { useSetSource, clearSetSource, setSourceDir, withSetSource } from "#src/set/artifacts/source.ts";
import { recordInstalledSet } from "#src/set/artifacts/install.ts";
import { validateSet } from "#src/set/ownership/validate.ts";
import { localSecretValues } from "./set.ts";
import { ensureDataDirs, ensureSecretsFile, secretsFileOnTarget, runMaybePrivileged } from "#src/runtime/datadir.ts";
import { ensureBaselineConfig, configureProvider } from "../management/provider.ts";
import { applyConfig } from "../orchestration/config.ts";
import { preflightSecrets } from "../management/secrets.ts";
import { down } from "../lifecycle/lifecycle.ts";
import { provisionAgent } from "../management/provision-agent/index.ts";
import { runCheck, requiresModel, summarize, acceptanceSpecError } from "../orchestration/accept.ts";
import type { AcceptanceResult } from "../orchestration/accept.ts";
import { observeRuntime, runtimeMatches, saveEvidence } from "#src/set/artifacts/evidence.ts";
import type { ObservedRuntime } from "#src/set/artifacts/evidence.ts";
import { unpackForTry, findFreePort, tryDeploymentName, targetSiblingRoot, buildEnv, tryTargetProblem } from "./set-try-env.ts";

export * from "./set-try-env.ts";

export interface TryReport {
  readonly name: string;
  readonly setId: string;
  readonly setName: string;
  readonly serviceUrl: string;
  readonly acceptance: {
    readonly passed: number;
    readonly failed: number;
    readonly notChecked: number;
    readonly couldNotCheck: number;
    readonly summary: string;
    readonly results: Record<string, AcceptanceResult[]>;
  };
  readonly healthy: boolean;
  readonly torndown: boolean;
  readonly receipt?: { id: string; setId: string; verdict: string };
}

export interface TryTeardownResult {
  readonly torndown: boolean;
  readonly running: boolean;
  readonly error?: unknown;
}

/** Stops and removes only the resources owned by a try. The callbacks are injectable so the
 * lifecycle contract can be tested without Docker, and so teardown remains best-effort when
 * bootstrap or acceptance has already failed. */
export async function teardownTry(
  ctx: Context,
  dataRoot: string,
  keep: boolean,
  operations: {
    down?: (ctx: Context) => Promise<void>;
    remove?: (ctx: Context, dataRoot: string) => Promise<void>;
  } = {},
): Promise<TryTeardownResult> {
  let running = false;
  try {
    running = await ctx.runtime.isRunning();
  } catch {
    // An unanswerable runtime is not called running, and is not called torn down either.
  }
  if (keep) return { torndown: false, running };

  let error: unknown;
  // `down` is deliberately unconditional. A failed bootstrap can leave a stopped container
  // or network behind, while isRunning() only tells us about the process, not the project.
  try {
    await (operations.down ?? ((target) => down(target, [])))(ctx);
  } catch (failure) {
    error = failure;
  }
  // If compose teardown failed, leave the data in place: deleting a bind mount while an
  // orphaned container still uses it is worse than reporting a recoverable leftover.
  if (error === undefined) {
    try {
      await (operations.remove ?? ((target, root) => runMaybePrivileged(target, root, "rm", ["-rf", root])))(ctx, dataRoot);
    } catch (failure) {
      error = failure;
    }
  }
  return { torndown: error === undefined, running, ...(error === undefined ? {} : { error }) };
}

export async function setTry(ctx: Context, args: string[], dependencies: {
  createContext?: typeof createContext;
  findFreePort?: typeof findFreePort;
} = {}): Promise<void> {
  const startedAt = new Date().toISOString();
  let artifact: string | undefined;
  let withModel = false;
  let keep = false;
  let jsonOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--set") {
      artifact = args[index + 1] ?? die("--set needs an artifact path");
      index += 1;
    } else if (arg === "--with-model") withModel = true;
    else if (arg === "--keep") keep = true;
    else if (arg === "--json") jsonOnly = true;
    else die(`unknown argument: ${arg}`);
  }
  if (artifact === undefined) die("usage: ./clawforge set try --set <artifact> [--with-model] [--keep] [--json]");

  // Gathered from the real deployment before anything below points useDeployment() at the
  // throwaway one: the values already on this machine are what the throwaway needs too — a
  // set only ever carries their NAMES, never their values. Two sources, and the live one
  // wins when both have an answer: a host-side secret store can be stale, but the value a
  // running instance is actually configured with cannot be.
  const realDir = deploymentDir();
  const previousSource = setSourceDir();
  // The throwaway's own createContext() call resets this the same way it resets the set
  // source above — its .env has no OC_COMPOSE_PROJECT of its own, so building its Context
  // clears whatever the real deployment's .env had set. Restored in the same finally block,
  // for the same reason: a composite command that keeps using the original Context after
  // set try returns must still address Docker under the name it started with.
  const previousComposeProject = composeProjectOverride();
  const realEnv = parseEnv(await readFile(envFile(), "utf8").catch(() => ""));
  const targetLocation = (realEnv.OC_TARGET_LOCATION ?? "auto").toLowerCase();
  const targetProblem = tryTargetProblem(targetLocation);
  if (targetProblem !== undefined) die(targetProblem);
  const secretValues: Record<string, string> = Object.fromEntries(
    (await localSecretValues()).map(({ name, value }) => [name.replace(/ \([^)]*\)$/, ""), value]),
  );
  try {
    Object.assign(secretValues, parseEnv(await ctx.transport.readFile(secretsFileOnTarget(ctx))));
  } catch {
    // The real instance is down, or has never been bootstrapped — nothing live to read.
  }

  // The deployment directory's own basename becomes the compose project name
  // (deploymentName() derives it unconditionally, same as any other deployment) — so it has
  // to be built from tryName itself, lowercase and hyphens only, rather than from whatever
  // random suffix mkdtemp would otherwise pick (which can and does contain uppercase
  // letters, and compose refuses those in a project name).
  const unpacked = await unpackForTry(artifact);
  const staging = unpacked.staging;
  const tryName = tryDeploymentName();
  // Keep the throwaway deployment under the checkout. A WSL or SSH path bridge can express
  // this location on the target; a random host temp directory cannot be mapped by SSH.
  const tempDir = join(realDir, "sets", ".tries", tryName);
  let tempDirCreated = false;
  const dataRoot = targetSiblingRoot(realEnv.OC_DATA_DIR ?? "/tmp/openclaw/data", tryName);

  let report: TryReport | undefined;
  let teardownError: unknown;
  let operationError: unknown;
  let ownsTarget = false;
  let observedBefore: ObservedRuntime | undefined;
  let observedAfter: ObservedRuntime | undefined;
  let provisioned = false;

  try {
    await mkdir(dirname(tempDir), { recursive: true });
    await mkdir(tempDir);
    tempDirCreated = true;
    await cp(staging, tempDir, { recursive: true });

    const { manifest, id } = unpacked.verified;

    let problems;
    try {
      problems = await withSetSource(staging, () => validateSet(manifest, { checkFiles: false }));
    } catch (error) {
      die(`this set has an invalid manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
    const blocking = problems.filter((entry) => entry.severity === "blocking");
    if (blocking.length > 0) {
      die(
        `this set is not coherent — ${blocking.length} blocking finding(s), fix them first:\n` +
          blocking.map((entry) => `  ${entry.code}  ${entry.detail}`).join("\n"),
      );
    }

    if (manifest.acceptance === null || typeof manifest.acceptance !== "object" || Array.isArray(manifest.acceptance)) {
      die("this set has an invalid acceptance section: expected an object keyed by recipe");
    }
    for (const [recipe, checks] of Object.entries(manifest.acceptance)) {
      if (!Array.isArray(checks)) die(`this set has an invalid acceptance section for recipe "${recipe}": expected an array`);
      const invalid = checks.map((check, index) => acceptanceSpecError(check, index)).find((detail) => detail !== undefined);
      if (invalid !== undefined) die(`recipe "${recipe}": ${invalid}`);
    }
    if (!Array.isArray(manifest.secrets) || manifest.secrets.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      die("this set has invalid secret names: use shell variable names such as WIKI_TOKEN");
    }
    if (typeof manifest.requires?.image !== "string" || /[\r\n]/.test(manifest.requires.image)) {
      die("this set has an invalid image reference");
    }

    const port = await (dependencies.findFreePort ?? findFreePort)();
    const token = randomBytes(24).toString("hex");

    await mkdir(join(tempDir, "config"), { recursive: true });
    const extension = extname(fileURLToPath(import.meta.url));
    const modulePaths: Record<string, string> = {
      app: "core/app",
      mounts: "runtime/mounts",
      "commands/index": "commands/interface/index",
    };
    const modulePath = (name: string) => {
      const module = modulePaths[name];
      if (module === undefined) throw new Error(`unknown temporary app module: ${name}`);
      const path = relative(tempDir, resolve(frameworkRoot, `${module}${extension}`)).replaceAll("\\", "/");
      return path.startsWith(".") ? path : `./${path}`;
    };
    await writeFile(join(tempDir, "app.ts"),
      `import { defineApp } from ${JSON.stringify(modulePath("app"))};\n` +
      `import { mountPoints } from ${JSON.stringify(modulePath("mounts"))};\n` +
      `import { openclawCommands } from ${JSON.stringify(modulePath("commands/index"))};\n` +
      `export default defineApp({name:${JSON.stringify(tryName)},description:"temporary set instance",service:{name:"gateway"},mounts:mountPoints,commands:openclawCommands});\n`);
    await writeFile(
      join(tempDir, ".env"),
      buildEnv({ port, token, image: manifest.requires.image, dataRoot, copiedFrom: realEnv }),
    );

    useDeployment(tempDir);
    useSetSource(staging);

    let tryCtx: Context;
    try {
      tryCtx = await (dependencies.createContext ?? createContext)({ mounts: mountPoints, service: { name: "gateway", logTail: "100" } });
    } catch (error) {
      // Preserve the real target/path error through the outer restoration cleanup.
      operationError = error;
      throw error;
    }

    try {
      log(`bringing up a throwaway instance "${tryName}" on port ${port}`);
      // Verify both the coordinate bridge and the target-side port before creating any data
      // directories. A local port probe cannot see an SSH/WSL target's listeners.
      await tryCtx.paths.toTarget(tempDir);
      const conflict = await tryCtx.runtime.portConflict(String(port));
      if (conflict !== undefined) die(`throwaway port ${port} is already used on the target by ${conflict}`);
      await runMaybePrivileged(tryCtx, dataRoot, "mkdir", [dataRoot]);
      ownsTarget = true;
      await ensureDataDirs(tryCtx);
      await ensureSecretsFile(tryCtx);

      // Values only, and never the gateway token: this instance generated its own above,
      // the same as any other bootstrap. Anything the set needs but this machine does not
      // know is left absent — preflightSecrets says so plainly rather than this guessing.
      const targetLines = manifest.secrets
        .filter((name) => name !== "OPENCLAW_GATEWAY_TOKEN" && secretValues[name] !== undefined)
        .map((name) => `${name}=${secretValues[name]}`);
      if (targetLines.length > 0) {
        await tryCtx.transport.writeFile(secretsFileOnTarget(tryCtx), `${targetLines.join("\n")}\n`, "600");
      }

      await tryCtx.runtime.pullImage();
      await ensureBaselineConfig(tryCtx);
      // Same order as bootstrap, same reason: a new custom provider's baseUrl and models
      // come from the set's own desired-state.json, and OpenClaw's schema requires them
      // before it accepts an apiKey for a provider id it does not already know.
      await applyConfig(tryCtx, []);
      await configureProvider(tryCtx, []);
      await preflightSecrets(tryCtx);

      await tryCtx.runtime.start();
      await tryCtx.runtime.waitForHealth();
      log(`throwaway instance healthy: ${tryCtx.settings.serviceUrl}`);

      // Per recipe, not all-or-nothing: one recipe whose provisioning fails must not stop
      // the report from saying anything about the others, and it must not abort before any
      // acceptance check has had a chance to run at all — a coder trying a set wants to
      // know what worked as much as what did not.
      const provisionError = new Map<string, string>();
      for (const [recipe, recipeEntry] of Object.entries(manifest.recipes)) {
        if (recipeEntry.agent === undefined) continue;
        try {
          await provisionAgent(tryCtx, [recipe]);
        } catch (error) {
          provisionError.set(recipe, error instanceof Error ? error.message : String(error));
          warn(`recipe "${recipe}" did not provision — its acceptance checks are reported as could-not-check`);
        }
      }

      await recordInstalledSet(tryCtx, manifest, id);
      provisioned = provisionError.size === 0;
      observedBefore = await observeRuntime(tryCtx, manifest);

      const results: Record<string, AcceptanceResult[]> = {};
      let passed = 0;
      let failed = 0;
      let notChecked = 0;
      let couldNotCheck = 0;
      for (const [recipe, checks] of Object.entries(manifest.acceptance)) {
        const recipeResults: AcceptanceResult[] = [];
        const failure = provisionError.get(recipe);
        for (const check of checks) {
          if (failure !== undefined) {
            recipeResults.push({ name: check.name ?? check.kind, kind: check.kind, status: "could-not-check", detail: `recipe did not provision: ${failure}` });
            couldNotCheck += 1;
            continue;
          }
          if ((requiresModel(check.kind) || check.usesModel === true) && !withModel) {
            recipeResults.push({ name: check.name ?? check.kind, kind: check.kind, status: "not-checked", detail: "calls the model — pass --with-model to include it" });
            notChecked += 1;
            continue;
          }
          const result = await runCheck(tryCtx, recipe, check);
          recipeResults.push(result);
          if (result.status === "passed") passed += 1;
          else if (result.status === "failed") failed += 1;
          else if (result.status === "could-not-check") couldNotCheck += 1;
          else notChecked += 1;
        }
        results[recipe] = recipeResults;
      }
      // A recipe can fail to provision without declaring any acceptance check at all — its
      // failure would otherwise vanish from the report entirely rather than merely not add
      // to the counts above.
      for (const [recipe, failure] of provisionError) {
        if ((results[recipe]?.length ?? 0) > 0) continue;
        results[recipe] = [{ name: "provision", kind: "provision", status: "could-not-check", detail: failure }];
        couldNotCheck += 1;
      }

      report = {
        name: tryName,
        setId: id,
        setName: manifest.name,
        serviceUrl: tryCtx.settings.serviceUrl,
        acceptance: {
          passed,
          failed,
          notChecked,
          couldNotCheck,
          summary: summarize(passed, failed, notChecked, couldNotCheck),
          results,
        },
        healthy: Object.values(results).some((entries) => entries.length > 0)
          && failed === 0 && notChecked === 0 && couldNotCheck === 0,
        torndown: !keep,
      };
      observedAfter = await observeRuntime(tryCtx, manifest);
    } catch (error) {
      // Keep the lifecycle result machine-readable even when bootstrap, health or recording
      // fails. A thrown error without a report makes a failed try indistinguishable from a
      // command that never attempted the set.
      operationError = error;
      report = {
        name: tryName,
        setId: id,
        setName: manifest.name,
        serviceUrl: tryCtx.settings.serviceUrl,
        acceptance: {
          passed: 0,
          failed: 0,
          notChecked: 0,
          couldNotCheck: 0,
          summary: "0 passed, 0 failed",
          results: {},
        },
        healthy: false,
        torndown: false,
      };
    } finally {
      const teardown = ownsTarget
        ? await teardownTry(tryCtx, dataRoot, keep)
        : { torndown: true, running: false };
      teardownError ??= teardown.error;
      if (keep) {
        info(teardown.running
          ? `--keep: instance "${tryName}" left running at ${tryCtx.settings.serviceUrl}, data at ${dataRoot}`
          : `--keep: instance "${tryName}" was not confirmed running; inspect it before cleanup, data at ${dataRoot}`);
        info(`deployment retained at ${tempDir}; run the framework CLI there to inspect or stop it`);
      }
    }
  } finally {
    clearSetSource();
    useDeployment(realDir);
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (!keep && teardownError === undefined && tempDirCreated) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        teardownError ??= error;
      }
    }
    if (previousSource === undefined) clearSetSource();
    else useSetSource(previousSource);
    useComposeProjectOverride(previousComposeProject);
  }

  if (report === undefined) {
    if (operationError !== undefined) throw operationError;
    die("set try did not produce a report");
  }
  if (!keep) report = { ...report, torndown: teardownError === undefined };

  const observed = observedAfter ?? observedBefore ?? { observations: { frameworkVersion: "unknown" }, digests: [] };
  const receipt = await saveEvidence({
    verified: unpacked.verified,
    source: "set-try",
    startedAt,
    withModel,
    selected: Object.keys(unpacked.verified.manifest.acceptance),
    results: report.acceptance.results,
    observed,
    subjectVerified: provisioned && operationError === undefined && teardownError === undefined
      && observedBefore !== undefined && observedAfter !== undefined
      && runtimeMatches(unpacked.verified.manifest, observedBefore, observedAfter),
    failure: operationError instanceof Error ? operationError.message : undefined,
    root: realDir,
  });
  report = { ...report, receipt: { id: receipt.receiptId, setId: receipt.setId, verdict: receipt.verdict } };

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    log(`set "${report.setName}" (${report.setId.slice(0, 12)}…) tried on throwaway instance "${report.name}"`);
    if (Object.keys(report.acceptance.results).length === 0) {
      info("the set declares no acceptance checks — the instance came up, but nothing was verified");
    } else {
      info(`acceptance: ${report.acceptance.summary}`);
      for (const [recipe, checks] of Object.entries(report.acceptance.results)) {
        for (const entry of checks) {
          const mark = entry.status === "passed" ? "ok  " : entry.status === "failed" ? "FAIL" : entry.status === "not-checked" ? "WAIT" : "?   ";
          info(`  ${mark} ${recipe}/${entry.name}${entry.detail === undefined ? "" : ` — ${entry.detail}`}`);
        }
      }
    }
    info(report.torndown ? "torn down — nothing left behind" : `instance resources retained; deployment at ${tempDir}, data at ${dataRoot}`);
    info(`receipt: ${receipt.receiptId} (${receipt.verdict})`);
  }

  if (teardownError !== undefined) {
    warn(`teardown had a problem: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`);
    warn(`check for a leftover instance — data root was ${dataRoot}`);
    if (operationError === undefined) throw new Error(`throwaway instance cleanup failed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`);
  }

  // Preserve the original lifecycle failure after emitting the honest report and restoring
  // the caller's deployment/source context.
  if (typeof operationError !== "undefined") throw operationError;

  if (report.acceptance.failed > 0 || report.acceptance.couldNotCheck > 0) {
    throw new Error(`${report.acceptance.failed + report.acceptance.couldNotCheck} acceptance check(s) did not pass on the throwaway instance`);
  }
}
