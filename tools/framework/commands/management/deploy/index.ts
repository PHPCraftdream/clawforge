// `./clawforge deploy user@host` — puts this repository on a server and brings the instance up.
//
// Two deliveries, not one: the framework (code, mirrored with deletions) and the deployment
// (configuration, only its non-secret parts). rsync and ssh run on the target side (inside
// WSL when the tooling is on Windows), because that is where the SSH keys and the tools live.
//
// Phases, in order: resolve arguments (arguments.ts) → refuse if any tree carries private
// bytes (refusals.ts) → prove the target is reachable and equipped (server.ts) → prove the
// remote root is safe for --delete (server.ts) → mirror both trees (sync.ts) → bootstrap or
// report (sync.ts). Each phase mutates nothing the phase before it didn't already allow.
//
// npm distribution: this command is monorepo-specific — it mirrors the whole checkout
// (tools/ included) over rsync, which only makes sense when there is a whole checkout to
// mirror. It deliberately keeps using `monorepoRoot` (env.ts), not `frameworkRoot`: deploying
// an npm-distributed app to a server is a different, not-yet-built command. See
// frameworkSourceRoot below — installed as a package, monorepoRoot would resolve to whatever
// directory happens to sit two levels above the package, and mirroring that with --delete
// would put an unrelated tree on the server.

import { log, info } from "#src/core/io/log.ts";
import { emit, withOutputSink } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import type { DeployPlan } from "./arguments.ts";
import { frameworkSourceRoot, resolveDeployArguments } from "./arguments.ts";
import { assertDeployable } from "./refusals.ts";
import { checkServerReady, prepareRemoteRoot } from "./server.ts";
import { syncTrees, bootstrapAndReport } from "./sync.ts";

export { DEPLOY_ARGUMENTS, frameworkSourceRoot, remoteRecipesPath, isDeployDryRun } from "./arguments.ts";
export { runRemote } from "./server.ts";
export {
  collectSensitiveCheckoutNames,
  rootProbeScript,
  parseRootProbe,
  markerWriteScript,
  markerVerifyScript,
} from "#src/security/privacy/deploy-boundary.ts";

/** `--dry-run`: the local refusal check (assertDeployable) plus the same reachability/tool
 *  check a real deploy runs BEFORE its first mutation (checkServerReady) — nothing past that
 *  point runs, since preparing the remote root is itself a write (mkdir, and a marker file
 *  for a first-time root). Does not cover: whether the remote root is safe for --delete
 *  (only prepareRemoteRoot proves that, by writing its marker) or the exact file-level diff
 *  rsync would produce there. */
async function deployDryRun(ctx: Context, sourceRoot: string, plan: DeployPlan): Promise<void> {
  await checkServerReady(ctx, plan.target);

  const report = {
    ok: true,
    changed: false,
    dryRun: true,
    target: plan.target,
    remotePath: plan.remotePath,
    remoteApp: plan.remoteApp,
    remoteRecipes: plan.remoteRecipes,
    wouldRunBootstrap: plan.runBootstrap,
    wouldSync: [
      "framework (full mirror, --delete, credentials excluded)",
      `${plan.name} deployment (declaration, desired state, recipes) -> ${plan.remoteApp}`,
    ],
    refusals: [] as string[],
  };

  if (plan.jsonOnly) {
    emit(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  log(`deploy --dry-run: would mirror the framework and the "${plan.name}" deployment to ${plan.target}:${plan.remotePath}`);
  info("connection and remote dependencies: checked, OK");
  info("framework mirror: --delete, credentials excluded (.env, apps/, data/, snapshots/, secrets/)");
  info(`deployment mirror: declaration, desired state, recipes -> ${plan.remoteApp}`);
  info(plan.runBootstrap
    ? `would bootstrap remotely afterwards: cd ${plan.remotePath} && ./clawforge --app ${plan.name} bootstrap`
    : "bootstrap skipped (--no-bootstrap)");
  if (plan.remotePathNote !== undefined) info(plan.remotePathNote);
  info(
    "does not cover: whether the remote root is safe for --delete (proving that writes a marker there) " +
      "or the exact file-level diff rsync would produce — both only happen during a real deploy",
  );
}

export async function deploy(ctx: Context, args: string[]): Promise<void> {
  // Before the arguments: no set of them makes this command work in the wrong mode, and a
  // usage error would send the reader off to fix the wrong thing.
  const sourceRoot = await frameworkSourceRoot();

  const plan = resolveDeployArguments(ctx, args);

  await assertDeployable(sourceRoot);

  if (plan.dryRun) return deployDryRun(ctx, sourceRoot, plan);

  if (plan.jsonOnly) {
    let caught: unknown;
    await withOutputSink(() => {}, async () => {
      try {
        await runDeploy(ctx, sourceRoot, plan);
      } catch (error) {
        caught = error;
      }
    });
    if (caught !== undefined) {
      const message = caught instanceof Error ? caught.message : String(caught);
      emit(`${JSON.stringify({ ok: false, changed: true, target: plan.target, remotePath: plan.remotePath, problems: [message] }, null, 2)}\n`);
      throw caught;
    }
    emit(
      `${JSON.stringify(
        { ok: true, changed: true, target: plan.target, remotePath: plan.remotePath, remoteApp: plan.remoteApp, bootstrapped: plan.runBootstrap },
        null,
        2,
      )}\n`,
    );
    return;
  }

  await runDeploy(ctx, sourceRoot, plan);
}

async function runDeploy(ctx: Context, sourceRoot: string, plan: DeployPlan): Promise<void> {
  await checkServerReady(ctx, plan.target);

  const root = await prepareRemoteRoot(ctx, plan.target, plan.remotePath, plan.name, plan.adopt);

  await syncTrees(ctx, plan.target, sourceRoot, plan.remotePath, plan.remoteApp, plan.remoteRecipes, plan.name, root);

  await bootstrapAndReport(ctx, plan.target, plan.remotePath, plan.name, plan.runBootstrap, plan.remotePathNote);
}
