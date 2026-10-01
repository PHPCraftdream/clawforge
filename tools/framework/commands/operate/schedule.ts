// Shared OS-scheduler machinery for any command that installs an unattended job on the
// target — `watch install` and `backup install`. One place owns the crontab conventions
// (marker, merge, print, apply) and the Windows fallback, so the two jobs cannot drift.
// Target-side account flock protects the whole table across different instance locks.
//
// A job (e.g. "watch", "backup") owns a marker keyed by canonical execution-root identity,
// not the human basename, so same-basename deployments cannot replace one another.
//
// Where an unattended crontab is not trusted (a WSL target, or a local one on Windows),
// schedulingSupport() says so and the caller falls back to
// printSchedulingInstructions(), which prints a real `schtasks /create …` line on a Windows
// host, or generic "wire it in yourself" text otherwise. `--apply` on Windows can run that
// line for real, through the same host-spawn helper (spawnLocal) every host-side action
// uses — swappable (withScheduleRunner) so a check can prove the wiring without touching a
// real scheduled task.

import { access, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import { die, info, infoRaw, regexEscape } from "../../core/io/log.ts";
import { monorepoRoot } from "../../core/env.ts";
import { parseInterval } from "../../core/values/durations.ts";
import { ValueError, type ValueParser } from "../../core/values/value.ts";
import { deploymentDir, deploymentName } from "../../runtime/deployment.ts";
import { spawnLocal, SshTransport } from "../../runtime/transport/transport.ts";
import type { Context } from "../../core/context.ts";

export interface ScheduledInvocation {
  readonly cwd: string;
  readonly command: string;
  readonly args: string[];
}

/** The namespace is the scheduler account itself, not the operator's SSH hostname alias.
 * SSH and target-local commands hash the same physical deployment directory. */
export async function schedulerIdentity(ctx: Context): Promise<string> {
  const name = deploymentName();
  let root: string;
  let location = "posix";
  if (ctx.transport.description.startsWith("ssh:")) {
    const result = await ctx.transport.exec("sh", [
      "-c", 'cd -- "$1" && pwd -P', "clawforge-scheduler-root", posix.join(ctx.settings.remotePath, "apps", name),
    ], { allowFailure: true });
    root = result.stdout.replace(/\n$/, "");
    if (result.code !== 0 || !root.startsWith("/") || /[\r\n]/.test(root)) {
      die("could not resolve the scheduled deployment root on target; scheduler unchanged");
    }
  } else {
    root = await realpath(deploymentDir());
    if (schedulerPlatform === "win32") {
      root = root.toLowerCase();
      location = `windows:${ctx.transport.description}`;
    }
  }
  return createHash("sha256").update(JSON.stringify([location, root])).digest("hex");
}

export interface PriorSchedule {
  readonly name: string;
  readonly invocation: ScheduledInvocation;
}

/** One crontab line's trailing marker, and a Task Scheduler task's own name — both identify
 *  "this job, this deployment" so a re-run replaces exactly one entry, never another job's or
 *  another deployment's. */
export function jobMarker(job: string, identity: string): string {
  return `# clawforge-${job}:${identity}`;
}

export function scheduledTaskName(job: string, identity: string): string {
  return `clawforge-${identity}-${job}`;
}

/** Cron steps fire evenly only when they divide 60 (minutes) or 24 (hours); other steps are
 *  refused. schtasksSchedule() reuses this, so both schedulers accept the same intervals. */
const MINUTE_DIVISORS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const HOUR_DIVISORS = [1, 2, 3, 4, 6, 8, 12, 24];
const VALID_INTERVAL_MINUTES = [...MINUTE_DIVISORS, ...HOUR_DIVISORS.map((hours) => hours * 60)];

/** An interval the way `--interval` spells it: 30m, 6h, 1d. */
function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return minutes === 1440 ? "1d" : `${minutes / 60}h`;
}

