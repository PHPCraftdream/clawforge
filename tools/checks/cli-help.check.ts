// Checks that --help actually shows help for the framework-level pseudo-commands —
// new-app, control-mcp, help itself — instead of running the real thing. Also checks that
// `./clawforge help` works in a checkout with no deployments at all, before any app.ts exists to
// load commands from.
//
// control-mcp is the sharp edge: before this was fixed, `./clawforge control-mcp --help` started
// the real MCP server and waited on stdin forever, since --help was only checked for
// commands looked up in app.commands, and control-mcp is dispatched before that lookup
// ever runs. A hang can't be told apart from a slow process without a real timeout, so
// this spawns the real gate (tools/clawforge.ts) with a bounded wait rather than asserting on a
// direct function call.

import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createApp, appsDir } from "../framework/scaffold.ts";
import { monorepoRoot } from "../framework/env.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

/** Runs the real gate with a hard deadline: a hang and a slow success must not look the
 *  same to this check. */
function runGate(args: string[], timeoutMs = 8000): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(
      process.execPath,
      ["--experimental-strip-types", resolve(monorepoRoot, "tools", "clawforge.ts"), ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout: stdout + stderr, timedOut });
    });
  });
}

const deploymentName = `cli-help-check-${randomBytes(4).toString("hex")}`;

try {
  await createApp(deploymentName);

  const controlHelp = await runGate(["--app", deploymentName, "control-mcp", "--help"]);
  check("control-mcp --help does not hang waiting on stdin", controlHelp.timedOut, false);
  check("control-mcp --help exits cleanly", controlHelp.code, 0);
  check("control-mcp --help explains itself, not silence", controlHelp.stdout.includes("MCP tools"), true);

  const helpHelp = await runGate(["--app", deploymentName, "help", "--help"]);
  check("help --help exits cleanly", helpHelp.code, 0);
  check("help --help falls back to the command list", helpHelp.stdout.includes("Usage: ./clawforge <command>"), true);

  const newAppHelp = await runGate(["new-app", "--help"]);
  check("new-app --help exits cleanly", newAppHelp.code, 0);
  check("new-app --help explains itself", newAppHelp.stdout.includes("new-app"), true);
  // The real regression this guards: --help used to be treated as the deployment name and
  // rejected by safeName, instead of being recognised as a request for help.
  check("new-app --help is not treated as an invalid deployment name", newAppHelp.stdout.includes("invalid"), false);

  // The gate used to check the deployment exists before it ever looked at what command was
  // asked for, so `./clawforge help` in a completely fresh checkout (no apps/<name> yet — exactly
  // when someone reaches for help) failed with "deployment not found" instead of listing
  // commands. Deliberately never created, unlike deploymentName above.
  const neverCreated = `cli-help-check-missing-${randomBytes(4).toString("hex")}`;
  const helpBeforeSetup = await runGate(["--app", neverCreated, "help"]);
  check("./clawforge help works before any deployment exists", helpBeforeSetup.code, 0);
  check(
    "./clawforge help before setup still lists real commands",
    helpBeforeSetup.stdout.includes("bootstrap") && helpBeforeSetup.stdout.includes("Usage: ./clawforge <command>"),
    true,
  );

  const realCommandBeforeSetup = await runGate(["--app", neverCreated, "status"]);
  check(
    "a real command still refuses cleanly when there is truly no deployment",
    realCommandBeforeSetup.stdout.includes("not found") && realCommandBeforeSetup.code !== 0,
    true,
  );
} finally {
  await rm(resolve(appsDir, deploymentName), { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all cli-help checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
