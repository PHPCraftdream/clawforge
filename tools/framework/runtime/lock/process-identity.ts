import { readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Context } from "../../core/context.ts";

const execFileAsync = promisify(execFile);

// Whether a pid this framework recorded is still the process that recorded it — shared here
// since every pid clawforge writes into a lock/guard file is this tool's own process.pid,
// wherever it runs. `process.pid`/`process.kill()` always mean the machine actually running
// `clawforge`, never a WSL/SSH target reached through a transport — checking liveness THROUGH
// the transport would compare the wrong two things and call every cross-transport lock
// "foreign" forever.

/** Host name plus the pid space its pids belong to. Windows Node and a WSL distro's Node on
 *  the same PC share a host name but not pids: without the scope, one side's live pid reads
 *  as ESRCH ("dead") to the other, and a sweep would remove a live run's files. */
export function machineName(): string {
  return `${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? hostname()}:${pidScope()}`;
}

function pidScope(): string {
  if (process.platform !== "linux") return process.platform;
  try {
    // "pid:[4026531836]" — distinct per pid namespace (each WSL distro, each container).
    return `linux-${/\d+/.exec(readlinkSync("/proc/self/ns/pid"))?.[0] ?? "unknown"}`;
  } catch {
    return "linux-unknown";
  }
}

/** This process's own approximate start time, wall-clock ISO — recorded beside a pid so a
 *  later reader can tell a genuinely surviving process from an unrelated one the OS handed
 *  the same pid after the original exited. Derived from process.uptime(), accurate to a few
 *  milliseconds — enough to catch a reused pid. */
export function ownProcessStartedAt(): string {
  return new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
}

/** WMIC's DMTF wall clock has an explicit signed UTC offset in minutes. Only a single,
 *  complete CreationDate proves a birth time; wildcards or partial output prove nothing. */
export function parseWindowsProcessStartedAt(stdout: string): string | undefined {
  const values = stdout.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line.startsWith("CreationDate="));
  if (values.length !== 1) return undefined;
  const match = /^CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(values[0]!);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = Math.floor(Number(match[7]) / 1000);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) return undefined;
  // setUTCFullYear avoids Date.UTC's special interpretation of years 00 through 99.
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, millis);
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 ||
      wall.getUTCDate() !== day) return undefined;
  const offsetMinutes = Number(match[9]) * (match[8] === "+" ? 1 : -1);
  return new Date(wall.getTime() - offsetMinutes * 60_000).toISOString();
}

/** Best-effort: when the process currently holding `pid` on this machine actually started,
 *  used only to catch pid reuse. Undefined when the platform tool is unavailable or its
 *  output cannot be parsed — the caller must then fall back to treating the process as alive
 *  rather than risk calling a live one dead. */
async function queryProcessStartedAt(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"]);
      return parseWindowsProcessStartedAt(stdout);
    }
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const parsed = Date.parse(stdout.trim());
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  } catch {
    return undefined;
  }
}

/** Swappable for checks: spawning a real child process to answer "when did this start" is
 *  exactly what a unit check must not do to stay deterministic and fast. */
export const platformProbes = { processStartedAt: queryProcessStartedAt };

export type Liveness = "alive" | "dead" | "unknown";

export interface LocalProcessRecord {
  readonly pid: number;
  readonly machine: string;
  /** This process's own start time when recorded — absent for a record written before this
   *  field existed, or where recording it was not worth the write. */
  readonly startedAt?: string;
}

/** The recorded start comes from process.uptime(), which counts from after Node's own boot, and
 *  the OS probe has 1 s resolution: under load the two differ by seconds for the SAME process.
 *  Wide on purpose — a live owner called dead loses its state, a reused pid called alive only
 *  keeps a lock a human can break. Windows reuses pids within seconds, so no tolerance separates
 *  reuse from jitter perfectly; 15 s keeps the common live case safe at the cost of holding a
 *  stale lock a little longer. */
export const START_TIME_TOLERANCE_MS = 15_000;

/** "unknown" means: do not assume anything — a different machine's pid can't be signalled
 *  from here, and a probe error other than "no such process" proves nothing either way. A
 *  caller must never treat "unknown" as "dead"; only a human breaking the lock decides that. */
export async function localLiveness(record: LocalProcessRecord): Promise<Liveness> {
  if (record.machine !== machineName()) return "unknown";
  let exists: boolean;
  try {
    process.kill(record.pid, 0);
    exists = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") exists = true;
    else return "unknown";
  }
  if (!exists) return "dead";
  if (record.startedAt === undefined) return "alive";
  // Reused pid: a different process now holds this number. Only treated as dead when the
  // actual start time was obtained AND clearly disagrees — never on a probe failure, which
  // falls back to "alive" rather than risk calling a live process dead.
  const actual = await platformProbes.processStartedAt(record.pid);
  if (actual === undefined) return "alive";
  const drift = Math.abs(Date.parse(actual) - Date.parse(record.startedAt));
  return Number.isNaN(drift) || drift <= START_TIME_TOLERANCE_MS ? "alive" : "dead";
}

/** Removes only an empty directory; another owner's contents must survive. Shared by the
 *  instance lock and the mutation guard, whose cleanup paths both need exactly this. */
export async function removeEmptyDirectory(ctx: Context, path: string): Promise<void> {
  if (ctx.transport.removeEmptyDir !== undefined) {
    await ctx.transport.removeEmptyDir(path).catch(() => {});
    return;
  }
  await ctx.transport.exec("rmdir", [path], { allowFailure: true });
}
