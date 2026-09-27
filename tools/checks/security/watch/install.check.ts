// `./clawforge watch install` / `watch uninstall` — the pure builders (marker, cron line,
// which transports are schedulable), and the idempotent install/uninstall cycle against a
// stub transport that answers `crontab`/`sh -c "command -v crontab"` and the instance
// lock's own mkdir/test/mv/rm plumbing — the same lock harness
// tools/checks/security/expose/tailscale.check.ts uses.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cronLine,
  displayCommandLine,
  schedulingSupport,
  watchInstall,
  watchMarker,
  watchUninstall,
  withoutMarkedLine,
} from "#framework/watch/install.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { stubContext } from "#checks/runtime/convergence/instance-lock/fixture.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecOptions, ExecResult } from "#framework/runtime/transport.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

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
  "withoutMarkedLine keeps every other line and drops only the marked one, and blanks",
  withoutMarkedLine("0 3 * * * /usr/bin/backup.sh\n*/5 * * * * ./clawforge watch check # clawforge-watch:myapp\n\n0 4 * * * /usr/bin/other.sh\n", "myapp"),
  ["0 3 * * * /usr/bin/backup.sh", "0 4 * * * /usr/bin/other.sh"],
);
check(
  "withoutMarkedLine leaves a DIFFERENT deployment's marked line alone",
  withoutMarkedLine("*/5 * * * * ./clawforge watch check # clawforge-watch:other\n", "myapp"),
  ["*/5 * * * * ./clawforge watch check # clawforge-watch:other"],
);

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
function crontabTransport(initial = ""): { transport: Context["transport"]; calls: RecordedCall[]; crontab: () => string } {
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
  const ctx = { transport, settings: { remotePath: "/opt/openclaw", dataDir: "/does/not/exist", env: {} } } as unknown as Context;

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

  // --apply again, with a different interval: replaces the SAME line rather than duplicating it.
  await withOutputSink(() => {}, () => watchInstall(ctx, ["--apply", "--interval", "10"]));
  const afterSecondInstall = crontab();
  const ourLines = afterSecondInstall.split("\n").filter((line) => line.includes(watchMarker(name)));
  check("re-installing replaces the one line rather than adding a second", ourLines.length, 1);
  check("the new interval took effect", ourLines[0]?.startsWith("*/10 * * * *"), true);
  check("the foreign and other-deployment lines are still untouched", [afterSecondInstall.includes(FOREIGN), afterSecondInstall.includes(OTHER_DEPLOYMENT)], [true, true]);

  // uninstall --apply: removes only OUR marked line.
  await withOutputSink(() => {}, () => watchUninstall(ctx, ["--apply"]));
  const afterUninstall = crontab();
  check("uninstall removes our own line", afterUninstall.includes(watchMarker(name)), false);
  check("uninstall leaves the foreign entry alone", afterUninstall.includes(FOREIGN), true);
  check("uninstall leaves another deployment's entry alone", afterUninstall.includes(OTHER_DEPLOYMENT), true);

  // uninstall --apply again: nothing to remove, and it does not touch the crontab at all.
  calls.length = 0;
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => watchUninstall(ctx, ["--apply"]));
  check("a second uninstall reports nothing to remove", written.join("").includes("nothing to remove"), true);
  check("and never re-writes the crontab", calls.some((call) => call.command === "crontab" && call.args[0] === "-"), false);
} finally {
  await rm(root, { recursive: true, force: true });
}

// --- an unsupported transport never installs, apply or not ------------------------------

{
  const ctx = {
    transport: { description: "wsl:Ubuntu-24.04", clientInvocation: (entry: string, args: string[]) => ({ command: "wsl.exe", args: [entry, ...args] }) },
    paths: { async toTarget(path: string): Promise<string> { return path; } },
    settings: {},
  } as unknown as Context;
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => watchInstall(ctx, []));
  check("an unsupported transport prints instructions instead of a crontab line", written.join("").includes("Run this yourself"), true);

  const message = await deathOf(() => withOutputSink(() => {}, () => watchInstall(ctx, ["--apply"])));
  check("--apply refuses outright on an unsupported transport", message.includes("refusing --apply"), true);
}

// The printed operator command must survive a paste: bash -lc's script is one argument.
check(
  "an argument with spaces and && stays one quoted argument",
  displayCommandLine("wsl.exe", ["-d", "Ubuntu-24.04", "--", "bash", "-lc", "cd '/mnt/d/x' && ./clawforge watch check"]),
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd '/mnt/d/x' && ./clawforge watch check"`,
);

process.stderr.write(failed === 0 ? "all watch install checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
