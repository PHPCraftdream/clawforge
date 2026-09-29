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
import { resolve } from "node:path";
import { main } from "./cli.ts";
import { runGateCommand, gateHelpLines, type GateCommand } from "../integration/gate.ts";
import { reportError } from "../core/io/log.ts";
import { useDeployment } from "../runtime/deployment.ts";
import { initApp } from "../integration/deployment/init.ts";
import { normalizeVersionAlias, versionGateCommand } from "../integration/version.ts";
import { makeCompletionGateCommand } from "../integration/completion.ts";
import type { AppDefinition } from "../core/app.ts";

const argv = normalizeVersionAlias(process.argv.slice(2));
const appRoot = process.cwd();

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
    run: async () => {
      await initApp(appRoot);
      return 0;
    },
  },
  versionGateCommand,
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
  reportError("this directory has not been initialised as an OpenClaw deployment yet — run: clawforge init");
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
    ["--experimental-strip-types", fileURLToPath(import.meta.url), ...argv],
    { stdio: "inherit", env: { ...process.env, CLAWFORGE_TYPE_STRIPPING_RETRY: "1" } },
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
