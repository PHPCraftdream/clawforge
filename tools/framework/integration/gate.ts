// Commands that run before a deployment exists.
//
// `check` describes the framework, `new-app`/`init` create the thing every other command
// needs — none can be an AppCommand (that type takes a Context, built from a deployment's
// .env). Dispatched by the gate (tools/clawforge.ts, framework/entry/bin.ts), not cli.ts's
// dispatcher, but still declared like a capability of the gate: one declaration feeds
// dispatch, `--help` and the MCP tool list, so help text lives in the declaration, not as
// literal strings at each call site.
//
// Which entries exist depends on the gate: `new-app` belongs to the monorepo one, `init` to
// the installed one (exactly one deployment, at the repo root), `check` needs this
// repository's own test suite, which the npm package doesn't ship. Each gate builds its own list.

import { info, log, reportError, UserError } from "../core/io/log.ts";
import { command, manual } from "../core/io/invocation/advice.ts";
import { commandLine } from "../core/io/invocation/render.ts";
import { shellLine } from "../core/io/invocation/advice.ts";
import { closestCommand } from "../core/command/index.ts";
import { helpEntryLine, renderCommandHelp, renderFullCommandHelp, renderUsage } from "../core/io/help-render.ts";
import type { AppCommand, AppDefinition, CommandArgument } from "../core/app.ts";

export { closestCommand } from "../core/command/index.ts";

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

/** Lines for the command list in the gate's `help`, so a gate command appears beside the rest. */
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
  const candidates = [...context.deploymentCommands, ...offered.map((entry) => entry.name), ...DISPATCHER_COMMANDS];
  if (first !== undefined && first !== "help" && first !== "--help" && first !== "-h") {
    // `<deployment command> --help` answers without a deployment, from the built-in
    // declaration — same as the checkout root (R32-09). A bare command stays a refusal.
    if (context.deploymentCommands.includes(first) && context.deploymentHelp !== undefined && isDeploymentHelpRequest(argv, context.deploymentCommands)) {
      context.deploymentHelp(first);
      deploymentHelpNote(first, checkout);
      return 0;
    }
    // A word nothing declares is a typo, not a missing app.ts; options are left to the caller.
    if (first.startsWith("-") || candidates.includes(first) || commands.some((entry) => entry.name === first)) return undefined;
    reportUnknownCommand(first, candidates);
    return 1;
  }
  const target = first === "help" ? argv[1] : undefined;
  if (target === undefined || target === "--help" || target === "-h" || target === "help") {
    log("clawforge — manage self-hosted OpenClaw deployments");
    info("");
    info(`Usage: ${commandLine(["<command>"])} [options]`);
    info("");
    for (const line of gateHelpLines(offered)) info(line);
    info("");
    if (checkout === undefined) info(`The full command list appears inside an initialised app folder (create one with: ${commandLine(["init"])})`);
    else info(`This is a ClawForge checkout (${checkout}): ${commandLine(["help"])} at its root lists every command, apps/<name> holds the deployments.`);
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
      reportError(fromRoot);
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
        ? `"${target}" is a deployment command: it needs an app folder, and there is no app.ts here — run: ${commandLine(["init"])}`
        : `"${target}" is a deployment command: it needs an app folder, and there is no app.ts here — this is a ClawForge checkout; run it from apps/<name> or with ${commandLine([])} at the checkout root`,
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
      ? `"${name}" runs inside an app folder — there is no app.ts here; run: ${commandLine(["init"])}`
      : `"${name}" runs inside an app folder — this is a ClawForge checkout; run it from apps/<name> or with ${commandLine([])} at the checkout root`,
  );
}

/** The monorepo gate's own commands, which are real in any folder of a checkout — just run
 *  from its root. A subfolder's help must not call them unknown. Derived from
 *  entry/checkout-gate.ts, where the declarations live — there is no hand list left to
 *  keep in step with tools/clawforge.ts. */
export { CHECKOUT_GATE_COMMANDS } from "../entry/checkout-gate.ts";
import { CHECKOUT_GATE_COMMANDS } from "../entry/checkout-gate.ts";