function nearestValidIntervals(minutes: number): string[] {
  const below = [...VALID_INTERVAL_MINUTES].reverse().find((value) => value <= minutes);
  const above = VALID_INTERVAL_MINUTES.find((value) => value >= minutes);
  return [...new Set([below, above].filter((value): value is number => value !== undefined))].map(formatInterval);
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
    `--interval has no faithful encoding: minutes must divide 60 (${MINUTE_DIVISORS.map(formatInterval).join(",")}), hours must divide a day (${HOUR_DIVISORS.map((hours) => formatInterval(hours * 60)).join(",")}) — nearest valid: ${nearest}`,
  );
}

/** One `--interval` grammar for every scheduled job — the spellings live in
 *  core/values/durations.ts; this adds the scheduler's own rule: an interval is range-checked
 *  through cronSchedule() so no job accepts an interval the cron line itself would then
 *  refuse. */
export function parseIntervalToMinutes(raw: string, options?: { bareMinutes?: boolean }): number {
  const result = parseInterval(raw, {
    requireUnit: options?.bareMinutes === false,
    nearestUnit: (value) => nearestValidIntervals(value).join(", "),
  });
  try {
    cronSchedule(result.minutes);
  } catch (error) {
    die((error as Error).message); // cronSchedule's message already names the flag.
  }
  return result.minutes;
}

export function cronLine(minutes: number, invocation: ScheduledInvocation, job: string, name: string): string {
  if ([invocation.cwd, invocation.command, ...invocation.args, jobMarker(job, name)].some((part) => part.includes("%"))) {
    throw new Error("cron scheduling does not support % in the working directory, command, arguments or marker");
  }
  const args = invocation.args.map((arg) => SshTransport.quote(arg)).join(" ");
  return `${cronSchedule(minutes)} cd ${SshTransport.quote(invocation.cwd)} && ${invocation.command} ${args} >/dev/null 2>&1 ${jobMarker(job, name)}`;
}

export function withoutMarkedLine(text: string, job: string, name: string, prior?: PriorSchedule): string[] {
  return crontabLines(text).filter((line) => !new RegExp(ownedCronPattern(job, name, prior)).test(line));
}

export function crontabLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Shared JS/POSIX ERE ownership predicate for local previews and locked target edits. */
function ownedCronPattern(job: string, name: string, prior?: PriorSchedule): string {
  const jobArgs = job === "watch" ? ["watch", "check"] : job === "backup" ? ["backup"] : undefined;
  if (jobArgs === undefined || /[%\r\n]/.test(name)) return "^$.";
  const quoted = (args: readonly string[]): string => args.map(SshTransport.quote).join(" ");
  const schedules = VALID_INTERVAL_MINUTES.map((minutes) => regexEscape(cronSchedule(minutes))).join("|");
  const args = `(${regexEscape(quoted(jobArgs))}|'--app' '[^'%]+' ${regexEscape(quoted(jobArgs))})`;
  const current = `(${schedules}) cd ('([^'%]|'\\\\'')*') && \\./clawforge ${args} >/dev/null 2>&1 ${regexEscape(jobMarker(job, name))}`;
  // Old basename markers are not ownership evidence. Only the exact invocation
  // produced for this root can be migrated; manual/other-root rows stay untouched.
  const invocation = prior?.invocation;
  const legacy = prior !== undefined && invocation !== undefined &&
    ![prior.name, invocation.cwd, invocation.command, ...invocation.args].some((part) => /[%\r\n]/.test(part))
    ? `|(${schedules}) ${regexEscape(`cd ${SshTransport.quote(invocation.cwd)} && ${invocation.command} ${quoted(invocation.args)} >/dev/null 2>&1 ${jobMarker(job, prior.name)}`)}`
    : "";
  return `^(${current}${legacy})\r?$`;
}

function ownedCronLine(line: string, job: string, name: string): boolean {
  return new RegExp(ownedCronPattern(job, name)).test(line);
}

