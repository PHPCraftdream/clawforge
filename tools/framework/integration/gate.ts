// Commands that run before a deployment exists.
//
// `check` describes the framework, `new-app`/`init` create the thing every other command
// needs — none can be an AppCommand (that type takes a Context, built from a deployment's
// .env). Dispatched by the gate (tools/clawforge.ts, framework/entry/bin.ts), not cli.ts's
// dispatcher, but still declared like a capability of `./clawforge`: one declaration feeds
// dispatch, `--help` and the MCP tool list, so help text lives in the declaration, not as
// literal strings at each call site.
//
// Which entries exist depends on the gate: `new-app` belongs to the monorepo one, `init` to
// the installed one (exactly one deployment, at the repo root), `check` needs this
// repository's own test suite, which the npm package doesn't ship. Each gate builds its own list.

import { info, log, reportError } from "../core/io/log.ts";
import { closestCommand } from "../core/arguments.ts";
import { helpEntryLine, renderCommandHelp, renderFullCommandHelp, renderUsage } from "../core/io/help-render.ts";
import type { AppDefinition, CommandArgument } from "../core/app.ts";

export { closestCommand } from "../core/arguments.ts";

export interface GateCommand {
  readonly name: string;
  /** One line for the command list and the MCP tool's short description. */
  readonly summary: string;
  /** The longer explanation, shown by `--help` and folded into the tool description. */
  readonly details?: string;
  /** Declared the same way an AppCommand's are, and used for the same three things. */
  readonly arguments?: CommandArgument[];
  /** No Context — there is no deployment yet. Returns the exit code. */
  readonly run: (args: string[]) => Promise<number>;
}

/** The `--help` screen for one gate command, from its declaration — the same renderer
 *  entry/cli.ts uses for an AppCommand, so a gate command's `choices` and value names show
 *  up here too instead of only on the deployment's own commands. */
export function gateCommandHelp(command: GateCommand): void {
  renderCommandHelp(command.name, command);
}

/** Lines for the command list in `./clawforge help`, so a gate command appears beside the rest. */
export function gateHelpLines(commands: GateCommand[]): string[] {
  if (commands.length === 0) return [];
  return commands.map((command) => helpEntryLine(command.name, command.summary));
}

/** Dispatches argv against the gate's own commands. Returns the exit code when one of them
 *  ran, and undefined when argv belongs to the deployment's commands instead — so a gate
 *  can hand over without knowing what the deployment declares. */
export async function runGateCommand(
  commands: GateCommand[],
  argv: string[],
): Promise<number | undefined> {
  const command = commands.find((entry) => entry.name === argv[0]);
  if (command === undefined) return undefined;

  const args = argv.slice(1);
  if (args.includes("--help") || args.includes("-h")) {
    gateCommandHelp(command);
    return 0;
  }

  try {
    return await command.run(args);
  } catch (error) {
    reportError(error);
    return 1;
  }
}

/** What the help without a deployment knows about its surroundings. */
export interface HelpContext {
  /** Names of the deployment's commands, known without an app.ts. */
  readonly deploymentCommands: readonly string[];
  /** The ClawForge checkout the directory is in, if any: `init` is refused there. */
  readonly checkout?: string;
  /** Renders a deployment command's --help body from its declaration, without a
   *  deployment (built from openclawCommands, as the checkout root does). Absent — as in
   *  older callers — a deployment command stays refused with the "needs an app folder"
   *  advice. */
  readonly deploymentHelp?: (name: string) => void;
}

/** `help`/`--help`/`-h` (or no argument at all) where no deployment exists: the gate's own
 *  commands only. Returns the exit code, or undefined when argv is not a help request. */
