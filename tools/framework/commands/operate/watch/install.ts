// `./clawforge watch install` / `watch uninstall` — a scheduler entry that runs `watch check`
// every N minutes.
//
// crontab, not a systemd --user timer: a timer only fires unattended once the user session
// is allowed to linger (`loginctl enable-linger`) and systemd itself is PID 1 — neither is
// guaranteed on a minimal Docker host, and setting up lingering is an extra privileged step
// this command would otherwise have to take on the operator's behalf. Cron is the one
// mechanism every POSIX target in scope already runs as a system service, logged-in or not.
//
// Where the schedule can actually live is a property of the TRANSPORT, not a flag:
//   ssh    the remote host is a real, always-on machine, and `./clawforge deploy` already made
//          it self-sufficient (framework mirrored whole, this deployment nested beneath it)
//          — a crontab entry there runs the same `./clawforge --app <name> watch check` deploy's
//          own bootstrap advice already prints.
//   local  (POSIX only) tooling and target are the same machine; the crontab entry runs
//          exactly what a human would type.
//   wsl    the WSL distro is a Docker host, not a place this tooling is proven to also
//          run — no crontab is installed there. `clientInvocation()` still answers "how
//          would an external client on THIS (Windows) side reach it", which is what the
//          printed instructions are built from — Windows itself has no cron/systemd, and
//          wiring a real Task Scheduler entry is the operator's own call, never this
//          command's.
//   local on win32   same absence of a POSIX scheduler as wsl, same printed answer.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { die, info, log, warn } from "../../../core/io/log.ts";
import { monorepoRoot } from "../../../core/env.ts";
import { deploymentDir, deploymentName } from "../../../runtime/deployment.ts";
import { guarded } from "../../../runtime/instance-lock.ts";
import { SshTransport } from "../../../runtime/transport/transport.ts";
import type { Context } from "../../../core/context.ts";
import type { CommandArgument } from "../../../core/app.ts";
import { parseDeclaredArgs } from "../../../core/arguments.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "../../interface/groups/shared-arguments.ts";

