// check:exclusive — packs tools/framework, whose prepack rebuilds dist/, which other checks read.
// The system-wide install, end to end: `npm run install:system` into a scratch prefix, then the
// installed `clawforge` run the way a shell runs it (a .cmd through cmd.exe on Windows) in each
// kind of app folder — a fresh one with no install of its own, one pinning its own local
// package, and an apps/<name> of this checkout. Plus the two committed entry points init writes
// (the ./clawforge shim and the MCP launcher), which must reach the system-wide command when
// the deployment has no local package.

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { createApp, appsDir } from "#framework/integration/deployment/scaffold.ts";
import { projectMcpEntries } from "#framework/integration/mcp/project.ts";
import { check, finish } from "#checks/kit/harness.ts";

const windows = process.platform === "win32";

interface Run {
  code: number | null;
  output: string;
}

function run(command: string, args: string[], cwd: string, options: { env?: NodeJS.ProcessEnv; input?: string; shell?: boolean; timeoutMs?: number } = {}): Promise<Run> {
  return new Promise((settle) => {
    const child = spawn(command, args, { cwd, env: options.env ?? process.env, shell: options.shell ?? false, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 90_000);
    child.on("error", (error) => { output += error.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ code, output });
    });
    child.stdin.end(options.input ?? "");
  });
}

/** This environment with `directory` first on PATH, under the key the platform already uses. */
function withOnPath(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAWFORGE_DELEGATED;
  delete env.OC_APP;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  env[key] = `${directory}${delimiter}${env[key] ?? ""}`;
  return env;
}

const expected = (JSON.parse(await readFile(resolve(monorepoRoot, "tools", "framework", "package.json"), "utf8")) as { version: string }).version;
const prefix = await mkdtemp(join(tmpdir(), "clawforge-system-install-"));
const outside = await mkdtemp(join(tmpdir(), "clawforge-system-apps-"));
const checkoutApp = `sys-install-check-${randomBytes(4).toString("hex")}`;
const bin = windows ? prefix : join(prefix, "bin");
const env = withOnPath(bin);
const globalPackage = join(prefix, ...(windows ? [] : ["lib"]), "node_modules", "@clawforge", "framework");

