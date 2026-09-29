// `./clawforge watch install` / `watch uninstall` — the pure builders (marker, cron line,
// which transports are schedulable), and the idempotent install/uninstall cycle against a
// stub transport that answers `crontab`/`sh -c "command -v crontab"` and the instance
// lock's own mkdir/test/mv/rm plumbing — the same lock harness
// tools/checks/security/expose/tailscale.check.ts uses.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WATCH_INTERVAL_MINUTES,
  cronLine,
  cronSchedule,
  displayCommandLine,
  schedulingSupport,
  watchInstall,
  watchMarker,
  watchUninstall,
  withoutMarkedLine,
} from "#framework/commands/operate/watch/install.ts";
import { scheduledTaskName, withScheduleRunner } from "#framework/commands/operate/schedule.ts";
import { readWatchState } from "#framework/commands/operate/watch/state.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { stubContext } from "#checks/runtime/convergence/instance-lock/fixture.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecOptions, ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function deathOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

// --- pure builders ---------------------------------------------------------------------

check("the marker names the deployment", watchMarker("myapp"), "# clawforge-watch:myapp");
check(
  "cronLine quotes every part and carries the marker",
  cronLine(5, { cwd: "/opt/open claw", command: "./clawforge", args: ["--app", "my app", "watch", "check"] }, "myapp"),
  "*/5 * * * * cd '/opt/open claw' && ./clawforge '--app' 'my app' 'watch' 'check' >/dev/null 2>&1 # clawforge-watch:myapp",
);
check(
  "withoutMarkedLine preserves other lines and blanks",
  withoutMarkedLine(`0 3 * * * /usr/bin/backup.sh\n${cronLine(5, { cwd: "/x", command: "./clawforge", args: ["watch", "check"] }, "myapp")}\n\n0 4 * * * /usr/bin/other.sh\n`, "myapp"),
  ["0 3 * * * /usr/bin/backup.sh", "", "0 4 * * * /usr/bin/other.sh"],
);
check(
  "withoutMarkedLine leaves a DIFFERENT deployment's marked line alone",
  withoutMarkedLine("*/5 * * * * ./clawforge watch check # clawforge-watch:other\n", "myapp"),
  ["*/5 * * * * ./clawforge watch check # clawforge-watch:other"],
);

// --- cronSchedule(): only minute steps dividing 60, or hour steps dividing a day, fire
// evenly — `*/45`, `*/7` (hours) would silently misfire and are refused ---------------------

for (const [minutes, expected] of [
  [1, "*/1 * * * *"],
  [5, "*/5 * * * *"],
  [30, "*/30 * * * *"],
  [60, "0 * * * *"],
  [120, "0 */2 * * *"],
  [180, "0 */3 * * *"],
  [720, "0 */12 * * *"],
  [1440, "0 0 * * *"],
] as const) {
  check(`cronSchedule(${minutes})`, cronSchedule(minutes), expected);
}
for (const invalid of [0, 7, 25, 45, 59, 90, 300, 420, 1441, 1.5, -5]) {
  check(
    `cronSchedule(${invalid}) refuses — no faithful cron encoding`,
    await deathOf(() => cronSchedule(invalid)) !== "",
    true,
  );
}
check("cronLine builds its schedule through cronSchedule, not its own copy", cronLine(120, { cwd: "/x", command: "./clawforge", args: [] }, "myapp").startsWith("0 */2 * * *"), true);

// --- schedulingSupport(): a property of the transport, checked against THIS platform's own
// POSIX-ness for the "local" branch so the assertion holds on every CI runner ------------

function ctxWith(description: string, extra: Record<string, unknown> = {}): Context {
  return { transport: { description, ...extra }, settings: { remotePath: "/opt/openclaw" } } as unknown as Context;
}

