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

import { access } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { main } from "./cli.ts";
import { runGateCommand, gateHelpLines, type GateCommand } from "../integration/gate.ts";
import { reportError } from "../core/io/log.ts";
import { INVOKED_AS_ENV, cli, invocation, setInvocation, takeInvokedAs } from "../core/io/invocation.ts";
import { useDeployment } from "../runtime/deployment.ts";
import { initApp, INIT_ARGUMENTS } from "../integration/deployment/init.ts";
import { parseDeclaredArgs } from "../core/arguments.ts";
import { normalizeVersionAlias, makeVersionGateCommand } from "../integration/version.ts";
import { makeCompletionGateCommand } from "../integration/completion.ts";
import { delegateToOwnFramework, resolveFrameworkFromSelf, takeDelegationFlag } from "./delegate.ts";
import { defaultInvocation, findAppRoot, findCheckoutRoot } from "./root.ts";
import type { AppDefinition } from "../core/app.ts";

// First, before anything can spawn: the flag covers this hand-over only, not descendants.
const handedOver = takeDelegationFlag();
// The shim says `./clawforge`; unnamed, the copy decides (see defaultInvocation).
const invokedAs = takeInvokedAs();
setInvocation(invokedAs ?? "clawforge");
const rawArgv = process.argv.slice(2);
const scheduled = rawArgv[0] === "--project-root";
if (scheduled && (rawArgv[1] === undefined || !isAbsolute(rawArgv[1]))) {
  reportError("--project-root requires an absolute directory");
  process.exit(1);
}
const argv = normalizeVersionAlias(scheduled ? rawArgv.slice(2) : rawArgv);

// Without --project-root the deployment is the nearest app.ts at or above the cwd. `init` is
// the exception: it always initialises the cwd itself, and refuses under an existing deployment.
const cwd = process.cwd();
const initializing = argv[0] === "init" && !argv.includes("--help") && !argv.includes("-h");
const ancestor = scheduled ? undefined : findAppRoot(cwd);
if (initializing && !scheduled && ancestor !== undefined && ancestor !== cwd) {
  reportError(`${ancestor} already holds app.ts — this directory is inside that deployment; init here would nest a second one`);
  process.exit(1);
}
const checkout = scheduled ? undefined : findCheckoutRoot(cwd);
if (initializing && ancestor === undefined && checkout !== undefined) {
  reportError(`${checkout} is a ClawForge checkout — init would write an installed-style deployment it cannot load; create one from its root with: './clawforge' new-app <name>`);
  process.exit(1);
}
const appRoot = scheduled ? resolve(rawArgv[1]) : initializing ? cwd : (ancestor ?? cwd);
// A hand-over target may predate the walk, so the found root is passed explicitly.
const launchArgv = scheduled || appRoot === cwd ? rawArgv : ["--project-root", appRoot, ...rawArgv];

if (invokedAs === undefined) setInvocation(await defaultInvocation(appRoot));

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
      "Refuses if app.ts already exists — run this once, then ./clawforge bootstrap.",
    arguments: INIT_ARGUMENTS,
    run: async (args) => {
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

const appFile = resolve(appRoot, "app.ts");
try {
  await access(appFile);
} catch {
  reportError(`no app.ts in ${appRoot}`);
  if (checkout !== undefined) reportError(`this is a ClawForge checkout (${checkout}) — './clawforge' in its root is the entry`);
  else reportError(`this directory has not been initialised as an OpenClaw deployment yet — run: ${cli("init")}`);
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
    { stdio: "inherit", env: { ...process.env, CLAWFORGE_TYPE_STRIPPING_RETRY: "1", [INVOKED_AS_ENV]: invocation(), ...(handedOver ? { CLAWFORGE_DELEGATED: "1" } : {}) } },
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
