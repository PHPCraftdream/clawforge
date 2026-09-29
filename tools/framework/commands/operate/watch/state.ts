// Persisted watch state: one small JSON file per deployment, on the OPERATOR side —
// deploymentDir(), never ctx.settings.dataDir (the target): watch check runs from wherever
// this tooling runs, the one place guaranteed to still be there between cycles when the
// instance being watched is itself down.
//
// Read with plain node:fs, like every other operator-side file — deploymentDir() is always
// local to whoever runs this tooling, whatever transport reaches the target.

import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { deploymentDir } from "../../../runtime/deployment.ts";
import { renameOverPrivateFile } from "../../../security/privacy/private-file.ts";

export type WatchLevel = "ok" | "degraded" | "down";

export interface WatchReason {
  readonly code: string;
  readonly detail: string;
}

export interface WatchState {
  /** Verdict from the most recently COMPLETED probe cycle — absent before the first cycle
   *  ever completes, or when the only thing recorded is a config error that stopped
   *  watchCheck before a cycle ran. */
  readonly level?: WatchLevel;
  readonly reasons?: readonly WatchReason[];
  /** When that cycle ran. */
  readonly checkedAt?: string;
  /** When the current STATE was last entered — level changing, or (at a non-ok level) the
   *  SET of reason codes changing; a detail text changing alone does not. Equal to checkedAt
   *  on the cycle that changed either. */
  readonly changedAt?: string;
  /** When `watch check` was last INVOKED, successful cycle or not. What `watch status`'s
   *  staleness warning compares against: proves the scheduler is still firing even while
   *  every cycle keeps failing the same way. */
  readonly lastRunAt?: string;
  /** The most recent configuration error or alert-delivery failure — masked/capped, never
   *  the webhook/heartbeat URL. Cleared once a later cycle completes without one. Never set
   *  by `watch test`, which persists only the heartbeat fields below. */
  readonly lastError?: string;
  /** An alert that could not be delivered: `level`/`reasons` above stay at `from`'s value so
   *  the next cycle retries the same unreported change — see runWatchCycle. `from`/`to` are
   *  equal for a codes-only change. `since` is when this failure streak started. Cleared once
   *  a retry delivers, or the observed state naturally returns to `from`/`fromCodes` first. */
  readonly alertPending?: {
    readonly from: WatchLevel;
    readonly to: WatchLevel;
    readonly since: string;
    /** Reason codes as of the cycle this streak started — fixed across retries, like
     *  `since`. Absent on a state file predating this field, or when there were none to
     *  record (a transition from "ok", which never has reasons). */
    readonly fromCodes?: readonly string[];
    /** Reason codes as of the most recent retry attempt — unlike fromCodes/since, this
     *  refreshes every retry so a further code change mid-outage is not lost. */
    readonly toCodes?: readonly string[];
  };
  /** Minutes between cycles, recorded by `watch install --apply` when a schedule is actually
   *  installed, cleared by `watch uninstall --apply` — the only way this framework observes
   *  the real interval, since cron is never asked afterwards. Absent for an old state file or
   *  a hand-wired schedule; `watch status` then falls back to DEFAULT_WATCH_INTERVAL_MINUTES. */
  readonly intervalMinutes?: number;
  /** When the heartbeat (OC_WATCH_HEARTBEAT_URL) last answered success — set by both `watch
   *  check` and `watch test`. Absent when no heartbeat is configured, or none has ever
   *  succeeded. */
  readonly heartbeatAt?: string;
  /** The most recent heartbeat ping failure, if the last attempt did not succeed — cleared
   *  the moment a later attempt does. Never the URL itself. */
  readonly heartbeatError?: string;
}

export function watchStateFile(): string {
  return resolve(deploymentDir(), "state", "watch.json");
}

function isWatchLevel(value: unknown): value is WatchLevel {
  return value === "ok" || value === "degraded" || value === "down";
}

