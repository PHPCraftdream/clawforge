// `./clawforge backup install` / `backup uninstall` — mirrors watch/install.check.ts's own
// idempotent install/uninstall cycle against a stub crontab + the real instance lock, proving
// backup's schedule uses its OWN marker ("backup", not "watch") so the two jobs — and a
// watch entry already installed for the same deployment — never disturb each other.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupInstall,
  backupUninstall,
} from "#framework/commands/lifecycle/backup/install.ts";
import { jobMarker, schedulerIdentity, withScheduleRunner } from "#framework/commands/operate/schedule.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { stubContext } from "#checks/runtime/convergence/instance-lock/fixture.ts";
import { stubCrontabTransaction } from "#checks/runtime/schedule/fixture.ts";
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

interface RecordedCall { readonly command: string; readonly args: string[] }

/** Same fixture watch/install.check.ts uses: a stub `crontab`/`sh -c "command -v crontab"`
 *  layered over the real instance-lock fixture, so install/uninstall run their real locking
 *  code across repeated --apply cycles. */
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
      if (command === "sh" && args[2] === "clawforge-scheduler-root") {
        return { code: 0, stdout: `${args[3]}\n`, stderr: "" };
      }
      if (command === "sh" && args[2] === "clawforge-crontab-update") {
        calls.push({ command: "crontab", args: ["-l"] });
        const transaction = stubCrontabTransaction(args, current, listingFailure);
        if (transaction.wrote) calls.push({ command: "crontab", args: ["-"] });
        current = transaction.next;
        return transaction.result;
      }
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


const root = await mkdtemp(join(tmpdir(), "clawforge-backup-install-check-"));
useDeployment(root);
const name = deploymentName();

try {
  const WATCH_ENTRY = `*/5 * * * * cd /opt/openclaw && ./clawforge watch check >/dev/null 2>&1 ${jobMarker("watch", name)}`;
  const FOREIGN = "0 3 * * * /usr/bin/foreign-backup.sh";
  const { transport, calls, crontab } = crontabTransport(`${FOREIGN}\n${WATCH_ENTRY}\n`);
  const ctx = {
    transport,
    settings: { remotePath: "/opt/openclaw", dataDir: "/does/not/exist", env: {} },
    runtime: { async isRunning(): Promise<boolean> { return true; } },
  } as unknown as Context;
  const identity = await schedulerIdentity(ctx);

  // print-only (no --apply): never touches crontab at all.
  await withOutputSink(() => {}, () => backupInstall(ctx, []));
  check("print-only install never reads or writes the real crontab", calls.some((call) => call.command === "crontab"), false);

  // --apply, default interval (1d): installs our own line under our OWN marker, leaving the
  // foreign line AND the same deployment's own watch entry alone.
  await withOutputSink(() => {}, () => backupInstall(ctx, ["--apply"]));
  const afterInstall = crontab();
  check("the foreign entry survives install", afterInstall.includes(FOREIGN), true);
  check("this deployment's own watch entry survives install untouched", afterInstall.includes(WATCH_ENTRY), true);
  check("our own backup marker is present", afterInstall.includes(jobMarker("backup", identity)), true);
  check("the default interval (1d) is a daily schedule", afterInstall.includes("0 0 * * * cd"), true);

  // --apply again with a different interval: replaces the SAME line rather than duplicating it.
  await withOutputSink(() => {}, () => backupInstall(ctx, ["--apply", "--interval", "6h"]));
  const afterSecondInstall = crontab();
  const ourLines = afterSecondInstall.split("\n").filter((line) => line.includes(jobMarker("backup", identity)));
  check("re-installing replaces the one line rather than adding a second", ourLines.length, 1);
  check("the new interval took effect", ourLines[0]?.startsWith("0 */6 * * *"), true);
  check("the foreign and watch entries are still untouched", [afterSecondInstall.includes(FOREIGN), afterSecondInstall.includes(WATCH_ENTRY)], [true, true]);

  // an invalid interval is refused up front, before any crontab line is even built.
  {
    calls.length = 0;
    const message = await deathOf(() => withOutputSink(() => {}, () => backupInstall(ctx, ["--interval", "90m"])));
    check("--interval 90m is refused — no faithful cron encoding", message.length > 0, true);
    check("...and never touches the crontab", calls.some((call) => call.command === "crontab"), false);
  }
  {
    const message = await deathOf(() => withOutputSink(() => {}, () => backupInstall(ctx, ["--interval", "not-a-duration"])));
    check("a malformed --interval is refused, named", message.includes("number of minutes or look like 30m"), true);
  }
  {
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), () => backupInstall(ctx, ["--interval", "30"]));
    check("a bare number is minutes, as in `watch install`", written.join("").includes("*/30 * * * *"), true);
    const message = await deathOf(() => withOutputSink(() => {}, () => backupInstall(ctx, ["--interval", "45m"])));
    check("--interval 45m suggests only values backup itself accepts", message.includes("nearest valid: 30m, 1h"), true);
  }

  // uninstall --apply: removes only OUR marked line.
  await withOutputSink(() => {}, () => backupUninstall(ctx, ["--apply"]));
  const afterUninstall = crontab();
  check("uninstall removes our own line", afterUninstall.includes(jobMarker("backup", identity)), false);
  check("uninstall leaves the foreign entry alone", afterUninstall.includes(FOREIGN), true);
  check("uninstall leaves this deployment's own watch entry alone", afterUninstall.includes(WATCH_ENTRY), true);

  // uninstall --apply again: nothing to remove, and it does not touch the crontab at all.
  calls.length = 0;
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => backupUninstall(ctx, ["--apply"]));
  check("a second uninstall reports nothing to remove", written.join("").includes("nothing to remove"), true);
  check("and never re-writes the crontab", calls.some((call) => call.command === "crontab" && call.args[0] === "-"), false);

  const unreadableInitial = `${FOREIGN}\n${WATCH_ENTRY}\n`;
  const unreadable = crontabTransport(unreadableInitial, { code: 1, stdout: "", stderr: "permission denied" });
  const unreadableCtx = { ...ctx, transport: unreadable.transport } as Context;
  const readError = await deathOf(() => withOutputSink(() => {}, () => backupInstall(unreadableCtx, ["--apply"])));
  check("backup install aborts on crontab read failure", readError.includes("could not read crontab"), true);
  check("backup install leaves existing entries untouched on read failure", unreadable.crontab(), unreadableInitial);
  check("backup install never writes after a crontab read failure", unreadable.calls.some((call) => call.command === "crontab" && call.args[0] === "-"), false);

