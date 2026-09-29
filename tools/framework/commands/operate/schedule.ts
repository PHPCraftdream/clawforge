// Shared OS-scheduler machinery for any command that installs an unattended job on the
// target — `watch install` and `backup install`. One place owns the crontab conventions
// (marker, merge, print, apply) and the Windows fallback, so the two jobs cannot drift.
//
// A job (e.g. "watch", "backup") owns its own marker — jobMarker(job, name) — so re-running
// one job's install only ever replaces that job's own crontab line, never another job's.
//
// Windows has no crontab/systemd: schedulingSupport() says so, and the caller falls back to
// printSchedulingInstructions(), which prints a real `schtasks /create …` line on a Windows
// host, or generic "wire it in yourself" text otherwise. `--apply` on Windows can run that
// line for real, through the same host-spawn helper (spawnLocal) every host-side action
// uses — swappable (withScheduleRunner) so a check can prove the wiring without touching a
// real scheduled task.

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

/** Cron steps fire evenly only when they divide 60 (minutes) or 24 (hours); other steps are
 *  refused. schtasksSchedule() reuses this, so both schedulers accept the same intervals. */
const MINUTE_DIVISORS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const HOUR_DIVISORS = [1, 2, 3, 4, 6, 8, 12, 24];
const VALID_INTERVAL_MINUTES = [...MINUTE_DIVISORS, ...HOUR_DIVISORS.map((hours) => hours * 60)];

function nearestValidIntervals(minutes: number): number[] {
  const below = [...VALID_INTERVAL_MINUTES].reverse().find((value) => value <= minutes);
  const above = VALID_INTERVAL_MINUTES.find((value) => value >= minutes);
  return [...new Set([below, above].filter((value): value is number => value !== undefined))];
}

export function cronSchedule(minutes: number): string {
  if (Number.isInteger(minutes) && MINUTE_DIVISORS.includes(minutes)) return `*/${minutes} * * * *`;
  if (Number.isInteger(minutes) && minutes % 60 === 0 && HOUR_DIVISORS.includes(minutes / 60)) {
    const hours = minutes / 60;
    if (hours === 24) return "0 0 * * *";
    if (hours === 1) return "0 * * * *";
    return `0 */${hours} * * *`;
  }
  const nearest = nearestValidIntervals(minutes).join(", ");
  throw new Error(
    `--interval has no faithful encoding: minutes must divide 60 (${MINUTE_DIVISORS.join(",")}), hours must divide a day (${HOUR_DIVISORS.join(",")}) — nearest valid: ${nearest}`,
  );
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
  } catch (error) {
    die(`--interval ${raw}: ${(error as Error).message}`);
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

/** Only a known no-crontab diagnostic means the table is empty; other failures must stop writes. */
export async function readCrontab(ctx: Context): Promise<string> {
  const listing = await ctx.transport.exec("crontab", ["-l"], { allowFailure: true, env: { LC_ALL: "C" } });
  if (listing.code === 0) return listing.stdout;
  const diagnostic = (listing.stderr || listing.stdout).trim();
  if (listing.code === 1 && /^(?:crontab:\s*)?no crontab for .+$/i.test(diagnostic)) return "";
  die(`could not read crontab on ${ctx.transport.description} (exit ${listing.code}): ${diagnostic || "no diagnostic"}`);
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
  if (description === "local" && schedulerPlatform !== "win32") return { supported: true };
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
      args: [resolve(deploymentDir(), "node_modules", "@clawforge", "framework", "dist", "entry", "bin.js"), "--project-root", deploymentDir(), ...jobArgs],
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
let schedulerPlatform = process.platform;

/** Runs `body` with the scheduler command answered by `substitute` instead of executed. */
export async function withScheduleRunner<T>(substitute: ScheduleRunner, body: () => Promise<T>, platform = process.platform): Promise<T> {
  const previous = scheduleRunner;
  const previousPlatform = schedulerPlatform;
  scheduleRunner = substitute;
  schedulerPlatform = platform;
  try {
    return await body();
  } finally {
    scheduleRunner = previous;
    schedulerPlatform = previousPlatform;
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
 *  to. ssh/local-POSIX never reach here. On any other host (a wsl:/local transport driven
 *  from a non-Windows machine — not possible from shipped entry points, but not ruled out
 *  structurally) this falls back to a purely manual message. */
export async function printSchedulingInstructions(
  ctx: Context,
  job: string,
  name: string,
  minutes: number,
  jobArgs: readonly string[],
  apply: boolean,
): Promise<boolean> {
  const installed = await installedShimExists(deploymentDir());
  const entryHost = installed ? resolve(deploymentDir(), "clawforge") : resolve(monorepoRoot, "clawforge");
  const posixArgs = installed ? [...jobArgs] : ["--app", name, ...jobArgs];
  const entryTarget = await ctx.paths.toTarget(entryHost);
  const invocation = ctx.transport.clientInvocation(entryTarget, posixArgs);
  info("no unattended install exists for this target from here. Run this yourself, on a scheduler that can reach it:");
  info(`  ${displayCommandLine(invocation.command, invocation.args)}`);

  if (schedulerPlatform !== "win32") {
    info("on Windows that means wiring it into Task Scheduler by hand — this command never creates or touches one.");
    if (apply) die("refusing --apply: no correct unattended install exists for this target (see above)");
    return false;
  }

  const action = await windowsScheduledAction(ctx, jobArgs, invocation);
  const taskName = scheduledTaskName(job, name);
  const create = schtasksCreateCommand(taskName, minutes, action);
  info("on Windows, Task Scheduler can run this instead (`/f` replaces the same named task on a re-run):");
  info(`  ${displayCommandLine(create.command, create.args)}`);
  if (!apply) {
    info("run it yourself, or re-run with --apply to have this command run it for you");
    return false;
  }
  const result = await scheduleRunner(create.command, create.args, { allowFailure: true });
  if (result.code !== 0) die(`schtasks could not create ${taskName} (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
  info(`installed via Task Scheduler as "${taskName}"`);
  return true;
}

/** Prints or removes this job's deterministic Task Scheduler entry on Windows. */
export async function printUnschedulingInstructions(job: string, name: string, apply: boolean): Promise<boolean> {
  if (schedulerPlatform !== "win32") {
    info(`remove any entry you wired in yourself (e.g. Windows Task Scheduler): ${scheduledTaskName(job, name)}`);
    if (apply) die("refusing --apply: no correct unattended uninstall exists for this target");
    return false;
  }

  const taskName = scheduledTaskName(job, name);
  const remove = schtasksDeleteCommand(taskName);
  info(`Task Scheduler removal: ${displayCommandLine(remove.command, remove.args)}`);
  if (!apply) {
    info("re-run with --apply to remove this task");
    return false;
  }
  const result = await scheduleRunner(remove.command, remove.args, { allowFailure: true });
  if (result.code !== 0) die(`schtasks could not delete ${taskName} (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
  info(`removed via Task Scheduler: "${taskName}"`);
  return true;
}