/** Only a known no-crontab diagnostic means the table is empty; other failures must stop writes. */
export async function readCrontab(ctx: Context): Promise<string> {
  const listing = await ctx.transport.exec("crontab", ["-l"], { allowFailure: true, env: { LC_ALL: "C" } });
  if (listing.code === 0) return listing.stdout;
  const diagnostic = (listing.stderr || listing.stdout).trim();
  if (listing.code === 1 && /^(?:crontab:\s*)?no crontab for .+$/i.test(diagnostic) && (listing.stderr.trim() === "" || listing.stdout.trim() === "")) return "";
  die(`could not read crontab on ${ctx.transport.description} (exit ${listing.code}); table unchanged`);
}

const CRONTAB_FAILURES: Readonly<Record<number, string>> = {
  20: "crontab is not available",
  21: "flock is required to serialize scheduler updates",
  22: "could not identify scheduler account",
  23: "unsafe scheduler lock parent /tmp (expected root-owned sticky directory, mode 1777, no symlink)",
  24: "unsafe scheduler lock directory (expected account-owned directory, mode 700, no symlink)",
  25: "could not open scheduler account lock",
  26: "could not acquire scheduler account lock within 30 seconds; retry after the other update finishes",
  27: "could not create private transaction files",
  28: "could not read crontab; table unchanged",
  29: "could not filter crontab; table unchanged",
  30: "could not prepare crontab entry; table unchanged",
  31: "invalid scheduler mutation",
  32: "could not compare crontab; table unchanged",
  33: "could not update crontab",
};

/** One target process holds the account lock from crontab read through replacement. */
const CRONTAB_TRANSACTION = `
set -u
export LC_ALL=C
umask 077
fail() { code=$1; shift; printf 'crontab transaction: %s\\n' "$*" >&2; exit "$code"; }
command -v crontab >/dev/null 2>&1 || fail 20 'crontab is not available'
command -v flock >/dev/null 2>&1 || fail 21 'flock is required to serialize scheduler updates'
uid=$(id -u) || fail 22 'could not identify scheduler account'
case "$uid" in ''|*[!0-9]*) fail 22 'invalid scheduler account uid';; esac
[ ! -L /tmp ] && [ "$(stat -c '%u:%a' /tmp)" = 0:1777 ] || fail 23 'lock parent /tmp must be a root-owned sticky directory (1777), not a symlink'
lock_dir=/tmp/clawforge-crontab-$uid
mkdir -m 700 -- "$lock_dir" 2>/dev/null || :
[ ! -L "$lock_dir" ] && [ -d "$lock_dir" ] && [ "$(stat -c '%u:%a' -- "$lock_dir")" = "$uid:700" ] || fail 24 'unsafe scheduler lock directory (expected account-owned directory, mode 700, no symlink)'
exec 9< "$lock_dir" || fail 25 'could not open scheduler account lock'
flock -x -w 30 9 || fail 26 'could not acquire scheduler account lock within 30 seconds; retry after the other update finishes'
work=$(mktemp -d "$lock_dir/transaction.XXXXXXXXXX") || fail 27 'could not create private transaction directory'
trap 'rm -f -- "$work/current" "$work/next" "$work/error"; rmdir -- "$work"' EXIT
trap 'exit 143' HUP INT TERM
if crontab -l > "$work/current" 2> "$work/error"; then :; else
  code=$?
  diagnostic=$(cat -- "$work/error")
  [ -n "$diagnostic" ] || diagnostic=$(cat -- "$work/current")
  if [ "$code" = 1 ] && { [ ! -s "$work/error" ] || [ ! -s "$work/current" ]; } && [ "$(printf '%s\\n' "$diagnostic" | wc -l)" -eq 1 ] && printf '%s\\n' "$diagnostic" | grep -Eiq '^(crontab:[[:space:]]*)?no crontab for .+$'; then
    : > "$work/current" || fail 27 'could not initialize empty table'
  else
    fail 28 "could not read crontab (exit $code); table unchanged"
  fi
fi
grep -Ev -- "$1" "$work/current" > "$work/next"
code=$?
[ "$code" -le 1 ] || fail 29 'could not filter crontab; table unchanged'
if [ "$3" = install ]; then
  printf '%s\\n' "$2" >> "$work/next" || fail 30 'could not prepare crontab entry; table unchanged'
elif [ "$3" != uninstall ]; then
  fail 31 'invalid scheduler mutation'
fi
cmp -s -- "$work/current" "$work/next"
code=$?
if [ "$code" = 0 ]; then printf 'unchanged\\n'; exit 0; fi
[ "$code" = 1 ] || fail 32 'could not compare crontab; table unchanged'
if crontab - < "$work/next" > "$work/error" 2>&1; then :; else
  code=$?
  fail 33 "could not update crontab (exit $code)"
fi
printf 'updated\\n'
`;

