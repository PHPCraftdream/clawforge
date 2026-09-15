// Shared configuration-path and inspection helpers.

import { readFile } from "node:fs/promises";
import JSON5 from "json5";
import { desiredStateFile } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import type { CronJob, AgentConfig } from "#src/commands/management/provision-agent/index.ts";
import type { DeclaredState } from "#src/service/inspection.ts";

/** Field by field, so the reader is not left to diff a cron job themselves. Mirrors exactly
 *  what cronJobMatches compares — it decides, this only explains its verdict. */
export function cronDifferences(job: CronJob, config: AgentConfig, cronMessage: string): string[] {
  const differences: string[] = [];
  if (job.enabled === false) differences.push("the job is disabled");
  if (job.agentId !== config.agentId) differences.push(`agent is ${job.agentId ?? "(none)"}, declared ${config.agentId}`);
  if (job.schedule?.expr !== config.cronSchedule) differences.push(`runs at ${job.schedule?.expr ?? "(none)"}, declared ${config.cronSchedule}`);
  if (config.cronTimezone !== undefined && job.schedule?.tz !== config.cronTimezone) differences.push(`timezone is ${job.schedule?.tz ?? "(host default)"}, declared ${config.cronTimezone}`);
  if (job.sessionTarget !== "isolated") differences.push(`session is ${job.sessionTarget ?? "(none)"}, declared isolated`);
  if (job.payload?.message !== cronMessage) differences.push("the message differs from agent/cron-message.txt");
  if (job.payload?.timeoutSeconds !== config.cronTimeoutSeconds) {
    differences.push(`timeout is ${job.payload?.timeoutSeconds ?? "(none)"}s, declared ${config.cronTimeoutSeconds}s`);
  }
  if (job.delivery?.mode !== "none") differences.push(`delivery is ${job.delivery?.mode ?? "(none)"}, declared none`);
  return differences;
}

/** Reads a config path without following inherited properties. */
export function valueAt(config: unknown, path: string): unknown {
  let node = config;
  try {
    for (const part of configPathParts(path)) {
      if (node === null || (typeof node !== "object" && typeof node !== "function")) return undefined;
      if (Array.isArray(node) && arrayIndex(part.key) === undefined) return undefined;
      if (!Object.hasOwn(node, part.key)) return undefined;
      node = (node as Record<string, unknown>)[part.key];
    }
    return node;
  } catch {
    return undefined;
  }
}

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

interface ConfigPathPart {
  readonly key: string;
  readonly arrayIndex: boolean;
}

const MAX_CONFIG_PATH_ARRAY_INDEX = 100_000;

function arrayIndex(key: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
  const value = Number(key);
  return Number.isSafeInteger(value) && value <= MAX_CONFIG_PATH_ARRAY_INDEX ? value : undefined;
}

/** Parses OpenClaw's dot/bracket path notation, including quoted keys containing dots. */
function configPathParts(path: string): ConfigPathPart[] {
  const raw = path.trim();
  if (raw === "") throw new Error("configuration path must not be empty");
  const parts: ConfigPathPart[] = [];
  let current = "";
  let segmentEmitted = false;
  const invalid = (): never => { throw new Error(`invalid configuration path "${path}"`); };
  const emitDotSegment = (): void => {
    if ((current.length > 0 && !current.trim()) || (!segmentEmitted && !current.trim())) invalid();
    if (current) {
      const key = current.trim();
      parts.push({ key, arrayIndex: arrayIndex(key) !== undefined });
    }
    current = "";
    segmentEmitted = false;
  };
  const bracketClose = (open: number): number => {
    let quote: string | undefined;
    for (let cursor = open + 1; cursor < raw.length; cursor += 1) {
      const character = raw[cursor];
      if (quote !== undefined) {
        if (character === "\\") cursor += 1;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === "]") return cursor;
      if ((character === "\"" || character === "'") && !raw.slice(open + 1, cursor).trim()) quote = character;
    }
    return -1;
  };
  let index = 0;
  while (index < raw.length) {
    const character = raw[index];
    if (character === "\\") {
      if (raw[index + 1] === undefined) invalid();
      current += raw[index + 1];
      index += 2;
      continue;
    }
    if (character === ".") {
      emitDotSegment();
      index += 1;
      continue;
    }
    if (character === "[") {
      if ((current.length > 0 && !current.trim()) || (!current.trim() && !segmentEmitted && parts.length > 0)) invalid();
      if (current) {
        const key = current.trim();
        parts.push({ key, arrayIndex: arrayIndex(key) !== undefined });
      }
      current = "";
      const close = bracketClose(index);
      if (close === -1) invalid();
      const inside = raw.slice(index + 1, close).trim();
      if (inside === "") invalid();
      let key: string;
      let isArrayIndex = false;
      if (inside.startsWith("\"") || inside.startsWith("'")) {
        let parsed: unknown;
        try { parsed = JSON5.parse(inside); } catch { invalid(); }
        if (typeof parsed !== "string" || parsed.trim() === "") invalid();
        key = parsed as string;
      } else {
        key = inside;
        isArrayIndex = arrayIndex(key) !== undefined;
      }
      parts.push({ key, arrayIndex: isArrayIndex });
      const next = raw[close + 1];
      if (next !== undefined && next !== "." && next !== "[") invalid();
      segmentEmitted = true;
      index = close + 1;
      continue;
    }
    current += character;
    index += 1;
  }
  if (!segmentEmitted && !current.trim()) invalid();
  if (current) {
    const key = current.trim();
    parts.push({ key, arrayIndex: arrayIndex(key) !== undefined });
  }
  const unsafe = parts.find((part) => UNSAFE_PATH_SEGMENTS.has(part.key));
  if (unsafe !== undefined) {
    throw new Error(`refusing to apply configuration path "${path}": "${unsafe.key}" is not a valid segment`);
  }
  return parts;
}

