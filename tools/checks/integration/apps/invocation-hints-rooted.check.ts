// rooted invocation hint assertions
import { resolve } from "node:path";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { frameworkOwner } from "#framework/entry/resolve.ts";
import { spawnDelegated } from "#framework/entry/delegate.ts";
import { resolveCheckoutEntry } from "#framework/entry/resolve.ts";
import { frameFromInvocation } from "#framework/core/io/invocation/frame.ts";
import type { Invocation } from "#framework/core/io/invocation/index.ts";
import { INVOCATION_ENV, parseInvocation } from "#framework/core/io/invocation/index.ts";

import { appsRootFor, monorepoRoot } from "#framework/core/env.ts";
import { checkoutGateFrame } from "#framework/core/io/invocation/frame.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { renderFrameAdvice } from "#framework/core/io/invocation/render.ts";
import { check, checkTrue, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";
import { runProcess, CHILD_NODE_DEADLINE_MS } from "#checks/kit/spawn.ts";

const GATE = resolve(monorepoRoot, "tools", "clawforge.ts");
const SUBDIR = resolve(monorepoRoot, "docs");

/** Runs the real gate from `cwd` — the committed shim path, exactly as gate-dispatch does. */
function runGate(args: string[], cwd: string): Promise<string> {
  return runProcess(process.execPath, ["--experimental-strip-types", GATE, ...args], { cwd, timeoutMs: CHILD_NODE_DEADLINE_MS })
    .then((result) => result.output);
}

// entry: the real gate runs against an EMPTY apps root, so a deployment left in the checkout never selects itself

const entryApps = await isolatedAppsRoot("rooted-hints");
const docsHelp = await runGate(["help"], SUBDIR);
check("help from docs/ spells the entry relative to that folder", docsHelp.split(["Usage:", "../clawforge", "<command>", "[options]"].join(" ")).length > 1, true);
check("help from docs/ carries no root spelling", docsHelp.split(["Usage:", "./clawforge"].join(" ")).length > 1, false);

const docsUnknown = await runGate(["frobnicate"], SUBDIR);
check("an unknown command's hint from docs/ spells the entry relative to that folder", docsUnknown.split(["run", "../clawforge", "help"].join(" ")).length > 1, true);

const rootHelp = await runGate(["help"], monorepoRoot);
check("help from the checkout root keeps the root spelling", rootHelp.split(["Usage:", "./clawforge", "<command>", "[options]"].join(" ")).length > 1, true);
await entryApps.dispose();

// unit frame

const ROOT = "/clawforge-checkout";
const HOST = "posix";
const FRAME_SUBDIR = `${ROOT}/docs`;
const frame = checkoutGateFrame(ROOT, { host: HOST, msys: false, cwd: FRAME_SUBDIR });
checkTrue("frame rooted relative hint", renderFrameAdvice(command(["status"]), frame) === ["../clawforge", "status"].join(" "));
checkTrue("the rooted hint derives its entry from the frame root", renderFrameAdvice(command(["status"]), frame).startsWith("../clawforge"));
const atRoot = checkoutGateFrame(ROOT, { host: HOST, msys: false, cwd: ROOT });
checkTrue("root frame spelling", renderFrameAdvice(command(["status"]), atRoot) === ["./clawforge", "status"].join(" "));

// production: delegated spawn helper executes the production spawn contract through an injected runner.
const invocation: Invocation = { program: "clawforge", mode: "installed", app: { name: "demo", selectedBy: "flag" }, audience: "terminal" };
const spawnFrame = frameFromInvocation(invocation, { host: "posix", msys: false, cwd: process.cwd() });
const fixture = await createDeploymentFixture();
try {
  const root = fixture.root;
  const checkoutRoot = monorepoRoot;
  const appsRoot = appsRootFor(checkoutRoot);
  const appRoot = resolve(monorepoRoot, "apps", "demo");
  const owner = frameworkOwner({ self: resolve(root, "global", "entry", "bin.js"), appRoot, launchArgv: ["--app", "demo", "status"], argv: ["status"], handedOver: false, platform: "linux", fs: {
    exists: (path) => path === resolve(checkoutRoot, "tools", "clawforge.ts") || path === resolve(appRoot, "app.ts") || path === resolve(checkoutRoot, "apps", "demo", "app.ts"),
    isDirectory: (path) => path === resolve(checkoutRoot, "apps", "demo") || path === resolve(checkoutRoot, "apps"),
    readdir: (path) => path === resolve(checkoutRoot, "apps") ? ["demo"] : [],
    readFile: (path) => path === resolve(checkoutRoot, "tools", "framework", "package.json") ? JSON.stringify({ name: "@clawforge/framework" }) : undefined,
    realpath: (path) => path,
  }, localEntry: undefined });
  checkTrue("system launch delegates to owning checkout gate", owner.kind === "spawn" && owner.delegated === false);
  if (owner.kind === "spawn") {
    let captured: { command: string; args: readonly string[]; options: SpawnSyncOptions } | undefined;
    const runner = (command: string, args: readonly string[], options: SpawnSyncOptions) => {
      captured = { command, args, options };
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, error: undefined } as ReturnType<typeof spawnSync>;
    };
    spawnDelegated(owner.entry, [...owner.args], owner.delegated, spawnFrame, runner as typeof spawnSync);
    check("delegated spawn passes selected app to final gate", captured?.args.slice(2), owner.args);
    checkTrue("delegated spawn inherits cwd", captured !== undefined && captured.options.cwd === undefined);
    const finalInvocation = captured === undefined ? undefined : parseInvocation(String(captured.options.env?.[INVOCATION_ENV]));
    checkTrue("delegated spawn serializes selected app", finalInvocation?.app?.name === "demo" && finalInvocation.app.selectedBy === "flag");
    const final = resolveCheckoutEntry({ root: checkoutRoot, cwd: process.cwd(), argv: owner.args, ocApp: undefined, handedOver: true, launch: frame.launch, handedProgram: owner.entry, fs: {
      exists: (path) => path === resolve(checkoutRoot, "tools", "clawforge.ts") || path === resolve(appsRoot, "openclaw", "app.ts") || path === resolve(appsRoot, "demo", "app.ts"),
      isDirectory: (path) => path === appsRoot || path === resolve(appsRoot, "demo"),
      readdir: (path) => path === appsRoot ? ["demo"] : [],
      readFile: (path) => path === resolve(checkoutRoot, "tools", "framework", "package.json") ? JSON.stringify({ name: "@clawforge/framework" }) : undefined,
      realpath: (path) => path,
    }, gateCommands: [], deploymentCommands: ["status"], variadicCommands: [] });
    checkTrue("delegated spawn passes the selected app to the final gate", final.kind === "run" && final.appName === "demo");
    check("delegated spawn preserves the final argv", final.kind === "run" ? final.argv : undefined, ["status"]);
  }
} finally {
  await fixture.dispose();
}

finish("rooted invocation hints");
