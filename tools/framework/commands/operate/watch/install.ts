// `./clawforge watch install` / `watch uninstall` — a scheduler entry that runs `watch check`
// every N minutes.
//
// crontab, not a systemd --user timer: a timer needs `loginctl enable-linger` and systemd as
// PID 1, neither guaranteed on a minimal Docker host. Cron is the one mechanism every POSIX
// target in scope already runs as a system service.
// Schedule location depends on the TRANSPORT: ssh/local run a real crontab entry; wsl
// (on a Windows host) has no POSIX scheduler, so ../schedule.ts prints (and with --apply, runs)
// the equivalent `schtasks` entry instead.
//
// Crontab conventions and the Windows fallback are shared with `backup install` via
// ../schedule.ts — this file supplies only watch's job name, invocation and interval.

import { info, infoRaw, log, warn } from "../../../core/io/log.ts";
import { deploymentName } from "../../../runtime/deployment.ts";
import { guarded } from "../../../runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "../../../runtime/runtime.ts";
import type { Context } from "../../../core/context.ts";
import type { CommandArgument } from "../../../core/app.ts";
import { parseDeclaredArgs } from "../../../core/command/index.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "../../interface/groups/shared-arguments.ts";
import {
  cronLine as sharedCronLine,
  cronSchedule,
  parseIntervalToMinutes,
  displayCommandLine,
  jobMarker,
  posixTargetInvocation,
  printSchedulingInstructions,
  printUnschedulingInstructions,
  schedulingSupport,
  schedulerIdentity,
  withoutMarkedLine as sharedWithoutMarkedLine,
  updateCrontab,
  type ScheduledInvocation,
} from "../schedule.ts";
import { recordWatchSchedule } from "./state.ts";

export { cronSchedule, displayCommandLine, schedulingSupport };

const JOB = "watch";

/** `watch status`'s own staleness check falls back to this when a state file never recorded
 *  the real interval — one predating this field, or a schedule wired up by hand outside
 *  `watch install --apply` — a documented default (also in docs/guide/monitoring-and-access.md),
 *  never guessed silently per call. */
export const DEFAULT_WATCH_INTERVAL_MINUTES = 5;

/** The slice of `watch`'s declaration `install`'s own argv actually uses. */
export const WATCH_INSTALL_ARGUMENTS: CommandArgument[] = [
  { name: "interval", description: "With install: time between checks (default 5m) — a bare number is minutes, or 30m/6h/1d; minutes must divide 60 (1,2,3,4,5,6,10,12,15,20,30), hours must divide a day (1,2,3,4,6,8,12,24)", kind: "option", valueName: "interval" },
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
    interval = parseIntervalToMinutes(parsed.interval as string);
  }
  return { interval, apply: parsed.apply === true };
}

function parseUninstallArgs(args: string[]): boolean {
  return parseDeclaredArgs(WATCH_UNINSTALL_ARGUMENTS, args).apply === true;
}


export async function watchInstall(ctx: Context, args: string[]): Promise<void> {
  const { interval, apply } = parseInstallArgs(args);
  const support = schedulingSupport(ctx);
  const name = deploymentName();

  if (!support.supported) {
    warn(`cannot install an unattended schedule on ${ctx.transport.description}: ${support.reason}`);
    const installed = await printSchedulingInstructions(ctx, JOB, name, interval, [JOB, "check"], apply);
    if (installed) await recordWatchSchedule(ctx, interval);
    return;
  }

  const invocation = await posixTargetInvocation(ctx, [JOB, "check"]);
  cronLine(interval, invocation, name); // Validate cron syntax before querying the target.
  if (apply) await requireBootstrapped(ctx);
  const identity = await schedulerIdentity(ctx);
  const line = cronLine(interval, invocation, identity);

  log(`crontab entry (every ${interval} minute(s), runs on ${ctx.transport.description})`);
  infoRaw(line);
  info(`marked "${watchMarker(identity)}" — re-running this replaces only that line; watch uninstall removes only it`);
  if (ctx.transport.description.startsWith("ssh:")) {
    info(`assumes this deployment was mirrored to ${ctx.settings.remotePath} by ./clawforge deploy (set OC_REMOTE_PATH if --path differed)`);
  }

  if (!apply) {
    info("add it yourself with `crontab -e`, or re-run with --apply to install it directly");
    return;
  }

  await guarded(ctx, "watch install --apply", args, async () => {
    await updateCrontab(ctx, JOB, identity, line, { name, invocation });
    await recordWatchSchedule(ctx, interval);
    log("installed");
  });
}

export async function watchUninstall(ctx: Context, args: string[]): Promise<void> {
  const apply = parseUninstallArgs(args);
  const support = schedulingSupport(ctx);
  const name = deploymentName();

  if (!support.supported) {
    warn(`no unattended schedule could have been installed on ${ctx.transport.description} in the first place: ${support.reason}`);
    const removed = await printUnschedulingInstructions(ctx, JOB, apply);
    if (removed) await recordWatchSchedule(ctx, undefined);
    return;
  }

  const identity = await schedulerIdentity(ctx);
  const invocation = await posixTargetInvocation(ctx, [JOB, "check"]);

  if (!apply) {
    info(`would remove the crontab entry marked "${watchMarker(identity)}" on ${ctx.transport.description}; re-run with --apply`);
    return;
  }

  await guarded(ctx, "watch uninstall --apply", args, async () => {
    if (!await updateCrontab(ctx, JOB, identity, undefined, { name, invocation })) {
      await recordWatchSchedule(ctx, undefined);
      info("no watch schedule was installed for this deployment — nothing to remove");
      return;
    }
    await recordWatchSchedule(ctx, undefined);
    log("removed");
  });
}
