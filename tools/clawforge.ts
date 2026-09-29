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
//
// With neither set and no "openclaw" deployment, a checkout holding exactly one deployment
// under apps/ uses it automatically — there is nothing to disambiguate.

import { resolve } from "node:path";
import { access, readdir } from "node:fs/promises";
import { main } from "./framework/entry/cli.ts";
import {
  runGateCommand,
  gateHelpLines,
  reportUnknownCommand,
  splitLeadingAppFlag,
  misplacedAppFlag,
  soleDeploymentFallback,
  missingDeploymentReport,
  type GateCommand,
} from "./framework/integration/gate.ts";
import { reportError, info } from "./framework/core/io/log.ts";
import { emit } from "./framework/core/io/output.ts";
import { monorepoRoot } from "./framework/core/env.ts";
import { useDeployment } from "./framework/runtime/deployment.ts";
import { createApp } from "./framework/integration/deployment/scaffold.ts";
import { listDeployments, printDeploymentList } from "./framework/integration/list.ts";
import { safeName } from "./framework/core/names.ts";
import { parseDeclaredArgs } from "./framework/core/arguments.ts";
import { openclawCommands } from "./framework/commands/interface/index.ts";
import { normalizeVersionAlias, versionGateCommand } from "./framework/integration/version.ts";
import { makeCompletionGateCommand } from "./framework/integration/completion.ts";
import type { AppDefinition, CommandArgument } from "./framework/core/app.ts";

const argv = normalizeVersionAlias(process.argv.slice(2));

// --app wins over the environment, the environment over the default.
let name = process.env.OC_APP ?? "openclaw";
let appExplicit = process.env.OC_APP !== undefined;
const appFlag = splitLeadingAppFlag(argv);
if (appFlag.missingValue) {
  reportError("--app needs a deployment name");
  process.exit(1);
} else if (appFlag.value !== undefined) {
  name = appFlag.value;
  appExplicit = true;
}
argv.splice(0, argv.length, ...appFlag.rest);

// Drives both new-app's parser and its declaration.
const NEW_APP_ARGUMENTS: CommandArgument[] = [
  { name: "name", description: "Deployment name", kind: "positional", required: true },
];

// Both of these run before a deployment is resolved — the checks describe the framework
// rather than an instance, and new-app creates the very thing every other command needs.
// Declared rather than hand-dispatched so that the help text, the argument list and the MCP
// tool all come from one place; see framework/gate.ts.
const checkArguments: CommandArgument[] = [
  {
    name: "filter",
    description: "Only run checks whose relative path (e.g. foundation/cli/gate-commands.check.ts) contains this text — repeatable, matches any",
    kind: "variadic",
  },
  { name: "list", description: "Print the matching check paths instead of running them", kind: "flag" },
  {
    name: "jobs",
    description: "Concurrent check-file processes (default: OC_CHECK_JOBS, else min(4, cores/2))",
    kind: "option",
    valueName: "n",
  },
  {
    name: "require",
    description:
      "Comma-separated capabilities (docker, wsl, posix-sh, rsync, linux-host) whose absence must fail a " +
      "check that needs them, instead of skipping it — merged with OC_CHECK_REQUIRE",
    kind: "option",
    valueName: "cap,...",
  },
];

const gateCommands: GateCommand[] = [
  {
    name: "check",
    summary: "Run the framework's own checks (no instance needed)",
    details:
      "Paths, archives, the argument contract, what a server delivery contains, secret " +
      "masking — the parts where a mistake is silent. `./clawforge smoke` covers a live instance " +
      "instead.\n" +
      "With no filter, every check runs. One or more substrings narrow that down to checks " +
      "whose path contains at least one of them, e.g. `./clawforge check gate` or " +
      "`npm run check -- foundation runtime`. `--list` prints the matching paths (and, where " +
      "one is declared, the host capabilities a file needs) without running them. A filter " +
      "matching nothing is refused rather than silently running everything.\n" +
      "A file naming a capability it cannot run without (docker, wsl, posix-sh, rsync, " +
      "linux-host) is skipped, not failed, when this host lacks it. `--require` (or " +
      "OC_CHECK_REQUIRE) names capabilities this host is expected to have, turning a skip " +
      "into a failure for those.",
    arguments: checkArguments,
    run: async (args) => {
      const parsed = parseDeclaredArgs(checkArguments, args);
      const filters = (parsed.filter as string[] | undefined) ?? [];
      const list = parsed.list === true;
      const jobsRaw = parsed.jobs as string | undefined;
      const jobs = jobsRaw === undefined ? undefined : Number(jobsRaw);
      const requireRaw = parsed.require as string | undefined;
      const require = requireRaw === undefined ? undefined : requireRaw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
      const { runChecks } = await import("./checks/kit/run.ts");
      return runChecks({ filters, list, jobs: jobs !== undefined && jobs > 0 ? jobs : undefined, require });
    },
  },
  {
    name: "new-app",
    summary: "Create a deployment under apps/",
    details:
      "Writes apps/<name>/ with a .env (own data directory and project-specific port), " +
      "config/desired-state.json and an app.ts declaring every framework " +
      "command.\n" +
      "The port avoids readable sibling .env files; it is not a host availability check. " +
      "Bootstrap checks active Docker deployments AND raw listening sockets (ss/netstat) on the target " +
      "before preparing data or pulling an image.\n" +
      "Refuses if the directory already exists — run this once per deployment, then " +
      "./clawforge --app <name> bootstrap.",
    arguments: NEW_APP_ARGUMENTS,
    run: async (args) => {
      const target = parseDeclaredArgs(NEW_APP_ARGUMENTS, args).name as string | undefined;
      if (target === undefined) {
        reportError("usage: ./clawforge new-app <name>");
        return 1;
      }
      await createApp(target);
      return 0;
    },
  },
  {
    name: "list",
    summary: "Overview of every deployment under apps/",
    details:
      "One line per apps/<name>: target (OC_TARGET_LOCATION, plus OC_SSH_HOST for ssh), " +
      "gateway port, image (pinned when it carries @sha256:), and whether the gateway is " +
      "running.\n" +
      "A deployment this cannot fully read — no .env yet, a broken app.ts, an unreachable " +
      "target — gets its own line naming why instead of failing the whole listing.\n" +
      "--no-status skips asking the target altogether, for a fast read of configuration " +
      "alone; state then reads \"not checked\".\n" +
      "--json prints the same rows as an array of objects instead.",
    arguments: [
      { name: "json", description: "Emit as a JSON array instead of text", kind: "flag" },
      { name: "no-status", description: "Configuration only — do not query any target", kind: "flag" },
    ],
    run: async (args) => {
      const unknown = args.find((arg) => arg !== "--json" && arg !== "--no-status");
      if (unknown !== undefined) {
        reportError(`unknown argument: ${unknown}`);
        return 1;
      }
      const summaries = await listDeployments({ checkStatus: !args.includes("--no-status") });
      if (args.includes("--json")) emit(`${JSON.stringify(summaries)}\n`);
      else printDeploymentList(summaries);
      return 0;
    },
  },
  versionGateCommand,
];
// Pushed after the literal above, not inside it: the closure needs the finished array
// (itself included), which is only true once this line has run — see completion.ts.
gateCommands.push(makeCompletionGateCommand(gateCommands, true));