check("ssh is schedulable — a real, always-on machine deploy already mirrored the checkout to", schedulingSupport(ctxWith("ssh:user@host")).supported, true);
check("a WSL Docker host is not — not proven to also run this tooling's own node + checkout", schedulingSupport(ctxWith("wsl:Ubuntu-24.04")).supported, false);
check("wsl explains why, in the reason", schedulingSupport(ctxWith("wsl:Ubuntu-24.04")).reason?.includes("container host"), true);
check("local reflects whether THIS platform is POSIX (no crontab/systemd on Windows)", schedulingSupport(ctxWith("local")).supported, process.platform !== "win32");

// --- the idempotent install/uninstall cycle, against a stub crontab + the real lock -----

interface RecordedCall { readonly command: string; readonly args: string[] }

/** `crontab` and `sh -c "command -v crontab"` layered over the real instance-lock/mutation-
 *  guard fixture (an in-memory tree that emulates mkdir/rmdir/ln/mv/rm faithfully — the same
 *  one instance-lock.check.ts's own split uses), so install/uninstall run their REAL locking
 *  code across repeated --apply cycles, not a hand-rolled approximation of it. */
function crontabTransport(initial = "", listingFailure?: ExecResult): { transport: Context["transport"]; calls: RecordedCall[]; crontab: () => string } {
  const { ctx: fixtureCtx } = stubContext();
  const baseExec = fixtureCtx.transport.exec;
  let current = initial;
  const calls: RecordedCall[] = [];
  const transport: Context["transport"] = {
    ...fixtureCtx.transport,
    description: "ssh:user@host",
    async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
      calls.push({ command, args });
      if (command === "sh" && args[0] === "-c" && args[1] === "command -v crontab") {
        return { code: 0, stdout: "/usr/bin/crontab\n", stderr: "" };
      }
      if (command === "crontab" && args[0] === "-l") {
        if (listingFailure !== undefined) return listingFailure;
        return current === "" ? { code: 1, stdout: "", stderr: "no crontab for user" } : { code: 0, stdout: current, stderr: "" };
      }
      if (command === "crontab" && args[0] === "-") {
        current = typeof options?.input === "string" ? options.input : "";
        return { code: 0, stdout: "", stderr: "" };
      }
      return baseExec(command, args, options);
    },
  };
  return { transport, calls, crontab: () => current };
}

const root = await mkdtemp(join(tmpdir(), "clawforge-watch-install-check-"));
useDeployment(root);
const name = deploymentName();

