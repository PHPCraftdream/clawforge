// Shared OS-scheduler machinery for any command that installs an unattended job on the
// target — today `watch install` (watch/install.ts) and `backup install`
// (lifecycle/backup/install.ts). One place owns the crontab conventions (marker, merge,
// print, apply) and the Windows fallback, so the two jobs cannot drift into two slightly
// different implementations of the same idea.
//
// A job (e.g. "watch", "backup") owns its own marker — jobMarker(job, name) — so re-running
// one job's install only ever replaces that job's own crontab line, never another job's,
// even for the same deployment.
//
// Windows has no crontab/systemd: schedulingSupport() below says so, and the caller falls
// back to printSchedulingInstructions(), which prints the exact command an operator-side
// scheduler needs — a real `schtasks /create …` line on a Windows host, since Task Scheduler
// really can run one, and only the generic "wire it in yourself" text for anything else
// (a WSL/Windows-shaped transport driven from a non-Windows host, which cannot happen from
// the shipped entry points but is not ruled out structurally). `--apply` on a Windows host
// can additionally run that line for real, through the same host-spawn helper (spawnLocal)
// every other host-side action already uses — swappable (withScheduleRunner) so a check can
// prove the wiring without ever touching a real scheduled task.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { die, info } from "../../core/io/log.ts";
import { monorepoRoot } from "../../core/env.ts";
import { deploymentDir, deploymentName } from "../../runtime/deployment.ts";
import { spawnLocal, SshTransport } from "../../runtime/transport/transport.ts";
import type { Context } from "../../core/context.ts";

export interface ScheduledInvocation {
  readonly cwd: string;
  readonly command: string;
  readonly args: string[];
}

/** One crontab line's trailing marker, and a Task Scheduler task's own name — both identify
 *  "this job, this deployment" so a re-run replaces exactly one entry, never another job's or
 *  another deployment's. */
export function jobMarker(job: string, name: string): string {
  return `# clawforge-${job}:${name}`;
}

export function scheduledTaskName(job: string, name: string): string {
  return `clawforge-${name}-${job}`;
}

/** A step in cron's minute field only works up to 59; whole hours step the hour field.
 *  Anything else has no faithful encoding and is refused — reused by schtasksSchedule()
 *  below so the two schedulers never accept an interval the other would refuse. */
export function cronSchedule(minutes: number): string {
  if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 59) return `*/${minutes} * * * *`;
  if (Number.isInteger(minutes) && minutes >= 60 && minutes <= 1440 && minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours === 24) return "0 0 * * *";
    if (hours === 1) return "0 * * * *";
    return `0 */${hours} * * *`;
  }
  throw new Error("--interval must be 1-59 minutes, or an exact multiple of 60 up to 1440 (60, 120, …, 1440)");
}

/** "30m" / "6h" / "1d" → minutes, for a command whose own --interval takes a duration string
 *  rather than watch's bare minute count. Range-checked through cronSchedule() so the two
 *  parsers cannot silently accept an interval the cron line itself would then refuse. */
export function parseIntervalToMinutes(raw: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(raw.trim());
  if (match === null) die(`--interval must look like 30m, 6h or 1d (minutes, hours or days) — got "${raw}"`);
  const value = Number(match[1]);
  const unit = match[2];
  const minutes = unit === "m" ? value : unit === "h" ? value * 60 : value * 1440;
  try {
    cronSchedule(minutes);
  } catch {
    die(`--interval ${raw} is out of range — minutes must be 1-59, hours an exact divisor of a day, or exactly 1d`);
  }
  return minutes;
}

export function cronLine(minutes: number, invocation: ScheduledInvocation, job: string, name: string): string {
  const args = invocation.args.map((arg) => SshTransport.quote(arg)).join(" ");
  return `${cronSchedule(minutes)} cd ${SshTransport.quote(invocation.cwd)} && ${invocation.command} ${args} >/dev/null 2>&1 ${jobMarker(job, name)}`;
}

export function withoutMarkedLine(text: string, job: string, name: string): string[] {
  const needle = jobMarker(job, name);
  return text.split("\n").filter((line) => line.trim() !== "" && !line.includes(needle));
}

export async function probeCrontab(ctx: Context): Promise<void> {
  const found = await ctx.transport.exec("sh", ["-c", "command -v crontab"], { allowFailure: true });
  if (found.code !== 0 || found.stdout.trim() === "") {
    die(`crontab is not available on ${ctx.transport.description} — install a cron package there first (e.g. cronie, vixie-cron)`);
  }
}

