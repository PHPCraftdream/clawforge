// commands/operate/schedule.ts — the scheduling machinery `watch install` and
// `backup install` both build on: the pure builders (marker, cron/schtasks encoding,
// interval parsing, which transports are schedulable) and the Windows fallback's own
// apply path, proven here against a recording transport that never touches a real
// scheduled task (see schedule.ts's own withScheduleRunner).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cronLine,
  cronSchedule,
  displayCommandLine,
  jobMarker,
  parseIntervalToMinutes,
  posixTargetInvocation,
  printSchedulingInstructions,
  schedulingSupport,
  scheduledTaskName,
  schtasksCreateCommand,
  schtasksDeleteCommand,
  schtasksSchedule,
  withoutMarkedLine,
  withScheduleRunner,
} from "#framework/commands/operate/schedule.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function deathOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

// --- markers: distinct per job, so two jobs scheduling the same deployment never collide ----

check("jobMarker names both the job and the deployment", jobMarker("backup", "myapp"), "# clawforge-backup:myapp");
check("a different job never matches another job's marker", jobMarker("watch", "myapp") === jobMarker("backup", "myapp"), false);
check("scheduledTaskName is deployment-then-job, distinct per job", scheduledTaskName("backup", "myapp"), "clawforge-myapp-backup");
check("...and per deployment", scheduledTaskName("backup", "myapp") === scheduledTaskName("backup", "other"), false);

check(
  "withoutMarkedLine drops only the named job's marked line for the named deployment",
  withoutMarkedLine(
    "0 3 * * * /usr/bin/other.sh\n*/5 * * * * ./clawforge watch check # clawforge-watch:myapp\n0 0 * * * ./clawforge backup # clawforge-backup:myapp\n",
    "backup",
    "myapp",
  ),
  ["0 3 * * * /usr/bin/other.sh", "*/5 * * * * ./clawforge watch check # clawforge-watch:myapp"],
);

// --- cronSchedule(): shared by both jobs, and by schtasksSchedule()'s own range check -------

for (const [minutes, expected] of [
  [1, "*/1 * * * *"],
  [59, "*/59 * * * *"],
  [60, "0 * * * *"],
  [120, "0 */2 * * *"],
  [1440, "0 0 * * *"],
] as const) {
  check(`cronSchedule(${minutes})`, cronSchedule(minutes), expected);
}
for (const invalid of [0, 61, 90, 1441]) {
  check(`cronSchedule(${invalid}) refuses`, await deathOf(() => cronSchedule(invalid)) !== "", true);
}

check("cronLine carries the job's own marker, not another job's", cronLine(5, { cwd: "/x", command: "./clawforge", args: ["backup"] }, "backup", "myapp").endsWith(jobMarker("backup", "myapp")), true);

// --- parseIntervalToMinutes(): backup's own duration-string convention, funneled through
// cronSchedule so it can never accept an interval the cron line itself would then refuse ----

check("30m -> 30 minutes", parseIntervalToMinutes("30m"), 30);
check("6h -> 360 minutes", parseIntervalToMinutes("6h"), 360);
check("1d -> 1440 minutes", parseIntervalToMinutes("1d"), 1440);
check("a bare number with no unit is refused, named", (await deathOf(() => parseIntervalToMinutes("30"))).includes("--interval must look like"), true);
check("90m has no faithful cron encoding and is refused", (await deathOf(() => parseIntervalToMinutes("90m"))).includes("out of range"), true);

// --- schedulingSupport(): a property of the transport, checked against THIS platform's own
// POSIX-ness for the "local" branch so the assertion holds on every CI runner ----------------

function ctxWith(description: string): Context {
  return { transport: { description }, settings: { remotePath: "/opt/openclaw" } } as unknown as Context;
}

check("ssh is schedulable", schedulingSupport(ctxWith("ssh:user@host")).supported, true);
check("a WSL target is not", schedulingSupport(ctxWith("wsl:Ubuntu-24.04")).supported, false);
check("local reflects whether THIS platform is POSIX", schedulingSupport(ctxWith("local")).supported, process.platform !== "win32");

// --- schtasksSchedule()/schtasksCreateCommand()/schtasksDeleteCommand(): the pure Windows
// builders, exercised regardless of the host this check itself runs on ----------------------

