// commands/operate/schedule.ts — the scheduling machinery `watch install` and
// `backup install` both build on: the pure builders (marker, cron/schtasks encoding,
// interval parsing, which transports are schedulable) and the Windows fallback's own
// apply path, proven here against a recording transport that never touches a real
// scheduled task (see schedule.ts's own withScheduleRunner).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cronLine,
  cronSchedule,
  displayCommandLine,
  installedEntryScript,
  jobMarker,
  parseIntervalToMinutes,
  posixTargetInvocation,
  printSchedulingInstructions,
  readCrontab,
  updateCrontab,
  schedulingSupport,
  schtasksCreateCommand,
  schtasksDeleteCommand,
  schtasksSchedule,
  withoutMarkedLine,
  withScheduleRunner,
} from "#framework/commands/operate/schedule.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { shellQuote } from "#framework/core/io/shell.ts";
import { WslTransport } from "#framework/runtime/transport/wsl.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { cmdExeArgv } from "#checks/runtime/schedule/fixture.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function deathOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}


check(
  "withoutMarkedLine drops only the named job's marked line for the named deployment",
  withoutMarkedLine(
    `0 3 * * * /usr/bin/other.sh\n${cronLine(5, { cwd: "/x", command: "./clawforge", args: ["watch", "check"] }, "watch", "myapp")}\n${cronLine(1440, { cwd: "/x", command: "./clawforge", args: ["backup"] }, "backup", "myapp")}\n`,
    "backup",
    "myapp",
  ),
  ["0 3 * * * /usr/bin/other.sh", cronLine(5, { cwd: "/x", command: "./clawforge", args: ["watch", "check"] }, "watch", "myapp")],
);

const owned = cronLine(5, { cwd: "/x", command: "./clawforge", args: ["watch", "check"] }, "watch", "myapp");
const foreign = [
  `# note: ${jobMarker("watch", "myapp")}`,
  `*/5 * * * * echo '${jobMarker("watch", "myapp")}'`,
  `${owned} extra`,
  owned.replace("'watch' 'check'", "'backup'"),
  owned.replace("# clawforge-watch:myapp", "# clawforge-watch:myapp-extra"),
  "",
  "  ",
];
check("only an exact generated entry is removed; foreign rows and blank lines survive", withoutMarkedLine(`${foreign.join("\n")}\n${owned}\n`, "watch", "myapp"), foreign);
const quoted = cronLine(5, { cwd: "/owner's app", command: "./clawforge", args: ["--app", "myapp", "watch", "check"] }, "watch", "myapp");
check("an owned line with a quoted path and explicit deployment is removed", withoutMarkedLine(`${quoted}\n`, "watch", "myapp"), []);

for (const path of ["/srv/project%blue", "/srv/project\\%blue", "/srv/project\\\\%blue"]) {
  check("percent paths are refused even with a preceding backslash", (await deathOf(() => cronLine(5, { cwd: path, command: "./clawforge", args: ["watch", "check"] }, "watch", "myapp"))).includes("does not support %"), true);
  const legacy = owned.replace("'/x'", shellQuote(path));
  check("unsupported legacy percent rows are preserved", withoutMarkedLine(`${legacy}\n`, "watch", "myapp"), [legacy]);
}
for (const invocation of [
  { cwd: "/x", command: "./clawforge%", args: ["watch", "check"] },
  { cwd: "/x", command: "./clawforge", args: ["watch", "%"] },
]) {
  check("percent in commands or arguments is refused", (await deathOf(() => cronLine(5, invocation, "watch", "myapp"))).includes("does not support %"), true);
}
check("percent in markers is refused", (await deathOf(() => cronLine(5, { cwd: "/x", command: "./clawforge", args: ["backup"] }, "backup", "my%app"))).includes("does not support %"), true);

// --- cronSchedule(): only true divisors of 60 (minutes) or 24 (hours) fire evenly — shared
// by both jobs, and by schtasksSchedule()'s own range check ---------------------------------

