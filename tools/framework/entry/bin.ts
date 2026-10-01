#!/usr/bin/env node
// The installed-mode gate — the package's own bin entry once tools/framework/ is installed
// as an npm dependency in a consumer repo, as opposed to tools/clawforge.ts (the monorepo
// gate, several deployments side by side under apps/<name>).
//
// Exactly one app here: the consumer's own project root. No --app/OC_APP selection, no
// apps/<name> nesting — those exist in the monorepo gate to share one checkout, not what
// an installed dependency needs.
//
// The shebang is a plain `#!/usr/bin/env node`; loading the consumer's app.ts needs the
// strip-types flag explicit (re-executing this file, see below) rather than in the
// shebang, since busybox `env` has no -S — on Alpine, the common Node base image, the
// npm-linked bin would fail before a single line of this ran.
//
// Where the deployment is, whether init may write here and which framework copy runs are
// one pure decision (entry/resolve.ts); this file only performs its side effects.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { main } from "./cli.ts";
import { runGateCommand, gateHelpLines, helpWithoutDeployment, type GateCommand } from "../integration/gate.ts";
import { info, reportError, reportErrorVerbatim } from "../core/io/log.ts";
import { INVOCATION_ENV, invocation, serializeInvocation, setInvocation, takeInvocationFromEnv } from "../core/io/invocation/index.ts";
import { useDeployment } from "../runtime/deployment.ts";
import { initApp, localTypesLines, INIT_ARGUMENTS } from "../integration/deployment/init.ts";
import { openclawCommands } from "../commands/interface/index.ts";
import { parseDeclaredArgs } from "../core/command/index.ts";
import { renderFullCommandHelp } from "../core/io/help-render.ts";
import { makeVersionGateCommand } from "../integration/version.ts";
import { makeCompletionGateCommand } from "../integration/completion.ts";
import { delegateToOwnFramework, refuseStrayCheckoutApp, resolveFrameworkFromSelf, takeDelegationFlag } from "./delegate.ts";
import { defaultInvocation } from "./root.ts";
import { missingAppDecision, nodeFs, resolveInstalledEntry } from "./resolve.ts";
import type { AppDefinition } from "../core/app.ts";

// First, before anything can spawn: the flag covers this hand-over only, not descendants.
const handedOver = takeDelegationFlag();
// The shim names itself; unnamed, the copy decides (see defaultInvocation).
const handed = takeInvocationFromEnv();
setInvocation(handed ?? { program: "clawforge", mode: "installed", audience: "terminal" });
const rawArgv = process.argv.slice(2);

const entry = resolveInstalledEntry({ cwd: process.cwd(), rawArgv, platform: process.platform, fs: nodeFs });
switch (entry.kind) {
  case "refuse": {
    for (const line of entry.lines) reportError(line);
    process.exit(1);
  }
  case "refuse-verbatim": {
    for (const line of entry.lines) reportErrorVerbatim(line);
    process.exit(1);
  }
  case "checkout-types-note": {
    info(entry.line);
    process.exit(0);
  }
}
const { appRoot, localTypesOnly, ancestor, checkout } = entry;
// Mutable copies: the executors below take string[].
const argv = [...entry.argv];
const launchArgv = [...entry.launchArgv];

if (handed === undefined) setInvocation({ ...(await defaultInvocation(appRoot)), audience: "terminal" });

// Installed system-wide, this may not be the framework this deployment runs on.
delegateToOwnFramework(fileURLToPath(import.meta.url), appRoot, launchArgv, argv, handedOver);
resolveFrameworkFromSelf();

