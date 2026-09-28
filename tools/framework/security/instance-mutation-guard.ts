import { randomBytes } from "node:crypto";
import { readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { locksDir } from "../core/env.ts";
import type { Context } from "../core/context.ts";
import type { Transport } from "../runtime/transport/transport.ts";

const execFileAsync = promisify(execFile);

// Whether a pid this framework recorded is still the process that recorded it — shared here,
// rather than duplicated per caller, because every pid clawforge writes into a lock or guard
// file (this guard's own owner, the instance lock's holder, a compose invocation's temporary
// env-file owner) is this tool's own process.pid, wherever it happens to run. The Windows
// tooling reaches a WSL or SSH target through a transport, but the CLI process itself never
// runs there: `process.pid` and `process.kill()` always mean the machine actually running
// `clawforge`, never the target the transport reaches. Checking liveness THROUGH the transport
// (asking the WSL target for its own hostname or process table) would compare the wrong two
// things and call every cross-transport lock "foreign" forever.

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
 *  the same pid number after the original exited. Approximate: derived from process.uptime(),
 *  accurate to a few milliseconds — more than enough to catch a reused pid, since the OS does
 *  not hand out a just-freed pid again within milliseconds. */
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

/** "unknown" means: do not assume anything — a different machine's pid cannot be signalled
 *  from here, and a probe that errors for a reason other than "no such process" proves
 *  nothing either way. A caller must never treat "unknown" as "dead"; only a human deciding
 *  to break the lock gets to make that call.
 *
 *  Generic across callers (the instance lock's holder, a compose invocation's owner); this
 *  guard's own owner uses the narrower `processIsAlive()` below instead, kept separate rather
 *  than folded together to avoid touching its already-tested boolean|undefined contract. */
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
  return Number.isNaN(drift) || drift <= 2000 ? "alive" : "dead";
}

/** Removes `compose-*` directories (runtime-docker.ts #withEnvFile) a PAST call left behind — a token-bearing compose.env
 *  survives a crash between the mkdir below and this method's own finally block (crash 139
 *  mid-command, an OOM kill, anything that skips Node's own cleanup entirely). Only ones
 *  provably abandoned: an owner.json naming this machine and a pid that is provably gone
 *  (never a bare "unreadable owner.json", which a sibling call still mid-write toward its
 *  own — see the write order below — would also show for an instant; never a different
 *  machine's own clawforge, whose pid cannot be checked from here at all). Best-effort:
 *  a failed listing or removal here must never block the real compose call that follows. */
export async function sweepStaleComposeEnvs(transport: Transport, directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await transport.listFiles(directory);
  } catch {
    return;
  }
  const names = new Set(
    entries
      .map((entry) => entry.split("/")[0] ?? "")
      .filter((name) => /^compose-[0-9a-f-]+$/.test(name)),
  );
  for (const name of names) {
    const path = `${directory}/${name}`;
    let owner: { pid?: unknown; machine?: unknown; startedAt?: unknown } | undefined;
    try {
      owner = JSON.parse(await transport.readFile(`${path}/owner.json`)) as typeof owner;
    } catch {
      continue; // Unreadable or missing: cannot prove this run is gone, so it is left alone.
    }
    if (typeof owner !== "object" || owner === null) continue;
    if (typeof owner.machine !== "string" || owner.machine !== machineName() || typeof owner.pid !== "number") continue;
    const liveness = await localLiveness({
      pid: owner.pid,
      machine: owner.machine,
      startedAt: typeof owner.startedAt === "string" ? owner.startedAt : undefined,
    });
    if (liveness !== "dead") continue;
    await transport.remove(path).catch(() => {});
  }
}

interface MutationOwner {
  readonly generation: string;
  readonly pid: number;
  readonly machine: string;
  readonly takenAt: string;
}

function guardPath(ctx: Context): string {
  return `${locksDir(ctx.settings.dataDir)}/operation.mutation`;
}

function ownerPath(ctx: Context): string {
  return `${guardPath(ctx)}/owner.json`;
}

function claimPath(ctx: Context, generation: string): string {
  return `${guardPath(ctx)}/.claim-${generation}`;
}

/** Where a confirmed foreign takeover is recorded — beside the guard, never inside it: the
 *  guard directory itself is removed once the takeover completes, and the point of this
 *  record is to survive that. One append-only file for the deployment's whole history of
 *  them, since they are meant to be rare enough that a human reads this by hand. */
function foreignTakeoverLog(ctx: Context): string {
  return `${locksDir(ctx.settings.dataDir)}/foreign-lock-takeovers.jsonl`;
}

/** Best-effort append: a confirmed, explicit override of someone else's orphaned guard is
 *  exactly the kind of event that must not go unrecorded when writing it is possible at all —
 *  but it must never be the reason the takeover itself fails. */
