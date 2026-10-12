// Real command binding and hook loader, mocked stack only. No clocks, sleeps or live services.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { useRecipesDir, clearRecipesDir } from "#framework/service/recipe.ts";
import { clearDeployment, composeProjectOverride, selectedDeployment, useComposeProjectOverride, useDeployment } from "#framework/runtime/deployment.ts";
import { runOwning, lockPath, lockHeldHere, type HeldLock } from "#framework/runtime/lock/instance-lock.ts";
import type { Context } from "#framework/core/context.ts";
import type { StackRecoverOptions, StackRecoverPlan, StackLock } from "#framework/runtime/runtime.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

interface RunObservations {
  consumer: { endpoint: string; generation: number };
  recoveries: number;
  recoveryScopes: number;
  moduleEvaluations: number;
  afterStart: number;
  prepare: number;
  defaultHook: number;
  readiness: number;
  build: number;
  dependencyStart: number;
  restart: number;
}

interface RunObservationResult {
  error: unknown;
  before: RunObservations;
  after: RunObservations;
}

const root = await mkdtemp(join(tmpdir(), "recipe-recover-command-"));
const directory = join(root, "local");
const observations: RunObservations = {
  consumer: { endpoint: "original", generation: 0 }, recoveries: 0, recoveryScopes: 0,
  moduleEvaluations: 0, afterStart: 0, prepare: 0, defaultHook: 0,
  readiness: 0, build: 0, dependencyStart: 0, restart: 0,
};
const global = globalThis as unknown as Record<string, unknown>;
global.__recoverObservations = observations;
const previousDeployment = selectedDeployment();
const previousComposeOverride = composeProjectOverride();
let ready = true;
const plan: StackRecoverPlan = {
  token: "opaque-secret-token", service: "db", build: false, pull: false,
  imageIds: ["sha256:exact"], containers: [], impacts: ["unsafe-diagnostic"],
};
const ctx = {
  settings: { dataDir: "/fixture/data", env: {} },
  transport: { description: "recover-fixture" },
  runtime: {
    stack: () => ({
      async planRecover(options: StackRecoverOptions) {
        if (options.service !== "db") throw new Error("unknown selected service");
        return { ...plan, build: options.build === true, pull: options.pull === true };
      },
      async recover(_value: StackRecoverPlan, withLock: StackLock) {
        // Exercise guardedWith against a real async-local owning scope, without a live target.
        const path = lockPath(ctx);
        const held = { path, resource: `recover-fixture\u0000${path}` } as HeldLock;
        await runOwning(held, async () => {
          await withLock(async () => {
            observations.recoveryScopes++;
            observations.recoveries++;
            checkTrue("executor callback is inside caller lock", lockHeldHere(ctx));
          });
        });
      },
      async serviceStates() {
        checkTrue("dependency readiness is inside lock", lockHeldHere(ctx));
        observations.readiness++;
        return { db: { running: true, health: "healthy" }, dependency: { running: ready } };
      },
      async build() { observations.build++; throw new Error("implicit build"); },
      async up() { observations.dependencyStart++; throw new Error("automatic dependency start"); },
    }),
    async restart() { observations.restart++; throw new Error("implicit gateway restart"); },
  },
} as unknown as Context;
global.__recoverCheckHookLock = () => {
  checkTrue("actual afterStart hook is inside caller lock", lockHeldHere(ctx));
};

async function run(args: string[]): Promise<RunObservationResult> {
  const before = structuredClone(observations);
  let error: unknown;
  try { await withOutputSink(() => {}, () => recipe(ctx, args)); }
  catch (caught) { error = caught; }
  const after = structuredClone(observations);
  check("recover never invokes implicit build, dependency start or restart", {
    build: after.build, dependencyStart: after.dependencyStart, restart: after.restart,
  }, { build: before.build, dependencyStart: before.dependencyStart, restart: before.restart });
  checkTrue("dependency observations are bounded", after.readiness - before.readiness <= 1);
  check("recover never invokes prepare or default hooks", {
    prepare: after.prepare, defaultHook: after.defaultHook,
  }, { prepare: before.prepare, defaultHook: before.defaultHook });
  return { error, before, after };
}

function checkHooksUnchanged(label: string, result: RunObservationResult) {
  check(label, {
    consumer: result.after.consumer,
    moduleEvaluations: result.after.moduleEvaluations, afterStart: result.after.afterStart,
  }, {
    consumer: result.before.consumer,
    moduleEvaluations: result.before.moduleEvaluations, afterStart: result.before.afterStart,
  });
}

