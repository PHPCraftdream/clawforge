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

import type { Context } from "#src/core/context.ts";
import { frameworkSourceRoot, resolveDeployArguments } from "./arguments.ts";
import { assertDeployable } from "./refusals.ts";
import { checkServerReady, prepareRemoteRoot } from "./server.ts";
import { syncTrees, bootstrapAndReport } from "./sync.ts";

export { DEPLOY_ARGUMENTS, frameworkSourceRoot, remoteRecipesPath } from "./arguments.ts";
export { runRemote } from "./server.ts";
export {
  collectSensitiveCheckoutNames,
  rootProbeScript,
  parseRootProbe,
  markerWriteScript,
  markerVerifyScript,
} from "#src/security/privacy/deploy-boundary.ts";

export async function deploy(ctx: Context, args: string[]): Promise<void> {
  // Before the arguments: no set of them makes this command work in the wrong mode, and a
  // usage error would send the reader off to fix the wrong thing.
  const sourceRoot = await frameworkSourceRoot();

  const plan = resolveDeployArguments(ctx, args);

  await assertDeployable(sourceRoot);

  await checkServerReady(ctx, plan.target);

  const root = await prepareRemoteRoot(ctx, plan.target, plan.remotePath, plan.name, plan.adopt);

  await syncTrees(ctx, plan.target, sourceRoot, plan.remotePath, plan.remoteApp, plan.remoteRecipes, plan.name, root);

  await bootstrapAndReport(ctx, plan.target, plan.remotePath, plan.name, plan.runBootstrap, plan.remotePathNote);
}
