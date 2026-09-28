// Persisted watch state: one small JSON file per deployment, on the OPERATOR side —
// `deploymentDir()`, never `ctx.settings.dataDir` (the target). `watch check` runs from
// wherever this tooling itself runs, and that is the only place guaranteed to still be
// there between two cycles when the instance being watched is the very thing that is down.
//
// Read with plain node:fs, like every other operator-side file (.env, secret stores,
// desired-state.json) — deploymentDir() is always local to whoever runs this tooling,
// whatever transport reaches the target (core/env.ts's own header makes the same point).

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { deploymentDir } from "../runtime/deployment.ts";

export type WatchLevel = "ok" | "degraded" | "down";

export interface WatchReason {
  readonly code: string;
  readonly detail: string;
}

export interface WatchState {
  readonly level: WatchLevel;
  readonly reasons: readonly WatchReason[];
  /** When this cycle ran. */
  readonly checkedAt: string;
  /** When `level` was last entered — equal to checkedAt on the cycle that changed it. */
  readonly changedAt: string;
  /** When the heartbeat (OC_WATCH_HEARTBEAT_URL) last answered success. Absent when no
   *  heartbeat is configured, or none has ever succeeded. */
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

function parseWatchState(raw: string): WatchState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (!isWatchLevel(candidate.level)) return undefined;
  if (typeof candidate.checkedAt !== "string" || typeof candidate.changedAt !== "string") return undefined;
  if (!Array.isArray(candidate.reasons)) return undefined;
  const reasons: WatchReason[] = [];
  for (const entry of candidate.reasons) {
    if (entry === null || typeof entry !== "object") return undefined;
    const { code, detail } = entry as Record<string, unknown>;
    if (typeof code !== "string" || typeof detail !== "string") return undefined;
    reasons.push({ code, detail });
  }
  // Both optional, and absent from every state file written before the heartbeat feature —
  // present-but-wrong-typed is treated as corrupt (undefined state), present-and-a-string is
  // kept, and simply missing is fine either way.
  if (candidate.heartbeatAt !== undefined && typeof candidate.heartbeatAt !== "string") return undefined;
  if (candidate.heartbeatError !== undefined && typeof candidate.heartbeatError !== "string") return undefined;
  return {
    level: candidate.level,
    reasons,
    checkedAt: candidate.checkedAt,
    changedAt: candidate.changedAt,
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
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
