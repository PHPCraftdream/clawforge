// check:exclusive — packs tools/framework, whose prepack rebuilds dist/, which other checks read.
// The system-wide install, end to end: `npm run install:system` into a scratch prefix, then the
// installed `clawforge` run the way a shell runs it (a .cmd through cmd.exe on Windows) in each
// kind of app folder — a fresh one with no install of its own, one pinning its own local
// package, and an apps/<name> of this checkout. Plus the two committed entry points init writes
// (the ./clawforge shim and the MCP launcher), which must reach the system-wide command when
// the deployment has no local package.

import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createName } from "#framework/core/values/names.ts";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { createApp } from "#framework/integration/deployment/scaffold.ts";
import { CLAWFORGE_CONTROL_MCP_NAME, projectMcpEntries } from "#framework/integration/mcp/project.ts";
import { usageTopLine, usageFooterHint } from "#framework/core/io/help-render.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { renderAdvice, WINDOWS_BIN_PROGRAM } from "#framework/core/io/invocation/render.ts";
import type { Invocation } from "#framework/core/io/invocation/index.ts";
import { FULL_LIST_NOTE, CHECKOUT_NOTE, NO_APP_TS_HERE, RUNS_INSIDE_NOTE, CHECKOUT_ROOT_NOTE, unknownCommandMessage, didYouMeanMessage, emptyDirNote, closestCommand } from "#framework/integration/gate.ts";
import { surfaceRegistry } from "#framework/entry/registry.ts";
import { INIT_REFUSES_NOTE, ALREADY_INITIALISED, noSaveInstall } from "#framework/integration/deployment/init.ts";
import { ALREADY_HOLDS_APP, NOTHING_TO_INSTALL_NOTE, IN_BASH_NOTE, NOT_INITIALISED_NOTE, FROM_CHECKOUT_ROOT, takeoverNote, CANNOT_LOAD } from "#framework/entry/resolve.ts";
import { APP_CONFLICT_NOTE, FOREIGN_SOURCES_NOTE } from "#framework/entry/delegate.ts";
import { INSTALLED_MARK, NOT_ON_PATH_HINT } from "#tools/dev/install-messages.ts";
import { check, requires, finish } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";

const windows = process.platform === "win32";

const installedHint: Invocation = { program: "clawforge", mode: "installed", audience: "terminal" };
const shimHint: Invocation = { program: "./clawforge", mode: "checkout", audience: "terminal" };
// The app's own package run directly: the bash shim does not run in cmd or PowerShell, so on Windows
// the hints name npm's bin wrapper (defaultInvocation, entry/root.ts).
const localPackageHint: Invocation = windows ? { ...shimHint, program: WINDOWS_BIN_PROGRAM } : shimHint;
const names = surfaceRegistry().names;
const say = (argv: string[], on: Invocation, app?: string): string => renderAdvice(command(argv, app === undefined ? undefined : { app }), on);

interface Run {
  code: number | null;
  output: string;
}

