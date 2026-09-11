// Everyday lifecycle commands: up, down, logs.
//
// Nothing here mentions Docker: the runtime and the
// transport in the context decide how the instance is actually started.

import { log, info, die } from "../../core/log.ts";
import { isCaptured, emit } from "../../core/output.ts";
import type { Context } from "../../core/context.ts";
import { preflightSecrets } from "../management/secrets.ts";
import { guarded } from "../../runtime/instance-lock.ts";

/** Another deployment on the same port fails deep inside compose with a bind error naming
 *  only the port. Said plainly here, before anything is started. */
export async function preflightPort(ctx: Context): Promise<void> {
  const holder = await ctx.runtime.portConflict(ctx.settings.gatewayPort);
  if (holder === undefined) return;
  die(
    `port ${ctx.settings.gatewayPort} is already published by ${holder} — ` +
      "give this deployment its own OPENCLAW_GATEWAY_PORT in .env",
  );
}

/** Starts the gateway and waits until it actually serves, not just until the container
 *  exists — a container that is "up" while crash-looping is the failure mode we hit. */
export async function up(ctx: Context, args: string[]): Promise<void> {
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
 *  `up` cannot do this: it asks the runtime to converge on "running", and an instance that
 *  is already running and healthy is already converged — an edit to openclaw.json inside a
 *  bind mount changes nothing the runtime compares. That is why applying a desired state
 *  and then running `up` leaves the old settings live.
 *
 *  Secrets are checked first, same as `up`: a config that now references a variable nothing
 *  supplies would otherwise turn a restart into a crash loop. The port is not checked —
 *  the container keeps the binding it already holds. */
export async function restart(ctx: Context, args: string[]): Promise<void> {
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
 *  runtime-managed volumes. */
export async function down(ctx: Context, args: string[]): Promise<void> {
  return guarded(ctx, "down", args, async () => {
    await ctx.runtime.stop(args.filter((arg) => arg !== "--break-lock"));
    log(`stopped; data kept in ${ctx.settings.dataDir}`);
  });
}

/** One capability, two shapes. On a terminal this follows the log until interrupted, which
 *  is what someone watching a start-up wants. Under an output sink — an MCP tool call, which
 *  owes its client exactly one result — following would never return, so the same command
 *  reads a bounded tail instead and hands it back.
 *
 *  The switch is on how the output is being consumed rather than on a separate command
 *  name: it is one capability, and the mirror is meant to expose it, not a second spelling
 *  of it. recipe.ts's logs action makes the same choice the same way. */
export async function logs(ctx: Context, args: string[]): Promise<void> {
  const { tail, rest } = takeTail(args);

  if (!isCaptured()) {
    await ctx.runtime.followLogs(rest);
    return;
  }

  emit(await ctx.runtime.readLogs(tail, rest));
}

/** Pulls `--tail <n>` out of the arguments, leaving the rest for the runtime. Declared as an
 *  option in commands/index.ts, so this is the parser side of that declaration. */
export function takeTail(args: string[]): { tail?: string; rest: string[] } {
  const at = args.indexOf("--tail");
  if (at === -1) return { rest: args };

  const value = args[at + 1];
  if (value === undefined || value.startsWith("-")) die("--tail needs a number of lines");
  if (!/^\d+$/.test(value)) die(`--tail takes a number of lines, not "${value}"`);

  return { tail: value, rest: [...args.slice(0, at), ...args.slice(at + 2)] };
}