export function helpWithoutDeployment(commands: GateCommand[], argv: string[], context: HelpContext = { deploymentCommands: [] }): number | undefined {
  const first = argv[0];
  const { checkout } = context;
  // `init` is refused in a checkout, so it is no suggestion there either.
  const offered = checkout === undefined ? commands : commands.filter((entry) => entry.name !== "init");
  const candidates = [...context.deploymentCommands, ...offered.map((entry) => entry.name), "help"];
  if (first !== undefined && first !== "help" && first !== "--help" && first !== "-h") {
    // `<deployment command> --help` answers without a deployment, from the built-in
    // declaration — same as the checkout root (R32-09). A bare command stays a refusal.
    if (context.deploymentCommands.includes(first) && context.deploymentHelp !== undefined && isDeploymentHelpRequest(argv, context.deploymentCommands)) {
      context.deploymentHelp(first);
      deploymentHelpNote(first, checkout);
      return 0;
    }
    // A word nothing declares is a typo, not a missing app.ts; options are left to the caller.
    if (first.startsWith("-") || first === "control-mcp" || candidates.includes(first) || commands.some((entry) => entry.name === first)) return undefined;
    reportUnknownCommand(first, candidates);
    return 1;
  }
  const target = first === "help" ? argv[1] : undefined;
  if (target === undefined || target === "--help" || target === "-h" || target === "help") {
    log("clawforge — manage self-hosted OpenClaw deployments");
    info("");
    info("Usage: ./clawforge <command> [options]");
    info("");
    for (const line of gateHelpLines(offered)) info(line);
    info("");
    if (checkout === undefined) info("The full command list appears inside an initialised app folder (create one with: ./clawforge init).");
    else info(`This is a ClawForge checkout (${checkout}): ./clawforge help at its root lists every command, apps/<name> holds the deployments.`);
    return 0;
  }
  const command = commands.find((entry) => entry.name === target);
  if (command !== undefined) {
    gateCommandHelp(command);
    return 0;
  }
  // `help list` from a checkout subfolder: the command is real, it just runs at the root —
  // the same answer typing `list` there gets, not "unknown command".
  if (checkout !== undefined) {
    const fromRoot = checkoutSubfolderReport(target, checkout);
    if (fromRoot !== undefined) {
      for (const line of fromRoot) reportError(line);
      return 1;
    }
  }
  // A deployment command's declaration is built in — the checkout root answers
  // `help <cmd>` from it, so a subfolder and an installed command outside an app answer
  // the same way instead of refusing (R32-09).
  if (context.deploymentCommands.includes(target) && context.deploymentHelp !== undefined) {
    context.deploymentHelp(target);
    deploymentHelpNote(target, checkout);
    return 0;
  }
  if (context.deploymentCommands.includes(target)) {
    reportError(
      checkout === undefined
        ? `"${target}" is a deployment command: it needs an app folder, and there is no app.ts here — run: ./clawforge init`
        : `"${target}" is a deployment command: it needs an app folder, and there is no app.ts here — this is a ClawForge checkout; run it from apps/<name> or with ./clawforge at the checkout root`,
    );
    return 1;
  }
  reportUnknownCommand(target, candidates);
  return 1;
}

/** The one line after a deployment command's help, rendered without a deployment: where
 *  the command actually runs — the refusal's advice, one level deeper. */
function deploymentHelpNote(name: string, checkout: string | undefined): void {
  info("");
  info(
    checkout === undefined
      ? `"${name}" runs inside an app folder — there is no app.ts here; run: ./clawforge init`
      : `"${name}" runs inside an app folder — this is a ClawForge checkout; run it from apps/<name> or with ./clawforge at the checkout root`,
  );
}

/** The monorepo gate's own commands, which are real in any folder of a checkout — just run
 *  from its root. A subfolder's help must not call them unknown. Kept by hand in step with
 *  tools/clawforge.ts's gateCommands (the gate script runs its own dispatch on import, so
 *  importing the list from there is not an option) — a new gate command must be added here too. */
export const CHECKOUT_GATE_COMMANDS: readonly string[] = ["check", "list", "new-app", "remove-app"];

/** Report lines for a checkout gate command typed from a checkout subfolder: the command is
 *  real there too, it just runs at the root — not an unknown command. */
export function checkoutSubfolderReport(first: string, checkout: string): string[] | undefined {
  if (!CHECKOUT_GATE_COMMANDS.includes(first)) return undefined;
  // Quoted: a path with spaces breaks unquoted in any shell, and Windows backslashes read
  // as escapes in the Git Bash this hint is most likely pasted into.
  return [
    `${first} is a checkout command — run it from the checkout root:`,
    `    cd "${checkout}"`,
  ];
}

/** `<command> [<any arguments up to a bare --> --help>` for a deployment command: help must
 *  answer without a deployment. The scan matches entry/cli.ts's requestsHelp — so the natural
 *  `<command> <action> --help` form and `--json --help` count, while `-h` after a command,
 *  which requestsHelp also does not treat as help, does not. */
export function isDeploymentHelpRequest(argv: readonly string[], deploymentCommands: readonly string[]): boolean {
  if (argv[0] === undefined || !deploymentCommands.includes(argv[0])) return false;
  const rest = argv.slice(1);
  if (rest.length === 0) return false;
  const sep = rest.indexOf("--");
  return (sep === -1 ? rest : rest.slice(0, sep)).includes("--help");
}

/** What a leading `--app <name>` or `--app=<name>` split off argv, if either was there. */
export interface AppFlagSplit {
  /** The name after --app/--app=, absent when --app did not lead argv at all. */
  readonly value: string | undefined;
  /** --app led argv with no value after it — distinct from "absent" so the caller can
   *  report "--app needs a deployment name" rather than falling through to the default. */
  readonly missingValue: boolean;
  readonly rest: string[];
}

/** Recognises `--app`/`--app=<name>` only as the very first token(s) of argv — after the
 *  command name, an identically-spelled `--app` belongs to that command's own arguments
 *  (exec/cli/host pass theirs through verbatim) and must survive untouched. */
export function splitLeadingAppFlag(argv: string[]): AppFlagSplit {
  if (argv[0] === "--app") {
    const value = argv[1];
    if (value === undefined) return { value: undefined, missingValue: true, rest: argv.slice(1) };
    return { value, missingValue: false, rest: argv.slice(2) };
  }
  if (argv[0] !== undefined && argv[0].startsWith("--app=")) {
    return { value: argv[0].slice("--app=".length), missingValue: false, rest: argv.slice(1) };
  }
  return { value: undefined, missingValue: false, rest: argv };
}