// --- an unsupported transport never installs a crontab line; on an actual Windows host it
// can apply through the recording transport only, targeting backup's own task name ----------

{
  const ctx = {
    transport: { description: "wsl:Ubuntu-24.04", clientInvocation: (entry: string, args: string[]) => ({ command: "wsl.exe", args: [entry, ...args] }) },
    paths: { async toTarget(path: string): Promise<string> { return path; } },
    settings: {},
  } as unknown as Context;
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => withScheduleRunner(
    async () => ({ code: 0, stdout: "", stderr: "" }),
    () => backupInstall(ctx, []),
    "win32",
  ));
  check("an unsupported transport prints instructions instead of a crontab line", written.join("").includes("Run this yourself"), true);

  {
    const recorded: { command: string; args: string[] }[] = [];
    await withOutputSink(() => {}, () =>
      withScheduleRunner(
        async (command, args) => {
          recorded.push({ command, args: [...args] });
          return { code: 0, stdout: "", stderr: "" };
        },
        () => backupInstall(ctx, ["--apply"]),
        "win32",
      ));
    check("--apply on Windows runs schtasks through the recording transport, never a real one", recorded.length, 1);
    const failed = await deathOf(() => withOutputSink(() => {}, () => withScheduleRunner(
      async () => ({ code: 1, stdout: "", stderr: "access denied" }),
      () => backupUninstall(ctx, ["--apply"]),
      "win32",
    )));
    check("a failed Windows backup uninstall is reported", failed.includes("access denied"), true);
  }
  if (process.platform !== "win32") {
    const message = await deathOf(() => withOutputSink(() => {}, () => backupInstall(ctx, ["--apply"])));
    check("--apply refuses outright on an unsupported, non-Windows transport", message.includes("refusing --apply"), true);
  }
}
} finally {
  await rm(root, { recursive: true, force: true });
}

finish("backup install");
