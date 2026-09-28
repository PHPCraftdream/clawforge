// The alert webhook: a URL in the deployment's own `.env` (`OC_WATCH_WEBHOOK`), treated as
// a secret from the moment it is read — registered with core/io/log.ts's masking (see
// core/context.ts, beside OPENCLAW_GATEWAY_TOKEN) so any error message it ever ends up in
// is scrubbed the same way a leaked gateway token is. Nothing in this file ever hands the
// raw value to log()/info()/emit(): those are not masked (only reportError() is), so the
// only safe rule is to never construct a string with it in the first place.
//
// Also owns the heartbeat "dead-man's switch" (`OC_WATCH_HEARTBEAT_URL`): a GET on every
// cycle that reads `ok`, so an external service (healthchecks.io, Uptime Kuma push, Better
// Stack heartbeat — all three accept a plain GET, verified against each one's own docs)
// alerts on its own the moment the whole instance — or this tooling's own scheduler — stops
// running, something a webhook fired FROM here can never report.

import { deploymentName } from "../../../runtime/deployment.ts";
import type { Context } from "../../../core/context.ts";
import type { WatchLevel, WatchReason } from "./state.ts";

export const WATCH_WEBHOOK_ENV = "OC_WATCH_WEBHOOK";
export const WATCH_WEBHOOK_FORMAT_ENV = "OC_WATCH_WEBHOOK_FORMAT";
export const WATCH_TELEGRAM_CHAT_ID_ENV = "OC_WATCH_TELEGRAM_CHAT_ID";
export const WATCH_HEARTBEAT_URL_ENV = "OC_WATCH_HEARTBEAT_URL";

const REQUEST_TIMEOUT_MS = 10_000;

