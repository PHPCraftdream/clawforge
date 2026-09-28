// deploy's --path used to be hardcoded to /opt/openclaw, ignoring OC_REMOTE_PATH
// (ctx.settings.remotePath) — the same setting watch install reads to know where a
// deployment was mirrored. A mismatch between them sends the framework to one directory
// and points every later remote-side command at another. Split from checkout-policy.check.ts
// (same directory) — see fixture.ts for why this is a sibling directory rather than a
// sibling file.

import { deploy } from "#framework/commands/management/deploy/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { ctx, probeReply, isRootProbe } from "./fixture.ts";

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

function runCtxWithRemotePath(remotePath: string, calls: { command: string; args: string[] }[]): Context {
  return {
    ...ctx,
    settings: { ...ctx.settings, remotePath },
    transport: {
      description: "stub",
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (isRootProbe(args)) return probeReply(args);
        calls.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

async function runDeploy(remotePath: string, args: string[]): Promise<{ calls: { command: string; args: string[] }[]; output: string }> {
  const calls: { command: string; args: string[] } [] = [];
  let output = "";
  await withOutputSink(
    (text) => { output += text; },
    () => deploy(runCtxWithRemotePath(remotePath, calls), args),
  );
  return { calls, output };
}

const flatten = (calls: { command: string; args: string[] }[]) => calls.map((call) => [call.command, ...call.args].join(" "));

// --- default --path is OC_REMOTE_PATH, not a hardcoded /opt/openclaw -------------------

{
  const { calls, output } = await runDeploy("/srv/cf", ["deployer@server", "--no-bootstrap"]);
  const flat = flatten(calls);
  const frameworkRsync = calls.find((call) => call.command === "rsync" && call.args.at(-1) === "deployer@server:/srv/cf/");
  check("with no --path, the framework mirrors to OC_REMOTE_PATH (/srv/cf)", frameworkRsync !== undefined, true);
  const appMkdir = flat.find((line) => line.includes("mkdir -p") && line.includes("/srv/cf/apps/example app/config"));
  check("the deployment's remote app directory is nested under OC_REMOTE_PATH", appMkdir !== undefined, true);
  check("no --path was given, so no mismatch note is printed", output.includes("differs from OC_REMOTE_PATH"), false);
}

// --- an explicit --path overrides OC_REMOTE_PATH, and is noted when it diverges --------

{
  const { calls, output } = await runDeploy("/srv/cf", ["deployer@server", "--path", "/opt/custom", "--no-bootstrap"]);
  const frameworkRsync = calls.find((call) => call.command === "rsync" && call.args.at(-1) === "deployer@server:/opt/custom/");
  check("--path overrides OC_REMOTE_PATH for where the mirror actually goes", frameworkRsync !== undefined, true);
  const cfRsync = calls.find((call) => call.command === "rsync" && call.args.at(-1) === "deployer@server:/srv/cf/");
  check("OC_REMOTE_PATH itself is never used once --path is given", cfRsync, undefined);
  check("a diverging --path is named in the closing output", output.includes("--path /opt/custom differs from OC_REMOTE_PATH (/srv/cf)"), true);
  check("the note tells the operator which value to set in .env", output.includes("set OC_REMOTE_PATH=/opt/custom"), true);
}

// --- the same note reaches the closing output of a completing (bootstrapped) deploy too -

{
  const { output } = await runDeploy("/srv/cf", ["deployer@server", "--path", "/opt/custom"]);
  check("the mismatch note also appears after a full (bootstrapped) deploy", output.includes("differs from OC_REMOTE_PATH"), true);
}

// --- an explicit --path equal to OC_REMOTE_PATH is not a mismatch ----------------------

{
  const { output } = await runDeploy("/srv/cf", ["deployer@server", "--path", "/srv/cf", "--no-bootstrap"]);
  check("--path equal to OC_REMOTE_PATH prints no mismatch note", output.includes("differs from OC_REMOTE_PATH"), false);
}

process.stderr.write(failed === 0 ? "all deploy remote-path checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
