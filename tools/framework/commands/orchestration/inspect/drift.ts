// The per-facet declared-vs-target comparisons `./clawforge inspect` runs: the live
// openclaw.json against declared.ts's declaredState, the .env connection facts against the
// running container, and the local secret store against what the target holds. Split out of
// observe.ts; see helpers.ts (this same directory) for the pure pieces these use, and
// live.ts for what the target itself reports without a declared counterpart to compare.

import { readFile } from "node:fs/promises";
import JSON5 from "json5";
import { envFile, secretStoreFile } from "#src/runtime/deployment.ts";
import { parseEnv } from "#src/core/env.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem, DeclaredState, ConnectionFactObservation, SecretStoreObservation } from "#src/service/inspection.ts";
import type { SecretStatus } from "#src/service/secrets.ts";
import {
  CONNECTION_FACTS,
  staleConnectionFacts,
  unrecoverableConnectionFacts,
} from "#src/commands/operate/recover-env/facts.ts";
import type { ConnectionFacts } from "#src/commands/operate/recover-env/facts.ts";
import { DEFAULT_SECRET_STORE } from "#src/commands/management/secrets.ts";
import { configValuesEqual, effectiveDeclarationPaths, prospectiveConfig, valueAt } from "./helpers.ts";
import type { Context } from "#src/core/context.ts";