async function recordForeignTakeover(ctx: Context, confirmedHost: string, foreignOwner: MutationOwner): Promise<void> {
  const entry = {
    at: new Date().toISOString(),
    by: `${process.env.USERNAME ?? process.env.USER ?? "unknown"}@${machineName()} pid ${process.pid}`,
    confirmedHost,
    foreignOwner,
  };
  const path = foreignTakeoverLog(ctx);
  let existing = "";
  try {
    existing = await ctx.transport.readFile(path);
  } catch {
    // First takeover ever recorded for this deployment.
  }
  try {
    await ctx.transport.writeFile(path, `${existing}${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort audit trail: it must never be the reason a confirmed takeover fails.
  }
}

async function writeExclusive(ctx: Context, path: string, content: string): Promise<boolean> {
  const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await ctx.transport.writeFile(temporary, content);
    const linked = await ctx.transport.exec("ln", [temporary, path], { allowFailure: true });
    return linked.code === 0;
  } finally {
    await ctx.transport.remove(temporary).catch(() => {});
  }
}

async function claims(ctx: Context): Promise<string[]> {
  const files = await ctx.transport.listFiles(guardPath(ctx));
  return files
    .filter((file) => /^\.claim-[a-f0-9]+$/.test(file))
    .map((file) => `${guardPath(ctx)}/${file}`);
}

async function readOwner(ctx: Context, path: string): Promise<MutationOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await ctx.transport.readFile(path));
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Partial<MutationOwner>;
    if (typeof owner.generation !== "string" || !Number.isInteger(owner.pid) || owner.pid! <= 0 ||
        typeof owner.machine !== "string" || typeof owner.takenAt !== "string") return undefined;
    return owner as MutationOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(owner: MutationOwner): boolean | undefined {
  if (owner.machine !== machineName()) return undefined;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

function busy(path: string, owner?: MutationOwner): Error {
  const identity = owner === undefined ? "an unnamed operation" : `pid ${owner.pid} on ${owner.machine}`;
  const advice = owner === undefined
    ? "if no lock change is active, retry with --break-lock"
    : owner.machine === machineName()
      ? "wait for it to finish"
      : `check whether it is still running on ${owner.machine}`;
  return new Error(`another instance-lock change is in progress at ${path} (${identity}); ${advice}`);
}

async function removeEmptyDirectory(ctx: Context, path: string): Promise<void> {
  if (ctx.transport.removeEmptyDir !== undefined) {
    await ctx.transport.removeEmptyDir(path).catch(() => {});
    return;
  }
  await ctx.transport.exec("rmdir", [path], { allowFailure: true });
}

async function claim(ctx: Context, breakLock: boolean, breakForeignLockHost?: string): Promise<MutationOwner | undefined> {
  const homePath = locksDir(ctx.settings.dataDir);
  const home = await ctx.transport.exec("mkdir", ["-p", homePath], { allowFailure: true });
  if (home.code !== 0) {
    const homeExists = await ctx.transport.exec("test", ["-d", homePath], { allowFailure: true });
    if (homeExists.code !== 0) return undefined;
  }

  const guard = guardPath(ctx);
  const generation = randomBytes(12).toString("hex");
  const candidate: MutationOwner = { generation, pid: process.pid, machine: machineName(), takenAt: new Date().toISOString() };
  const content = `${JSON.stringify(candidate)}\n`;
  const acquired = await ctx.transport.exec("mkdir", [guard], { allowFailure: true });

  if (acquired.code === 0) {
    const marker = claimPath(ctx, generation);
    try {
      if (await writeExclusive(ctx, marker, content) && await ctx.transport.exec("ln", [marker, ownerPath(ctx)], { allowFailure: true }).then((r) => r.code === 0)) {
        await ctx.transport.remove(marker).catch(() => {});
        return candidate;
      }
    } catch (error) {
      await removeEmptyDirectory(ctx, guard);
      throw error;
    }
    await ctx.transport.remove(marker).catch(() => {});
    await removeEmptyDirectory(ctx, guard);
    throw busy(guard, await readOwner(ctx, ownerPath(ctx)));
  }

  const exists = await ctx.transport.exec("test", ["-d", guard], { allowFailure: true });
  if (exists.code !== 0) throw new Error(`could not serialize instance-lock changes at ${guard}: ${(acquired.stderr || acquired.stdout).trim()}`);

  const ownerFile = ownerPath(ctx);
  const current = await readOwner(ctx, ownerFile);
  let confirmedForeignTakeover = false;
  if (current !== undefined) {
    const alive = processIsAlive(current);
    if (alive === true) throw busy(guard, current);
    if (alive === undefined) {
      // processIsAlive returns undefined for two different reasons: a genuinely foreign
      // machine, or a probe error on THIS machine that proves nothing either way (EIO, a
      // permission the signal itself needs). Only the first is what --break-foreign-lock is
      // for — a probe error on an owner already recorded as this machine is never treated as
      // foreign, confirmed host or not, since there is nothing "foreign" to confirm.
      if (current.machine === machineName() || breakForeignLockHost === undefined) throw busy(guard, current);
      if (breakForeignLockHost !== current.machine) {
        throw new Error(
          `refusing to take over the instance-lock guard at ${guard}: its recorded owner is on ` +
            `"${current.machine}", not "${breakForeignLockHost}" — pass the exact host to confirm, or leave it alone`,
        );
      }
      // Confirmed: an explicit, host-matched operator override, never automatic. Recorded
      // once the takeover actually publishes below, alongside who did it and when.
      confirmedForeignTakeover = true;
    }
    // alive === false: proven dead on this machine, recoverable regardless of any flag (the
    // guard's own short critical section, unlike the outer instance lock, has always allowed
    // this — see instance-lock.ts's REPORTED-never-silently-taken note for why the outer one
    // still requires --break-lock even then).
  } else if (!breakLock) {
    throw busy(guard);
  }

  const marker = claimPath(ctx, generation);
  if (!(await writeExclusive(ctx, marker, content))) throw busy(guard, current);

  let otherClaims: string[];
  try {
    otherClaims = (await claims(ctx)).filter((path) => path !== marker);
  } catch (error) {
    await ctx.transport.remove(marker).catch(() => {});
    throw error;
  }
  for (const other of otherClaims) {
    const otherOwner = await readOwner(ctx, other);
    const alive = otherOwner === undefined ? undefined : processIsAlive(otherOwner);
    if (alive === true || alive === undefined) {
      await ctx.transport.remove(marker).catch(() => {});
      throw busy(guard, otherOwner ?? current);
    }
    await ctx.transport.remove(other).catch(() => {});
  }

  if (current !== undefined) {
    const latest = await readOwner(ctx, ownerFile);
    if (latest?.generation !== current.generation) {
      await ctx.transport.remove(marker).catch(() => {});
      throw busy(guard, latest);
    }
    const parked = `${guard}/.stale-owner-${current.generation}`;
    const moved = await ctx.transport.exec("mv", [ownerFile, parked], { allowFailure: true });
    if (moved.code !== 0) {
      await ctx.transport.remove(marker).catch(() => {});
      throw busy(guard, await readOwner(ctx, ownerFile));
    }
  } else {
    let staleClaims: string[];
    try {
      staleClaims = (await claims(ctx)).filter((path) => path !== marker);
    } catch (error) {
      await ctx.transport.remove(marker).catch(() => {});
      throw error;
    }
    if (staleClaims.length > 0) {
      let claimed = false;
      for (const staleClaim of staleClaims) {
        const staleOwner = await readOwner(ctx, staleClaim);
        if (staleOwner !== undefined && processIsAlive(staleOwner) !== false) continue;
        const retired = `${guard}/.retired-claim-${randomBytes(6).toString("hex")}`;
        const moved = await ctx.transport.exec("mv", [staleClaim, retired], { allowFailure: true });
        if (moved.code === 0) {
          await ctx.transport.remove(retired).catch(() => {});
          claimed = true;
          break;
        }
      }
      if (!claimed) {
        await ctx.transport.remove(marker).catch(() => {});
        throw busy(guard);
      }
    }
  }

  const published = await ctx.transport.exec("ln", [marker, ownerFile], { allowFailure: true });
  if (published.code !== 0) {
    if (current !== undefined) {
      const parked = `${guard}/.stale-owner-${current.generation}`;
      const restored = await ctx.transport.exec("ln", [parked, ownerFile], { allowFailure: true });
      if (restored.code === 0) await ctx.transport.remove(parked).catch(() => {});
    }
    if (await readOwner(ctx, ownerFile) !== undefined) await ctx.transport.remove(marker).catch(() => {});
    throw busy(guard, await readOwner(ctx, ownerFile));
  }
  await ctx.transport.remove(marker).catch(() => {});
  if (current !== undefined) await ctx.transport.remove(`${guard}/.stale-owner-${current.generation}`).catch(() => {});
  if (confirmedForeignTakeover && current !== undefined && breakForeignLockHost !== undefined) {
    await recordForeignTakeover(ctx, breakForeignLockHost, current);
  }
  return candidate;
}

async function release(ctx: Context, owner: MutationOwner): Promise<void> {
  const current = await readOwner(ctx, ownerPath(ctx));
  if (current?.generation !== owner.generation) return;
  await ctx.transport.remove(ownerPath(ctx)).catch(() => {});
  await removeEmptyDirectory(ctx, guardPath(ctx));
}

/** Runs a lock-state mutation under the shared, recoverable mutation guard.
 *
 *  `breakForeignLockHost` is the exact host id an operator has confirmed as the orphaned
 *  owner's machine — never inferred, never automatic. A mismatch refuses; a match takes over
 *  and records who did it, when, and which foreign owner it replaced (instance-mutation-guard.ts,
 *  runbook in docs/architecture.md). */
export async function withMutationGuard<T>(
  ctx: Context,
  body: () => Promise<T>,
  breakLock = false,
  breakForeignLockHost?: string,
): Promise<T> {
  const owner = await claim(ctx, breakLock, breakForeignLockHost);
  if (owner === undefined) return body();
  try {
    return await body();
  } finally {
    await release(ctx, owner);
  }
}
