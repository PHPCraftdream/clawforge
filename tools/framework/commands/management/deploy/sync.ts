// The two deliveries. The framework is code and is mirrored, deletions included. The
// deployment is configuration, and only the parts that are not secret travel: the
// declaration, the desired state and the recipes. Its .env, its secret stores and its
// snapshots stay here — the server generates its own token, so a leaked local one cannot
// unlock it.

import { log, info, die } from "#src/core/io/log.ts";
import { deploymentDir, recipesDir } from "#src/runtime/deployment.ts";
import { EXCLUDES, MARKER_FILE, markerVerifyScript, quoted } from "#src/security/privacy/deploy-boundary.ts";
import type { Context } from "#src/core/context.ts";
import { runRemote } from "./server.ts";
import type { RemoteRoot } from "./server.ts";

/** Mirrors the framework checkout, then the deployment's own files (app.ts, config/,
 *  recipes/) onto the prepared remote root. Same order as the marker protocol expects: the
 *  destructive framework mirror runs first, and its marker survival is verified before the
 *  smaller deployment sync starts. */
export async function syncTrees(
  ctx: Context,
  target: string,
  sourceRoot: string,
  remotePath: string,
  remoteApp: string,
  remoteRecipes: string,
  name: string,
  root: RemoteRoot,
): Promise<void> {
  const source = await ctx.paths.toTarget(sourceRoot);
  log(`syncing the framework to ${target}:${remotePath}`);
  await ctx.transport.exec(
    "rsync",
    [
      "-az",
      // Deletions are mirrored, but only within what is actually sent: excluded paths on
      // the server — its .env, its data, other deployments — are left alone.
      "--delete",
      // This generated remote file is absent from the source tree; protect only its root path.
      "--exclude",
      `/${MARKER_FILE}`,
      ...EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
      `${source}/`,
      `${target}:${remotePath}/`,
    ],
    { stream: true },
  );

  if (root.createdMarkerLine !== undefined) {
    const verified = await runRemote(
      ctx,
      target,
      markerVerifyScript(root.markerPath, root.expectedMarker, root.createdMarkerLine),
      { allowFailure: true },
    );
    if (verified.code !== 0) {
      die(`the deploy root marker did not survive the framework sync at ${remotePath} on ${target}`);
    }
  }

  // The deployment, by name and file. Anything not listed here does not travel.
  const local = await ctx.paths.toTarget(deploymentDir());
  log(`syncing the ${name} deployment (declaration, desired state, recipes)`);
  // No secrets directory: the server creates its own when keys are installed there.
  await runRemote(ctx, target, `mkdir -p ${quoted(`${remoteApp}/config`)} ${quoted(remoteRecipes)}`);
  await ctx.transport.exec("rsync", ["-az", `${local}/app.ts`, `${target}:${remoteApp}/`]);

  // Same exclusions as the framework sync, so what --delete may touch stays symmetric with
  // what was actually sent — a recipe's own .env or a stray secret store under config/ must
  // not be erased just because it wasn't mirrored.
  const deploymentExcludes = EXCLUDES.flatMap((pattern) => ["--exclude", pattern]);
  const localRecipes = await ctx.paths.toTarget(recipesDir());
  await ctx.transport.exec("rsync", [
    "-az",
    "--delete",
    ...deploymentExcludes,
    `${local}/config/`,
    `${target}:${remoteApp}/config/`,
  ]);
  await ctx.transport.exec("rsync", [
    "-az",
    "--delete",
    ...deploymentExcludes,
    `${localRecipes}/`,
    `${target}:${remoteRecipes}/`,
  ]);

  // rsync from a Windows-mounted filesystem loses the executable bit.
  await runRemote(ctx, target, `chmod +x ${quoted(`${remotePath}/clawforge`)}`);
}

/** Either leaves the files synced with a hint for a manual bootstrap, or bootstraps the
 *  remote instance and prints how to reach it. */
export async function bootstrapAndReport(
  ctx: Context,
  target: string,
  remotePath: string,
  name: string,
  runBootstrap: boolean,
  remotePathNote: string | undefined,
): Promise<void> {
  if (!runBootstrap) {
    log(`files synced to ${target}:${remotePath} (bootstrap skipped)`);
    info(`bring it up there with: cd ${remotePath} && ./clawforge --app ${name} bootstrap`);
    if (remotePathNote !== undefined) info(remotePathNote);
    return;
  }

  log(`bootstrapping ${name} on ${target}`);
  // The deployment is named: the server's default would otherwise be a different one.
  // -t only when we have a terminal to give it.
  await runRemote(ctx, target, `cd ${quoted(remotePath)} && ./clawforge --app ${quoted(name)} bootstrap`, {
    stream: true,
    tty: process.stdout.isTTY === true,
  });

  log("deployed");
  info("the gateway listens on the remote loopback only. Open a tunnel from here:");
  info(`  ssh -N -L ${ctx.settings.gatewayPort}:127.0.0.1:${ctx.settings.gatewayPort} ${target}`);
  info(`provider keys are not copied — install them there: ./clawforge --app ${name} secrets --apply`);
  if (remotePathNote !== undefined) info(remotePathNote);
}