/** Parses GNU stat's fractional, timezone-qualified `%y` timestamp. */
function parseStatTimestamp(raw: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))? ([+-]\d{2}:?\d{2})$/.exec(raw.trim());
  if (match === null) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const zoneDigits = zone.replace(":", "");
  const zoneHour = Number(zoneDigits.slice(1, 3));
  const zoneMinute = Number(zoneDigits.slice(3, 5));
  if (
    month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59
  ) return undefined;

  const milliseconds = fraction.slice(0, 3).padEnd(3, "0");
  const parsed = Date.parse(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${milliseconds}${zone}`);
  if (Number.isNaN(parsed)) return undefined;
  // Runtime.startedAt() is exposed in milliseconds and Date.parse truncates finer Docker
  // precision too. Keep both sides at that same resolution to avoid false restarts.
  return parsed;
}

/** The declared settings against their live values, and when the file was last written.
 *
 *  Deliberately outside the "is it running" branch. openclaw.json is a file on the target,
 *  readable whether or not anything is serving — and skipping the comparison because the
 *  gateway is down produced a plan of just [up], which then started the instance on a
 *  configuration nobody had applied. The command reported success, the journal said
 *  succeeded, and the declaration was not in force. A comparison that works without the
 *  gateway must not be gated on the gateway. */
export async function observeConfig(
  ctx: Context,
  declared: DeclaredState,
  problems: Problem[],
): Promise<{ config: Record<string, unknown>; mtimeMs?: number }> {
  const config: Record<string, unknown> = {};
  const configFile = `${ctx.settings.dataDir}/config/openclaw.json`;
  let mtimeMs: number | undefined;

  try {
    // JSON5, not JSON: the live config is OpenClaw's own JSON5 gateway format (docs.openclaw.ai/
    // gateway/configuration) — a comment or trailing comma is legitimate there, and plain
    // JSON.parse rejecting it produced a false CONFIG_DRIFT on every run against such a config.
    const parsed = JSON5.parse(await ctx.transport.readFile(configFile)) as unknown;
    for (const entry of declared.config) config[entry.path] = valueAt(parsed, entry.path);
    const target = prospectiveConfig(parsed, declared.config);
    for (const entry of effectiveDeclarationPaths(declared.config)) {
      const actual = valueAt(parsed, entry.path);
      const desired = valueAt(target, entry.path);
      if (!configValuesEqual(actual, desired)) {
        problems.push(
          problem("CONFIG_DRIFT", `${entry.path} is ${JSON.stringify(actual)}, declared ${JSON.stringify(desired)}`),
        );
      }
    }
    const stamp = await ctx.transport.exec("stat", ["-c", "%y", configFile], { allowFailure: true });
    if (stamp.code === 0) {
      mtimeMs = parseStatTimestamp(stamp.stdout);
    }
  } catch {
    // A deployment that has never been bootstrapped has no configuration at all, which is
    // not drift — there is nothing to have drifted from. Only a file that exists and cannot
    // be understood is a finding.
    //
    // exists() itself now throws when the CHECK could not run (an unreachable target, rather
    // than an answer) — caught here rather than allowed to escape: inspect answers whatever
    // it can see, and a target it cannot reach at all is a finding of its own, not a reason
    // to abandon every other observation already gathered.
    let present: boolean;
    try {
      present = await ctx.transport.exists(configFile);
    } catch (error) {
      problems.push(problem("CONFIG_DRIFT", `${configFile} could not be reached: ${(error as Error).message}`));
      present = false;
    }
    if (present) {
      problems.push(problem("CONFIG_DRIFT", `${configFile} could not be read or parsed`));
    }
  }

  return { config, mtimeMs };
}

/** The deployment .env's connection facts against the running container — the same
 *  comparison recover-env reports on and --adopt-runtime resolves (staleConnectionFacts), surfaced instead of waiting
 *  to be asked. Below the not-running early return in gatherInspection: the facts come
 *  from a running container, and without one there is nothing to compare against.
 *
 *  The finding names WHICH variable drifted and never a value, not even a non-secret one:
 *  .env mixes a real secret (OPENCLAW_GATEWAY_TOKEN) with these plumbing facts, so nothing
 *  parsed from that file is printable beyond the four names. */
export async function observeConnectionFacts(
  ctx: Context,
  problems: Problem[],
): Promise<ConnectionFactObservation[] | undefined> {
  // Optional on the runtime contract, the way execCommand is: a runtime that cannot
  // introspect its container is not asked, and skipping is its honest answer.
  if (typeof ctx.runtime.runningConnectionFacts !== "function") return undefined;
  const facts: ConnectionFacts | undefined = await ctx.runtime.runningConnectionFacts();
  // Not running, or the container could not be inspected: a gap, not a verdict.
  if (facts === undefined) return undefined;
  let raw: string;
  try {
    raw = await readFile(envFile(), "utf8");
  } catch {
    // No .env — nothing to compare against; the fresh-clone shape, not a finding.
    return undefined;
  }
  const current = parseEnv(raw);
  // The comparison itself comes from facts.ts — recover-env acts on exactly it, so
  // inspect and recover-env cannot disagree about what counts as stale.
  const stale = new Set(staleConnectionFacts(facts, current).map((entry) => entry.name));
  const unrecovered = new Set(unrecoverableConnectionFacts(facts).map((entry) => entry.name));
  const observations: ConnectionFactObservation[] = CONNECTION_FACTS.map((fact) => ({
    name: fact.name,
    state: unrecovered.has(fact.name) ? "unrecovered" : stale.has(fact.name) ? "stale" : "match",
  }));
  for (const name of stale) {
    problems.push(problem("ENV_STALE", `${name} in ${envFile()} differs from the running container`));
  }
  return observations;
}

/** The deployment's default local store against the values the target holds. Watched only
 *  when a store file exists, and only the default one (inspect takes no store name):
 *  bootstrap puts values on the target without ever creating a store, so an absent store
 *  is how every healthy deployment starts out, not evidence of loss — and there is no way
 *  to tell it from a lost one. A store that EXISTS missing a required name is unambiguous:
 *  the workflow is in use, and that value has no local copy. Names checked are the same
 *  required set SECRET_MISSING reports, and only names the target still holds — the
 *  target-absent ones are SECRET_MISSING's business, and `secrets --dump` recovers from
 *  the target, not from nowhere. */
export async function observeSecretStore(
  ctx: Context,
  secrets: readonly SecretStatus[],
  problems: Problem[],
): Promise<SecretStoreObservation | undefined> {
  const store = secretStoreFile(DEFAULT_SECRET_STORE);
  let raw: string;
  try {
    raw = await readFile(store, "utf8");
  } catch {
    return undefined;
  }
  const values = parseEnv(raw);
  const missing = secrets.filter(
    (entry) => entry.required && entry.present && (values[entry.name] ?? "").trim() === "",
  );
  for (const entry of missing) {
    problems.push(problem("STORE_INCOMPLETE", `${entry.name} (${entry.usedBy}) is present on the target but has no value in ${store}`));
  }
  return { file: store, missing: missing.map((entry) => entry.name) };
}