async function run(command: string, args: string[], cwd: string, options: { env?: NodeJS.ProcessEnv; input?: string; shell?: boolean; timeoutMs?: number } = {}): Promise<Run> {
  const { code, output } = await runProcess(command, args, {
    cwd, env: options.env, shell: options.shell ?? false, input: options.input ?? "", timeoutMs: options.timeoutMs ?? 90_000,
  });
  return { code, output };
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
// A synthetic checkout for the apps/-parent probes: same geometry as the real one (tools/framework
// manifest + tools/clawforge.ts beside it), with the gate a shim handing off to the real gate, so
// the hand-over and takeover logic runs physically while every deployment lands in the temp tree.
const sc = await mkdtemp(join(tmpdir(), "clawforge-system-checkout-"));
const scApps = join(sc, "apps");
// Declared here so the finally can clean up even when the failure happens before the
// assignment inside the try block.
let packRoot: string | undefined;
const realGate = resolve(monorepoRoot, "tools", "clawforge.ts");
await mkdir(join(sc, "tools", "framework"), { recursive: true });
await writeFile(join(sc, "tools", "framework", "package.json"), JSON.stringify({ name: "@clawforge/framework" }), "utf8");
await writeFile(
  join(sc, "tools", "clawforge.ts"),
  `// Check-only shim: stands in for the real gate at this synthetic checkout's root.\n` +
  `import { pathToFileURL } from "node:url";\n` +
  `if (process.env.CLAWFORGE_REAL_GATE === undefined) throw new Error("CLAWFORGE_REAL_GATE not set");\n` +
  `await import(pathToFileURL(process.env.CLAWFORGE_REAL_GATE).href);\n`,
  "utf8",
);
process.env["CLAWFORGE_REAL_GATE"] = realGate;
// Deployments resolve through appsRootFor, so this points createApp and the gate at the synthetic
// apps/ — set before the spawn env below is built, so the children inherit it too.
process.env["CLAWFORGE_CHECKS_APPS_DIR"] = scApps;
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

// The pack-and-install runs entirely on a TEMP COPY of the packing tree (see below), so the
// prepack build's dist/ lands in the temp tree, never in this checkout.
try {
  // --- the pack: a temp copy of the packing tree -----------------------------------------
  // tools/framework's prepack (tools/build-framework-package.ts) and the installer
  // (tools/dev/install-system.ts) both derive every path from their own import.meta.url —
  // nothing is pinned to the real checkout — so copying the layout they expect and running the
  // copied installer keeps the produced tarball byte-equivalent while dist/ is rebuilt in the
  // temp tree. The layout each piece reads:
  //   tools/framework/**            sources, tsconfig.declaration.json, package.json, README.md,
  //                                 LICENSE*, NOTICE, THIRD_PARTY_NOTICES.md, docker-compose.yml,
  //                                 .env.example (npm pack's "files" + build script's copies)
  //   tsconfig.json                 repo root, extended by tsconfig.declaration.json; tsgo runs
  //                                 with the tree root as cwd
  //   tools/build-framework-package.ts  the prepack script, run as "../build-framework-package.ts"
  //   tools/dev/install-system.ts + resolve-on-path.ts + install-messages.ts  the installer and
  //                                 its imports; its repoRoot is its own grandparent
  //   node_modules                  tsgo (@typescript/native-preview) and @types/node; the build
  //                                 resolves them upward, so one link at the temp root suffices
  packRoot = await mkdtemp(join(tmpdir(), "clawforge-pack-"));
  await mkdir(join(packRoot, "tools", "dev"), { recursive: true });
  await cp(resolve(monorepoRoot, "tools", "framework"), join(packRoot, "tools", "framework"), {
    recursive: true,
    filter: (entry) => {
      const name = basename(entry);
      return name !== "dist" && name !== "node_modules";
    },
  });
  await cp(resolve(monorepoRoot, "tsconfig.json"), join(packRoot, "tsconfig.json"));
  await cp(resolve(monorepoRoot, "tools", "build-framework-package.ts"), join(packRoot, "tools", "build-framework-package.ts"));
  for (const file of ["install-system.ts", "resolve-on-path.ts", "install-messages.ts"]) {
    await cp(resolve(monorepoRoot, "tools", "dev", file), join(packRoot, "tools", "dev", file));
  }
  await symlink(resolve(monorepoRoot, "node_modules"), join(packRoot, "node_modules"), windows ? "junction" : "dir");

  // --- the installer --------------------------------------------------------------------
  const installed = await run(process.execPath, ["--experimental-strip-types", resolve(packRoot, "tools", "dev", "install-system.ts"), "--prefix", prefix], packRoot, { timeoutMs: 300_000 });
  tail(installed);
  check("the installer succeeds into a scratch prefix", installed.code, 0);
  check("and reports the installed command", installed.output.includes(INSTALLED_MARK), true);
  check("it names a prefix that is not on PATH instead of staying silent", installed.output.includes(NOT_ON_PATH_HINT), true);
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
  check("outside any app the advice stays: run clawforge init", outsideStatus.code === 1 && outsideStatus.output.includes(NOT_INITIALISED_NOTE) && outsideStatus.output.includes(say(["init"], installedHint)), true);

  // Outside an app, help lists the gate commands instead of failing.
  for (const args of [["help"], ["--help"], ["-h"]]) {
    const gateHelp = await clawforge(args, outside);
    check(`outside any app clawforge ${args.join(" ")} lists the gate commands and exits 0`, gateHelp.code === 0 && ["init", "version", "completion"].every((name) => gateHelp.output.includes(name)), true);
    check(`and points at an initialised app folder (${args.join(" ")})`, gateHelp.output.includes(FULL_LIST_NOTE) && !gateHelp.output.includes(NO_APP_TS_HERE), true);
  }
  const gateInitHelp = await clawforge(["help", "init"], outside);
  check("outside any app help init prints init's help", gateInitHelp.code === 0 && gateInitHelp.output.includes(INIT_REFUSES_NOTE), true);
  const appHelp = await clawforge(["help", "status"], outside);
  check(
    "outside any app help <app command> prints the command's help and says where it runs (R32-09)",
    appHelp.code === 0 && /Usage: (\.\/)?clawforge status/.test(appHelp.output) && appHelp.output.includes(RUNS_INSIDE_NOTE),
    true,
  );

  const bareRun = await clawforge([], outside);
  check("outside any app a bare clawforge lists the gate commands and exits 0", bareRun.code === 0 && bareRun.output.includes("init") && !bareRun.output.includes(NO_APP_TS_HERE), true);
  const unknownHelp = await clawforge(["help", "int"], outside);
  // Independent token expectation: single-word tokens, no counted prose pin.
  const UNKNOWN_SUGGESTION = ["unknown", "command:", "int"];
  const MEANT_INIT = ["did", "you", "mean:", "init"];
  check("outside any app help <unknown> is an unknown command with a suggestion", unknownHelp.code === 1 && UNKNOWN_SUGGESTION.every((token) => unknownHelp.output.includes(token)) && MEANT_INIT.every((token) => unknownHelp.output.includes(token)), true);

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
  check("the global command's help footer says clawforge help <command>", helped.output.includes(usageFooterHint(installedHint)), true);
  check("and never advises ./clawforge, which does not run in every shell", helped.output.includes(usageTopLine(shimHint)) || helped.output.includes(usageFooterHint(shimHint)), false);
  check("the help heading carries the directory name, not a hardcoded openclaw", helped.output.includes("cf-fresh" + " — ") && !helped.output.includes("openclaw" + " — "), true);
  const localAgain = await clawforge(["init", "--local"], fresh);
  // Independent token expectation: single-word tokens, no counted prose pin.
  const NPM_LINE = ["npm", "install", "--no-save"];
  check("init --local in an initialised folder prints the npm line and exits 0", localAgain.code === 0 && NPM_LINE.every((token) => localAgain.output.includes(token)), true);
  const plainAgain = await clawforge(["init"], fresh);
  check("plain init in an initialised folder still refuses", plainAgain.code === 1 && plainAgain.output.includes(ALREADY_INITIALISED), true);

  // A subfolder of the app: the deployment is found upward; init there is refused, not nested.
  const sub = join(fresh, "recipes", "sub");
  await mkdir(sub, { recursive: true });
  const subHelp = await clawforge(["help"], sub);
  tail(subHelp);
  check("in a subfolder of the app the deployment is found upward", subHelp.code === 0 && subHelp.output.includes("bootstrap"), true);
  const subInit = await clawforge(["init"], sub);
  check("init in a subfolder of an app is refused", subInit.code, 1);
  check("and says which ancestor holds app.ts", subInit.output.includes(ALREADY_HOLDS_APP) && subInit.output.includes("cf-fresh"), true);
  check("and creates nothing there", existsSync(join(sub, "app.ts")), false);
  const subLocal = await clawforge(["init", "--local"], sub);
  check("init --local in a subfolder prints the editor-types line instead of refusing", subLocal.code === 0 && subLocal.output.includes(noSaveInstall("")), true);
  check("and still writes nothing there", existsSync(join(sub, "app.ts")) || existsSync(join(sub, "config")), false);

  // The committed MCP launcher, as a client starts it: no local package, so the system-wide
  // command serves the session over the same stdio.
  const control = projectMcpEntries()[CLAWFORGE_CONTROL_MCP_NAME] as { args: string[] };
  const mcp = await run(process.execPath, control.args, fresh, {
    env,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`,
  });
  const answer = mcp.output.split("\n").find((line) => line.includes('"id":7'));
  if (answer === undefined) tail({ code: 1, output: mcp.output });
  check("the MCP launcher reaches the system-wide command and answers a ping", answer === undefined ? undefined : (JSON.parse(answer) as { result?: unknown }).result, {});

  // The committed ./clawforge shim is bash; on Windows that is Git Bash, never WSL's bash.exe.
  const bash = windows ? ["C:\\Program Files\\Git\\bin\\bash.exe"].find((path) => existsSync(path)) : "bash";
  await requires("bash", "the committed ./clawforge shim fallback", async () => {
    if (bash === undefined) throw new Error("bash capability present but no bash binary resolved");
    const shimmed = await run(bash, ["./clawforge", "version"], fresh, { env });
    tail(shimmed);
    check("without a local package the ./clawforge shim hands over to the system-wide command", shimmed.output.trim(), `clawforge ${expected}`);
    const shimHelp = await run(bash, ["./clawforge", "help"], fresh, { env });
    tail(shimHelp);
    check("through the shim the hints say ./clawforge, which is what runs there", shimHelp.output.includes(usageFooterHint(shimHint)) && shimHelp.output.includes(usageTopLine(shimHint)), true);

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
  });

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

  // No entry named itself (npx, node_modules/.bin, the MCP launcher): the app's own copy has no
  // global command behind it, so hints say the committed ./clawforge shim.
  const localBin = await run(process.execPath, [join(localPackage, "dist", "entry", "bin.js"), "help"], pinned, { env });
  tail(localBin);
  check("an app's own package run directly hints its own program", localBin.output.includes(usageFooterHint(localPackageHint)), true);
  const globalBin = await run(process.execPath, [join(globalPackage, "dist", "entry", "bin.js"), "help"], fresh, { env });
  check("the global package run directly still hints clawforge", globalBin.output.includes(usageFooterHint(installedHint)), true);

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
  // The probe never touches the target; ssh keeps a macOS host (no local target) out of its way.
  const pinnedEnv = join(pinned, ".env");
  await writeFile(pinnedEnv, (await readFile(pinnedEnv, "utf8")).replace(/^OC_TARGET_LOCATION=.*$/m, "OC_TARGET_LOCATION=ssh").replace(/^OC_SSH_HOST=.*$/m, "OC_SSH_HOST=probe.invalid"), "utf8");
  const probe = await clawforge(["probe"], pinned);
  tail(probe);
  check("a descendant does not inherit the hand-over flag", probe.output.includes("flag:unset"), true);
  check("so a clawforge run in another app still hands over to that app's own package", probe.output.includes("child:" + `clawforge ${expected}-other|`), true);

  // --- this checkout: apps/<name> and the root hand over to the checkout's own gate -------------
  await createApp(createName("deployment", checkoutApp));
  // A second deployment makes the root's deployment ambiguous, which `<command> --help` must survive.
  await createApp(createName("deployment", `${checkoutApp}-b`));
  const ambiguousHelp = await clawforge(["watch", "--help"], monorepoRoot);
  tail(ambiguousHelp);
  check("watch --help at the checkout root answers even with several deployments", ambiguousHelp.code === 0 && ambiguousHelp.output.includes("watch"), true);
  const statusHelp = await clawforge(["status", "--help"], monorepoRoot);
  check("status --help works the same way", statusHelp.code === 0 && statusHelp.output.includes("status"), true);
  // An existing but empty apps/<name>: new-app would take it over, so the answer says so.
  const emptyApp = resolve(scApps, `${checkoutApp}-empty`);
  await mkdir(emptyApp, { recursive: true });
  try {
    const emptyStatus = await clawforge(["--app", `${checkoutApp}-empty`, "status"], monorepoRoot);
    check("--app at an empty apps/<name> offers new-app to take it over", emptyStatus.code === 1 && emptyStatus.output.includes(emptyDirNote(emptyApp)) && emptyStatus.output.includes(say(["new-app", `${checkoutApp}-empty`], installedHint)), true);
  } finally {
    await rm(emptyApp, { recursive: true, force: true });
  }
  const inApp = await clawforge(["help"], resolve(scApps, checkoutApp));
  tail(inApp);
  check("in apps/<name> of a checkout the checkout's own gate answers", inApp.code === 0 && inApp.output.includes("new-app"), true);
  check("and its hints keep the name the user typed", inApp.output.includes(usageFooterHint(installedHint)), true);
  const checkoutInfo = lastJson(await clawforge(["version", "--json"], resolve(scApps, checkoutApp)));
  check("version --json in a checkout app says checkout and the checkout root", [checkoutInfo.source, checkoutInfo.path], ["checkout", await realpath(monorepoRoot)]);
  // --app is passed on once: the same name as the cwd's is kept, another one is refused.
  const appDir = resolve(scApps, checkoutApp);
  const sameApp = await clawforge(["--app", checkoutApp, "help"], appDir);
  check("apps/<name> accepts its own --app without doubling it", sameApp.code === 0 && sameApp.output.includes("new-app"), true);
  const otherApp = await clawforge(["--app", "someone-else", "help"], appDir);
  check("a different --app there is a clear error, not an unknown command", otherApp.code === 1 && otherApp.output.includes(APP_CONFLICT_NOTE) && !otherApp.output.includes(unknownCommandMessage("help")), true);
  // A named deployment is named in the hints unless the cwd already selects it.
  const helpFromRoot = await clawforge(["--app", checkoutApp, "help"], monorepoRoot);
  check("from the checkout root help hints keep the named deployment", helpFromRoot.output.includes(say(["help", "<command>"], installedHint, checkoutApp)), true);
  // status needs a reachable target (Linux, WSL with docker, ssh); without one it fails before
  // any hint — gated by a declared capability, not an ad-hoc output sniff (plan stage 0.3).
  await requires("auto-target", "status hints name the named deployment", async () => {
    const fromRoot = await clawforge(["--app", checkoutApp, "status"], monorepoRoot);
    check("from the checkout root hints keep the named deployment", fromRoot.output.includes(say(["bootstrap"], installedHint, checkoutApp)), true);
    const fromApp = await clawforge(["status"], appDir);
    check("from apps/<name> the cwd selects it, so hints stay plain", fromApp.output.includes(say(["bootstrap"], installedHint)) && !fromApp.output.includes("--app"), true);
  });

  // The file system may not tell apps from APPS; the hand-over must not depend on the spelling.
  await requires("windows-host", "APPS/<name> hands over like apps/<name>", async () => {
    const upper = join(sc, "APPS", checkoutApp);
    const upperInfo = lastJson(await clawforge(["version", "--json"], upper));
    check("from APPS/<name> the hand-over to the checkout gate still happens", upperInfo.source, "checkout");
    const upperStatus = await clawforge(["help"], upper);
    check("and its gate answers there too", upperStatus.code === 0 && upperStatus.output.includes("new-app"), true);
  });

  // An app.ts importing a checkout's framework sources outside apps/<name> is not loaded as a second copy.
  const strayDir = resolve(scApps, `.${checkoutApp}-stray`, "nested");
  await mkdir(strayDir, { recursive: true });
  try {
    await writeFile(join(strayDir, "app.ts"), 'import { defineApp } from "../../../tools/framework/core/app.ts";\nexport default defineApp({});\n', "utf8");
    const stray = await clawforge(["status"], strayDir);
    check("a checkout-style app.ts that the gate cannot take over is refused", stray.code === 1 && stray.output.includes(FOREIGN_SOURCES_NOTE) && !stray.output.includes(CANNOT_LOAD), true);
    const strayVersion = await clawforge(["version"], strayDir);
    check("version answers there anyway — it does not need the app", strayVersion.code === 0 && strayVersion.output.includes("clawforge"), true);
    // Decided by content: the package specifier needs no second copy of the sources.
    await writeFile(join(strayDir, "app.ts"), 'import { defineApp } from "@clawforge/framework/app";\nexport default defineApp({});\n', "utf8");
    const installedStyle = await clawforge(["version", "--json"], strayDir);
    check("an installed-style app.ts inside a checkout still runs under the global command", installedStyle.code === 0, true);
    const scheduledStyle = await clawforge(["--project-root", strayDir, "version"], strayDir);
    check("also with --project-root", scheduledStyle.code === 0, true);
    const installedStatus = await clawforge(["status"], strayDir);
    check("and its commands are not refused for their location", installedStatus.output.includes(FOREIGN_SOURCES_NOTE), false);
  } finally {
    await rm(resolve(scApps, `.${checkoutApp}-stray`), { recursive: true, force: true });
  }

  // The global command inside a checkout never creates a deployment in the framework sources.
  const docs = resolve(monorepoRoot, "docs");
  const docsHelp = await clawforge(["help"], docs);
  check("help in a checkout folder does not offer init and names the checkout", docsHelp.code === 0 && docsHelp.output.includes(CHECKOUT_NOTE) && !docsHelp.output.includes(say(["init"], installedHint)), true);
  const inDocs = await clawforge(["status"], docs);
  check("in a non-app subfolder of a checkout it names the checkout entry", inDocs.code === 1 && inDocs.output.includes(FROM_CHECKOUT_ROOT) && !inDocs.output.includes(say(["init"], installedHint)), true);
  // The checkout's own gate commands are real from any folder of the checkout — they just run at the root.
  for (const args of [["list"], ["new-app", "x"], ["check"], ["remove-app", "x"]]) {
    const subfolder = await clawforge(args, docs);
    check(`clawforge ${args.join(" ")} from a checkout subfolder says to run it from the root, not unknown`, subfolder.code === 1 && subfolder.output.includes(CHECKOUT_ROOT_NOTE) && !subfolder.output.includes(unknownCommandMessage(args[0])), true);
  }
  const typo = await clawforge(["stauts"], docs);
  check("a typo outside an app is an unknown command with a suggestion, not a missing app.ts", typo.code === 1 && typo.output.includes(unknownCommandMessage("stauts")) && typo.output.includes(didYouMeanMessage(closestCommand("stauts", names)!)) && !typo.output.includes(NO_APP_TS_HERE), true);
  const helpTypo = await clawforge(["help", "int"], docs);
  check("help <typo> in a checkout never suggests init", helpTypo.code === 1 && helpTypo.output.includes(unknownCommandMessage("int")) && !helpTypo.output.includes("init"), true);
  const emptyDocs = resolve(sc, "docs", `${checkoutApp}-empty`);
  await mkdir(emptyDocs, { recursive: true });
  try {
    const nested = await clawforge(["init"], emptyDocs);
    check("an empty folder that is not apps/<name> is not offered for reuse", nested.code === 1 && nested.output.includes("(" + IN_BASH_NOTE + ")") && !nested.output.includes(takeoverNote(basename(emptyDocs))), true);
  } finally {
    await rm(emptyDocs, { recursive: true, force: true });
  }
  const freshApp = resolve(scApps, `${checkoutApp}-new`);
  await mkdir(freshApp, { recursive: true });
  try {
    const initInCheckout = await clawforge(["init"], freshApp);
    check("init inside a checkout is refused with the new-app advice", initInCheckout.code === 1 && initInCheckout.output.includes(say(["new-app", "<name>"], installedHint)) && initInCheckout.output.includes(say(["new-app", "<name>"], shimHint)) && initInCheckout.output.includes("(" + IN_BASH_NOTE + ")") && initInCheckout.output.includes(takeoverNote(`${checkoutApp}-new`)), true);
    check("and writes nothing", existsSync(join(freshApp, "app.ts")), false);
  } finally {
    await rm(freshApp, { recursive: true, force: true });
  }
  // The reuse advice only names folders new-app would accept: not hidden, not unsafe names.
  for (const folder of [`.${checkoutApp}-hid`, "Bad Name"]) {
    const unusable = resolve(scApps, folder);
    await mkdir(unusable, { recursive: true });
    try {
      const refused = await clawforge(["init"], unusable);
      check(`init in empty apps/${folder} withholds the take-over advice`, refused.code === 1 && !refused.output.includes(takeoverNote(basename(unusable))) && refused.output.includes(say(["new-app", "<name>"], installedHint)), true);
    } finally {
      await rm(unusable, { recursive: true, force: true });
    }
  }

  // init --local in a checkout deployment: the checkout already resolves the editor types.
  await mkdir(resolve(appDir, "recipes"), { recursive: true });
  for (const where of [appDir, resolve(appDir, "recipes")]) {
    const local = await clawforge(["init", "--local"], where);
    check("init --local in a checkout deployment says nothing needs installing", local.code === 0 && local.output.includes(NOTHING_TO_INSTALL_NOTE) && !local.output.includes(noSaveInstall("")) && !local.output.includes(unknownCommandMessage("init")), true);
  }

  const atRoot = await clawforge(["help"], monorepoRoot);
  tail(atRoot);
  check("and at the checkout root too", atRoot.code === 0 && atRoot.output.includes("new-app"), true);
} finally {
  await rm(resolve(scApps, checkoutApp), { recursive: true, force: true });
  await rm(resolve(scApps, `${checkoutApp}-b`), { recursive: true, force: true });
  // The synthetic tree has no git, so no read-only bits to clear on Windows.
  await rm(sc, { recursive: true, force: true });
  delete process.env["CLAWFORGE_REAL_GATE"];
  delete process.env["CLAWFORGE_CHECKS_APPS_DIR"];
  await rm(outside, { recursive: true, force: true });
  if (packRoot !== undefined) await rm(packRoot, { recursive: true, force: true });
  await rm(prefix, { recursive: true, force: true });
}

finish("system install");
