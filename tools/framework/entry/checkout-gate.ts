// The checkout gate's own commands (check, new-app, remove-app, list), declared without
// import-time side effects — nothing here runs or reads state at import time, so the gate
// script (tools/clawforge.ts), the goldens and the checks can all import the same
// declarations. version/completion stay wired in the gate script itself: completion's
// declaration closes over the finished command array (see completion.ts).

import { parseDeclaredArgs, type UnknownArgumentError } from "../core/command/index.ts";
import { reportError } from "../core/io/log.ts";
import { commandLine } from "../core/io/invocation/render.ts";
import { emit } from "../core/io/output.ts";
import { createApp } from "../integration/deployment/scaffold.ts";
import { removeApp } from "../integration/deployment/remove.ts";
import { listDeployments, printDeploymentList } from "../integration/list.ts";
import type { CommandArgument } from "../core/app.ts";
import type { GateCommand } from "../integration/gate.ts";

// The check runner is this repository's own tree, outside the shipped package — the path is
// built, not literal, so the declaration build's graph stays inside tools/framework.
const CHECK_RUNNER_PATH = ["../../checks/kit", "run.ts"].join("/");

// Drives both new-app's parser and its declaration.
const NEW_APP_ARGUMENTS: CommandArgument[] = [
  { name: "name", description: "Deployment name", kind: "positional", required: true },
];

// Drives both remove-app's parser and its declaration.
const REMOVE_APP_ARGUMENTS: CommandArgument[] = [
  { name: "name", description: "Deployment name", kind: "positional", required: true },
  { name: "yes", description: "Perform the removal instead of a dry run", kind: "flag" },
];

// Drives both list's parser and its declaration.
const LIST_ARGUMENTS: CommandArgument[] = [
  { name: "json", description: "Emit as a JSON array instead of text", kind: "flag" },
  { name: "no-status", description: "Configuration only — do not query any target", kind: "flag" },
];

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

/** The checkout gate's own commands, in help order. Declared rather than hand-dispatched so
 *  help text, argument list and MCP tool come from one place; both run before a deployment
 *  is resolved — the checks describe the framework rather than an instance, and new-app
 *  creates the thing every other command needs. */
export const checkoutGateCommands: readonly GateCommand[] = [
  {
    name: "check",
    summary: "Run the framework's own checks (no instance needed)",
    details:
      "Paths, archives, the argument contract, what a server delivery contains, secret " +
      "masking — the parts where a mistake is silent. `{clawforge smoke}` covers a live instance " +
      "instead.\n" +
      "With no filter, every check runs. One or more substrings narrow that down to checks " +
      "whose path contains at least one of them, e.g. `{clawforge check gate}` or " +
      "`npm run check -- foundation runtime`. `{--list}` prints the matching paths (and, where " +
      "one is declared, the host capabilities a file needs) without running them. A filter " +
      "matching nothing is refused rather than silently running everything.\n" +
      "A file naming a capability it cannot run without (docker, wsl, posix-sh, rsync, " +
      "linux-host) is skipped, not failed, when this host lacks it. `{--require}` (or " +
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
      const { runChecks } = await import(CHECK_RUNNER_PATH);
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
      "Refuses an existing directory unless it is empty — run this once per deployment, then " +
      "{clawforge --app <name> bootstrap}.",
    arguments: NEW_APP_ARGUMENTS,
    run: async (args) => {
      const target = parseDeclaredArgs(NEW_APP_ARGUMENTS, args).name as string | undefined;
      if (target === undefined) {
        reportError(`usage: ${commandLine(["new-app", "<name>"])}`);
        return 1;
      }
      await createApp(target);
      return 0;
    },
  },
  {
    name: "remove-app",
    summary: "Delete apps/<name>",
    details:
      "Deletes apps/<name>/ — the repository-side deployment directory (.env, config/, " +
      "secrets/, recipes/, app.ts, client MCP configs). Never touches the target: an " +
      "instance this deployment bootstrapped is untouched by this command.\n" +
      "Default is a dry run: lists the top-level entries and total size, and warns when the " +
      "directory carries its own `.git` history (apps/<name> is not tracked by this " +
      "repository's own git — see new-app's gitInitAdvice), then exits 0 without removing " +
      "anything. {--yes} performs the removal.\n" +
      "Refuses while the deployment still has a bootstrapped instance (running or " +
      "stopped-but-bootstrapped, read the same way {clawforge list} reads it) — " +
      "{clawforge --app <name> destroy} first (and --data if the data should go too).\n" +
      "Refuses a name that is not a plain deployment name (the same rule new-app enforces), " +
      "and refuses when the directory is itself a symlink.",
    arguments: REMOVE_APP_ARGUMENTS,
    run: async (args) => {
      const parsed = parseDeclaredArgs(REMOVE_APP_ARGUMENTS, args);
      const target = parsed.name as string | undefined;
      if (target === undefined) {
        reportError(`usage: ${commandLine(["remove-app", "<name>"])} [--yes]`);
        return 1;
      }
      return removeApp(target, parsed.yes === true ? ["--yes"] : []);
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
      "{--no-status} skips asking the target altogether, for a fast read of configuration " +
      "alone; state then reads \"not checked\".\n" +
      "{--json} prints the same rows as an array of objects instead.",
    arguments: LIST_ARGUMENTS,
    run: async (args) => {
      let parsed;
      try {
        parsed = parseDeclaredArgs(LIST_ARGUMENTS, args);
      } catch (error) {
        const { reportUnknownArgument } = await import("./cli.ts");
        reportUnknownArgument("list", error as UnknownArgumentError);
        return 1;
      }
      const checkStatus = parsed["no-status"] !== true;
      const summaries = await listDeployments({ checkStatus, includeOthers: parsed.json !== true });
      if (parsed.json === true) emit(`${JSON.stringify(summaries)}\n`);
      else printDeploymentList(summaries);
      return 0;
    },
  },
];

/** The same commands as names, derived: the one list a subfolder's help, the golden
 *  surfaces and any future surface read — never a hand copy of the declarations above. */
export const CHECKOUT_GATE_COMMANDS: readonly string[] = checkoutGateCommands.map((command) => command.name).sort();