function rawEnvValue(ctx: Context, envName: string): string | undefined {
  const raw = ctx.settings.env[envName];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** `.env`'s raw value, or undefined when unset/blank — alerting is optional. */
export function watchWebhookRaw(ctx: Context): string | undefined {
  return rawEnvValue(ctx, WATCH_WEBHOOK_ENV);
}

/** Same optionality as the webhook: unset/blank means no dead-man's switch is wired up. */
export function watchHeartbeatUrlRaw(ctx: Context): string | undefined {
  return rawEnvValue(ctx, WATCH_HEARTBEAT_URL_ENV);
}

function isLocalhostHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** https, or plain http only against localhost/127.0.0.1/::1 — a webhook or heartbeat URL is
 *  an outbound credential-bearing request, and this mirrors the framework's whole posture on
 *  the inbound side (OC_BIND_ADDRESS defaults to loopback; expose/tailscale.ts refuses a
 *  public port outright). The message never repeats the value — only that the variable is
 *  invalid — so a caller who mistypes the scheme does not have it echoed back at them
 *  anywhere logs might land. Shared by both URLs so they can never quietly diverge. */
function parseSecretUrl(envName: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${envName} is not a valid URL`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLocalhostHostname(url.hostname)) return url;
  throw new Error(`${envName} must be https, or http only against localhost/127.0.0.1`);
}

/** Throws rather than dying directly: the caller (check.ts) decides how the refusal is
 *  reported, the same split every other pure validator in this codebase keeps. */
export function parseWebhookUrl(raw: string): URL {
  return parseSecretUrl(WATCH_WEBHOOK_ENV, raw);
}

export function parseHeartbeatUrl(raw: string): URL {
  return parseSecretUrl(WATCH_HEARTBEAT_URL_ENV, raw);
}

export type WatchWebhookFormat = "generic" | "slack" | "discord" | "telegram";

const WEBHOOK_FORMATS: ReadonlySet<string> = new Set<WatchWebhookFormat>(["generic", "slack", "discord", "telegram"]);

/** Each vendor's own incoming-webhook host, verified against their docs (docs/guide/monitoring-and-access.md links them):
 *  Slack's are always hooks.slack.com; Discord's live at discord.com or the legacy
 *  discordapp.com under /api/webhooks/; Telegram's Bot API is always api.telegram.org.
 *  Anything else stays "generic" — the original {deployment, from, to, reasons, at} JSON. */
function detectWebhookFormat(url: URL): WatchWebhookFormat {
  if (url.hostname === "hooks.slack.com") return "slack";
  if ((url.hostname === "discord.com" || url.hostname === "discordapp.com") && url.pathname.startsWith("/api/webhooks/")) return "discord";
  if (url.hostname === "api.telegram.org") return "telegram";
  return "generic";
}

export interface WatchWebhookTarget {
  readonly url: URL;
  readonly format: WatchWebhookFormat;
  /** Only present (and only meaningful) for format "telegram" — sendMessage's own required
   *  destination parameter, kept apart from the URL because the URL already carries the bot
   *  token (`api.telegram.org/bot<token>/sendMessage`). */
  readonly telegramChatId?: string;
}

/** Resolves OC_WATCH_WEBHOOK's target shape before any probe cycle runs: an unrecognized
 *  OC_WATCH_WEBHOOK_FORMAT value, or format=telegram with no OC_WATCH_TELEGRAM_CHAT_ID, is a
 *  configuration error surfaced the same way an invalid URL already is — not one first
 *  discovered when a real transition tries (and fails) to deliver. */
export function resolveWebhookTarget(ctx: Context, url: URL): WatchWebhookTarget {
  const rawFormat = ctx.settings.env[WATCH_WEBHOOK_FORMAT_ENV]?.trim();
  let format: WatchWebhookFormat;
  if (rawFormat === undefined || rawFormat === "") {
    format = detectWebhookFormat(url);
  } else if (WEBHOOK_FORMATS.has(rawFormat)) {
    format = rawFormat as WatchWebhookFormat;
  } else {
    throw new Error(`${WATCH_WEBHOOK_FORMAT_ENV} must be generic, slack, discord or telegram`);
  }

  if (format !== "telegram") return { url, format };

  const chatId = rawEnvValue(ctx, WATCH_TELEGRAM_CHAT_ID_ENV);
  if (chatId === undefined) {
    throw new Error(`${WATCH_TELEGRAM_CHAT_ID_ENV} is required when the webhook format is telegram`);
  }
  return { url, format, telegramChatId: chatId };
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

// Each chat format's own documented text limit: Slack's hard per-message cap (40,000
// chars), Discord's `content` field (2,000), Telegram's `text` field (4,096, after entity
// parsing) — sources in docs/guide/monitoring-and-access.md's Health monitoring section.
const FORMAT_TEXT_LIMIT: Record<"slack" | "discord" | "telegram", number> = {
  slack: 40_000,
  discord: 2_000,
  telegram: 4_096,
};

// Per-reason cap, so one long detail cannot crowd out every other reason before the whole
// message even reaches its format's own limit.
const REASON_DETAIL_MAX = 80;

function reasonsLine(reasons: readonly WatchReason[]): string {
  if (reasons.length === 0) return "no reason recorded";
  return reasons
    .map((entry) => {
      const detail = entry.detail.length > REASON_DETAIL_MAX ? `${entry.detail.slice(0, REASON_DETAIL_MAX)}…` : entry.detail;
      return detail === "" ? entry.code : `${entry.code}: ${detail}`;
    })
    .join("; ");
}

function capToLimit(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** One-two lines for the chat formats: deployment + transition, then reason codes (with a
 *  short detail each) and when. Generic keeps the original structured JSON instead — this is
 *  only for a format a human reads in a chat client. */
function transitionText(payload: WatchTransitionPayload): string {
  return `${payload.deployment}: ${payload.from} → ${payload.to}\n${reasonsLine(payload.reasons)} — ${payload.at}`;
}

function webhookBody(target: WatchWebhookTarget, payload: WatchTransitionPayload): string {
  if (target.format === "generic") return JSON.stringify(payload);
  const text = capToLimit(transitionText(payload), FORMAT_TEXT_LIMIT[target.format]);
  if (target.format === "slack") return JSON.stringify({ text });
  if (target.format === "discord") return JSON.stringify({ content: text });
  return JSON.stringify({ chat_id: target.telegramChatId, text });
}

/** Every Bot API response carries a boolean `ok`; only `ok: true` proves delivery, and an
 *  unparseable body does not. */
async function telegramDelivered(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** Posts the transition, in `target.format`'s own shape. Throws on anything short of proof
 *  of delivery — a timeout, a refused connection, a non-2xx status, or (Telegram only) a 2xx
 *  answer with `ok:false` — so the caller can tell "delivered" from "not", which is what
 *  decides whether the new state is allowed to replace the old one. */
export async function postWebhookAlert(target: WatchWebhookTarget, payload: WatchTransitionPayload): Promise<void> {
  let response: Response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: webhookBody(target, payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // fetch's own TypeError names the failure ("fetch failed") but not the URL, and the
    // value is registered with core/io/log.ts regardless — belt and suspenders, since a
    // future Node/undici version repeating the target in a rejection message must still
    // come out masked wherever this error is eventually reported.
    throw new Error(`webhook request failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(`webhook responded with ${response.status}`);
  }
  if (target.format === "telegram" && !(await telegramDelivered(response))) {
    throw new Error("webhook responded 2xx but telegram reported ok:false");
  }
}

/** The dead-man's switch: a plain GET, proven to be what all three reference services
 *  (healthchecks.io, Uptime Kuma push, Better Stack heartbeat) accept — no per-service
 *  method configuration needed. Throws the same way postWebhookAlert does; the caller
 *  decides how a failed ping is reported (never the level, never the exit code — see
 *  check.ts). */
export async function postHeartbeat(url: URL): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`heartbeat request failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(`heartbeat responded with ${response.status}`);
  }
}
