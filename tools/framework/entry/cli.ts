// Running an application from the command line.
//
// The framework owns argument dispatch, help text and error reporting; an application only
// declares its commands. Adding a command to an application must not require touching any
// file in framework/ — that is the property this module exists to guarantee.

import { reportError, UserError, CommandFailedError, log, info, maskSecrets } from "../core/io/log.ts";
import { UnknownArgumentError, preparesEnvironmentFor } from "../core/arguments.ts";
import { emit, machineWritesCount } from "../core/io/output.ts";
import { createContext } from "../core/context.ts";
import { recoverEnv, recoverEnvBeforeContext } from "../commands/operate/recover-env/index.ts";
import { clearRecipesDir } from "../service/recipe.ts";
import { useApplicationRecipesDir } from "../runtime/deployment.ts";
import { ensureEnvironment } from "../integration/provision.ts";
import { serveMcp } from "../integration/mcp/server.ts";
import { knownCommandNames, reportUnknownCommand, renderHelp, type GateCommand } from "../integration/gate.ts";
import { GROUP_HEADINGS, GROUP_ORDER, destructiveMarker, destructiveSymbol, helpEntryLine, renderFullCommandHelp, renderUsage } from "../core/io/help-render.ts";
import type { AppDefinition } from "../core/app.ts";

// Re-exported for tools/checks/foundation/cli/help-groups.check.ts, which asserts the console
// listing against the real grouping and wording rather than a copy that could drift from it.
export { GROUP_HEADINGS, GROUP_ORDER, destructiveMarker, destructiveSymbol };

/** Lines shown between the command list and the closing "Run ./clawforge help ..." hint —
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

  if (name === undefined || name === "-h" || name === "--help") {
    renderUsage(app, gateHelp);
    return name === undefined ? 1 : 0;
  }

  // `help` alone behaves like `--help`; `help <command>` is the same lookup `<command>
  // --help` does. Shared with the MCP `help` tool (integration/mcp/server.ts) through
  // renderHelp, so the two never answer the same question differently.
  if (name === "help") {
    return renderHelp(args[0], app, gateCommands, gateHelp) ? 0 : 1;
  }

  // Serves the application's commands as MCP tools, so the instance can be driven from a
  // chat client too. --help is checked before starting: the server owns stdio once it runs.
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
    // Gate commands travel with the application's — the surface mirrors what `./clawforge`
    // can do. gateHelp rides along too, for the MCP `help` tool's no-argument form.
    await serveMcp(app, gateCommands, gateHelp);
    return 0;
  }

  const command = app.commands[name];
  if (command === undefined) {
    reportUnknownCommand(name, knownCommandNames(app, gateCommands));
    return 1;
  }

  if (requestsHelp(args)) {
    renderFullCommandHelp(name, command);
    return 0;
  }

  // Configure this before building the context; set sources still take precedence in recipesDir().
  useApplicationRecipesDir(app.recipesDir);
  clearRecipesDir();

  // Recovery repairs the very facts a Context is validated from, so it can't owe its own
  // dispatch to a built one — with OC_DATA_DIR absent, createContext dies in the settings
  // parser before recover-env could even start. Its own bootstrap builds only what the
  // container read needs: transport and project identity (recover-env/bootstrap.ts).
  // Compared by identity so the declaration stays the single source of truth.
  if (command.run === recoverEnv) {
    try {
      await recoverEnvBeforeContext(args, { service: app.service?.name });
    } catch (error) {
      // Same answer as every other command's unknown flag, though recovery parses outside
      // the command.run try below.
      if (error instanceof UnknownArgumentError) {
        reportUnknownArgument(name, error);
        return 1;
      }
      throw error;
    }
    return 0;
  }

  // Before the context: it parses .env and builds the runtime around it, so a command
  // meant to create that file cannot run after it exists. Only a mutating call prepares it.
  try {
    if (preparesEnvironmentFor(command, args)) await ensureEnvironment();
  } catch (error) {
    if (error instanceof UnknownArgumentError) {
      reportUnknownArgument(name, error);
      return 1;
    }
    throw error;
  }

  // Built here, not by the command: an application never constructs a transport itself.
  const ctx = await createContext({
    mounts: app.mounts,
    service: app.service,
    settings: app.settings,
    secrets: app.secrets,
    afterBackup: app.afterBackup,
    beforeRestore: app.beforeRestore,
  });

  try {
    await command.run(ctx, args);
  } catch (error) {
    if (error instanceof UnknownArgumentError) {
      reportUnknownArgument(name, error);
      return 1;
    }
    throw error;
  }
  return 0;
}

/** The standard answer to a token no declared argument matches: the refusal (already
 *  carrying a did-you-mean guess from parseDeclaredArgs) plus a pointer to that command's
 *  own --help. Mirrors reportUnknownCommand (integration/gate.ts) for the sibling case. */
export function reportUnknownArgument(commandName: string, error: UnknownArgumentError): void {
  reportError(error);
  info(`run ./clawforge ${commandName} --help for its full argument list`);
}

/** The one --json failure contract: a command invoked with --json that fails after its
 *  arguments parsed still prints a machine-readable answer — an error document on stdout —
 *  so a script's jq never receives empty input. Skipped when the command already printed a
 *  document of its own (status/doctor/upgrade --dry-run report their failures as JSON), and
 *  never for a non-JSON invocation, whose human-readable reporting is unchanged. */
function reportJsonFailure(argv: string[], error: unknown): void {
  const sep = argv.indexOf("--");
  const scope = sep === -1 ? argv : argv.slice(0, sep);
  if (!scope.slice(1).includes("--json")) return;
  if (machineWritesCount() > 0) return;
  const message = maskSecrets(error instanceof Error ? error.message : String(error));
  emit(`${JSON.stringify({ error: { message } }, null, 2)}\n`);
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
    reportJsonFailure(argv, error);
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
