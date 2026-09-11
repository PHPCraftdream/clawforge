#!/usr/bin/env -S node --experimental-strip-types
// The installed-mode gate — the package's own bin entry once tools/framework/ is installed
// as an npm dependency in a consumer repo, as opposed to tools/clawforge.ts (the monorepo gate,
// used only inside this clawforge checkout, where several deployments sit side by side
// under apps/<name>).
//
// There is exactly one app here: the consumer's own project root. No --app/OC_APP
// selection, no apps/<name> nesting — those exist in the monorepo gate to let several
// deployments share one checkout, which is not what an installed dependency is for.
//
// The flag in the shebang is harmless on a Node new enough to strip types by default (this
// framework's own check suite already invokes tools/clawforge.ts the same way unconditionally);
// it only matters for Node 22.6-22.x, where stripping is still behind the flag.

import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
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
      "Writes app.ts, config/desired-state.json and .env (own data directory and port) " +
      "directly into the current directory, plus config/, secrets/, recipes/, .gitignore " +
      "entries for the deployment state and node_modules/, and a committed ./clawforge entrypoint " +
      "that delegates to this package's CLI. Project MCP settings for Claude Code and Codex " +
      "are created automatically, without changing global client settings.\n" +
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

let app: AppDefinition;
try {
  const module = (await import(pathToFileURL(appFile).href)) as { default: AppDefinition };
  app = module.default;
} catch (error) {
  reportError(`cannot load ${appFile}: ${(error as Error).message}`);
  process.exit(1);
}

await main(app, argv, gateHelpLines(gateCommands), gateCommands);