/** The refusal for a checkout gate command typed from a checkout subfolder: the command is
 *  real there too, it just runs at the root — not an unknown command. The cd line is for
 *  another shell, so it is shell advice: nothing rewrites it. */
export function checkoutSubfolderReport(first: string, checkout: string): UserError | undefined {
  if (!CHECKOUT_GATE_COMMANDS.includes(first)) return undefined;
  // Quoted: a path with spaces breaks unquoted in any shell, and Windows backslashes read
  // as escapes in the Git Bash this hint is most likely pasted into.
  return new UserError(`${first} is a checkout command — run it from the checkout root:`, {
    advice: [shellLine("posix", `cd "${checkout}"`)],
  });
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
export function reportUnknownCommand(name: string, candidates: readonly string[]): void {
  reportError(`unknown command: ${name}`);
  const suggestion = closestCommand(name, candidates);
  if (suggestion !== undefined) info(`did you mean: ${suggestion}`);
  info(`run ${commandLine(["help"])} to list every command`);
}

/** Where a name comes from: the deployment's own commands, the gate's, or the dispatcher's
 *  two built-ins (control-mcp, help). */
export type CommandOrigin = "deployment" | "gate" | "dispatcher";

/** One name the dispatcher resolves, for a surface (help, completion, docs, checks) to read
 *  from — a command declaration plus where it came from. `command`/`gate` carry the effect and
 *  the run for readers that need them; the help renderer reads only summary/arguments. */
export interface RegistryEntry {
  readonly name: string;
  readonly origin: CommandOrigin;
  readonly summary: string;
  readonly details?: string;
  readonly arguments?: readonly CommandArgument[];
  /** only "deployment": the spec, effect, group and run */
  readonly command?: AppCommand;
  /** only "gate" */
  readonly gate?: GateCommand;
}

/** Every name the dispatcher resolves: deployment commands (declaration order), the gate's
 *  (gate order), then the two dispatcher entries. `find` is what help, the MCP help tool and
 *  completion read a command by. */
export interface CommandRegistry {
  readonly entries: readonly RegistryEntry[];
  readonly names: readonly string[];
  find(name: string): RegistryEntry | undefined;
}

/** The dispatcher's own two commands — not app commands, not the gate's: neither carries a
 *  Context. The tail of every surface's command list, and the one place their names live. */
export const DISPATCHER_COMMANDS = ["control-mcp", "help"] as const;

/** The description the `help` command's own positional takes. */
export const HELP_COMMAND_DESCRIPTION = "Command name; omit to list every command";

/** The details body shared by `help control-mcp` and `control-mcp --help` — control-mcp is
 *  dispatched by runApp (entry/cli.ts) before the app.commands lookup, so no AppCommand
 *  carries it, but both help paths must answer from this one declaration (R33-09). */
export const CONTROL_MCP_DETAILS = [
  "stdio JSON-RPC server, same shape as mcp-serve but for this deployment's own",
  "commands instead of OpenClaw's channels — status, backup, secrets, and the",
  "rest, with arguments checked against the same declarations --help reads.",
  "Destructive commands (push, restore, deploy) need confirm: true.",
  "Registered for a client automatically by {clawforge mcp-setup}; not meant to be run",
  "by hand outside of testing.",
].join("\n");

/** Builds the one registry a surface reads: the deployment's commands, the gate's, and the two
 *  dispatcher entries the tail of `names` (`DISPATCHER_COMMANDS`) names. `help`'s positional
 *  carries every name as its `choices`, so completion, the docs table and the prose checks read
 *  it as any other positional. */
export function commandRegistry(source: {
  readonly deployment: Readonly<Record<string, AppCommand>>;
  readonly gate: readonly GateCommand[];
  readonly appName: string;
}): CommandRegistry {
  const names = [
    ...Object.keys(source.deployment),
    ...source.gate.map((gate) => gate.name),
    ...DISPATCHER_COMMANDS,
  ];
  const entries: RegistryEntry[] = [
    ...Object.entries(source.deployment).map(([name, command]): RegistryEntry => ({
      name, origin: "deployment", summary: command.summary, details: command.details,
      arguments: command.arguments, command,
    })),
    ...source.gate.map((gate): RegistryEntry => ({
      name: gate.name, origin: "gate", summary: gate.summary, details: gate.details,
      arguments: gate.arguments, gate,
    })),
    {
      name: "control-mcp", origin: "dispatcher",
      summary: `expose ${source.appName}'s commands as MCP tools, for agents`,
      details: CONTROL_MCP_DETAILS, arguments: [],
    },
    {
      name: "help", origin: "dispatcher", summary: "same as: <command> --help",
      arguments: [{ name: "command", kind: "positional", description: HELP_COMMAND_DESCRIPTION, choices: names }],
    },
  ];
  return { entries, names, find: (name) => entries.find((entry) => entry.name === name) };
}

/** The footer lines the two dispatcher commands contribute to every gate's command list:
 *  `control-mcp` and `help <command>` — byte for byte the lines help-render.ts's renderUsage
 *  used to append itself, so a caller composing `[...gateHelp, ...dispatcherHelpLines]` prints
 *  the same screen it did. */
export function dispatcherHelpLines(registry: CommandRegistry): string[] {
  return registry.entries
    .filter((entry) => entry.origin === "dispatcher")
    .map((entry) =>
      helpEntryLine(
        `${entry.name}${(entry.arguments ?? []).filter((argument) => argument.kind === "positional").map((argument) => ` <${argument.name}>`).join("")}`,
        entry.summary,
      ),
    );
}

/** Renders `help [<command>]`; false for an unknown command. Shared by the console
 *  and the MCP `help` tool. `help`/`help help` and the bare flags show the command list. */
export function renderHelp(
  target: string | undefined,
  app: AppDefinition,
  registry: CommandRegistry,
  gateHelp: readonly string[],
): boolean {
  // `help` is not in app.commands; `help help` shows the general list.
  if (target === undefined || target === "--help" || target === "-h" || target === "help") {
    renderUsage(app, [...gateHelp, ...dispatcherHelpLines(registry)]);
    return true;
  }
  // Everything the dispatcher resolves is a registry entry now — a deployment command, a gate
  // command or one of the two dispatcher commands — so there is no control-mcp lookup left to
  // special-case here: its help answers from the entry, like any other.
  const entry = registry.find(target);
  if (entry !== undefined) {
    if (entry.command !== undefined) renderFullCommandHelp(target, entry.command);
    else renderCommandHelp(target, entry);
    return true;
  }
  reportUnknownCommand(target, registry.names);
  return false;
}

/** The deployment to use when the requested one is missing: the lone deployment under apps/,
 *  but only when nobody named one explicitly (--app or OC_APP); otherwise undefined. */
export function soleDeploymentFallback(explicit: boolean, available: readonly string[]): string | undefined {
  return !explicit && available.length === 1 ? available[0] : undefined;
}

/** The refusal for an unresolved deployment: several with none selected names the ambiguity;
 *  a missing explicit name (or none at all) keeps the "not found" wording. new-app is a gate
 *  command, so its advice never carries this run's `--app`. */
export function missingDeploymentReport(
  explicit: boolean,
  name: string,
  deploymentDir: string,
  available: readonly string[],
  /** The directory is there but holds no app.ts: new-app would refuse it as non-empty. */
  directoryExists = false,
): UserError {
  if (!explicit && available.length > 1) {
    return new UserError(`several deployments (${available.join(", ")}) — pick one with --app <name> or OC_APP`);
  }
  if (directoryExists) {
    return new UserError(`${deploymentDir} exists but holds no app.ts — if the directory is empty:`, {
      advice: [
        command(["new-app", name]),
        manual(`otherwise remove it or pick another name${available.length === 0 ? "" : ` (available: ${available.join(", ")})`}`),
      ],
    });
  }
  return new UserError(`deployment "${name}" not found at ${deploymentDir}`, {
    advice: available.length === 0
      ? [command(["new-app", "<name>"])]
      : [manual(`available: ${available.join(", ")} — pick one with --app <name> (or OC_APP), or create one with:`), command(["new-app", "<name>"])],
  });
}