for (const [minutes, expected] of [
  [15, "*/15 * * * *"],
  [30, "*/30 * * * *"],
  [60, "0 * * * *"],
  [120, "0 */2 * * *"],
  [360, "0 */6 * * *"],
  [1440, "0 0 * * *"],
] as const) {
  check(`cronSchedule(${minutes})`, cronSchedule(minutes), expected);
}
// 45m/7h/5h would fire unevenly (*/45, */7) — refused despite passing the old "multiple of 60"
// check; 25/90/300/420 are likewise non-divisors of 60 or 24.
for (const invalid of [7, 25, 45, 59, 90, 300, 420]) {
  check(`cronSchedule(${invalid}) refuses (no even-firing encoding)`, await deathOf(() => cronSchedule(invalid)) !== "", true);
}

check("cronLine carries the job's own marker, not another job's", cronLine(5, { cwd: "/x", command: "./clawforge", args: ["backup"] }, "backup", "myapp").endsWith(jobMarker("backup", "myapp")), true);

// --- parseIntervalToMinutes(): backup's own duration-string convention, funneled through
// cronSchedule so it can never accept an interval the cron line itself would then refuse ----

check("30m -> 30 minutes", parseIntervalToMinutes("30m"), 30);
check("6h -> 360 minutes", parseIntervalToMinutes("6h"), 360);
check("12h -> 720 minutes", parseIntervalToMinutes("12h"), 720);
check("1d -> 1440 minutes", parseIntervalToMinutes("1d"), 1440);
check("a bare number with no unit is refused, named", (await deathOf(() => parseIntervalToMinutes("30"))).includes("--interval must look like"), true);
check("5h has no faithful cron encoding and is refused", (await deathOf(() => parseIntervalToMinutes("5h"))).includes("no faithful encoding"), true);
check("7h has no faithful cron encoding and is refused", (await deathOf(() => parseIntervalToMinutes("7h"))).includes("no faithful encoding"), true);
check("the refusal names the nearest valid values", (await deathOf(() => parseIntervalToMinutes("7h"))).includes("nearest valid: 360, 480"), true);

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

// schtasks parity: same accept/refuse verdict as cronSchedule for every value in the table
// above, since schtasksSchedule() validates by calling cronSchedule() itself, not a copy.
for (const minutes of [15, 30, 60, 120, 360, 1440]) {
  check(`schtasksSchedule(${minutes}) accepts what cronSchedule accepts`, await deathOf(() => schtasksSchedule(minutes)), "");
}
for (const minutes of [7, 25, 45, 59, 90, 300, 420]) {
  check(`schtasksSchedule(${minutes}) refuses whatever cronSchedule refuses`, await deathOf(() => schtasksSchedule(minutes)) !== "", true);
}

{
  const create = schtasksCreateCommand("clawforge-myapp-backup", 1440, { command: "node.exe", args: ["C:\\tools\\clawforge.ts", "--app", "myapp", "backup"] });
  check("schtasksCreateCommand builds /create with the task name, schedule and a quoted /tr", create, {
    command: "schtasks",
    args: ["/create", "/tn", "clawforge-myapp-backup", "/sc", "DAILY", "/tr", displayCommandLine("node.exe", ["C:\\tools\\clawforge.ts", "--app", "myapp", "backup"]), "/f"],
  });
  check("...and /f, so a re-run replaces the same task instead of refusing", create.args.includes("/f"), true);
}
check("schtasksDeleteCommand names the task and forces it", schtasksDeleteCommand("clawforge-myapp-backup"), { command: "schtasks", args: ["/delete", "/tn", "clawforge-myapp-backup", "/f"] });

