#!/usr/bin/env node
// The installed-mode gate — the package's own bin entry once tools/framework/ is installed
// as an npm dependency in a consumer repo, as opposed to tools/clawforge.ts (the monorepo gate,
// used only inside this clawforge checkout, where several deployments sit side by side
// under apps/<name>).
//
// There is exactly one app here: the consumer's own project root. No --app/OC_APP
// selection, no apps/<name> nesting — those exist in the monorepo gate to let several
// deployments share one checkout, which is not what an installed dependency is for.
//
// The shebang is a plain `#!/usr/bin/env node`, and the flag is kept explicit when loading
// the consumer's app.ts is added by re-executing this file (see below) rather than carried
// there. `#!/usr/bin/env -S node --experimental-strip-types` looks tidier and does work with
// GNU coreutils, but busybox `env` has no -S at all — on an Alpine image, the most common
// Node base image there is, the npm-linked bin then fails before a single line of this runs.

import { access } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { main } from "./cli.ts";
import { runGateCommand, gateHelpLines, type GateCommand } from "../integration/gate.ts";
import { reportError } from "../core/log.ts";
import { useDeployment } from "../runtime/deployment.ts";
import { initApp } from "../integration/init.ts";
import type { AppDefinition } from "../core/app.ts";

const argv = process.argv.slice(2);
const appRoot = process.cwd();

// Creating the deployment happens before one can be loaded — there is no app.ts yet for a
// fresh consumer repo. Declared rather than hand-dispatched so the help text, the dispatch
// and the MCP tool all come from one place; see framework/integration/gate.ts. `check` is absent on
// purpose: it runs this repository's own test suite, which the package does not ship.
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
];

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

/** This file again, with type stripping switched on.
 *
 *  app.ts belongs to the consumer and is never compiled by anything here, so loading it needs
 *  a consumer's app.ts. The flag cannot ride in the shebang (busybox `env` has no -S), and
 *  guessing from process.version or process.features would have to be right about every
 *  release; the import failing with "Unknown file extension" is the capability itself
 *  answering.
 *
 *  Only that one flag is passed on: whatever disabled stripping in this process (an explicit
 *  --no-experimental-strip-types, an old default) must not be inherited by the retry. */
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
