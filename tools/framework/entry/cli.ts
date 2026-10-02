// Running an application from the command line.
//
// The framework owns argument dispatch, help text and error reporting; an application only
// declares its commands. Adding a command to an application must not require touching any
// file in framework/ — that is the property this module exists to guarantee.

import { reportError, UserError, CommandFailedError, info } from "../core/io/log.ts";
import { UnknownArgumentError } from "../core/command/index.ts";
import { executeCommand } from "../core/command/execute.ts";
import { serveMcp } from "../integration/mcp/server.ts";
import { commandRegistry, dispatcherHelpLines, reportUnknownCommand, renderHelp, type GateCommand } from "../integration/gate.ts";
import { GROUP_HEADINGS, GROUP_ORDER, destructiveMarker, destructiveSymbol, helpEntryLine, renderCommandHelp, renderFullCommandHelp, renderUsage } from "../core/io/help-render.ts";
import { commandLine } from "../core/io/invocation/render.ts";
import type { AppDefinition } from "../core/app.ts";

// Re-exported for tools/checks/foundation/cli/help-groups.check.ts, which asserts the console
// listing against the real grouping and wording rather than a copy that could drift from it.
export { GROUP_HEADINGS, GROUP_ORDER, destructiveMarker, destructiveSymbol };

/** Lines shown between the command list and the closing "Run the gate's help ..." hint —
 *  gate-specific (monorepo: --app/new-app; installed: init), not something an AppDefinition
 *  could know. tools/clawforge.ts and bin.ts each pass their own; this default is tools/clawforge.ts's. */
const DEFAULT_GATE_HELP = [
  helpEntryLine("--app <name>", "pick another deployment, before the command (default: the OC_APP one)"),
  helpEntryLine("new-app <name>", "create a deployment under apps/"),
];

/** Whether argv asks for this command's own `--help`, scanning only tokens before the
 *  first bare `--` (the same boundary `host`'s parser draws) — a command that passes argv
 *  through (`cli`, `exec`) reaches THAT tool's `--help` by putting it after `--`. */
export function requestsHelp(args: string[]): boolean {
  const sep = args.indexOf("--");
  return (sep === -1 ? args : args.slice(0, sep)).includes("--help");
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
  const registry = commandRegistry({ deployment: app.commands, gate: gateCommands, appName: app.name });

  if (name === undefined || name === "-h" || name === "--help") {
    renderUsage(app, [...gateHelp, ...dispatcherHelpLines(registry)]);
    return name === undefined ? 1 : 0;
  }

  // `help` alone behaves like `--help`; `help <command>` is the same lookup `<command>
  // --help` does. Shared with the MCP `help` tool (integration/mcp/server.ts) through
  // renderHelp, so the two never answer the same question differently.
  if (name === "help") {
    return renderHelp(args[0], app, registry, gateHelp) ? 0 : 1;
  }

  // Serves the application's commands as MCP tools, so the instance can be driven from a
  // chat client too. --help is checked before starting: the server owns stdio once it runs.
  if (name === "control-mcp") {
    if (args.includes("--help") || args.includes("-h")) {
      // From the registry entry renderHelp reads, so `help control-mcp` and this never answer
      // differently — the same declaration, not a bespoke help printer.
      const entry = registry.find("control-mcp");
      if (entry !== undefined) renderCommandHelp("control-mcp", entry);
      return 0;
    }
    // Gate commands travel with the application's — the surface mirrors what the gate
    // can do. gateHelp rides along too, for the MCP `help` tool's no-argument form.
    await serveMcp(app, gateCommands, gateHelp);
    return 0;
  }

  const command = app.commands[name];
  if (command === undefined) {
    reportUnknownCommand(name, registry.names);
    return 1;
  }

  if (requestsHelp(args)) {
    renderFullCommandHelp(name, command);
    return 0;
  }

  // The one pipeline (parse → confirm → prepare → environment → context → run), shared with
  // the MCP surface. Only an argument error is reported here; anything else rethrows so
  // main() reports it — the contract the app-hooks checks rely on.
  const execution = await executeCommand(app, name, args, { surface: "terminal" });
  if (execution.error === undefined) return 0;
  if (execution.error instanceof UnknownArgumentError) {
    reportUnknownArgument(name, execution.error);
    return 1;
  }
  throw execution.error;
}

/** The standard answer to a token no declared argument matches: the refusal (already
 *  carrying a did-you-mean guess from parseDeclaredArgs) plus a pointer to that command's
 *  own --help. Mirrors reportUnknownCommand (integration/gate.ts) for the sibling case. */
export function reportUnknownArgument(commandName: string, error: UnknownArgumentError): void {
  reportError(error);
  info(`run ${commandLine([commandName, "--help"])} for its full argument list`);
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
      // spawnLocal shortens a failed command's headline to what failed, not the full argv
      // (a wsl.exe/Compose call can run ~600 chars of plumbing); the argv rides along on
      // the error for exactly this branch.
      const fullCommand = (error as { fullCommand?: unknown }).fullCommand;
      if (typeof fullCommand === "string") console.error(`full command: ${fullCommand}`);
    }
    // A wrapped command's own exit status (host/exec/cli), already clamped to 1..255; every
    // other failure keeps the generic 1.
    process.exitCode = error instanceof CommandFailedError ? error.exitCode : 1;
  }
}