{
  const path = "/mnt/c/team's app/clawforge";
  const args = ["backup", "a b", "it's", "$(touch injected)", "a; false"];
  const invocation = new WslTransport("test-distro").clientInvocation(path, args);
  check("WSL scheduled invocation keeps shell syntax in one quoted argument", invocation, {
    command: "wsl.exe",
    args: [
      "-d", "test-distro", "--exec", "bash", "-lc",
      `set -e; cd -- ${shellQuote("/mnt/c/team's app")}; exec ${[shellQuote("./clawforge"), ...args.map(shellQuote)].join(" ")}`,
    ],
  });
  check("...with no cmd.exe operator outside its quotes", invocation.args.at(-1)?.includes("&"), false);
}

// Read failures may only become an empty table when cron explicitly says there is none.
{
  const listing = async (code: number, stdout: string, stderr: string) => {
    let env: Record<string, string> | undefined;
    const ctx = {
      transport: {
        description: "ssh:user@host",
        async exec(_command: string, _args: string[], options?: { env?: Record<string, string> }) {
          env = options?.env;
          return { code, stdout, stderr };
        },
      },
    } as unknown as Context;
    const error = await deathOf(() => readCrontab(ctx));
    return { error, env };
  };
  const empty = await listing(1, "", "no crontab for user");
  check("the known no-crontab diagnostic means an empty table", empty.error, "");
  check("crontab diagnostics use the stable C locale", empty.env, { LC_ALL: "C" });
  const denied = await listing(1, "", "permission denied");
  check("an unreadable crontab is surfaced instead of treated as empty", denied.error.includes("could not read crontab"), true);
  const transportFailure = await listing(255, "", "connection lost");
  check("a transport failure is surfaced instead of treated as empty", transportFailure.error.includes("exit 255"), true);
  const privateListing = await listing(1, "SCHEDULER_PRIVATE_FIXTURE", "");
  check("failed partial listings are never echoed", privateListing.error.includes("SCHEDULER_PRIVATE_FIXTURE"), false);
  const partialEmpty = await listing(1, "SCHEDULER_PRIVATE_FIXTURE", "no crontab for user");
  check("partial stdout prevents a contradictory empty-table result", partialEmpty.error.includes("could not read"), true);
  check("contradictory empty-table diagnostics never echo private content", partialEmpty.error.includes("SCHEDULER_PRIVATE_FIXTURE"), false);
}