/** Updates one owned job under a target-account flock, independent of instance data paths. */
export async function updateCrontab(ctx: Context, job: string, name: string, line?: string, prior?: PriorSchedule): Promise<boolean> {
  if (line !== undefined && /[\r\n]/.test(line)) die("a scheduled crontab entry must be exactly one line");
  if (line !== undefined && !ownedCronLine(line, job, name)) die("a scheduled crontab entry must match its job and deployment");
  const result = await ctx.transport.exec("sh", [
    "-c", CRONTAB_TRANSACTION, "clawforge-crontab-update", ownedCronPattern(job, name, prior), line ?? "", line === undefined ? "uninstall" : "install",
  ], { allowFailure: true });
  if (result.code !== 0) {
    const reason = CRONTAB_FAILURES[result.code] ?? "target scheduler transaction failed";
    die(`could not update crontab on ${ctx.transport.description} (exit ${result.code}): ${reason}`);
  }
  if (result.stdout.trim() === "updated") return true;
  if (result.stdout.trim() === "unchanged") return false;
  die(`could not confirm crontab update on ${ctx.transport.description}: unexpected transaction response`);
}

export interface SchedulingSupport {
  readonly supported: boolean;
  readonly reason?: string;
}

/** ssh and a POSIX `local` are real, always-on machines this framework already knows how to
 *  reach unattended; a WSL Docker host has no crontab/systemd this tooling can trust to be
 *  there. A `local` target on Windows is refused by createTransport, so it never gets here. */
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
  return { supported: false, reason: "this target has no crontab this command can install into" };
}

/** One pasteable command line: an argument with spaces or shell operators (WSL's
 *  `bash -lc "cd … && ./clawforge …"`) is one argv element and must stay quoted, or `&&`
 *  would be run by whatever shell the operator pastes it into. Also how a `schtasks /tr`
 *  value is built: it takes exactly one string the same way. */
export function displayCommandLine(command: string, args: readonly string[]): string {
  const quote = (value: string): string => (/^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replaceAll(`"`, `\\"`)}"`);
  return [command, ...args].map(quote).join(" ");
}

/** `displayCommandLine` as cmd.exe would run it, or undefined when it cannot be pasted there
 *  safely: `%` expands even inside quotes, and `& | < > ^` outside them split or redirect. */
export function cmdExeLine(command: string, args: readonly string[]): string | undefined {
  const line = displayCommandLine(command, args);
  if (line.includes("%")) return undefined;
  let quoted = false; // cmd.exe toggles on every `"`, backslash or not.
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && "&|<>^".includes(char)) return undefined;
  }
  return line;
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

/** cron's own accepted range (cronSchedule), translated into schtasks' vocabulary: a bare
 *  minute count under an hour, or an hour/day step above it. */
export function schtasksSchedule(minutes: number): { readonly sc: string; readonly mo?: string } {
  cronSchedule(minutes); // the one place that range is validated — reused, not copied.
  if (minutes <= 59) return { sc: "MINUTE", mo: String(minutes) };
  const hours = minutes / 60;
  return hours === 24 ? { sc: "DAILY" } : { sc: "HOURLY", mo: String(hours) };
}