try {
  useDeployment(root);
  useRecipesDir(root);
  useComposeProjectOverride("recover-command-fixture");
  await mkdir(directory);
  await writeFile(join(directory, "recipe.json"), JSON.stringify({ description: "fixture", readiness: { services: ["db", "dependency"] } }));
  await writeFile(join(directory, "compose.yml"), "services: {}\n");
  await writeFile(join(directory, "prepare.ts"), `
    globalThis.__recoverObservations.moduleEvaluations++;
    export function afterStart() {
      globalThis.__recoverObservations.afterStart++;
      globalThis.__recoverCheckHookLock();
      globalThis.__recoverObservations.consumer.endpoint = "reconciled";
      globalThis.__recoverObservations.consumer.generation++;
    }
    export function prepare() { globalThis.__recoverObservations.prepare++; }
    export default function () { globalThis.__recoverObservations.defaultHook++; }
  `);

  const preview = await run(["recover", "local", "--service", "db", "--dry-run", "--reconcile-consumer"]);
  check("preview succeeds", preview.error, undefined);
  checkHooksUnchanged("preview neither evaluates the module nor invokes hooks", preview);
  check("preview does not enter recovery or its lock scope", [preview.after.recoveries, preview.after.recoveryScopes],
    [preview.before.recoveries, preview.before.recoveryScopes]);
  check("preview does not observe dependencies", preview.after.readiness, preview.before.readiness);

  const plain = await run(["recover", "local", "--service", "db"]);
  check("default command succeeds", plain.error, undefined);
  checkHooksUnchanged("default recovery does not evaluate or invoke hooks", plain);
  check("default recovery completes exactly one owning scope", [plain.after.recoveries - plain.before.recoveries, plain.after.recoveryScopes - plain.before.recoveryScopes], [1, 1]);
  check("default recovery does not observe dependencies", plain.after.readiness, plain.before.readiness);

  ready = false;
  const failed = await run(["recover", "local", "--service", "db", "--reconcile-consumer"]);
  checkTrue("dependency failure refuses reconciliation", failed.error instanceof Error);
  checkTrue("dependency failure observes readiness", failed.after.readiness > failed.before.readiness);
  checkHooksUnchanged("unready dependencies prevent module evaluation and hook effects", failed);

  ready = true;
  const explicit = await run(["recover", "local", "--service", "db", "--build", "--pull", "--reconcile-consumer"]);
  check("named afterStart succeeds", explicit.error, undefined);
  checkTrue("reconciliation observes dependency readiness", explicit.after.readiness > explicit.before.readiness);
  checkTrue("reconciliation evaluates the real hook module", explicit.after.moduleEvaluations > explicit.before.moduleEvaluations);
  check("reconciliation changes actual consumer state exactly once", explicit.after.consumer,
    { endpoint: "reconciled", generation: explicit.before.consumer.generation + 1 });
  checkTrue("reconciliation invokes the actual named hook", explicit.after.afterStart > explicit.before.afterStart);

  await writeFile(join(directory, "prepare.ts"), `
    globalThis.__recoverObservations.moduleEvaluations++;
    export default function () { globalThis.__recoverObservations.defaultHook++; }
    export function prepare() { globalThis.__recoverObservations.prepare++; }
  `);
  const unnamed = await run(["recover", "local", "--service", "db", "--reconcile-consumer"]);
  checkTrue("missing requested named export refuses", unnamed.error instanceof Error);
  checkTrue("missing named export is observed by evaluating the actual module", unnamed.after.moduleEvaluations > unnamed.before.moduleEvaluations);
  check("missing named export preserves consumer state", unnamed.after.consumer, unnamed.before.consumer);
  check("missing named export does not invoke afterStart", unnamed.after.afterStart, unnamed.before.afterStart);
  check("missing named export never falls back to default", unnamed.after.defaultHook, unnamed.before.defaultHook);

  await rm(join(directory, "prepare.ts"));
  const noHook = await run(["recover", "local", "--service", "db", "--reconcile-consumer"]);
  checkTrue("missing requested hook refuses", noHook.error instanceof Error);
  checkHooksUnchanged("missing hook has no module evaluation or hook effects", noHook);
  check("missing hook does not observe dependencies", noHook.after.readiness, noHook.before.readiness);
} finally {
  clearRecipesDir();
  useComposeProjectOverride(previousComposeOverride);
  if (previousDeployment === undefined) clearDeployment();
  else useDeployment(previousDeployment);
  delete global.__recoverObservations;
  delete global.__recoverCheckHookLock;
  await rm(root, { recursive: true, force: true });
}
finish("recipe recover command behavior");