// --app after the command is refused, except where the command reads argv verbatim.
const verbatimCommands = [
  ...gateCommands.map((command) => command.name),
  ...Object.entries(openclawCommands)
    .filter(([, command]) => command.arguments?.some((argument) => argument.kind === "variadic") === true)
    .map(([commandName]) => commandName),
];
const misplacedApp = misplacedAppFlag(argv[0], argv.slice(1), verbatimCommands);
if (misplacedApp !== undefined) {
  reportError("--app must come before the command: ./clawforge --app <name> <command> …");
  process.exit(1);
}

const gateExit = await runGateCommand(gateCommands, argv);
if (gateExit !== undefined) process.exit(gateExit);

// The command list in `./clawforge help`: the gate's own commands, plus the one line here that is
// not a command at all.
const monorepoGateHelp = [
  ...gateHelpLines(gateCommands),
  "  --app <name>      pick another deployment, before the command (default: the OC_APP one)",
];

// Every name this gate can dispatch without a loaded app.ts — a deployment's own app.ts may
// declare more, which only it can answer for once loaded (see the missing-deployment branch
// below). Used both to tell a typo from a real command here, and as the pool one is compared
// against.
const baseCommandNames = [
  ...Object.keys(openclawCommands),
  ...gateCommands.map((command) => command.name),
  "help",
  "control-mcp",
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

let deploymentDir = resolve(monorepoRoot, "apps", name);
try {
  await access(deploymentDir);
} catch {
  // Other deployments may exist under another name: name them instead of claiming none.
  const available = (await readdir(resolve(monorepoRoot, "apps"), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const sole = soleDeploymentFallback(appExplicit, available);
  if (sole !== undefined) {
    name = sole;
    deploymentDir = resolve(monorepoRoot, "apps", name);
    // --json output must stay parseable, and a non-interactive caller (script, cron) has no one
    // to read this for — only print for a human at a real terminal.
    if (!argv.includes("--json") && process.stderr.isTTY === true) {
      info(`using the only deployment: ${name}`);
    }
  } else if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    // help/--help/-h must work even in a completely fresh checkout, before any deployment
    // exists — that is exactly when someone reaches for it. Built from openclawCommands
    // directly rather than a real app.ts (there isn't one yet): every deployment's own
    // declaration just re-exports this same set unless it adds commands of its own, so this
    // is the accurate answer for "what commands exist" up until one actually does that.
    const pick = available.length === 0
      ? "this checkout has no deployments yet"
      : `no deployment "${name}" — available: ${available.join(", ")} (pick one with --app <name> or OC_APP)`;
    const genericApp: AppDefinition = {
      name: "clawforge",
      description: `self-hosting framework for OpenClaw — ${pick}`,
      commands: openclawCommands,
    };
    await main(genericApp, argv, monorepoGateHelp, gateCommands);
    // runApp sets process.exitCode on error (e.g. unknown command) — respect it instead of forcing 0.
    process.exit(process.exitCode ?? 0);
  } else if (!baseCommandNames.includes(argv[0])) {
    // The typo case this all exists for: nothing declares this name in this checkout, so no
    // deployment's app.ts could ever make it valid either — answer the typo, not "deployment
    // not found", which sends the reader looking in the wrong place entirely.
    reportUnknownCommand(argv[0], baseCommandNames);
    process.exit(1);
  } else {
    for (const line of missingDeploymentReport(appExplicit, name, deploymentDir, available)) reportError(line);
    process.exit(1);
  }
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