/** schtasks rejects a /tr value longer than this ("Value for '/tr' option cannot be more than 261 character(s)"). */
export const SCHTASKS_RUN_LIMIT = 261;

/** `/f` forces overwrite: re-running this replaces the SAME named task instead of schtasks
 *  refusing "already exists" — Task Scheduler's counterpart to crontab's marked-line
 *  replace, keyed by task name instead of a marker inside a shared file. */
export function schtasksCreateCommand(taskName: string, minutes: number, action: { readonly command: string; readonly args: readonly string[] }): { command: string; args: string[] } {
  const { sc, mo } = schtasksSchedule(minutes);
  const run = displayCommandLine(action.command, action.args);
  if (run.length > SCHTASKS_RUN_LIMIT) {
    throw new Error(
      `the Task Scheduler action is ${run.length} characters and schtasks accepts at most ${SCHTASKS_RUN_LIMIT} for /tr — ` +
      "shorten the deployment's path (move it to a shorter directory) or its app name, then re-run",
    );
  }
  return {
    command: "schtasks",
    args: ["/create", "/tn", taskName, "/sc", sc, ...(mo === undefined ? [] : ["/mo", mo]), "/tr", run, "/f"],
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

/** Prints — and, with `apply` on an actual Windows host, also runs through scheduleRunner —
 *  what an operator-side scheduler needs on a transport schedulingSupport() already said no
 *  to. ssh/local-POSIX never reach here. On Windows only a WSL target does; on any other
 *  host (not possible from shipped entry points, but not ruled out structurally) this
 *  falls back to a purely manual message. Refuses a /tr longer than schtasks accepts. */
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
  infoRaw(`  ${displayCommandLine(invocation.command, invocation.args)}`);

  // Only a WSL target on a Windows host has a schtasks line to offer (local is refused on Windows).
  if (schedulerPlatform !== "win32" || !ctx.transport.description.startsWith("wsl:")) {
    info("on Windows that means wiring it into Task Scheduler by hand — this command never creates or touches one.");
    if (apply) die("refusing --apply: no correct unattended install exists for this target (see above)");
    return false;
  }

  const taskName = scheduledTaskName(job, await schedulerIdentity(ctx));
  let create: { command: string; args: string[] };
  try {
    create = schtasksCreateCommand(taskName, minutes, invocation);
  } catch (error) {
    return die((error as Error).message);
  }
  const pasteable = cmdExeLine(create.command, create.args);
  if (pasteable === undefined) {
    info("on Windows, Task Scheduler can run this instead, but a path here has a character (% & | < > ^) that cannot be pasted into cmd.exe; use --apply");
  } else {
    info("on Windows, Task Scheduler can run this instead — paste it into cmd.exe only (not PowerShell or Git Bash; use --apply there). `/f` replaces the same named task on a re-run:");
    infoRaw(`  ${pasteable}`);
  }
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
export async function printUnschedulingInstructions(ctx: Context, job: string, apply: boolean): Promise<boolean> {
  if (schedulerPlatform !== "win32") {
    info(`remove any entry you wired in yourself (e.g. Windows Task Scheduler): ${scheduledTaskName(job, await schedulerIdentity(ctx))}`);
    if (apply) die("refusing --apply: no correct unattended uninstall exists for this target");
    return false;
  }

  const taskName = scheduledTaskName(job, await schedulerIdentity(ctx));
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

/** `--interval` as an argument parser over parseIntervalToMinutes: the same refusal sentences,
 *  with the leading `--interval` left to the argument's label. */
export function scheduleIntervalValue(options: { bareMinutes: boolean }): ValueParser<number> {
  return {
    expected: "an interval such as 30m, 6h or 1d",
    example: "30m",
    invalidExample: "7x",
    parse(raw) {
      try {
        return parseIntervalToMinutes(raw, options);
      } catch (error) {
        const message = (error as Error).message;
        throw new ValueError(message.startsWith("--interval ") ? message.slice("--interval ".length) : `: ${message}`);
      }
    },
  };
}
