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

/** Best-effort: when the process currently holding `pid` on this machine actually started,
 *  used only to catch pid reuse. Undefined when the platform tool is unavailable or its
 *  output cannot be parsed — the caller must then fall back to treating the process as alive
 *  rather than risk calling a live one dead. */
async function queryProcessStartedAt(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"]);
      const match = /CreationDate=(\d{14})/.exec(stdout);
      if (match === null) return undefined;
      const raw = match[1];
      const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`;
      const parsed = Date.parse(iso);
      return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
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
 *  keeps a lock a human can break; a reused pid starts minutes, not seconds, after the original. */
const START_TIME_TOLERANCE_MS = 15_000;

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
