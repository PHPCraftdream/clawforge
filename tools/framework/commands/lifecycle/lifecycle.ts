// Everyday lifecycle commands: up, down, logs.
//
// Nothing here mentions Docker: the runtime and the
// transport in the context decide how the instance is actually started.

import { log, info, warn, die } from "#src/core/log.ts";
import { shouldFollow, emit } from "#src/core/output.ts";
import type { Context } from "#src/core/context.ts";
import { preflightSecrets } from "../management/secrets.ts";
import { guarded } from "#src/runtime/instance-lock.ts";

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `address:port` (or a wildcard bind covering it) already appears in a `ss`/`netstat`
 *  listening-socket listing. Matched loosely against just the local-address column, ending
 *  in ":<port>" — both tools' exact layout and spacing vary by version. */
function listeningLine(output: string, address: string, port: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)(?:\\*|0\\.0\\.0\\.0|::|\\[::\\]|${regexEscape(address)}):${port}(?:\\s|$)`);
  return output.split("\n").find((line) => pattern.test(line))?.trim();
}

/** `ss -ltnH` (falling back to `netstat -ltn` where `ss` is not installed) against the
 *  target. Docker's own publish list (portConflict, below) only sees what IT bound, so a
 *  bare process already holding the address:port fails compose deep inside `up` with
 *  nothing but a bind error naming the port — same failure a second deployment's container
 *  causes, from a listener this framework never considered. Absence of both tools is
 *  reported as "unavailable", never silently read as "free": a target this can never check
 *  must say so, not proceed as if it had. */
async function listeningPortHolder(ctx: Context, address: string, port: string): Promise<string | "unavailable" | undefined> {
  for (const [command, args] of [
    ["ss", ["-ltnH"]],
    ["netstat", ["-ltn"]],
  ] satisfies [string, string[]][]) {
    let result: { code: number; stdout: string } | undefined;
    try {
      result = await ctx.transport.exec(command, args, { allowFailure: true });
    } catch {
      // The tool itself could not even be launched (e.g. a local transport with no such
      // binary on PATH) — same as a nonzero exit below: try the next one.
      result = undefined;
    }
    if (result === undefined || result.code !== 0) continue;
    return listeningLine(result.stdout, address, port);
  }
  return "unavailable";
}

/** Strips the instance-lock takeover flags this command reads itself (guarded()) before
 *  anything is forwarded on — down passes its own leftover args straight to compose, and
 *  neither --break-lock nor --break-foreign-lock <hostId> (flag plus its value) are
 *  docker-compose arguments. */
function stripLockFlags(args: string[]): string[] {
  return args.filter((arg, index) => arg !== "--break-lock" && arg !== "--break-foreign-lock" && args[index - 1] !== "--break-foreign-lock");
}

/** Another deployment on the same port fails deep inside compose with a bind error naming
 *  only the port. Said plainly here, before anything is started. */
export async function preflightPort(ctx: Context): Promise<void> {
  const holder = await ctx.runtime.portConflict(ctx.settings.gatewayPort);
  if (holder !== undefined) {
    die(
      `port ${ctx.settings.gatewayPort} is already published by ${holder} — ` +
        "give this deployment its own OPENCLAW_GATEWAY_PORT in .env",
    );
  }

  // Docker's own publish list is the only thing the check above sees. If this deployment's
  // OWN gateway is already running, it legitimately holds the address:port already — an
  // ordinary bootstrap re-run, not a conflict — so the raw listening-socket probe below is
  // skipped rather than refusing an instance against itself.
  if (await ctx.runtime.isRunning()) return;

  const { bindAddress, gatewayPort } = ctx.settings;
  const listener = await listeningPortHolder(ctx, bindAddress, gatewayPort);
  if (listener === "unavailable") {
    warn(
      `could not check whether ${bindAddress}:${gatewayPort} is already listening — neither ss nor netstat ` +
        "answered on the target. Proceeding without that check: if compose then fails to bind, something else " +
        "already holds this port.",
    );
    return;
  }
  if (listener !== undefined) {
    die(
      `${bindAddress}:${gatewayPort} is already listening (${listener}) — not through Docker, so the check ` +
        "above never saw it. Give this deployment its own OPENCLAW_GATEWAY_PORT in .env, or stop whatever is " +
        "using this one.\n" +
        "This check and the later bind are not atomic — something else could still take the port in between.",
    );
  }
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
 *  The mirror-image limit: a restart re-reads files inside the container but keeps the
 *  container itself, environment included — those were interpolated from .env when compose
 *  created it. What restart is to an edited bind mount, Runtime.reconcile() (secrets --apply
 *  performs it, `up` is its manual form) is to an edited .env.
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
    await ctx.runtime.stop(stripLockFlags(args));
    log(`stopped; data kept in ${ctx.settings.dataDir}`);
  });
}

/** One capability, two shapes. On a terminal this follows the log until interrupted, which
 *  is what someone watching a start-up wants. Anywhere else — an MCP tool call, a script, an
 *  agent's shell tool, a redirect — following would never return, so the same command reads
 *  a bounded tail instead and hands it back. See shouldFollow() for why that is not simply
 *  "not captured".
 *
 *  The switch is on how the output is being consumed rather than on a separate command
 *  name: it is one capability, and the mirror is meant to expose it, not a second spelling
 *  of it. recipe.ts's logs action makes the same choice the same way. */
export async function logs(ctx: Context, args: string[]): Promise<void> {
  const { tail, rest } = takeTail(args);

  if (shouldFollow()) {
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
