// `./clawforge expose status` — and the one-line summary `./clawforge status` folds in.
//
// Prefers the PUBLISHED bind address/port read back from the running container
// (runningConnectionFacts(), extended in runtime.ts/runtime-docker.ts to also carry
// bindAddress off the same 18789/tcp entry port already reads) over the configured .env
// value, because .env can be stale the moment OC_BIND_ADDRESS is edited without a container
// recreate — the same class of drift recover-env/facts.ts already exists to catch for the
// other three connection facts (port, data dir, compose project, image). A caller asking "is
// this really loopback-only right now" must not be told so on the strength of a stale file.

import { log, info, warn } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { probeTailscale } from "./tailscale.ts";

export interface ExposureSummary {
  readonly bindAddress: string;
  readonly port: string;
  /** False when the container is not running (or this runtime cannot introspect it) and the
   *  fields above fall back to the configured .env values instead. */
  readonly running: boolean;
  readonly loopback: boolean;
  /** 0.0.0.0 or :: — every interface on the host, not just loopback. */
  readonly wildcard: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const WILDCARD = new Set(["0.0.0.0", "::"]);

/** `facts` is `runningConnectionFacts()`'s answer (or undefined when not running); the
 *  configured .env values are the fallback, never a guess about what is actually published. */
export function summarizeExposure(
  ctx: Context,
  facts: { bindAddress?: string; port?: string } | undefined,
): ExposureSummary {
  const bindAddress = facts?.bindAddress ?? ctx.settings.bindAddress;
  const port = facts?.port ?? ctx.settings.gatewayPort;
  return {
    bindAddress,
    port,
    running: facts !== undefined,
    loopback: LOOPBACK.has(bindAddress),
    wildcard: WILDCARD.has(bindAddress),
  };
}

/** `runningConnectionFacts()` behind one try/catch: not running and "this runtime could not
 *  introspect it" both read as `undefined` here, since every caller treats them the same —
 *  nothing to check right now either way. */
export async function safeConnectionFacts(
  ctx: Context,
): Promise<{ bindAddress?: string; port?: string } | undefined> {
  try {
    return await ctx.runtime.runningConnectionFacts?.();
  } catch {
    return undefined;
  }
}

/** The one line `./clawforge status` folds this command's whole answer into. */
export function exposureOneLiner(summary: ExposureSummary): string {
  const scope = summary.wildcard
    ? "PUBLIC INTERFACE — see ./clawforge expose status"
    : summary.loopback
      ? "loopback-only"
      : "non-loopback";
  const confirmed = summary.running ? "" : " (not running — configured .env, unconfirmed)";
  return `${summary.bindAddress}:${summary.port} (${scope})${confirmed}`;
}

export async function exposeStatus(ctx: Context, _args: string[]): Promise<void> {
  const facts = await ctx.runtime.runningConnectionFacts?.();
  const summary = summarizeExposure(ctx, facts);

  log("gateway exposure");
  info(`published        ${summary.bindAddress}:${summary.port}${summary.running ? "" : " (container not running — configured .env values, unconfirmed)"}`);
  info(`loopback-only    ${summary.loopback ? "yes" : "no"}`);
  if (summary.running && facts?.bindAddress !== undefined && facts.bindAddress !== ctx.settings.bindAddress) {
    info(
      `note: the running container differs from configured OC_BIND_ADDRESS=${ctx.settings.bindAddress} — ` +
        "restart to apply the .env value, or ./clawforge recover-env --adopt-runtime to adopt the running one.",
    );
  }
  if (summary.wildcard) {
    warn(`the gateway is published on ${summary.bindAddress} — reachable from every interface on this host, not loopback-only.`);
    warn(
      "put a reverse proxy with TLS and authentication in front of it (see .env.example), or set " +
        "OC_BIND_ADDRESS back to 127.0.0.1 and use ./clawforge expose ssh or ./clawforge expose tailscale instead.",
    );
  } else if (!summary.loopback) {
    warn(`the gateway is published on ${summary.bindAddress}, not a recognized loopback address — confirm this is intentional.`);
  }

  log("tailscale");
  const probe = await probeTailscale(ctx);
  info(probe.detail);
  if (!probe.present) return;

  const serveStatus = await ctx.transport.exec("tailscale", ["serve", "status"], { allowFailure: true });
  if (serveStatus.code !== 0) {
    info(`tailscale serve status could not be read (exit ${serveStatus.code})`);
    return;
  }
  const text = serveStatus.stdout.trim();
  if (text === "") info("no tailscale serve configuration");
  else for (const line of text.split("\n")) info(line);
}
