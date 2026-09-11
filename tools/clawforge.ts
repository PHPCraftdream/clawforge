#!/usr/bin/env node
// The gate.
//
// Picks a deployment, points the framework at its directory, loads its declaration and
// hands over. No command logic lives here.
//
// A deployment is a directory under apps/ holding .env, config/, secrets/, recipes/ and
// an app.ts that says which service it manages. Several can sit side by side:
//
//   ./clawforge status                    the default deployment
//   OC_APP=staging ./clawforge status     another one
//   ./clawforge --app staging status      same, as an argument

import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { main } from "./framework/entry/cli.ts";
import { runGateCommand, gateHelpLines, type GateCommand } from "./framework/integration/gate.ts";
import { reportError } from "./framework/core/log.ts";
import { monorepoRoot } from "./framework/core/env.ts";
import { useDeployment } from "./framework/runtime/deployment.ts";
import { createApp } from "./framework/integration/scaffold.ts";
import { safeName } from "./framework/core/names.ts";
import { openclawCommands } from "./framework/commands/interface/index.ts";
import type { AppDefinition } from "./framework/core/app.ts";

const argv = process.argv.slice(2);

// --app wins over the environment, the environment over the default.
let name = process.env.OC_APP ?? "openclaw";
const flagIndex = argv.indexOf("--app");
if (flagIndex !== -1) {
  const value = argv[flagIndex + 1];
  if (value === undefined) {
    reportError("--app needs a deployment name");
    process.exit(1);
  }
  name = value;
  argv.splice(flagIndex, 2);
}

// Both of these run before a deployment is resolved — the checks describe the framework
// rather than an instance, and new-app creates the very thing every other command needs.
// Declared rather than hand-dispatched so that the help text, the argument list and the MCP
// tool all come from one place; see framework/gate.ts.
const gateCommands: GateCommand[] = [
  {
    name: "check",
    summary: "Run the framework's own checks (no instance needed)",
    details:
      "Paths, archives, the argument contract, what a server delivery contains, secret " +
      "masking — the parts where a mistake is silent. `./clawforge smoke` covers a live instance " +
      "instead.",
    run: async () => {
      const { runChecks } = await import("./checks/run.ts");
      return runChecks();
    },
  },
  {
    name: "new-app",
    summary: "Create a deployment under apps/",
    details:
      "Writes apps/<name>/ with a .env (own data directory and port, first free port picked " +
      "automatically), config/desired-state.json and an app.ts declaring every framework " +
      "command.\n" +
      "Refuses if the directory already exists — run this once per deployment, then " +
      "./clawforge --app <name> bootstrap.",
    arguments: [{ name: "name", description: "Deployment name", kind: "positional", required: true }],
    run: async (args) => {
      const target = args[0];
      if (target === undefined) {
        reportError("usage: ./clawforge new-app <name>");
        return 1;
      }
      await createApp(target);
      return 0;
    },
  },
];

const gateExit = await runGateCommand(gateCommands, argv);
if (gateExit !== undefined) process.exit(gateExit);

// The command list in `./clawforge help`: the gate's own commands, plus the one line here that is
// not a command at all.
const monorepoGateHelp = [
  ...gateHelpLines(gateCommands),
  "  --app <name>      pick another deployment (default: the OC_APP one)",
];

// Checked before it becomes a path: --app or OC_APP set to "../.." would take the
// framework outside apps/ entirely, and the deployment name also becomes the compose
// project and the archive prefix.
try {
  safeName("deployment", name);
} catch (error) {
  reportError(error);
  process.exit(1);
}

const deploymentDir = resolve(monorepoRoot, "apps", name);
try {
  await access(deploymentDir);
} catch {
  // help/--help/-h must work even in a completely fresh checkout, before any deployment
  // exists — that is exactly when someone reaches for it. Built from openclawCommands
  // directly rather than a real app.ts (there isn't one yet): every deployment's own
  // declaration just re-exports this same set unless it adds commands of its own, so this
  // is the accurate answer for "what commands exist" up until one actually does that.
  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    const genericApp: AppDefinition = {
      name: "clawforge",
      description: "self-hosting framework for OpenClaw — this checkout has no deployments yet",
      commands: openclawCommands,
    };
    await main(genericApp, argv, monorepoGateHelp, gateCommands);
    process.exit(0);
  }
  reportError(`deployment "${name}" not found at ${deploymentDir}`);
  reportError("create one with: ./clawforge new-app <name>");
  process.exit(1);
}

// Set before anything reads configuration: every path below resolves against it.
useDeployment(deploymentDir);

let app: AppDefinition;
try {
  const module = (await import(`../apps/${name}/app.ts`)) as { default: AppDefinition };
  app = module.default;
} catch (error) {
  reportError(`cannot load deployment "${name}": ${(error as Error).message}`);
  process.exit(1);
}

await main(app, argv, monorepoGateHelp, gateCommands);