/** The last line of a run's output, parsed as JSON. */
function lastJson(result: Run): Record<string, unknown> {
  return JSON.parse(result.output.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

/** The installed command, as a shell starts it. Arguments here are plain words. */
function clawforge(args: string[], cwd: string): Promise<Run> {
  const shim = join(bin, windows ? "clawforge.cmd" : "clawforge");
  return windows
    ? run(`"${shim}" ${args.join(" ")}`, [], cwd, { env, shell: true })
    : run(shim, args, cwd, { env });
}

function tail(result: Run): void {
  if (result.code !== 0) process.stderr.write(`    ${result.output.trim().split("\n").slice(-6).join("\n    ")}\n`);
}

try {
  // --- the installer --------------------------------------------------------------------
  const installed = await run(process.execPath, ["--experimental-strip-types", resolve(monorepoRoot, "tools", "dev", "install-system.ts"), "--prefix", prefix], monorepoRoot, { timeoutMs: 300_000 });
  tail(installed);
  check("the installer succeeds into a scratch prefix", installed.code, 0);
  check("and reports the installed command", installed.output.includes("==> installed:"), true);
  check("it names a prefix that is not on PATH instead of staying silent", installed.output.includes("is not on PATH"), true);
  check("npm's shim for this platform is in the prefix", existsSync(join(bin, windows ? "clawforge.cmd" : "clawforge")), true);

  const version = await clawforge(["version"], outside);
  tail(version);
  check("the installed command runs outside any app and reports this checkout's version", version.output.trim(), `clawforge ${expected}`);

  const globalInfo = lastJson(await clawforge(["version", "--json"], outside));
  check("version --json names the global copy and its package directory", [globalInfo.source, globalInfo.path], ["global", await realpath(globalPackage)]);
  check("version --json keeps name and version", [globalInfo.name, globalInfo.version], ["clawforge", expected]);
  const verbose = await clawforge(["version", "--verbose"], outside);
  check("version --verbose adds the source and path lines", verbose.output.trim().split("\n").map((line) => line.trim()), [`clawforge ${expected}`, "source: global", `path: ${await realpath(globalPackage)}`]);
  const outsideStatus = await clawforge(["status"], outside);
  check("outside any app the advice stays: run clawforge init", outsideStatus.code === 1 && outsideStatus.output.includes("run: clawforge init"), true);

  // --- a fresh app folder with no framework of its own ----------------------------------------
  const fresh = join(outside, "cf-fresh");
  await mkdir(fresh);
  const initialised = await clawforge(["init"], fresh);
  tail(initialised);
  check("init in a fresh folder succeeds through the system-wide command", initialised.code, 0);
  check("it writes app.ts", existsSync(join(fresh, "app.ts")), true);
  check("and installs nothing into the folder", existsSync(join(fresh, "node_modules")), false);
  const helped = await clawforge(["help"], fresh);
  tail(helped);
  check("app.ts's @clawforge/framework imports resolve to the system-wide package", helped.code, 0);
  check("so the deployment's own commands are listed", helped.output.includes("bootstrap"), true);

  // A subfolder of the app: the deployment is found upward; init there is refused, not nested.
  const sub = join(fresh, "recipes", "sub");
  await mkdir(sub, { recursive: true });
  const subHelp = await clawforge(["help"], sub);
  tail(subHelp);
  check("in a subfolder of the app the deployment is found upward", subHelp.code === 0 && subHelp.output.includes("bootstrap"), true);
  const subInit = await clawforge(["init"], sub);
  check("init in a subfolder of an app is refused", subInit.code, 1);
  check("and says which ancestor holds app.ts", subInit.output.includes("already holds app.ts") && subInit.output.includes("cf-fresh"), true);
  check("and creates nothing there", existsSync(join(sub, "app.ts")), false);

  // The committed MCP launcher, as a client starts it: no local package, so the system-wide
  // command serves the session over the same stdio.
  const control = Object.values(projectMcpEntries())[1] as { args: string[] };
  const mcp = await run(process.execPath, control.args, fresh, {
    env,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`,
  });
  const answer = mcp.output.split("\n").find((line) => line.includes('"id":7'));
  if (answer === undefined) tail({ code: 1, output: mcp.output });
  check("the MCP launcher reaches the system-wide command and answers a ping", answer === undefined ? undefined : (JSON.parse(answer) as { result?: unknown }).result, {});

  // The committed ./clawforge shim is bash; on Windows that is Git Bash, never WSL's bash.exe.
  const bash = windows ? ["C:\\Program Files\\Git\\bin\\bash.exe"].find((path) => existsSync(path)) : "bash";
  if (bash === undefined) {
    process.stderr.write("  skip ./clawforge shim fallback (no Git Bash)\n");
  } else {
    const shimmed = await run(bash, ["./clawforge", "version"], fresh, { env });
    tail(shimmed);
    check("without a local package the ./clawforge shim hands over to the system-wide command", shimmed.output.trim(), `clawforge ${expected}`);

    // A global `clawforge` on PATH that cannot run (npm's shim without node on PATH) must not
    // be exec'd: the shim runs the package next to it with the node it already found.
    const stub = 'process.stdout.write(`stub ${process.argv.slice(2).join(" ")}`);\n';
    for (const [label, packageRoot] of [["windows layout", "bin"], ["posix layout", "."]] as const) {
      const fake = join(outside, `cf-fake-${label.split(" ")[0]}`);
      const fakeBin = join(fake, "bin");
      const entryDir = join(fake, packageRoot, ...(packageRoot === "." ? ["lib"] : []), "node_modules", "@clawforge", "framework", "dist", "entry");
      await mkdir(entryDir, { recursive: true });
      await writeFile(join(entryDir, "bin.js"), stub, "utf8");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(fakeBin, "clawforge"), "#!/bin/sh\necho 'exec: node: not found' >&2\nexit 97\n", { mode: 0o755 });
      const viaGlobalPackage = await run(bash, ["./clawforge", "status"], fresh, { env: withOnPath(fakeBin) });
      tail(viaGlobalPackage);
      check(`the shim runs the global package next to a global command that cannot run itself (${label})`, viaGlobalPackage.output.trim(), "stub status");
    }
  }

  // --- an app pinning its own local package --------------------------------------------------
  const pinned = join(outside, "cf-pinned");
  await mkdir(pinned);
  check("init in a second folder succeeds", (await clawforge(["init"], pinned)).code, 0);
  const localPackage = join(pinned, "node_modules", "@clawforge", "framework");
  await cp(globalPackage, localPackage, { recursive: true });
  const manifestPath = join(localPackage, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: `${expected}-local` }), "utf8");
  const local = await clawforge(["version"], pinned);
  tail(local);
  check("an app's own local package wins over the system-wide one", local.output.trim(), `clawforge ${expected}-local`);
  const localHelp = await clawforge(["help"], pinned);
  tail(localHelp);
  check("and runs the deployment's commands", localHelp.code === 0 && localHelp.output.includes("bootstrap"), true);

  const pinnedSub = join(pinned, "recipes");
  const localInfo = lastJson(await clawforge(["version", "--json"], pinnedSub));
  check("version --json from a subfolder of an app with its own package says local", [localInfo.source, localInfo.path, localInfo.version], ["local", await realpath(localPackage), `${expected}-local`]);

  // The delegation flag covers one hand-over: a clawforge run by a command of this app, in
  // another app with its own package, must still hand over to that package.
  const other = join(outside, "cf-other");
  await mkdir(other);
  check("init in a third folder succeeds", (await clawforge(["init"], other)).code, 0);
  const otherPackage = join(other, "node_modules", "@clawforge", "framework");
  await cp(globalPackage, otherPackage, { recursive: true });
  await writeFile(join(otherPackage, "package.json"), JSON.stringify({ ...manifest, version: `${expected}-other` }), "utf8");
  const probeApp = [
    `import { defineApp } from "@clawforge/framework/app";`,
    `import { mountPoints } from "@clawforge/framework/mounts";`,
    `import { spawnSync } from "node:child_process";`,
    `const run = async () => {`,
    `  const result = spawnSync(process.execPath, [${JSON.stringify(join(globalPackage, "dist", "entry", "bin.js"))}, "version"], { cwd: ${JSON.stringify(other)}, encoding: "utf8", env: process.env });`,
    "  process.stdout.write(`child:${result.stdout.trim()}|flag:${process.env.CLAWFORGE_DELEGATED ?? \"unset\"}\\n`);",
    `};`,
    `export default defineApp({ name: "openclaw", description: "probe", service: { name: "gateway", logTail: "100" }, mounts: mountPoints, commands: { probe: { summary: "probe", run } } });`,
    "",
  ].join("\n");
  await writeFile(join(pinned, "app.ts"), probeApp, "utf8");
  const probe = await clawforge(["probe"], pinned);
  tail(probe);
  check("a descendant does not inherit the hand-over flag", probe.output.includes("flag:unset"), true);
  check("so a clawforge run in another app still hands over to that app's own package", probe.output.includes(`child:clawforge ${expected}-other|`), true);

  // --- this checkout: apps/<name> and the root hand over to the checkout's own gate -------------
  await createApp(checkoutApp);
  const inApp = await clawforge(["help"], resolve(appsDir, checkoutApp));
  tail(inApp);
  check("in apps/<name> of a checkout the checkout's own gate answers", inApp.code === 0 && inApp.output.includes("new-app"), true);
  const checkoutInfo = lastJson(await clawforge(["version", "--json"], resolve(appsDir, checkoutApp)));
  check("version --json in a checkout app says checkout and the checkout root", [checkoutInfo.source, checkoutInfo.path], ["checkout", await realpath(monorepoRoot)]);
  const atRoot = await clawforge(["help"], monorepoRoot);
  tail(atRoot);
  check("and at the checkout root too", atRoot.code === 0 && atRoot.output.includes("new-app"), true);
} finally {
  await rm(resolve(appsDir, checkoutApp), { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(prefix, { recursive: true, force: true });
}

finish("system install");