function parseReasons(value: unknown): WatchReason[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reasons: WatchReason[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return undefined;
    const { code, detail } = entry as Record<string, unknown>;
    if (typeof code !== "string" || typeof detail !== "string") return undefined;
    reasons.push({ code, detail });
  }
  return reasons;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseAlertPending(value: unknown): WatchState["alertPending"] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { from, to, since, fromCodes, toCodes } = value as Record<string, unknown>;
  if (!isWatchLevel(from) || !isWatchLevel(to) || typeof since !== "string") return undefined;
  if (fromCodes !== undefined && !isStringArray(fromCodes)) return undefined;
  if (toCodes !== undefined && !isStringArray(toCodes)) return undefined;
  return {
    from,
    to,
    since,
    ...(fromCodes !== undefined ? { fromCodes } : {}),
    ...(toCodes !== undefined ? { toCodes } : {}),
  } as WatchState["alertPending"];
}

/** Every field is optional: a diagnostics-only write has no level yet, and a state file from
 *  before a field existed simply lacks it. Present-but-wrong-typed is corrupt (undefined
 *  state, same as unparsable JSON); present-and-right-typed is kept. */
function parseWatchState(raw: string): WatchState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const candidate = parsed as Record<string, unknown>;

  if (candidate.level !== undefined && !isWatchLevel(candidate.level)) return undefined;
  if (candidate.checkedAt !== undefined && typeof candidate.checkedAt !== "string") return undefined;
  if (candidate.changedAt !== undefined && typeof candidate.changedAt !== "string") return undefined;
  if (candidate.lastRunAt !== undefined && typeof candidate.lastRunAt !== "string") return undefined;
  if (candidate.lastError !== undefined && typeof candidate.lastError !== "string") return undefined;
  if (candidate.intervalMinutes !== undefined && typeof candidate.intervalMinutes !== "number") return undefined;
  if (candidate.heartbeatAt !== undefined && typeof candidate.heartbeatAt !== "string") return undefined;
  if (candidate.heartbeatError !== undefined && typeof candidate.heartbeatError !== "string") return undefined;

  let reasons: WatchReason[] | undefined;
  if (candidate.reasons !== undefined) {
    reasons = parseReasons(candidate.reasons);
    if (reasons === undefined) return undefined;
  }

  let alertPending: WatchState["alertPending"];
  if (candidate.alertPending !== undefined) {
    alertPending = parseAlertPending(candidate.alertPending);
    if (alertPending === undefined) return undefined;
  }

  return {
    level: candidate.level as WatchLevel | undefined,
    reasons,
    checkedAt: candidate.checkedAt as string | undefined,
    changedAt: candidate.changedAt as string | undefined,
    lastRunAt: candidate.lastRunAt as string | undefined,
    lastError: candidate.lastError as string | undefined,
    intervalMinutes: candidate.intervalMinutes as number | undefined,
    alertPending,
    heartbeatAt: candidate.heartbeatAt as string | undefined,
    heartbeatError: candidate.heartbeatError as string | undefined,
  };
}

/** Absent or unreadable/corrupt both read as "no previous state": a fresh install and a
 *  damaged file are told apart in the messages a caller may print, never in what this
 *  returns — either way there is nothing to compare the next cycle against, and the first
 *  cycle after either one just establishes a fresh baseline instead of alerting on it. */
export async function readWatchState(): Promise<WatchState | undefined> {
  let raw: string;
  try {
    raw = await readFile(watchStateFile(), "utf8");
  } catch {
    return undefined;
  }
  return parseWatchState(raw);
}

/** Publishes state at `path`: bytes land in a temp sibling in the same directory (same
 *  filesystem, so the rename is atomic) and one `rename` moves them over the final name —
 *  a crash before the rename leaves the previous file (or no file) intact, never a half
 *  written one a reader could mistake for valid state. Same shape as
 *  security/private-file.ts's replacePrivateFile, minus the owner-only ACL work that file
 *  exists for: this content carries no secret, only a level, reason codes and timestamps. */
export async function writeWatchState(state: WatchState): Promise<void> {
  const file = watchStateFile();
  await mkdir(resolve(file, ".."), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const content = `${JSON.stringify(state, null, 2)}\n`;
  let handle;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(content, "utf8");
  } finally {
    await handle?.close();
  }
  try {
    await renameOverPrivateFile(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
