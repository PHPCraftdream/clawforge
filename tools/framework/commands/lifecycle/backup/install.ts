// `./clawforge backup install` / `backup uninstall` — a scheduler entry that runs
// `./clawforge backup` on an interval, mirroring `watch install`/`watch uninstall` exactly:
// same crontab conventions, same Windows fallback, both built on schedule.ts.
//
// OC_BACKUP_KEEP (.env.example) presumes backups happen on a schedule; this command supplies
// backup's own job name, target invocation and interval shape onto schedule.ts's machinery.
//
// `--interval` is the shared duration grammar (30m/6h/1d or bare minutes; default 1d),
// parsed by parseIntervalToMinutes — the same parser `watch install` uses — into the minutes
// cronSchedule() validates, so the two commands cannot drift.

import { info, infoRaw, log, warn } from "#src/core/io/log.ts";
import type { Context } from "#src/core/context.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs, type ActionScope } from "#src/core/arguments.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { guarded } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";
import {
  cronLine,
  jobMarker,
  parseIntervalToMinutes,
  posixTargetInvocation,
  printSchedulingInstructions,
  printUnschedulingInstructions,
  schedulingSupport,
  schedulerIdentity,
  updateCrontab,
} from "#src/commands/operate/schedule.ts";
import { BACKUP_APPLY_ARGUMENT } from "./prune-replaced.ts";

const JOB = "backup";
const DEFAULT_BACKUP_INTERVAL = "1d";

/** The slice of `backup`'s declaration `install`'s own argv actually uses. `--apply` is the
 *  shared BACKUP_APPLY_ARGUMENT (prune-replaced.ts), not a second declaration of the same
 *  name — see its own comment for why. */
export const BACKUP_INSTALL_ARGUMENTS: CommandArgument[] = [
  { name: "interval", description: "With install: how often (default 1d) — 30m, 6h or 1d, explicit unit required (a bare number is minutes only for watch install); minutes must divide 60, hours must divide a day", kind: "option", valueName: "interval" },
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
  // An empty --interval is refused (not defaulted), and a bare number is refused: a backup
  // cadence must always carry an explicit unit — "6" is probably a typo for "6h", and a
  // gateway-stopping backup every 6 minutes would out-rotate OC_BACKUP_KEEP within an hour.
  const raw = parsed.interval === undefined ? DEFAULT_BACKUP_INTERVAL : parsed.interval as string;
  return { minutes: parseIntervalToMinutes(raw, { bareMinutes: false }), interval: raw, apply: parsed.apply === true };
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
  cronLine(minutes, invocation, JOB, name); // Validate cron syntax before querying the target.
  if (apply) await requireBootstrapped(ctx);
  const identity = await schedulerIdentity(ctx);
  const line = cronLine(minutes, invocation, JOB, identity);

  log(`crontab entry (every ${interval}, runs on ${ctx.transport.description})`);
  infoRaw(line);
  info(`marked "${jobMarker(JOB, identity)}" — re-running this replaces only that line; backup uninstall removes only it`);
  if (ctx.transport.description.startsWith("ssh:")) {
    info(`assumes this deployment was mirrored to ${ctx.settings.remotePath} by ./clawforge deploy (set OC_REMOTE_PATH if --path differed)`);
  }

  if (!apply) {
    info("add it yourself with `crontab -e`, or re-run with --apply to install it directly");
    return;
  }

  await guarded(ctx, "backup install --apply", args, async () => {
    await updateCrontab(ctx, JOB, identity, line, { name, invocation });
    log("installed");
  });
}

export async function backupUninstall(ctx: Context, args: string[], scope?: ActionScope): Promise<void> {
  const apply = parseUninstallArgs(args, scope);
  const support = schedulingSupport(ctx);
  const name = deploymentName();

  if (!support.supported) {
    warn(`no unattended schedule could have been installed on ${ctx.transport.description} in the first place: ${support.reason}`);
    await printUnschedulingInstructions(ctx, JOB, apply);
    return;
  }

  const identity = await schedulerIdentity(ctx);
  const invocation = await posixTargetInvocation(ctx, [JOB]);

  if (!apply) {
    info(`would remove the crontab entry marked "${jobMarker(JOB, identity)}" on ${ctx.transport.description}; re-run with --apply`);
    return;
  }

  await guarded(ctx, "backup uninstall --apply", args, async () => {
    if (!await updateCrontab(ctx, JOB, identity, undefined, { name, invocation })) {
      info("no backup schedule was installed for this deployment — nothing to remove");
      return;
    }
    log("removed");
  });
}