/** The first `--app`/`--app=<name>` among a command's own arguments (a leading one was already
 *  split off). `exempt` names commands that read their argv verbatim: gate commands and those
 *  declaring a variadic argument (cli, exec, host), whose `--app` belongs to them. */
export function misplacedAppFlag(
  commandName: string | undefined,
  args: readonly string[],
  exempt: readonly string[],
): string | undefined {
  if (commandName === undefined || exempt.includes(commandName)) return undefined;
  return args.find((arg) => arg === "--app" || arg.startsWith("--app="));
}

/** The standard answer to a command name nothing declares: the typo, a nearby spelling
 *  guess, and a pointer to the real list — never the full help screen. */
export function reportUnknownCommand(name: string, candidates: string[]): void {
  reportError(`unknown command: ${name}`);
  const suggestion = closestCommand(name, candidates);
  if (suggestion !== undefined) info(`did you mean: ${suggestion}`);
  info("run ./clawforge help to list every command");
}

/** Every name the dispatcher can resolve: app commands, gate commands and its own aliases. */
export function knownCommandNames(app: AppDefinition, gateCommands: readonly GateCommand[]): string[] {
  return [...Object.keys(app.commands), ...gateCommands.map((command) => command.name), "help", "control-mcp"];
}

/** The details body shared by `help control-mcp` and `control-mcp --help` — control-mcp is
 *  dispatched by runApp (entry/cli.ts) before the app.commands lookup, so no AppCommand
 *  carries it, but both help paths must answer from this one declaration (R33-09). */
const CONTROL_MCP_DETAILS = [
  "stdio JSON-RPC server, same shape as mcp-serve but for this deployment's own",
  "commands instead of OpenClaw's channels — status, backup, secrets, and the",
  "rest, with arguments checked against the same declarations --help reads.",
  "Destructive commands (push, restore, deploy) need confirm: true.",
  "Registered for a client automatically by ./clawforge mcp-setup; not meant to be run",
  "by hand outside of testing.",
].join("\n");

/** Prints `control-mcp`'s help — the same body `<command> --help` gets from its declaration. */
export function controlMcpHelp(appName: string): void {
  renderCommandHelp("control-mcp", {
    summary: `expose ${appName}'s commands as MCP tools, for agents`,
    details: CONTROL_MCP_DETAILS,
  });
}

/** Renders `./clawforge help [<command>]`; false for an unknown command. Shared by the console
 *  and the MCP `help` tool. */
export function renderHelp(
  target: string | undefined,
  app: AppDefinition,
  gateCommands: readonly GateCommand[],
  gateHelp: string[],
): boolean {
  // `help` is not in app.commands; `help help` shows the general list.
  if (target === undefined || target === "--help" || target === "-h" || target === "help") {
    renderUsage(app, gateHelp);
    return true;
  }
  // control-mcp is not in app.commands either — it is dispatched by runApp before that
  // lookup, and skipping it here made `help control-mcp` report the very word as unknown.
  if (target === "control-mcp") {
    controlMcpHelp(app.name);
    return true;
  }
  const command = app.commands[target];
  if (command !== undefined) {
    renderFullCommandHelp(target, command);
    return true;
  }
  const gateCommand = gateCommands.find((entry) => entry.name === target);
  if (gateCommand !== undefined) {
    gateCommandHelp(gateCommand);
    return true;
  }
  reportUnknownCommand(target, knownCommandNames(app, gateCommands));
  return false;
}

/** The deployment to use when the requested one is missing: the lone deployment under apps/,
 *  but only when nobody named one explicitly (--app or OC_APP); otherwise undefined. */
export function soleDeploymentFallback(explicit: boolean, available: readonly string[]): string | undefined {
  return !explicit && available.length === 1 ? available[0] : undefined;
}

/** Report lines for an unresolved deployment: several with none selected names the ambiguity;
 *  a missing explicit name (or none at all) keeps the "not found" wording. */
export function missingDeploymentReport(
  explicit: boolean,
  name: string,
  deploymentDir: string,
  available: readonly string[],
  /** The directory is there but holds no app.ts: new-app would refuse it as non-empty. */
  directoryExists = false,
): string[] {
  if (!explicit && available.length > 1) {
    return [`several deployments (${available.join(", ")}) — pick one with --app <name> or OC_APP`];
  }
  if (directoryExists) {
    return [
      `${deploymentDir} exists but holds no app.ts — if the directory is empty, ./clawforge new-app ${name} takes it over`,
      `otherwise remove it or pick another name${available.length === 0 ? "" : ` (available: ${available.join(", ")})`}`,
    ];
  }
  return [
    `deployment "${name}" not found at ${deploymentDir}`,
    available.length === 0
      ? "create one with: ./clawforge new-app <name>"
      : `available: ${available.join(", ")} — pick one with --app <name> (or OC_APP), or create one with ./clawforge new-app <name>`,
  ];
}
