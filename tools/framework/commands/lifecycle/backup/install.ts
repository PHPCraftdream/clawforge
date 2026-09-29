// `./clawforge backup install` / `backup uninstall` — a scheduler entry that runs
// `./clawforge backup` on an interval, mirroring `watch install`/`watch uninstall` exactly:
// same crontab conventions, same Windows fallback, both built on schedule.ts.
//
// OC_BACKUP_KEEP (.env.example) presumes backups happen on a schedule; this command supplies
// backup's own job name, target invocation and interval shape onto schedule.ts's machinery.
//
// One difference from watch: `--interval` here is a duration string (30m/6h/1d, default 1d),
// parsed by parseIntervalToMinutes into the same minutes cronSchedule() validates, so the two
// commands' intervals can never encode differently for the same duration.

import { info, log, warn } from "#src/core/io/log.ts";
import type { Context } from "#src/core/context.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs, type ActionScope } from "#src/core/arguments.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { guarded } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";
import {
  cronLine,
  crontabLines,
  jobMarker,
  parseIntervalToMinutes,
  posixTargetInvocation,
  printSchedulingInstructions,
  printUnschedulingInstructions,
  probeCrontab,
  readCrontab,
  schedulingSupport,
  withoutMarkedLine,
  writeCrontab,
} from "#src/commands/operate/schedule.ts";
import { BACKUP_APPLY_ARGUMENT } from "./prune-replaced.ts";

const JOB = "backup";
const DEFAULT_BACKUP_INTERVAL = "1d";

/** The slice of `backup`'s declaration `install`'s own argv actually uses. `--apply` is the
 *  shared BACKUP_APPLY_ARGUMENT (prune-replaced.ts), not a second declaration of the same
 *  name — see its own comment for why. */
export const BACKUP_INSTALL_ARGUMENTS: CommandArgument[] = [
  { name: "interval", description: "With install: how often (default 1d) — minutes must divide 60 (e.g. 30m), hours must divide a day (e.g. 6h), or 1d", kind: "option", valueName: "interval", actions: ["install"] },
  BACKUP_APPLY_ARGUMENT,
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

/** The slice `uninstall` uses — no --interval, since there is no schedule to set. A strict
 *  subset of BACKUP_INSTALL_ARGUMENTS's own names, so it is never merged into the top-level
 *  declaration itself (same convention as watch's own WATCH_UNINSTALL_ARGUMENTS). */
export const BACKUP_UNINSTALL_ARGUMENTS: CommandArgument[] = [
  BACKUP_APPLY_ARGUMENT,
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

function parseInstallArgs(args: string[], scope?: ActionScope): { minutes: number; interval: string; apply: boolean } {
  const parsed = parseDeclaredArgs(BACKUP_INSTALL_ARGUMENTS, args, scope);
  const raw = parsed.interval === undefined || parsed.interval === "" ? DEFAULT_BACKUP_INTERVAL : parsed.interval as string;
  return { minutes: parseIntervalToMinutes(raw), interval: raw, apply: parsed.apply === true };
}

function parseUninstallArgs(args: string[], scope?: ActionScope): boolean {
  return parseDeclaredArgs(BACKUP_UNINSTALL_ARGUMENTS, args, scope).apply === true;
}

export async function backupInstall(ctx: Context, args: string[], scope?: ActionScope): Promise<void> {
  const { minutes, interval, apply } = parseInstallArgs(args, scope);
  const support = schedulingSupport(ctx);
  const name = deploymentName();

  if (!support.supported) {
    warn(`cannot install an unattended schedule on ${ctx.transport.description}: ${support.reason}`);
    await printSchedulingInstructions(ctx, JOB, name, minutes, [JOB], apply);
    return;
  }

  const invocation = await posixTargetInvocation(ctx, [JOB]);
  const line = cronLine(minutes, invocation, JOB, name);

  log(`crontab entry (every ${interval}, runs on ${ctx.transport.description})`);
  info(line);
  info(`marked "${jobMarker(JOB, name)}" — re-running this replaces only that line; backup uninstall removes only it`);
  if (ctx.transport.description.startsWith("ssh:")) {
    info(`assumes this deployment was mirrored to ${ctx.settings.remotePath} by ./clawforge deploy (set OC_REMOTE_PATH if --path differed)`);
  }

  if (!apply) {
    info("add it yourself with `crontab -e`, or re-run with --apply to install it directly");
    return;
  }

  await requireBootstrapped(ctx);
  await guarded(ctx, "backup install --apply", args, async () => {
    await probeCrontab(ctx);
    const existing = await readCrontab(ctx);
    const kept = withoutMarkedLine(existing, JOB, name);
    await writeCrontab(ctx, [...kept, line]);
    log("installed");
  });
}

export async function backupUninstall(ctx: Context, args: string[], scope?: ActionScope): Promise<void> {
  const apply = parseUninstallArgs(args, scope);
  const support = schedulingSupport(ctx);
  const name = deploymentName();

  if (!support.supported) {
    warn(`no unattended schedule could have been installed on ${ctx.transport.description} in the first place: ${support.reason}`);
    await printUnschedulingInstructions(JOB, name, apply);
    return;
  }

  if (!apply) {
    info(`would remove the crontab entry marked "${jobMarker(JOB, name)}" on ${ctx.transport.description}; re-run with --apply`);
    return;
  }

  await guarded(ctx, "backup uninstall --apply", args, async () => {
    await probeCrontab(ctx);
    const existing = await readCrontab(ctx);
    const kept = withoutMarkedLine(existing, JOB, name);
    if (kept.length === crontabLines(existing).length) {
      info("no backup schedule was installed for this deployment — nothing to remove");
      return;
    }
    await writeCrontab(ctx, kept);
    log("removed");
  });
}
