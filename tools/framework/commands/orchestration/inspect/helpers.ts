// Pure helpers for `./clawforge inspect`'s gathering — no target I/O of their own beyond a
// single, independent read of the live config (readLiveConfigForProspective). Split out of
// inspect.ts; see observe.ts (this same directory) for the functions that actually observe
// the target, and gather.ts for gatherInspection/inspect/doctor/renderJson/renderText.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSON5 from "json5";
import { frameworkRoot } from "#src/core/env.ts";
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

export function valueAt(config: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], config);
}

/** Sets a dot-path on a plain-object tree, creating intermediate objects as needed —
 *  valueAt()'s writing counterpart, and the same additive-merge semantics OpenClaw's own
 *  `config set --batch-file` applies (config.ts's applyConfig): each declared path
 *  overwrites exactly that value, nothing it does not name is ever unset. */
function setAt(config: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = config;
  for (const key of parts.slice(0, -1)) {
    const next = node[key];
    if (next !== null && typeof next === "object" && !Array.isArray(next)) {
      node = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
    }
  }
  node[parts.at(-1)!] = value;
}

/** The configuration as it will be once config/desired-state.json is applied — the live
 *  config with every declared {path,value} overlaid on top. Used only to ask what secrets
 *  the DECLARATION is about to need: a SecretRef a coder just added is a real requirement
 *  before it has ever reached the target, and reporting it only after CONFIG_DRIFT has
 *  already been applied is exactly what let apply proceed with a config step that needs a
 *  secret no plan ever scheduled installing. */
export function prospectiveConfig(live: unknown, declared: DeclaredState["config"]): unknown {
  const base: Record<string, unknown> = live !== null && typeof live === "object" && !Array.isArray(live)
    ? structuredClone(live as Record<string, unknown>)
    : {};
  for (const entry of declared) setAt(base, entry.path, entry.value);
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

export async function frameworkVersion(): Promise<string | undefined> {
  // Source mode puts package.json next to this file's directory; the built package puts it
  // one level up from dist/. Asked for rather than assumed, same reasoning as clientEntry().
  for (const candidate of [resolve(frameworkRoot, "package.json"), resolve(frameworkRoot, "..", "package.json")]) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "@clawforge/framework") return parsed.version;
    } catch {
      // Try the next one.
    }
  }
  return undefined;
}