/** Writes a config path, preserving arrays and rejecting unsafe segments. */
function setAt(config: Record<string, unknown>, path: string, value: unknown): void {
  const parts = configPathParts(path);
  let node: Record<string, unknown> | unknown[] = config;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index].key;
    if (Array.isArray(node) && arrayIndex(key) === undefined) {
      throw new Error(`configuration path "${path}" expects a numeric array index`);
    }
    const next = Object.hasOwn(node, key) ? (node as Record<string, unknown>)[key] : undefined;
    if (next !== null && typeof next === "object") {
      node = next as Record<string, unknown> | unknown[];
    } else {
      const created: Record<string, unknown> | unknown[] = parts[index + 1].arrayIndex ? [] : {};
      (node as Record<string, unknown>)[key] = created;
      node = created;
    }
  }
  const last = parts.at(-1)!.key;
  if (Array.isArray(node) && arrayIndex(last) === undefined) {
    throw new Error(`configuration path "${path}" expects a numeric array index`);
  }
  (node as Record<string, unknown>)[last] = value;
}

/** Overlays declarations without mutating either the live config or declared values. */
export function prospectiveConfig(live: unknown, declared: DeclaredState["config"]): unknown {
  const base: Record<string, unknown> = live !== null && typeof live === "object" && !Array.isArray(live)
    ? structuredClone(live as Record<string, unknown>)
    : {};
  for (const entry of declared) setAt(base, entry.path, structuredClone(entry.value));
  return base;
}

/** The live openclaw.json, parsed as JSON5 — or undefined for any reason at all (absent,
 *  unreadable, unparseable). Failure here is not this function's finding to report:
 *  observeConfig() (inspect-observe.ts) already owns reporting a broken live config as
 *  CONFIG_DRIFT; this is a second, independent read purely to build the prospective merge
 *  above, and a config that cannot be read here simply means the prospective view falls
 *  back to the declaration alone. */
export async function readLiveConfigForProspective(ctx: Context): Promise<unknown> {
  try {
    return JSON5.parse(await ctx.transport.readFile(`${ctx.settings.dataDir}/config/openclaw.json`)) as unknown;
  } catch {
    return undefined;
  }
}

/** The same read, for a caller that is about to WRITE based on the result — secrets --apply's
 *  own prospective requirement list, not inspect's read-only report. readLiveConfigForProspective()
 *  above degrading a transient read or parse error to "no config" is correct for gatherInspection
 *  (it must always answer, and observeConfig() reports the break separately) but wrong here: a
 *  config that genuinely exists and briefly failed to read still has real secrets in it, and
 *  silently treating that the same as "never bootstrapped" produces an INCOMPLETE requirement
 *  list that then overwrites config/.env down to just that incomplete list — deleting whatever
 *  secret the missed requirement was for. Only a genuinely absent file (never bootstrapped) is
 *  a legitimate empty base; anything else must abort before applyStore() writes a single byte. */
export async function readLiveConfigOrThrow(ctx: Context): Promise<unknown> {
  const path = `${ctx.settings.dataDir}/config/openclaw.json`;
  if (!(await ctx.transport.exists(path))) return undefined;

  let raw: string;
  try {
    raw = await ctx.transport.readFile(path);
  } catch (error) {
    throw new Error(`${path} exists but could not be read: ${(error as Error).message}`);
  }
  try {
    return JSON5.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${path} exists but is not valid JSON5: ${(error as Error).message}`);
  }
}

/** The raw {path,value} declarations from config/desired-state.json, with no problem
 *  reporting and none of declaredState()'s (observe.ts) recipe/image extras — a caller that
 *  only wants prospectiveConfig's own input (secrets --apply's own prospective requirements,
 *  which have no use for an inspection Problem list) reads this directly instead of pulling
 *  in observe.ts's much heavier declaredState(). Absent or unparseable is the same answer, an
 *  empty declaration: a caller here already has nothing better to fall back to than the live
 *  config alone, which computing requirements from an empty declared array still gives it. */
export async function readDeclaredConfig(): Promise<DeclaredState["config"]> {
  let raw: string;
  try {
    raw = await readFile(desiredStateFile(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { path: string; value?: unknown }[];
    return parsed.map((entry) => ({ path: entry.path, value: entry.value }));
  } catch {
    return [];
  }
}

// Re-exported rather than reimplemented: this used to be a second copy of lock.ts's version,
// and "which framework is this" answered twice is a question that can be answered two ways.
export { frameworkVersion } from "#src/commands/management/lock.ts";
