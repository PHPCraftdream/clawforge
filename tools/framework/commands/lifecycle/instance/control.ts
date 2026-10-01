// Everyday lifecycle commands: up, restart, down.
//
// Nothing here mentions Docker: the runtime and the
// transport in the context decide how the instance is actually started.

import { log, info, die } from "#src/core/io/log.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import type { Context } from "#src/core/context.ts";
import { preflightSecrets } from "#src/commands/management/secrets.ts";
import { guarded } from "#src/runtime/lock/instance-lock.ts";
import { preflightPort } from "#src/commands/lifecycle/bootstrap/prereqs.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/command/index.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";

/** Drives up's, restart's and down's own parsers and their openclawCommands declarations —
 *  the only arguments any of the three accept. */
export const LOCK_ARGUMENTS: CommandArgument[] = [BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT];

/** Starts the gateway and waits until it actually serves, not just until the container
 *  exists — a container that is "up" while crash-looping is the failure mode we hit. */
export async function up(ctx: Context, args: string[]): Promise<void> {
  // Dies before the lock is ever taken: a bogus flag must not leave a half-started mutation.
  parseDeclaredArgs(LOCK_ARGUMENTS, args);
  await requireBootstrapped(ctx);
  return guarded(ctx, "up", args, () => startInstance(ctx));
}

async function startInstance(ctx: Context): Promise<void> {
  // Checked before starting: a missing referenced variable makes the gateway fail with
  // SecretRefResolutionError and restart in a loop, with the reason only in its log.
  await preflightSecrets(ctx);
  await preflightPort(ctx);
  await ctx.runtime.start();
  log(`waiting for the gateway at ${ctx.settings.serviceUrl}`);
  await ctx.runtime.waitForHealth();
  log("gateway is healthy");
  info(ctx.settings.serviceUrl);
}

/** Restarts the instance so it re-reads configuration loaded only at startup.
 *
 *  `up` cannot do this: it converges on "running", and an already-healthy instance is already
 *  converged — a bind-mount edit changes nothing the runtime compares. Mirror image: restart
 *  re-reads files but keeps the container's own environment, interpolated from .env at
 *  creation — an edited .env needs Runtime.reconcile() (secrets --apply / `up`), not restart.
 *
 *  Secrets are checked first, same as `up`, since an unresolvable variable would crash-loop
 *  the restart. The port is not checked — the container keeps its existing binding. */
export async function restart(ctx: Context, args: string[]): Promise<void> {
  parseDeclaredArgs(LOCK_ARGUMENTS, args);
  await requireBootstrapped(ctx);
  return guarded(ctx, "restart", args, () => restartInstance(ctx));
}

async function restartInstance(ctx: Context): Promise<void> {
  if (!(await ctx.runtime.isRunning())) {
    die("the gateway is not running — start it with ./clawforge up");
  }
  await preflightSecrets(ctx);
  log("restarting the gateway");
  await ctx.runtime.restart();
  log(`waiting for the gateway at ${ctx.settings.serviceUrl}`);
  await ctx.runtime.waitForHealth();
  log("gateway is healthy");
}

/** Stops and removes the containers. Data survives: it lives in host bind mounts, not in
 *  runtime-managed volumes. No compose passthrough: only the lock-takeover flags reach
 *  here, so nothing typed after `down` (e.g. --rmi all, -v) can widen what it does. */
export async function down(ctx: Context, args: string[]): Promise<void> {
  parseDeclaredArgs(LOCK_ARGUMENTS, args);
  await requireBootstrapped(ctx);
  return guarded(ctx, "down", args, async () => {
    await ctx.runtime.stop();
    log(`stopped; data kept in ${ctx.settings.dataDir}`);
  });
}
