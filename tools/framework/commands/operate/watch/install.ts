// `./clawforge watch install` / `watch uninstall` — a scheduler entry that runs `watch check`
// every N minutes.
//
// crontab, not a systemd --user timer: a timer needs `loginctl enable-linger` and systemd as
// PID 1, neither guaranteed on a minimal Docker host. Cron is the one mechanism every POSIX
// target in scope already runs as a system service.
// Schedule location depends on the TRANSPORT: ssh/local run a real crontab entry; wsl and
// local-on-win32 have no POSIX scheduler, so ../schedule.ts prints (and with --apply, runs)
// the equivalent `schtasks` entry instead.
//
// Crontab conventions and the Windows fallback are shared with `backup install` via
// ../schedule.ts — this file supplies only watch's job name, invocation and interval.

import { die, info, log, warn } from "../../../core/io/log.ts";
import { deploymentName } from "../../../runtime/deployment.ts";
import { guarded } from "../../../runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "../../../runtime/runtime.ts";
import type { Context } from "../../../core/context.ts";
import type { CommandArgument } from "../../../core/app.ts";
import { parseDeclaredArgs } from "../../../core/arguments.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "../../interface/groups/shared-arguments.ts";
import {
  cronLine as sharedCronLine,
  crontabLines,
  cronSchedule,
  displayCommandLine,
  jobMarker,
  posixTargetInvocation,
  printSchedulingInstructions,
  printUnschedulingInstructions,
  probeCrontab,
  readCrontab,
  schedulingSupport,
  withoutMarkedLine as sharedWithoutMarkedLine,
  writeCrontab,
  type ScheduledInvocation,
} from "../schedule.ts";
import { readWatchState, writeWatchState } from "./state.ts";

export { cronSchedule, displayCommandLine, schedulingSupport };

const JOB = "watch";

/** `watch status`'s own staleness check falls back to this when a state file never recorded
 *  the real interval — one predating this field, or a schedule wired up by hand outside
 *  `watch install --apply` — a documented default (also in docs/guide/monitoring-and-access.md),
 *  never guessed silently per call. */
export const DEFAULT_WATCH_INTERVAL_MINUTES = 5;

/** The slice of `watch`'s declaration `install`'s own argv actually uses. */
export const WATCH_INSTALL_ARGUMENTS: CommandArgument[] = [
  { name: "interval", description: "With install: minutes between checks (default 5); must divide 60 (1,2,3,4,5,6,10,12,15,20,30), or be a whole-hour step dividing a day (60,120,180,240,360,480,720,1440)", kind: "option", valueName: "minutes" },
  { name: "apply", description: "With install/uninstall: mutate the target's crontab instead of only printing it", kind: "flag" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

/** The slice `uninstall` uses — no --interval, since there is no schedule to set. */
export const WATCH_UNINSTALL_ARGUMENTS: CommandArgument[] = [
  { name: "apply", description: "With install/uninstall: mutate the target's crontab instead of only printing it", kind: "flag" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

export function watchMarker(name: string): string {
  return jobMarker(JOB, name);
}

/** watch's own 3-arg convention (no job parameter — it only ever schedules itself),
 *  predating schedule.ts's job-parameterized shared builder. */
export function cronLine(minutes: number, invocation: ScheduledInvocation, name: string): string {
  return sharedCronLine(minutes, invocation, JOB, name);
}

export function withoutMarkedLine(text: string, name: string): string[] {
  return sharedWithoutMarkedLine(text, JOB, name);
}

function parseInstallArgs(args: string[]): { interval: number; apply: boolean } {
  const parsed = parseDeclaredArgs(WATCH_INSTALL_ARGUMENTS, args);
  let interval = DEFAULT_WATCH_INTERVAL_MINUTES;
  if (parsed.interval !== undefined) {
    const raw = parsed.interval === "" ? undefined : parsed.interval as string;
    const numeric = raw === undefined ? Number.NaN : Number(raw);
    try {
      cronSchedule(numeric);
    } catch (error) {
      die((error as Error).message);
    }
    interval = numeric;
  }
  return { interval, apply: parsed.apply === true };
}

function parseUninstallArgs(args: string[]): boolean {
  return parseDeclaredArgs(WATCH_UNINSTALL_ARGUMENTS, args).apply === true;
}

/** Records (or clears) the real interval on this deployment's own watch state, so `watch
 *  status`'s staleness check compares against what was actually installed rather than a
 *  guess — the operator-side state file every watch action already shares (state.ts's own
 *  header), regardless of which transport the schedule itself runs on. */
async function recordInstalledInterval(minutes: number | undefined): Promise<void> {
  const previous = await readWatchState();
  await writeWatchState({ ...previous, intervalMinutes: minutes });
}

export async function watchInstall(ctx: Context, args: string[]): Promise<void> {
  const { interval, apply } = parseInstallArgs(args);
  const support = schedulingSupport(ctx);
  const name = deploymentName();

  if (!support.supported) {
    warn(`cannot install an unattended schedule on ${ctx.transport.description}: ${support.reason}`);
    const installed = await printSchedulingInstructions(ctx, JOB, name, interval, [JOB, "check"], apply);
    if (installed) await recordInstalledInterval(interval);
    return;
  }

  const invocation = await posixTargetInvocation(ctx, [JOB, "check"]);
  const line = cronLine(interval, invocation, name);

  log(`crontab entry (every ${interval} minute(s), runs on ${ctx.transport.description})`);
  info(line);
  info(`marked "${watchMarker(name)}" — re-running this replaces only that line; watch uninstall removes only it`);
  if (ctx.transport.description.startsWith("ssh:")) {
    info(`assumes this deployment was mirrored to ${ctx.settings.remotePath} by ./clawforge deploy (set OC_REMOTE_PATH if --path differed)`);
  }

  if (!apply) {
    info("add it yourself with `crontab -e`, or re-run with --apply to install it directly");
    return;
  }

  await requireBootstrapped(ctx);
  await guarded(ctx, "watch install --apply", args, async () => {
    await probeCrontab(ctx);
    const existing = await readCrontab(ctx);
    const kept = withoutMarkedLine(existing, name);
    await writeCrontab(ctx, [...kept, line]);
    await recordInstalledInterval(interval);
    log("installed");
  });
}

export async function watchUninstall(ctx: Context, args: string[]): Promise<void> {
  const apply = parseUninstallArgs(args);
  const support = schedulingSupport(ctx);
  const name = deploymentName();

  if (!support.supported) {
    warn(`no unattended schedule could have been installed on ${ctx.transport.description} in the first place: ${support.reason}`);
    const removed = await printUnschedulingInstructions(JOB, name, apply);
    if (removed) await recordInstalledInterval(undefined);
    return;
  }

  if (!apply) {
    info(`would remove the crontab entry marked "${watchMarker(name)}" on ${ctx.transport.description}; re-run with --apply`);
    return;
  }

  await guarded(ctx, "watch uninstall --apply", args, async () => {
    await probeCrontab(ctx);
    const existing = await readCrontab(ctx);
    const kept = withoutMarkedLine(existing, name);
    if (kept.length === crontabLines(existing).length) {
      info("no watch schedule was installed for this deployment — nothing to remove");
      return;
    }
    await writeCrontab(ctx, kept);
    await recordInstalledInterval(undefined);
    log("removed");
  });
}