/** The slice of `watch`'s declaration `install`'s own argv actually uses. */
export const WATCH_INSTALL_ARGUMENTS: CommandArgument[] = [
  { name: "interval", description: "With install: minutes between checks (default 5); 1-59, or an exact multiple of 60 up to 1440", kind: "option" },
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

const MARKER_PREFIX = "clawforge-watch";

export function watchMarker(name: string): string {
  return `# ${MARKER_PREFIX}:${name}`;
}

interface WatchInvocation {
  readonly cwd: string;
  readonly command: string;
  readonly args: string[];
}

async function installedShimExists(root: string): Promise<boolean> {
  return access(resolve(root, "clawforge")).then(
    () => true,
    () => false,
  );
}

/** Where and how `watch check` runs once it IS scheduled — see the header for why this is
 *  only asked when schedulingSupport() below already said yes. */
async function targetInvocation(ctx: Context): Promise<WatchInvocation> {
  if (ctx.transport.description.startsWith("ssh:")) {
    return { cwd: ctx.settings.remotePath, command: "./clawforge", args: ["--app", deploymentName(), "watch", "check"] };
  }
  const installed = await installedShimExists(deploymentDir());
  return installed
    ? { cwd: deploymentDir(), command: "./clawforge", args: ["watch", "check"] }
    : { cwd: monorepoRoot, command: "./clawforge", args: ["--app", deploymentName(), "watch", "check"] };
}

/** A step in cron's minute field only works up to 59; whole hours step the hour field.
 *  Anything else has no faithful encoding and is refused. */
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

export function cronLine(minutes: number, invocation: WatchInvocation, name: string): string {
  const args = invocation.args.map((arg) => SshTransport.quote(arg)).join(" ");
  return `${cronSchedule(minutes)} cd ${SshTransport.quote(invocation.cwd)} && ${invocation.command} ${args} >/dev/null 2>&1 ${watchMarker(name)}`;
}

interface SchedulingSupport {
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
 *  would be run by whatever shell the operator pastes it into. */
export function displayCommandLine(command: string, args: readonly string[]): string {
  const quote = (value: string): string => (/^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replaceAll(`"`, `\\"`)}"`);
  return [command, ...args].map(quote).join(" ");
}

/** The one thing `clientInvocation()` is actually for here: not "run this on the target",
 *  but "how would something OUTSIDE the target — an operator's own scheduler — reach it".
 *  Printed rather than installed, per the header: this command never touches a real
 *  Windows Task Scheduler. */
async function printOperatorSideInstructions(ctx: Context): Promise<void> {
  const installed = await installedShimExists(deploymentDir());
  const entryHost = installed ? resolve(deploymentDir(), "clawforge") : resolve(monorepoRoot, "clawforge");
  const args = installed ? ["watch", "check"] : ["--app", deploymentName(), "watch", "check"];
  const entryTarget = await ctx.paths.toTarget(entryHost);
  const invocation = ctx.transport.clientInvocation(entryTarget, args);
  info("no unattended install exists for this target from here. Run this yourself, on a scheduler that can reach it:");
  info(`  ${displayCommandLine(invocation.command, invocation.args)}`);
  info("on Windows that means wiring it into Task Scheduler by hand — this command never creates or touches one.");
}

async function probeCrontab(ctx: Context): Promise<void> {
  const found = await ctx.transport.exec("sh", ["-c", "command -v crontab"], { allowFailure: true });
  if (found.code !== 0 || found.stdout.trim() === "") {
    die(`crontab is not available on ${ctx.transport.description} — install a cron package there first (e.g. cronie, vixie-cron)`);
  }
}

/** crontab -l exits non-zero both for "no crontab yet for this user" (the ordinary case
 *  once probeCrontab() above already proved the binary exists) and for a real failure; only
 *  the former is expected to reach here, so it reads as empty rather than as an error. */
async function readCrontab(ctx: Context): Promise<string> {
  const listing = await ctx.transport.exec("crontab", ["-l"], { allowFailure: true });
  return listing.code === 0 ? listing.stdout : "";
}

export function withoutMarkedLine(text: string, name: string): string[] {
  const needle = watchMarker(name);
  return text.split("\n").filter((line) => line.trim() !== "" && !line.includes(needle));
}

async function writeCrontab(ctx: Context, lines: string[]): Promise<void> {
  const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  const result = await ctx.transport.exec("crontab", ["-"], { input: content, allowFailure: true });
  if (result.code !== 0) {
    die(`could not update crontab on ${ctx.transport.description} (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}

function parseInstallArgs(args: string[]): { interval: number; apply: boolean } {
  const parsed = parseDeclaredArgs(WATCH_INSTALL_ARGUMENTS, args);
  let interval = 5;
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

export async function watchInstall(ctx: Context, args: string[]): Promise<void> {
  const { interval, apply } = parseInstallArgs(args);
  const support = schedulingSupport(ctx);

  if (!support.supported) {
    warn(`cannot install an unattended schedule on ${ctx.transport.description}: ${support.reason}`);
    await printOperatorSideInstructions(ctx);
    if (apply) die("refusing --apply: no correct unattended install exists for this target (see above)");
    return;
  }

  const invocation = await targetInvocation(ctx);
  const line = cronLine(interval, invocation, deploymentName());

  log(`crontab entry (every ${interval} minute(s), runs on ${ctx.transport.description})`);
  info(line);
  info(`marked "${watchMarker(deploymentName())}" — re-running this replaces only that line; watch uninstall removes only it`);
  if (ctx.transport.description.startsWith("ssh:")) {
    info(`assumes this deployment was mirrored to ${ctx.settings.remotePath} by ./clawforge deploy (set OC_REMOTE_PATH if --path differed)`);
  }

  if (!apply) {
    info("add it yourself with `crontab -e`, or re-run with --apply to install it directly");
    return;
  }

  await guarded(ctx, "watch install --apply", args, async () => {
    await probeCrontab(ctx);
    const existing = await readCrontab(ctx);
    const kept = withoutMarkedLine(existing, deploymentName());
    await writeCrontab(ctx, [...kept, line]);
    log("installed");
  });
}

export async function watchUninstall(ctx: Context, args: string[]): Promise<void> {
  const apply = parseUninstallArgs(args);
  const support = schedulingSupport(ctx);

  if (!support.supported) {
    warn(`no unattended schedule could have been installed on ${ctx.transport.description} in the first place: ${support.reason}`);
    info("remove any entry you wired in yourself (e.g. Windows Task Scheduler) directly");
    if (apply) die("refusing --apply: nothing this command could have installed here");
    return;
  }

  if (!apply) {
    info(`would remove the crontab entry marked "${watchMarker(deploymentName())}" on ${ctx.transport.description}; re-run with --apply`);
    return;
  }

  await guarded(ctx, "watch uninstall --apply", args, async () => {
    await probeCrontab(ctx);
    const existing = await readCrontab(ctx);
    if (!existing.includes(watchMarker(deploymentName()))) {
      info("no watch schedule was installed for this deployment — nothing to remove");
      return;
    }
    await writeCrontab(ctx, withoutMarkedLine(existing, deploymentName()));
    log("removed");
  });
}