/** crontab -l exits non-zero both for "no crontab yet for this user" (the ordinary case once
 *  probeCrontab() above already proved the binary exists) and for a real failure; only the
 *  former is expected to reach here, so it reads as empty rather than as an error. */
export async function readCrontab(ctx: Context): Promise<string> {
  const listing = await ctx.transport.exec("crontab", ["-l"], { allowFailure: true });
  return listing.code === 0 ? listing.stdout : "";
}

export async function writeCrontab(ctx: Context, lines: string[]): Promise<void> {
  const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  const result = await ctx.transport.exec("crontab", ["-"], { input: content, allowFailure: true });
  if (result.code !== 0) {
    die(`could not update crontab on ${ctx.transport.description} (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}

export interface SchedulingSupport {
  readonly supported: boolean;
  readonly reason?: string;
}

/** ssh and a POSIX `local` are real, always-on machines this framework already knows how to
 *  reach unattended; everything else (a WSL Docker host, `local` on Windows) has no
 *  crontab/systemd this tooling can trust to be there. */
export function schedulingSupport(ctx: Context): SchedulingSupport {
  const description = ctx.transport.description;
  if (description.startsWith("ssh:")) return { supported: true };
  if (description === "local" && process.platform !== "win32") return { supported: true };
  if (description.startsWith("wsl:")) {
    return {
      supported: false,
      reason:
        "the WSL distro Docker runs in is a container host, not a place this tooling's own node + checkout are " +
        "proven to also run — a crontab entry installed there cannot be trusted to find either one unattended",
    };
  }
  return { supported: false, reason: "Windows has no crontab or systemd for this command to install into" };
}

/** One pasteable command line: an argument with spaces or shell operators (WSL's
 *  `bash -lc "cd … && ./clawforge …"`) is one argv element and must stay quoted, or `&&`
 *  would be run by whatever shell the operator pastes it into. Also how a `schtasks /tr`
 *  value is built: it takes exactly one string the same way. */
export function displayCommandLine(command: string, args: readonly string[]): string {
  const quote = (value: string): string => (/^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replaceAll(`"`, `\\"`)}"`);
  return [command, ...args].map(quote).join(" ");
}

export async function installedShimExists(root: string): Promise<boolean> {
  return access(resolve(root, "clawforge")).then(
    () => true,
    () => false,
  );
}

/** Where and how a job runs once it IS scheduled on a POSIX target — see schedulingSupport's
 *  own reasoning for why this is only asked once that already said yes. */
export async function posixTargetInvocation(ctx: Context, jobArgs: readonly string[]): Promise<ScheduledInvocation> {
  const name = deploymentName();
  if (ctx.transport.description.startsWith("ssh:")) {
    return { cwd: ctx.settings.remotePath, command: "./clawforge", args: ["--app", name, ...jobArgs] };
  }
  const installed = await installedShimExists(deploymentDir());
  return installed
    ? { cwd: deploymentDir(), command: "./clawforge", args: [...jobArgs] }
    : { cwd: monorepoRoot, command: "./clawforge", args: ["--app", name, ...jobArgs] };
}

/** Node itself, invoked directly — the Windows counterpart to posixTargetInvocation's
 *  `./clawforge` shim. `schtasks /tr` has no shell of its own to run a bash script through,
 *  unlike crontab's real shell, so this cannot reuse the shim path at all. */
async function windowsNodeInvocation(jobArgs: readonly string[]): Promise<ScheduledInvocation> {
  const name = deploymentName();
  const installed = await installedShimExists(deploymentDir());
  if (installed) {
    return {
      cwd: deploymentDir(),
      command: process.execPath,
      args: [resolve(deploymentDir(), "node_modules", "@clawforge", "framework", "dist", "entry", "bin.js"), ...jobArgs],
    };
  }
  return {
    cwd: monorepoRoot,
    command: process.execPath,
    args: ["--experimental-strip-types", resolve(monorepoRoot, "tools", "clawforge.ts"), "--app", name, ...jobArgs],
  };
}

/** cron's own accepted range (cronSchedule), translated into schtasks' vocabulary: a bare
 *  minute count under an hour, or an hour/day step above it. */
export function schtasksSchedule(minutes: number): { readonly sc: string; readonly mo?: string } {
  cronSchedule(minutes); // the one place that range is validated — reused, not copied.
  if (minutes <= 59) return { sc: "MINUTE", mo: String(minutes) };
  const hours = minutes / 60;
  return hours === 24 ? { sc: "DAILY" } : { sc: "HOURLY", mo: String(hours) };
}

/** `/f` forces overwrite: re-running this replaces the SAME named task instead of schtasks
 *  refusing "already exists" — Task Scheduler's counterpart to crontab's marked-line
 *  replace, keyed by task name instead of a marker inside a shared file. */
export function schtasksCreateCommand(taskName: string, minutes: number, action: { readonly command: string; readonly args: readonly string[] }): { command: string; args: string[] } {
  const { sc, mo } = schtasksSchedule(minutes);
  return {
    command: "schtasks",
    args: ["/create", "/tn", taskName, "/sc", sc, ...(mo === undefined ? [] : ["/mo", mo]), "/tr", displayCommandLine(action.command, action.args), "/f"],
  };
}

export function schtasksDeleteCommand(taskName: string): { command: string; args: string[] } {
  return { command: "schtasks", args: ["/delete", "/tn", taskName, "/f"] };
}

/** What actually runs a Windows scheduler command — spawnLocal, the same host-spawn helper
 *  `host local`'s own execution and every other bare-machine action already uses. A seam,
 *  for the same reason set-manifest.ts's tarRunner is one: a check must prove --apply wires
 *  this through without ever really creating a scheduled task. */
type ScheduleRunner = typeof spawnLocal;
let scheduleRunner: ScheduleRunner = spawnLocal;

/** Runs `body` with the scheduler command answered by `substitute` instead of executed. */
export async function withScheduleRunner<T>(substitute: ScheduleRunner, body: () => Promise<T>): Promise<T> {
  const previous = scheduleRunner;
  scheduleRunner = substitute;
  try {
    return await body();
  } finally {
    scheduleRunner = previous;
  }
}

/** The command a Windows Task Scheduler entry needs for `job` on the current deployment —
 *  wsl: the same `wsl.exe -d <distro> -- …` line a human would run (WslTransport's own
 *  clientInvocation, already built from the configured OC_WSL_DISTRO); a native Windows host
 *  (`local` transport): node invoked directly, since there is no shell here to run the bash
 *  shim through. */
async function windowsScheduledAction(
  ctx: Context,
  jobArgs: readonly string[],
  posixInvocation: { readonly command: string; readonly args: readonly string[] },
): Promise<{ command: string; args: readonly string[] }> {
  if (ctx.transport.description.startsWith("wsl:")) return posixInvocation;
  return windowsNodeInvocation(jobArgs);
}

/** Prints — and, with `apply` on an actual Windows host, also runs through scheduleRunner —
 *  what an operator-side scheduler needs on a transport schedulingSupport() already said no
 *  to. ssh/local-POSIX never reach here at all.
 *
 *  On any other host (a wsl:/local transport somehow driven from a non-Windows machine,
 *  which cannot happen from the shipped entry points but is not ruled out structurally) this
 *  falls back to the old, purely manual message — there is no scheduler this code knows how
 *  to drive there either. */
export async function printSchedulingInstructions(
  ctx: Context,
  job: string,
  name: string,
  minutes: number,
  jobArgs: readonly string[],
  apply: boolean,
): Promise<void> {
  const installed = await installedShimExists(deploymentDir());
  const entryHost = installed ? resolve(deploymentDir(), "clawforge") : resolve(monorepoRoot, "clawforge");
  const posixArgs = installed ? [...jobArgs] : ["--app", name, ...jobArgs];
  const entryTarget = await ctx.paths.toTarget(entryHost);
  const invocation = ctx.transport.clientInvocation(entryTarget, posixArgs);
  info("no unattended install exists for this target from here. Run this yourself, on a scheduler that can reach it:");
  info(`  ${displayCommandLine(invocation.command, invocation.args)}`);

  if (process.platform !== "win32") {
    info("on Windows that means wiring it into Task Scheduler by hand — this command never creates or touches one.");
    if (apply) die("refusing --apply: no correct unattended install exists for this target (see above)");
    return;
  }

  const action = await windowsScheduledAction(ctx, jobArgs, invocation);
  const taskName = scheduledTaskName(job, name);
  const create = schtasksCreateCommand(taskName, minutes, action);
  info("on Windows, Task Scheduler can run this instead (`/f` replaces the same named task on a re-run):");
  info(`  ${displayCommandLine(create.command, create.args)}`);
  if (!apply) {
    info("run it yourself, or re-run with --apply to have this command run it for you");
    return;
  }
  const result = await scheduleRunner(create.command, create.args, { allowFailure: true });
  if (result.code !== 0) die(`schtasks could not create ${taskName} (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
  info(`installed via Task Scheduler as "${taskName}"`);
}
