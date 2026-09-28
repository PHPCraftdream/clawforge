// Watch-only liveness signals: channel connectivity and free space on the data directory.
// Not inspect problem codes: neither compares the instance with its declaration.

import { maskSecrets } from "../../../core/io/log.ts";
import type { Context } from "../../../core/context.ts";
import type { ExecResult } from "../../../runtime/transport/transport.ts";
import type { ChannelAccountStatus, ChannelsStatusResponse } from "../../../service/inspection.ts";
import type { WatchLevel, WatchReason } from "./state.ts";

export const DISK_MIN_MB_ENV = "OC_WATCH_DISK_MIN_MB";
const DEFAULT_DISK_MIN_MB = 1024;
// "down" still fires near-empty even when the configured threshold is low.
const DISK_DOWN_FLOOR_MB = 100;
const DISK_DOWN_RATIO = 0.1;

// Transport errors may echo a credential: masked and capped before reaching the state file.
const DETAIL_MAX = 200;

function capDetail(raw: string): string {
  const masked = maskSecrets(raw);
  return masked.length > DETAIL_MAX ? `${masked.slice(0, DETAIL_MAX)}…` : masked;
}

export interface WatchFinding {
  readonly level: "degraded" | "down";
  readonly reason: WatchReason;
}

function channelFinding(id: string, detail: string): WatchFinding {
  return { level: "degraded", reason: { code: "CHANNEL_UNHEALTHY", detail: capDetail(`${id}: ${detail}`) } };
}

/** Per-account channel liveness from `openclaw channels status --json`'s already-parsed
 *  answer (verified on 2026.6.34), gathered by gatherInspection's `channels` option in the
 *  same batched CLI call as agents/mcp/cron/plugins/skills (inspect/gather.ts) rather than a
 *  one-off container of its own — a pure function over that data so it needs no ctx and no
 *  transport to test. Without --probe: the status already reflects the background
 *  connection. That CLI has no dead-letter/delivery-failure signal, so none is reported. Only
 *  configured, enabled accounts count; a connected account is healthy even if an old
 *  lastError lingers. An absent response — the option was not set, or the CLI call itself
 *  failed — is a gap, not a verdict. */
export function channelFindings(response: ChannelsStatusResponse | undefined): WatchFinding[] {
  if (response === undefined) return [];
  const accounts = response.channelAccounts;
  if (accounts === null || typeof accounts !== "object") return [];

  const findings: WatchFinding[] = [];
  for (const [channel, entry] of Object.entries(accounts)) {
    if (!Array.isArray(entry)) continue;
    for (const raw of entry as ChannelAccountStatus[]) {
      if (raw === null || typeof raw !== "object") continue;
      if (raw.configured !== true || raw.enabled === false) continue;
      const accountId = typeof raw.accountId === "string" && raw.accountId !== "" ? raw.accountId : "default";
      const id = `${channel}/${accountId}`;
      const lastError = typeof raw.lastError === "string" && raw.lastError.trim() !== "" ? `: ${raw.lastError}` : "";
      if (raw.running === false) {
        findings.push(channelFinding(id, `configured but not running${lastError}`));
      } else if (raw.connected === false) {
        findings.push(channelFinding(id, `configured but not connected${lastError}`));
      } else if (raw.connected !== true && lastError !== "") {
        findings.push(channelFinding(id, `last error${lastError}`));
      }
    }
  }
  return findings;
}

function diskThresholdMb(ctx: Context): number {
  const raw = ctx.settings.env[DISK_MIN_MB_ENV];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DISK_MIN_MB;
}

/** `df -Pk` for one path: a header, then one fixed six-field line; field 4 is Available (KiB). */
export function parseDfAvailableKb(stdout: string): number | undefined {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) return undefined;
  const fields = lines[1].trim().split(/\s+/);
  if (fields.length < 4) return undefined;
  const available = Number(fields[3]);
  return Number.isFinite(available) && available >= 0 ? available : undefined;
}

/** Below OC_WATCH_DISK_MIN_MB (default 1024): degraded; below max(10% of it, 100 MB): down.
 *  A failed or unparseable `df` is DISK_UNKNOWN (degraded): neither a silent ok nor a false down. */
export async function diskFindings(ctx: Context): Promise<WatchFinding[]> {
  const thresholdMb = diskThresholdMb(ctx);
  const dataDir = ctx.settings.dataDir;
  const unknown = (detail: string): WatchFinding[] => [
    { level: "degraded", reason: { code: "DISK_UNKNOWN", detail: capDetail(detail) } },
  ];

  let result: ExecResult;
  try {
    result = await ctx.transport.exec("df", ["-Pk", dataDir], { allowFailure: true });
  } catch (error) {
    return unknown(`df -Pk ${dataDir} could not run: ${(error as Error).message}`);
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return unknown(`df -Pk ${dataDir} failed (exit ${result.code})${detail === "" ? "" : `: ${detail}`}`);
  }
  const availableKb = parseDfAvailableKb(result.stdout);
  if (availableKb === undefined) return unknown(`df -Pk ${dataDir} returned output this could not parse`);

  const availableMb = availableKb / 1024;
  if (availableMb >= thresholdMb) return [];

  const downBoundMb = Math.max(thresholdMb * DISK_DOWN_RATIO, DISK_DOWN_FLOOR_MB);
  const level = availableMb < downBoundMb ? "down" : "degraded";
  return [
    {
      level,
      reason: {
        code: "DISK_LOW",
        detail: `${dataDir} has ${availableMb.toFixed(0)} MB free, below the ${DISK_MIN_MB_ENV} threshold of ${thresholdMb} MB`,
      },
    },
  ];
}

/** Folds findings into a verdict; only ever escalates, and keeps every reason. */
export function mergeFindings(
  base: { readonly level: WatchLevel; readonly reasons: readonly WatchReason[] },
  findings: readonly WatchFinding[],
): { level: WatchLevel; reasons: WatchReason[] } {
  let level = base.level;
  const reasons = [...base.reasons];
  for (const entry of findings) {
    reasons.push(entry.reason);
    if (entry.level === "down") level = "down";
    else if (level === "ok") level = "degraded";
  }
  return { level, reasons };
}