// Creating the deployment happens before one can be loaded — no app.ts yet for a fresh
// consumer repo. `check` is absent: it needs this repository's own test suite, unshipped.
const gateCommands: GateCommand[] = [
  {
    name: "init",
    summary: "Initialise this directory as an OpenClaw deployment",
    details:
      "Writes app.ts, config/desired-state.json and .env (own data directory and project-specific port) " +
      "directly into the current directory, plus config/, secrets/, recipes/, .gitignore " +
      "entries for the deployment state and node_modules/, and a committed ./clawforge entrypoint " +
      "that delegates to this package's CLI. Project MCP settings for Claude Code and Codex " +
      "are created automatically, without changing global client settings.\n" +
      "The port is randomized; it is not a host availability check. Bootstrap checks active Docker deployments on the target before preparing data or pulling an image.\n" +
      "Refuses if app.ts already exists — run this once, then ./clawforge bootstrap. " +
      "`init --local` in an already initialised directory only prints the editor-types npm line and writes nothing.",
    arguments: INIT_ARGUMENTS,
    run: async (args) => {
      if (localTypesOnly && ancestor !== appRoot) {
        for (const line of await localTypesLines()) info(line);
        return 0;
      }
      await initApp(appRoot, { local: parseDeclaredArgs(INIT_ARGUMENTS, args).local === true });
      return 0;
    },
  },
  makeVersionGateCommand(appRoot),
];
// Pushed after the literal above so the closure sees the finished array, itself included —
// see completion.ts. No --app here: an installed deployment is always the current directory.
gateCommands.push(makeCompletionGateCommand(gateCommands, false));

const gateExit = await runGateCommand(gateCommands, argv);
if (gateExit !== undefined) process.exit(gateExit);
// Only after the gate commands: `version` answers without needing the app to be one of apps/<name>.
refuseStrayCheckoutApp(fileURLToPath(import.meta.url), appRoot);

const appFile = resolve(appRoot, "app.ts");
try {
  await access(appFile);
} catch {
  const missing = missingAppDecision({
    appRoot,
    argv,
    checkout,
    gateCommandNames: gateCommands.map((command) => command.name),
    deploymentCommands: Object.keys(openclawCommands),
  });
  if (missing.kind === "subfolder-report") {
    reportError(missing.headline);
    for (const line of missing.verbatim) reportErrorVerbatim(line);
    process.exit(1);
  }
  if (missing.kind === "help") {
    // Help for a deployment command answers without a deployment, from the built-in
    // declarations — the same way the checkout root's gate answers (R32-09).
    const helpExit = helpWithoutDeployment(gateCommands, argv, {
      deploymentCommands: Object.keys(openclawCommands),
      checkout,
      deploymentHelp: (name) => {
        const declared = openclawCommands[name];
        if (declared !== undefined) renderFullCommandHelp(name, declared);
      },
    });
    if (helpExit !== undefined) process.exit(helpExit);
  }
  const { headline, plain, verbatim } = missing.kind === "help" ? missing.fallback : missing;
  reportError(headline);
  for (const line of plain) reportError(line);
  for (const line of verbatim) reportErrorVerbatim(line);
  process.exit(1);
}

// Set before anything reads configuration: every path below resolves against it.
useDeployment(appRoot);

/** This file again, with type stripping switched on. app.ts belongs to the consumer, so
 *  loading it needs the flag; it can't ride in the shebang (busybox `env` has no -S), and
 *  guessing from process.version would have to be right about every release — the import
 *  failing with "Unknown file extension" is the capability itself answering. Only that one
 *  flag is passed on: whatever disabled stripping here must not be inherited by the retry. */
function retryWithTypeStripping(): never {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", fileURLToPath(import.meta.url), ...launchArgv],
    { stdio: "inherit", env: { ...process.env, CLAWFORGE_TYPE_STRIPPING_RETRY: "1", [INVOCATION_ENV]: serializeInvocation(invocation()), ...(handedOver ? { CLAWFORGE_DELEGATED: "1" } : {}) } },
  );
  process.exit(result.status ?? 1);
}

let app: AppDefinition;
try {
  const module = (await import(pathToFileURL(appFile).href)) as { default: AppDefinition };
  app = module.default;
} catch (error) {
  const message = (error as Error).message;
  const cannotReadTypeScript = message.includes("Unknown file extension") || message.includes("experimental-strip-types");
  if (cannotReadTypeScript && process.env.CLAWFORGE_TYPE_STRIPPING_RETRY !== "1") retryWithTypeStripping();

  reportError(`cannot load ${appFile}: ${message}`);
  if (cannotReadTypeScript) {
    reportError("this Node cannot execute TypeScript even with --experimental-strip-types — Node 24 or newer is required");
  }
  process.exit(1);
}

await main(app, argv, gateHelpLines(gateCommands), gateCommands);
