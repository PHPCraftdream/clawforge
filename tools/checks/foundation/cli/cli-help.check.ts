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

import { rm, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createApp, appsDir } from "#framework/integration/deployment/scaffold.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { CHILD_NODE_DEADLINE_MS, runProcess } from "#checks/kit/spawn.ts";

/** Runs the real gate with a hard deadline. stdin stays an open, never-written pipe: a server
 *  wrongly started by --help would block on it, whereas /dev/null's EOF would let it exit and hide
 *  the hang. The deadline is generous — a cold start under a loaded machine is slow, a hang is forever. */
async function runGate(args: string[], timeoutMs = CHILD_NODE_DEADLINE_MS): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  const { code, output, timedOut } = await runProcess(
    process.execPath,
    ["--experimental-strip-types", resolve(monorepoRoot, "tools", "clawforge.ts"), ...args],
    { keepStdinOpen: true, timeoutMs },
  );
  return { code, stdout: output, timedOut };
}

const deploymentName = `cli-help-check-${randomBytes(4).toString("hex")}`;

try {
  await createApp(deploymentName);

  // new-app's own .gitignore must keep machine-local, regenerated-every-cycle state out of a
  // deployment's git history (state/watch.json, sets/*.tar.gz and sets/.tries|receipts/) while
  // leaving config/, recipes/ and deployment.lock.json — the parts lock.ts's own advice tells
  // an operator to commit — trackable. Only actual ignore-pattern lines count: an explanatory
  // comment mentioning "config/" in passing must not read as excluding it.
  const gitignoreLines = (await readFile(resolve(appsDir, deploymentName, ".gitignore"), "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  check("the deployment .gitignore excludes machine-local watch state", gitignoreLines.includes("state/"), true);
  check("and excludes built set artifacts", gitignoreLines.includes("sets/"), true);
  check("but leaves config/ trackable", gitignoreLines.includes("config/"), false);
  check("and leaves recipes/ trackable", gitignoreLines.includes("recipes/"), false);
  check("and leaves deployment.lock.json trackable", gitignoreLines.includes("deployment.lock.json"), false);

  const controlHelp = await runGate(["--app", deploymentName, "control-mcp", "--help"]);
  check("control-mcp --help does not hang waiting on stdin", controlHelp.timedOut, false);
  check("control-mcp --help exits cleanly", controlHelp.code, 0);
  check("control-mcp --help explains itself, not silence", controlHelp.stdout.includes("MCP tools"), true);

  const helpHelp = await runGate(["--app", deploymentName, "help", "--help"]);
  check("help --help exits cleanly", helpHelp.code, 0);
  check("help --help falls back to the command list", helpHelp.stdout.includes(`Usage: ./clawforge --app ${deploymentName} <command>`), true);

  // `help control-mcp` used to fail with "unknown command: control-mcp / did you mean:
  // control-mcp" — the general help and completion both offer it, but renderHelp knew only
  // app.commands and gate commands, while closestCommand happily suggested the exact match.
  const helpControl = await runGate(["--app", deploymentName, "help", "control-mcp"]);
  check("help control-mcp exits cleanly", helpControl.code, 0);
  check("help control-mcp does not report itself unknown", helpControl.stdout.includes("unknown command"), false);
  check("help control-mcp does not suggest itself", helpControl.stdout.includes("did you mean: control-mcp"), false);
  check("help control-mcp prints its help", helpControl.stdout.includes("MCP tools"), true);

  // mcp-serve and the other framework-owned names live in the declarations renderHelp
  // already reads; spot-check that `help <name>` answers for one of them too.
  const helpMcpServe = await runGate(["--app", deploymentName, "help", "mcp-serve"]);
  check("help mcp-serve exits cleanly", helpMcpServe.code, 0);
  check("help mcp-serve prints its help", helpMcpServe.stdout.includes("mcp-serve —"), true);

  const newAppHelp = await runGate(["new-app", "--help"]);
  check("new-app --help exits cleanly", newAppHelp.code, 0);
  check("new-app --help explains itself", newAppHelp.stdout.includes("new-app"), true);
  // The real regression this guards: --help used to be treated as the deployment name and
  // rejected by safeName, instead of being recognised as a request for help.
  check("new-app --help is not treated as an invalid deployment name", newAppHelp.stdout.includes("invalid"), false);

  // `help help` used to fall through to reportUnknownCommand, which then suggested "help" for
  // the very word just typed — "help" is always in its own candidate pool.
  const helpForHelp = await runGate(["--app", deploymentName, "help", "help"]);
  check("help help exits cleanly", helpForHelp.code, 0);
  check("help help does not report itself as unknown", helpForHelp.stdout.includes("unknown command"), false);
  check("help help does not suggest itself", helpForHelp.stdout.includes("did you mean: help"), false);
  check("help help falls back to the command list", helpForHelp.stdout.includes(`Usage: ./clawforge --app ${deploymentName} <command>`), true);

  // `new-app a b` used to read args[0] directly, so "b" vanished silently instead of being
  // refused — the shared declaration parser refuses any token past the one declared positional.
  const extraPositional = await runGate(["new-app", `${deploymentName}-extra`, "b"]);
  check("new-app with an extra positional exits non-zero", extraPositional.code === 0, false);
  check("new-app with an extra positional names the stray token", extraPositional.stdout.includes("unknown argument: b"), true);

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

  // Before this fix, this branch always ended in process.exit(0) regardless of what runApp()
  // reported — a typo'd sub-argument printed "unknown command" yet still exited success.
  const helpTypoBeforeSetup = await runGate(["--app", neverCreated, "help", "lsit"]);
  check("./clawforge help <typo> exits non-zero", helpTypoBeforeSetup.code === 0, false);
  check(
    "./clawforge help <typo> still names the unknown command",
    helpTypoBeforeSetup.stdout.includes("unknown command: lsit"),
    true,
  );
} finally {
  await rm(resolve(appsDir, deploymentName), { recursive: true, force: true });
}

finish("cli-help");