try {
  const FOREIGN = "0 3 * * * /usr/bin/foreign-backup.sh";
  const OTHER_DEPLOYMENT = "*/5 * * * * cd /opt/openclaw && ./clawforge --app other watch check >/dev/null 2>&1 # clawforge-watch:other";
  const { transport, calls, crontab } = crontabTransport(`${FOREIGN}\n${OTHER_DEPLOYMENT}\n`);
  const ctx = {
    transport,
    settings: { remotePath: "/opt/openclaw", dataDir: "/does/not/exist", env: {} },
    runtime: { async isRunning(): Promise<boolean> { return true; } },
  } as unknown as Context;

  // print-only (no --apply): never touches crontab at all.
  await withOutputSink(() => {}, () => watchInstall(ctx, []));
  check("print-only install never reads or writes the real crontab", calls.some((call) => call.command === "crontab"), false);

  // --apply: installs our own line, leaving the foreign and other-deployment lines alone.
  await withOutputSink(() => {}, () => watchInstall(ctx, ["--apply"]));
  const afterFirstInstall = crontab();
  check("foreign entries survive install", afterFirstInstall.includes(FOREIGN), true);
  check("another deployment's watch entry survives install", afterFirstInstall.includes(OTHER_DEPLOYMENT), true);
  check("our own marker is present", afterFirstInstall.includes(watchMarker(name)), true);
  check("the default interval is 5", afterFirstInstall.includes(`*/5 * * * * cd`), true);
  check("the default interval is recorded to watch state", (await readWatchState())?.intervalMinutes, DEFAULT_WATCH_INTERVAL_MINUTES);

  // --apply again, with a different interval: replaces the SAME line rather than duplicating it.
  await withOutputSink(() => {}, () => watchInstall(ctx, ["--apply", "--interval", "10"]));
  const afterSecondInstall = crontab();
  const ourLines = afterSecondInstall.split("\n").filter((line) => line.includes(watchMarker(name)));
  check("re-installing replaces the one line rather than adding a second", ourLines.length, 1);
  check("the new interval took effect", ourLines[0]?.startsWith("*/10 * * * *"), true);
  check("the new interval is recorded to watch state too", (await readWatchState())?.intervalMinutes, 10);
  check("the foreign and other-deployment lines are still untouched", [afterSecondInstall.includes(FOREIGN), afterSecondInstall.includes(OTHER_DEPLOYMENT)], [true, true]);

  // an hour-stepped interval (a multiple of 60) prints the hour-field schedule, not */120.
  {
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), () => watchInstall(ctx, ["--interval", "120"]));
    check("a 120-minute interval prints the hour-stepped schedule", written.join("").includes("0 */2 * * *"), true);
  }

  // a non-schedulable interval (not a divisor of 60 minutes or a day in hours) is refused up
  // front, before any crontab line is even built — never silently degrades to an uneven */N.
  {
    calls.length = 0;
    const message = await deathOf(() => withOutputSink(() => {}, () => watchInstall(ctx, ["--interval", "90"])));
    check("--interval 90 is refused", message.includes("no faithful encoding"), true);
    check("and never touches the crontab", calls.some((call) => call.command === "crontab"), false);
  }
  {
    const message = await deathOf(() => withOutputSink(() => {}, () => watchInstall(ctx, ["--interval", "1441"])));
    check("--interval beyond a day is refused", message.includes("no faithful encoding"), true);
  }
  {
    const message = await deathOf(() => withOutputSink(() => {}, () => watchInstall(ctx, ["--interval", "45"])));
    check("--interval 45 (would fire unevenly, */45) is refused", message.includes("no faithful encoding"), true);
  }

  // uninstall --apply: removes only OUR marked line.
  await withOutputSink(() => {}, () => watchUninstall(ctx, ["--apply"]));
  const afterUninstall = crontab();
  check("uninstall removes our own line", afterUninstall.includes(watchMarker(name)), false);
  check("uninstall leaves the foreign entry alone", afterUninstall.includes(FOREIGN), true);
  check("uninstall leaves another deployment's entry alone", afterUninstall.includes(OTHER_DEPLOYMENT), true);
  check("uninstall clears the recorded interval", (await readWatchState())?.intervalMinutes, undefined);

  // uninstall --apply again: nothing to remove, and it does not touch the crontab at all.
  calls.length = 0;
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => watchUninstall(ctx, ["--apply"]));
  check("a second uninstall reports nothing to remove", written.join("").includes("nothing to remove"), true);
  check("and never re-writes the crontab", calls.some((call) => call.command === "crontab" && call.args[0] === "-"), false);

  const unreadableInitial = `${FOREIGN}\n`;
  const unreadable = crontabTransport(unreadableInitial, { code: 1, stdout: "", stderr: "permission denied" });
  const unreadableCtx = { ...ctx, transport: unreadable.transport } as Context;
  const readError = await deathOf(() => withOutputSink(() => {}, () => watchInstall(unreadableCtx, ["--apply"])));
  check("watch install aborts on crontab read failure", readError.includes("could not read crontab"), true);
  check("watch install leaves existing entries untouched on read failure", unreadable.crontab(), unreadableInitial);
  check("watch install never writes after a crontab read failure", unreadable.calls.some((call) => call.command === "crontab" && call.args[0] === "-"), false);
} finally {
  await rm(root, { recursive: true, force: true });
}

// --- an unsupported transport never installs a crontab line; on an actual Windows host it
// can print (and, with --apply, run through a recording transport — never a real one) the
// schtasks equivalent instead ------------------------------------------------------------

