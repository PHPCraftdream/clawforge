// The alert webhook: a URL in the deployment's own `.env` (`OC_WATCH_WEBHOOK`), treated as
// a secret from the moment it is read — registered with core/log.ts's masking (see
// core/context.ts, beside OPENCLAW_GATEWAY_TOKEN) so any error message it ever ends up in
// is scrubbed the same way a leaked gateway token is. Nothing in this file ever hands the
// raw value to log()/info()/emit(): those are not masked (only reportError() is), so the
// only safe rule is to never construct a string with it in the first place.

import { deploymentName } from "../runtime/deployment.ts";
import type { Context } from "../core/context.ts";
import type { WatchLevel, WatchReason } from "./state.ts";

export const WATCH_WEBHOOK_ENV = "OC_WATCH_WEBHOOK";

const REQUEST_TIMEOUT_MS = 10_000;

/** `.env`'s raw value, or undefined when unset/blank — alerting is optional. */
export function watchWebhookRaw(ctx: Context): string | undefined {
  const raw = ctx.settings.env[WATCH_WEBHOOK_ENV];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isLocalhostHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** https, or plain http only against localhost/127.0.0.1/::1 — a webhook is an outbound
 *  credential-bearing request, and this mirrors the framework's whole posture on the
 *  inbound side (OC_BIND_ADDRESS defaults to loopback; expose/tailscale.ts refuses a public
 *  port outright). The message never repeats the value — only that the variable is
 *  invalid — so a caller who mistypes the scheme does not have it echoed back at them
 *  anywhere logs might land.
 *
 *  Throws rather than dying directly: the caller (check.ts) decides how the refusal is
 *  reported, the same split every other pure validator in this codebase keeps. */
export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${WATCH_WEBHOOK_ENV} is not a valid URL`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLocalhostHostname(url.hostname)) return url;
  throw new Error(`${WATCH_WEBHOOK_ENV} must be https, or http only against localhost/127.0.0.1`);
}

export interface WatchTransitionPayload {
  readonly deployment: string;
  readonly from: WatchLevel;
  readonly to: WatchLevel;
  readonly reasons: readonly WatchReason[];
  readonly at: string;
}

export function transitionPayload(from: WatchLevel, to: WatchLevel, reasons: readonly WatchReason[], at: string): WatchTransitionPayload {
  return { deployment: deploymentName(), from, to, reasons, at };
}

/** Posts the transition. Throws on anything short of a 2xx answer — a timeout, a refused
 *  connection, a non-2xx status — so the caller can tell "delivered" from "not", which is
 *  what decides whether the new state is allowed to replace the old one. */
export async function postWebhookAlert(url: URL, payload: WatchTransitionPayload): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // fetch's own TypeError names the failure ("fetch failed") but not the URL, and the
    // value is registered with core/log.ts regardless — belt and suspenders, since a
    // future Node/undici version repeating the target in a rejection message must still
    // come out masked wherever this error is eventually reported.
    throw new Error(`webhook request failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(`webhook responded with ${response.status}`);
  }
}
