#!/usr/bin/env node
// The gate.
//
// Picks a deployment, points the framework at its directory, loads its declaration and
// hands over. No command logic lives here.
//
// A deployment is a directory under apps/ holding .env, config/, secrets/, recipes/ and
// an app.ts naming its service. Several can sit side by side:
//
//   ./clawforge status                    the default deployment
//   OC_APP=staging ./clawforge status     another one
//   ./clawforge --app staging status      same, as an argument
//
// With neither set and no "openclaw" deployment, a checkout with exactly one deployment
// under apps/ uses it automatically.

import { main } from "./framework/entry/cli.ts";
import {
  runGateCommand,
  gateHelpLines,
  reportUnknownCommand,
  type GateCommand,
} from "./framework/integration/gate.ts";
import { helpEntryLine } from "./framework/core/io/help-render.ts";
import { reportError, info } from "./framework/core/io/log.ts";
import { invocation, setInvocation, takeInvocationFromEnv } from "./framework/core/io/invocation/index.ts";
import { monorepoRoot } from "./framework/core/env.ts";
import { useDeployment } from "./framework/runtime/deployment.ts";
import { openclawCommands } from "./framework/commands/interface/index.ts";
import { normalizeVersionAlias, versionGateCommand } from "./framework/integration/version.ts";
import { makeCompletionGateCommand } from "./framework/integration/completion.ts";
import type { AppDefinition } from "./framework/core/app.ts";
import { resolveFrameworkFromSources } from "./framework/entry/delegate.ts";
import { nodeFs, resolveCheckoutEntry } from "./framework/entry/resolve.ts";
import { checkoutGateCommands } from "./framework/entry/checkout-gate.ts";

// A deployment's app.ts importing @clawforge/framework resolves onto this checkout's
// sources — there is no dist build here (recipe hooks map the same table in the hook loader).
resolveFrameworkFromSources();

// A hand-over from the system-wide command or a launcher names itself; otherwise this is
// the ./clawforge gate.
const handedOver = takeInvocationFromEnv();
setInvocation(handedOver ?? { program: "./clawforge", mode: "checkout", audience: "terminal" });
const argv = normalizeVersionAlias(process.argv.slice(2));

// The gate's own commands are declared without side effects in entry/checkout-gate.ts —
// the same declarations the goldens and the checks import. version/completion stay wired
// here (see completion.ts).
const gateCommands: GateCommand[] = [...checkoutGateCommands, versionGateCommand];
// Pushed after the literal above, not inside it: the closure needs the finished array
// (itself included), which is only true once this line has run — see completion.ts.
gateCommands.push(makeCompletionGateCommand(gateCommands, true));

// The command list in `./clawforge help`: the gate's own commands, plus the one line here that is
// not a command at all.
const monorepoGateHelp = [
  ...gateHelpLines(gateCommands),
  helpEntryLine("--app <name>", "pick another deployment, before the command (default: the OC_APP one)"),
];

// Where am I, which deployment, which framework copy, how do I name myself — one pure
// decision (entry/resolve.ts); the switch below only performs its side effects.
const decision = resolveCheckoutEntry({
  root: monorepoRoot,
  cwd: process.cwd(),
  argv,
  ocApp: process.env.OC_APP,
  handedOver: handedOver !== undefined,
  fs: nodeFs,
  gateCommands: gateCommands.map((command) => command.name),
  deploymentCommands: Object.keys(openclawCommands),
  variadicCommands: Object.entries(openclawCommands)
    .filter(([, command]) => command.arguments?.some((argument) => argument.kind === "variadic") === true)
    .map(([commandName]) => commandName),
});

switch (decision.kind) {
  case "refuse": {
    for (const line of decision.lines) reportError(line);
    process.exit(1);
  }
  case "refuse-misplaced-app-flag": {
    reportError("--app must come before the command: ./clawforge --app <name> <command> …");
    process.exit(1);
  }
  case "refuse-unknown-command": {
    reportUnknownCommand(decision.name, [...decision.candidates]);
    process.exit(1);
  }
  case "gate-command": {
    process.exit((await runGateCommand(gateCommands, [decision.name, ...decision.args])) ?? 0);
  }
  case "help-without-deployment": {
    // help/--help/-h must work in a completely fresh checkout, before any deployment
    // exists — and so must `<deployment command> --help`, the second form the general
    // help itself promises. Built from openclawCommands directly (there's no app.ts yet):
    // every deployment's own declaration just re-exports this set unless it adds commands of its own.
    const genericApp: AppDefinition = {
      name: "clawforge",
      description: `self-hosting framework for OpenClaw — ${decision.description}`,
      commands: openclawCommands,
    };
    await main(genericApp, [...decision.argv], monorepoGateHelp, gateCommands);
    // runApp sets process.exitCode on error (e.g. unknown command) — respect it instead of forcing 0.
    process.exit(process.exitCode ?? 0);
  }
  case "run": {
    // --json output must stay parseable, and a non-interactive caller (script, cron) has no one
    // to read this for — only print for a human at a real terminal.
    if (decision.soleNote !== undefined && !decision.argv.includes("--json") && process.stderr.isTTY === true) {
      info(`using the only deployment: ${decision.soleNote}`);
    }
    if (decision.app !== undefined) setInvocation({ ...invocation(), app: decision.app });

    // Set before anything reads configuration: every path below resolves against it.
    useDeployment(decision.deploymentDir);

    let app: AppDefinition;
    try {
      const module = (await import(`../apps/${decision.appName}/app.ts`)) as { default: AppDefinition };
      app = module.default;
    } catch (error) {
      reportError(`cannot load deployment "${decision.appName}": ${(error as Error).message}`);
      process.exit(1);
    }

    await main(app, [...decision.argv], monorepoGateHelp, gateCommands);
  }
}