{
  let calls = 0;
  let answer = { code: 0, stdout: "updated\n", stderr: "" };
  const ctx = {
    transport: {
      description: "ssh:user@host",
      async exec() { calls += 1; return answer; },
    },
  } as unknown as Context;
  const wrongJob = cronLine(5, { cwd: "/x", command: "./clawforge", args: ["backup"] }, "backup", "myapp");
  check("an install cannot insert another job's entry", (await deathOf(() => updateCrontab(ctx, "watch", "myapp", wrongJob))).includes("must match"), true);
  check("multiline input is refused before target execution", (await deathOf(() => updateCrontab(ctx, "watch", "myapp", `${owned}\nforeign`))).includes("exactly one line"), true);
  check("invalid entries never reach the target", calls, 0);
  answer = { code: 26, stdout: "", stderr: "could not acquire scheduler account lock" };
  check("account lock refusal reaches the operator", (await deathOf(() => updateCrontab(ctx, "watch", "myapp", owned))).includes("could not acquire"), true);
  for (const code of [28, 33, 255]) {
    answer = { code, stdout: "SCHEDULER_PRIVATE_FIXTURE", stderr: "SCHEDULER_PRIVATE_FIXTURE" };
    const error = await deathOf(() => updateCrontab(ctx, "watch", "myapp", owned));
    check("scheduler failure never echoes target stdout/stderr", error.includes("SCHEDULER_PRIVATE_FIXTURE"), false);
    check("scheduler failure keeps its exit code", error.includes(`exit ${code}`), true);
  }
  answer = { code: 0, stdout: "unexpected output", stderr: "" };
  check("success requires transaction confirmation", (await deathOf(() => updateCrontab(ctx, "watch", "myapp", owned))).includes("could not confirm"), true);
}


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

  // The printed schtasks line, parsed the way cmd.exe + CommandLineToArgvW would, is exactly
  // what --apply passes as argv — on any host (the platform is forced).
  for (const [entryPath, pasteable] of [["/mnt/d/team's app/clawforge", true], ["/mnt/d/50%/clawforge", false], ["/mnt/d/a&b/clawforge", false]] as const) {
    const realWsl = new WslTransport("Ubuntu-24.04");
    const realCtx = {
      transport: { description: "wsl:Ubuntu-24.04", clientInvocation: realWsl.clientInvocation.bind(realWsl) },
      paths: { async toTarget(): Promise<string> { return entryPath; } },
      settings: {},
    } as unknown as Context;
    const applied: string[][] = [];
    const out: string[] = [];
    await withOutputSink((chunk) => out.push(chunk), () =>
      withScheduleRunner(
        async (_command, args) => { applied.push([...args]); return { code: 0, stdout: "", stderr: "" }; },
        () => printSchedulingInstructions(realCtx, "backup", name, 1440, ["backup"], true),
        "win32",
      ));
    const line = out.join("").split("\n").find((row) => row.trimStart().startsWith("schtasks "));
    check(`${entryPath}: --apply still runs schtasks`, applied.length, 1);
    if (pasteable) {
      check(`${entryPath}: the /tr is bash with no && or cmd.exe operator`, applied[0]?.[applied[0].indexOf("/tr") + 1]?.includes("&"), false);
      check(`${entryPath}: the printed line, parsed by cmd.exe, is the --apply argv`, cmdExeArgv(line?.trim() ?? ""), ["schtasks", ...(applied[0] ?? [])]);
      check(`${entryPath}: the line is labelled for cmd.exe`, out.join("").includes("cmd.exe only"), true);
    } else {
      check(`${entryPath}: a path cmd.exe cannot carry gets no pasteable line, only --apply`, [line, out.join("").includes("use --apply")], [undefined, true]);
    }
  }

  const installedRoot = join(root, "installed project");
  const otherCwd = join(root, "other directory");
  await mkdir(installedRoot);
  await mkdir(otherCwd);
  await writeFile(join(installedRoot, "clawforge"), "");
  await writeFile(join(installedRoot, "app.ts"), 'export default { name: "fixture", summary: "Fixture", commands: {} };\n');
  useDeployment(installedRoot);
  const entry = resolve(monorepoRoot, "tools", "framework", "entry", "bin.ts");
  const fromOtherCwd = spawnSync(process.execPath, ["--experimental-strip-types", entry, "--project-root", installedRoot, "help"], {
    cwd: otherCwd,
    encoding: "utf8",
  });
  check("installed entry loads app.ts from the scheduled root outside its cwd", fromOtherCwd.status, 0);
  // Global mode: no local package, so the job runs the running package's built entry.
  const fakeRunning = join(root, "running", "bin.js");
  await mkdir(join(root, "running"));
  await writeFile(fakeRunning, "");
  const localEntry = join(installedRoot, "node_modules", "@clawforge", "framework", "dist", "entry", "bin.js");
  check("global mode schedules the running package's entry, not a missing local one", installedEntryScript(installedRoot, fakeRunning), fakeRunning);
  check("without a built running entry the local path is kept", installedEntryScript(installedRoot, join(root, "absent.js")), localEntry);
  await mkdir(join(localEntry, ".."), { recursive: true });
  await writeFile(localEntry, "");
  check("a local package wins over the running one", installedEntryScript(installedRoot, fakeRunning), localEntry);
  const withoutRoot = spawnSync(process.execPath, ["--experimental-strip-types", entry, "status"], {
    cwd: otherCwd,
    encoding: "utf8",
  });
  check("installed entry cannot use the unrelated cwd as its app", withoutRoot.status, 1);
} finally {
  await rm(root, { recursive: true, force: true });
}

finish("schedule");
