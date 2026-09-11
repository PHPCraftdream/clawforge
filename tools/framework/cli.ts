// Running an application from the command line.
//
// The framework owns argument dispatch, help text and error reporting; an application only
// declares its commands. Adding a command to an application must not require touching any
// file in framework/ — that is the property this module exists to guarantee.

import { reportError, UserError, log, info } from "./log.ts";
import { createContext } from "./context.ts";
import { useRecipesDir } from "./recipe.ts";
import { recipesDir } from "./deployment.ts";
import { ensureEnvironment } from "./provision.ts";
import { serveMcp } from "./mcp-server.ts";
import { gateCommandHelp, type GateCommand } from "./gate.ts";
import type { AppCommand, AppDefinition, CommandArgument } from "./app.ts";

function label(argument: CommandArgument): string {
  if (argument.kind === "flag") return `--${argument.name}`;
  if (argument.kind === "option") return `--${argument.name} <value>`;
  return `<${argument.name}>`;
}

function formatArguments(command: AppCommand): string {
  if (command.arguments === undefined || command.arguments.length === 0) return "";
  return command.arguments
    .map((argument) => (argument.required === true ? label(argument) : `[${label(argument)}]`))
    .join(" ");
}

/** Lines shown between the command list and the closing "Run ./clawforge help ..." hint — the one
 *  part of this help screen that is gate-specific (monorepo: --app/new-app; installed: init)
 *  rather than something an AppDefinition or its commands could know. tools/clawforge.ts (several
 *  deployments under apps/<name>) and bin.ts (one deployment, this directory) each pass
 *  their own; this default is tools/clawforge.ts's, unchanged from before this became a parameter. */
const DEFAULT_GATE_HELP = [
  "  --app <name>      pick another deployment (default: the OC_APP one)",
  "  new-app <name>    create a deployment under apps/",
];

function usage(app: AppDefinition, gateHelp: string[]): void {
  log(`${app.name} — ${app.description}`);
  info("");
  info("Usage: ./clawforge <command> [options]");
  info("");

  const width = Math.max(...Object.keys(app.commands).map((name) => name.length)) + 2;
  for (const [name, command] of Object.entries(app.commands)) {
    const marker = command.destructive === true ? " (destructive)" : "";
    info(`  ${name.padEnd(width)} ${command.summary}${marker}`);
  }
  info("");
  for (const line of gateHelp) info(line);
  info("  help <command>    same as: <command> --help");
  info("");
  info("Run `./clawforge help <command>` or `./clawforge <command> --help` for its full description.");
}

function commandHelp(name: string, command: AppCommand): void {
  log(`${name} — ${command.summary}`);
  const signature = formatArguments(command);
  if (signature !== "") info(`Usage: ./clawforge ${name} ${signature}`);
  for (const argument of command.arguments ?? []) {
    const required = argument.required === true ? " (required)" : "";
    const choices = argument.choices === undefined ? "" : ` [${argument.choices.join("|")}]`;
    info(`  ${label(argument).padEnd(22)} ${argument.description}${choices}${required}`);
  }
  if (command.details !== undefined) {
    info("");
    for (const line of command.details.split("\n")) info(line);
  }
  if (command.destructive === true) {
    info("");
    info("This command replaces or destroys state.");
  }
}

/** Entry point: dispatches argv against an application definition. `gateHelp` is the
 *  gate-specific footer (see DEFAULT_GATE_HELP) — omit it from a monorepo-style gate, or
 *  pass an installed-mode gate's own lines. */
export async function runApp(
  app: AppDefinition,
  argv: string[],
  gateHelp: string[] = DEFAULT_GATE_HELP,
  gateCommands: GateCommand[] = [],
): Promise<number> {
  const [name, ...args] = argv;

  if (name === undefined || name === "-h" || name === "--help") {
    usage(app, gateHelp);
    return name === undefined ? 1 : 0;
  }

  // `./clawforge help` alone behaves like `--help`; `./clawforge help <command>` is the same lookup
  // `<command> --help` does, just easier to reach for from a cold start — "what commands
  // exist" and "what does this one do" are both spelled the same way, `help`.
  if (name === "help") {
    const target = args[0];
    if (target === undefined || target === "--help" || target === "-h") {
      usage(app, gateHelp);
      return 0;
    }
    const helpCommand = app.commands[target];
    if (helpCommand === undefined) {
      // A gate command is reached the same way as any other from a user's side, so
      // `help <it>` has to answer too — the gate itself already handled `<it> --help`
      // before this dispatcher ever ran.
      const gateCommand = gateCommands.find((entry) => entry.name === target);
      if (gateCommand !== undefined) {
        gateCommandHelp(gateCommand);
        return 0;
      }
      reportError(`unknown command: ${target}`);
      usage(app, gateHelp);
      return 1;
    }
    commandHelp(target, helpCommand);
    return 0;
  }

  // Framework-level command: serves the application's own commands as MCP tools, so the
  // instance can be driven from a chat client as well as from a terminal. --help is
  // checked before starting the server, not after — this owns stdin/stdout for JSON-RPC
  // once it runs, so passing --help used to just start the server and wait on stdin.
  if (name === "control-mcp") {
    if (args.includes("--help") || args.includes("-h")) {
      log(`control-mcp — expose ${app.name}'s commands as MCP tools`);
      info("Usage: ./clawforge control-mcp");
      info("");
      info("stdio JSON-RPC server, same shape as mcp-serve but for this deployment's own");
      info("commands instead of OpenClaw's channels — status, backup, secrets, and the");
      info("rest, with arguments checked against the same declarations --help reads.");
      info("Destructive commands (push, restore, deploy) need confirm: true.");
      info("Registered for a client automatically by ./clawforge mcp-setup; not meant to be run");
      info("by hand outside of testing.");
      return 0;
    }
    // The gate's commands travel with the application's: the surface is a mirror of what
    // `./clawforge` can do, and where a command happens to be dispatched from is our layering, not
    // a distinction a client should have to know about.
    await serveMcp(app, gateCommands);
    return 0;
  }

  const command = app.commands[name];
  if (command === undefined) {
    reportError(`unknown command: ${name}`);
    usage(app, gateHelp);
    return 1;
  }

  if (command.passesThroughHelp !== true && args.includes("--help")) {
    commandHelp(name, command);
    return 0;
  }

  // Recipes belong to the deployment, next to its configuration.
  useRecipesDir(recipesDir());

  // Before the context: it parses .env and builds the runtime around it, so a command that
  // is supposed to create that file cannot be the one to run afterwards.
  if (command.preparesEnvironment === true) await ensureEnvironment();

  // Built here, not by the command: an application never constructs a transport itself.
  const ctx = await createContext({ mounts: app.mounts, service: app.service });

  await command.run(ctx, args);
  return 0;
}

/** Wraps runApp with the error handling every entry point needs, so an application's own
 *  entry file stays a single call. */
export async function main(
  app: AppDefinition,
  argv: string[],
  gateHelp?: string[],
  gateCommands?: GateCommand[],
): Promise<void> {
  try {
    process.exitCode = await runApp(app, argv, gateHelp, gateCommands);
  } catch (error) {
    reportError(error);
    // A UserError is an expected, explained failure; anything else is a bug worth a trace.
    if (!(error instanceof UserError) && process.env.OC_DEBUG === "1") {
      console.error(error);
    }
    process.exitCode = 1;
  }
}