check("a sub-hour interval steps schtasks' own MINUTE schedule", schtasksSchedule(30), { sc: "MINUTE", mo: "30" });
check("an hour-multiple interval steps HOURLY", schtasksSchedule(360), { sc: "HOURLY", mo: "6" });
check("exactly a day steps DAILY, with no /mo", schtasksSchedule(1440), { sc: "DAILY" });
check("schtasksSchedule refuses whatever cronSchedule would", await deathOf(() => schtasksSchedule(90)) !== "", true);

{
  const create = schtasksCreateCommand("clawforge-myapp-backup", 1440, { command: "node.exe", args: ["C:\\tools\\clawforge.ts", "--app", "myapp", "backup"] });
  check("schtasksCreateCommand builds /create with the task name, schedule and a quoted /tr", create, {
    command: "schtasks",
    args: ["/create", "/tn", "clawforge-myapp-backup", "/sc", "DAILY", "/tr", displayCommandLine("node.exe", ["C:\\tools\\clawforge.ts", "--app", "myapp", "backup"]), "/f"],
  });
  check("...and /f, so a re-run replaces the same task instead of refusing", create.args.includes("/f"), true);
}
check("schtasksDeleteCommand names the task and forces it", schtasksDeleteCommand("clawforge-myapp-backup"), { command: "schtasks", args: ["/delete", "/tn", "clawforge-myapp-backup", "/f"] });

// --- posixTargetInvocation(): ssh vs. a monorepo checkout vs. an installed shim -------------

const root = await mkdtemp(join(tmpdir(), "clawforge-schedule-check-"));
useDeployment(root);
const name = deploymentName();

try {
  const sshCtx = { transport: { description: "ssh:user@host" }, settings: { remotePath: "/opt/openclaw" } } as unknown as Context;
  const sshInvocation = await posixTargetInvocation(sshCtx, ["backup"]);
  check("ssh runs from the mirrored remote path, with --app", sshInvocation, { cwd: "/opt/openclaw", command: "./clawforge", args: ["--app", name, "backup"] });

  const localCtx = { transport: { description: "local" }, settings: {} } as unknown as Context;
  const localInvocation = await posixTargetInvocation(localCtx, ["backup"]);
  check("a monorepo checkout (no installed shim here) still names --app explicitly", localInvocation.args, ["--app", name, "backup"]);

  // --- printSchedulingInstructions(): the Windows apply path, through the recording
  // transport only — this must never spawn a real schtasks.exe --------------------------

  const wslCtx = {
    transport: { description: "wsl:Ubuntu-24.04", clientInvocation: (entry: string, args: string[]) => ({ command: "wsl.exe", args: [entry, ...args] }) },
    paths: { async toTarget(path: string): Promise<string> { return path; } },
    settings: {},
  } as unknown as Context;

  const printed: string[] = [];
  await withOutputSink((chunk) => printed.push(chunk), () => printSchedulingInstructions(wslCtx, "backup", name, 1440, ["backup"], false));
  check("printing without --apply names the manual command, on every platform", printed.join("").includes("Run this yourself"), true);

  if (process.platform === "win32") {
    check("...and shows the schtasks command on an actual Windows host", printed.join("").includes("schtasks"), true);

    const recorded: { command: string; args: string[] }[] = [];
    await withOutputSink(() => {}, () =>
      withScheduleRunner(
        async (command, args) => {
          recorded.push({ command, args: [...args] });
          return { code: 0, stdout: "", stderr: "" };
        },
        () => printSchedulingInstructions(wslCtx, "backup", name, 1440, ["backup"], true),
      ));
    check("--apply on Windows runs schtasks through the recording transport, never a real one", recorded.length, 1);
    check("...via the wsl.exe line for a wsl: target, not a re-derived node invocation", recorded[0]?.args.some((arg) => arg.includes("wsl.exe")), true);

    const failing: { command: string; args: string[] }[] = [];
    const message = await deathOf(() =>
      withOutputSink(() => {}, () =>
        withScheduleRunner(
          async (command, args) => {
            failing.push({ command, args: [...args] });
            return { code: 1, stdout: "", stderr: "access denied" };
          },
          () => printSchedulingInstructions(wslCtx, "backup", name, 1440, ["backup"], true),
        )));
    check("a failing schtasks call is reported, not swallowed", message.includes("access denied"), true);
  } else {
    const message = await deathOf(() => withOutputSink(() => {}, () => printSchedulingInstructions(wslCtx, "backup", name, 1440, ["backup"], true)));
    check("--apply on a non-Windows host refuses outright — no scheduler here to drive", message.includes("refusing --apply"), true);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

finish("schedule");
