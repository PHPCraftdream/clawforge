// Commands that run before a deployment exists.
//
// `check` describes the framework, `new-app`/`init` create the thing every other command
// needs — so none of them can be an AppCommand: that type takes a Context, and a Context is
// built from a deployment's .env. They are dispatched by the gate (tools/clawforge.ts,
// framework/entry/bin.ts) rather than by the dispatcher in cli.ts.
//
// They are still capabilities of `./clawforge`, so they are declared rather than hand-written at
// each call site. One declaration feeds three things — the gate's dispatch, its `--help`,
// and the MCP tool list — which is the same property AppCommand already has, and the reason
// the help text for `new-app` no longer lives as literal strings inside the gate.
//
// Which entries exist depends on the gate: `new-app` belongs to the monorepo one (several
// deployments under apps/), `init` to the installed one (exactly one, at the repository
// root), and `check` needs this repository's own test suite, which the npm package does not
// ship. Each gate therefore builds its own list instead of declaring all of them everywhere
// and failing at call time.

import { log, info, reportError } from "../core/log.ts";
import type { CommandArgument } from "../core/app.ts";

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

function label(argument: CommandArgument): string {
  if (argument.kind === "flag") return `--${argument.name}`;
  if (argument.kind === "option") return `--${argument.name} <value>`;
  if (argument.kind === "variadic") return `<${argument.name}…>`;
  return `<${argument.name}>`;
}

/** The `--help` screen for one gate command, from its declaration. */
export function gateCommandHelp(command: GateCommand): void {
  log(`${command.name} — ${command.summary}`);
  const signature = (command.arguments ?? [])
    .map((argument) => (argument.required === true ? label(argument) : `[${label(argument)}]`))
    .join(" ");
  if (signature !== "") info(`Usage: ./clawforge ${command.name} ${signature}`);
  for (const argument of command.arguments ?? []) {
    const required = argument.required === true ? " (required)" : "";
    info(`  ${label(argument).padEnd(22)} ${argument.description}${required}`);
  }
  if (command.details !== undefined) {
    info("");
    for (const line of command.details.split("\n")) info(line);
  }
}

/** Lines for the command list in `./clawforge help`, so a gate command appears beside the rest. */
export function gateHelpLines(commands: GateCommand[]): string[] {
  if (commands.length === 0) return [];
  const width = Math.max(...commands.map((command) => command.name.length)) + 2;
  return commands.map((command) => `  ${command.name.padEnd(width)}${command.summary}`);
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