{
  const ctx = {
    transport: { description: "wsl:Ubuntu-24.04", clientInvocation: (entry: string, args: string[]) => ({ command: "wsl.exe", args: [entry, ...args] }) },
    paths: { async toTarget(path: string): Promise<string> { return path; } },
    settings: {},
  } as unknown as Context;
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => withScheduleRunner(
    async () => ({ code: 0, stdout: "", stderr: "" }),
    () => watchInstall(ctx, []),
    "win32",
  ));
  check("an unsupported transport prints instructions instead of a crontab line", written.join("").includes("Run this yourself"), true);

  {
    check("...and, on an actual Windows host, a ready schtasks command too", written.join("").includes("schtasks"), true);

    const recorded: { command: string; args: string[] }[] = [];
    await withOutputSink(() => {}, () =>
      withScheduleRunner(
        async (command, args) => {
          recorded.push({ command, args: [...args] });
          return { code: 0, stdout: "", stderr: "" };
        },
        () => watchInstall(ctx, ["--apply"]),
        "win32",
      ));
      check("--apply on Windows runs schtasks through the recording transport, never a real one", recorded.length, 1);
      check("...targeting this job's own task name", recorded[0]?.args.includes(scheduledTaskName("watch", name)) ?? false, true);

    check("Windows install records the applied interval", (await readWatchState())?.intervalMinutes, DEFAULT_WATCH_INTERVAL_MINUTES);
    const failed = await deathOf(() => withOutputSink(() => {}, () =>
      withScheduleRunner(
        async () => ({ code: 1, stdout: "", stderr: "access denied" }),
        () => watchInstall(ctx, ["--apply", "--interval", "10"]),
        "win32",
      )));
    check("a failed Windows reinstall is reported", failed.includes("access denied"), true);
    check("a failed Windows reinstall does not overwrite the installed interval", (await readWatchState())?.intervalMinutes, DEFAULT_WATCH_INTERVAL_MINUTES);

    const deleted: { command: string; args: string[] }[] = [];
    await withOutputSink(() => {}, () => withScheduleRunner(
      async (command, args) => {
        deleted.push({ command, args: [...args] });
        return { code: 0, stdout: "", stderr: "" };
      },
      () => watchUninstall(ctx, ["--apply"]),
      "win32",
    ));
    check("Windows uninstall deletes the same watch task", deleted[0]?.args, ["/delete", "/tn", scheduledTaskName("watch", name), "/f"]);
    check("Windows uninstall clears the interval after deletion succeeds", (await readWatchState())?.intervalMinutes, undefined);

    const localCtx = {
      transport: { description: "local", clientInvocation: (entry: string, args: string[]) => ({ command: entry, args }) },
      paths: { async toTarget(path: string): Promise<string> { return path; } },
      settings: {},
    } as unknown as Context;
    const localRecorded: { command: string; args: string[] }[] = [];
    await withOutputSink(() => {}, () =>
      withScheduleRunner(
        async (command, args) => {
          localRecorded.push({ command, args: [...args] });
          return { code: 0, stdout: "", stderr: "" };
        },
        () => watchInstall(localCtx, ["--apply"]),
        "win32",
      ));
    check(
      "a native Windows host (no WSL involved) runs node directly, not the bash shim",
      localRecorded[0]?.args.some((arg) => arg.includes(process.execPath)) ?? false,
      true,
    );
  }
  if (process.platform !== "win32") {
    const message = await deathOf(() => withOutputSink(() => {}, () => watchInstall(ctx, ["--apply"])));
    check("--apply refuses outright on an unsupported, non-Windows transport", message.includes("refusing --apply"), true);
  }
}

// The printed operator command must survive a paste: bash -lc's script is one argument.
check(
  "an argument with spaces and && stays one quoted argument",
  displayCommandLine("wsl.exe", ["-d", "Ubuntu-24.04", "--", "bash", "-lc", "cd '/mnt/d/x' && ./clawforge watch check"]),
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/d/x' && ./clawforge watch check"`,
);

finish("watch install");
