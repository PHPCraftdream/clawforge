// Running an application from the command line.
//
// The framework owns argument dispatch, help text and error reporting; an application only
// declares its commands. Adding a command to an application must not require touching any
// file in framework/ — that is the property this module exists to guarantee.

import { reportError, UserError, log, info } from "../core/io/log.ts";
import { UnknownArgumentError, preparesEnvironmentFor } from "../core/arguments.ts";
import { createContext } from "../core/context.ts";
import { recoverEnv, recoverEnvBeforeContext } from "../commands/operate/recover-env/index.ts";
import { clearRecipesDir } from "../service/recipe.ts";
import { useApplicationRecipesDir } from "../runtime/deployment.ts";
import { ensureEnvironment } from "../integration/provision.ts";
import { serveMcp } from "../integration/mcp/server.ts";
import { knownCommandNames, reportUnknownCommand, renderHelp, type GateCommand } from "../integration/gate.ts";
import { GROUP_HEADINGS, GROUP_ORDER, destructiveMarker, renderFullCommandHelp, renderUsage } from "../core/io/help-render.ts";
import type { AppCommand, AppDefinition } from "../core/app.ts";

// Re-exported for tools/checks/foundation/cli/help-groups.check.ts, which asserts the console
// listing against the real grouping and wording rather than a copy that could drift from it.
export { GROUP_HEADINGS, GROUP_ORDER, destructiveMarker };

/** Lines shown between the command list and the closing "Run ./clawforge help ..." hint — the one
 *  part of this help screen that is gate-specific (monorepo: --app/new-app; installed: init)
 *  rather than something an AppDefinition or its commands could know. tools/clawforge.ts (several
 *  deployments under apps/<name>) and bin.ts (one deployment, this directory) each pass
 *  their own; this default is tools/clawforge.ts's, unchanged from before this became a parameter. */
const DEFAULT_GATE_HELP = [
  "  --app <name>      pick another deployment, before the command (default: the OC_APP one)",
  "  new-app <name>    create a deployment under apps/",
];

/** `--opt=value` for a declared option becomes `--opt value`, so every reader of argv — the
 *  declared parser and the few that scan it directly — sees one form. Commands that pass
 *  their argv through verbatim (a variadic argument) are left untouched. */
export function splitInlineOptions(command: AppCommand, args: string[]): string[] {
  const declared = command.arguments ?? [];
  if (declared.some((argument) => argument.kind === "variadic")) return args;
  const options = new Set(declared.filter((argument) => argument.kind === "option").map((argument) => argument.name));
  return args.flatMap((arg) => {
    const match = /^--([^=]+)=(.*)$/s.exec(arg);
    return match !== null && options.has(match[1]) ? [`--${match[1]}`, match[2]] : [arg];
  });
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

  // `./clawforge help` alone behaves like `--help`; `./clawforge help <command>` is the same lookup
  // `<command> --help` does, just easier to reach for from a cold start — "what commands
  // exist" and "what does this one do" are both spelled the same way, `help`. Shared with the
  // MCP `help` tool (integration/mcp/server.ts) through renderHelp, so the two never answer
  // the same question differently.
  if (name === "help") {
    return renderHelp(args[0], app, gateCommands, gateHelp) ? 0 : 1;
  }

  // Framework-level command: serves the application's own commands as MCP tools, so the
  // instance can be driven from a chat client as well as from a terminal. --help is
  // checked before starting the server, not after — the server owns stdin/stdout for
  // JSON-RPC once it runs.
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
    // a distinction a client should have to know about. gateHelp rides along too — it is what
    // the MCP `help` tool's no-argument form renders, same as the console's own usage screen.
    await serveMcp(app, gateCommands, gateHelp);
    return 0;
  }

  const command = app.commands[name];
  if (command === undefined) {
    reportUnknownCommand(name, knownCommandNames(app, gateCommands));
    return 1;
  }

  if (command.passesThroughHelp !== true && args.includes("--help")) {
    renderFullCommandHelp(name, command);
    return 0;
  }

  // Configure this before building the context; set sources still take precedence in recipesDir().
  useApplicationRecipesDir(app.recipesDir);
  clearRecipesDir();

  // Recovery repairs the very facts a Context is validated from, so it cannot owe its own
  // dispatch to a built one: with OC_DATA_DIR absent, createContext dies in the settings
  // parser before the command that exists to fill that fact can even start. Its
  // bootstrap builds only what the container read needs — transport and project identity
  // (commands/operate/recover-env/bootstrap.ts). Compared by identity so the declaration stays the
  // single source of truth: if the declaration ever wires a different run, this branch
  // stops firing and the recover-env dispatch regression fails on the settings parser's
  // refusal instead of recovery's own.
  if (command.run === recoverEnv) {
    await recoverEnvBeforeContext(args, { service: app.service?.name });
    return 0;
  }

  const runArgs = splitInlineOptions(command, args);

  // Before the context: it parses .env and builds the runtime around it, so a command that
  // is supposed to create that file cannot be the one to run afterwards. Only a call about to
  // mutate prepares it: read-only (--check) and refused argv create nothing.
  try {
    if (preparesEnvironmentFor(command, runArgs)) await ensureEnvironment();
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
    await command.run(ctx, runArgs);
  } catch (error) {
    if (error instanceof UnknownArgumentError) {
      reportUnknownArgument(name, error);
      return 1;
    }
    throw error;
  }
  return 0;
}

/** The standard answer to a token no declared argument matches: the refusal itself (already
 *  carrying a did-you-mean guess at the nearest declared flag, from parseDeclaredArgs — see
 *  core/arguments.ts) plus a pointer to that command's own --help — a pointer only this
 *  dispatcher can add, since parseDeclaredArgs never learns the command name it is parsing
 *  for. Mirrors reportUnknownCommand's shape (integration/gate.ts) for the sibling case, an
 *  unrecognised command name rather than an unrecognised argument of a real one. */
export function reportUnknownArgument(commandName: string, error: UnknownArgumentError): void {
  reportError(error);
  info(`run ./clawforge ${commandName} --help for its full argument list`);
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
      // spawnLocal shortens a failed command's headline to what failed rather than the full
      // argv (a wsl.exe/env/Compose call can run ~600 characters of distro, path and
      // project-identity plumbing that says nothing about the reason); the argv it was
      // shortened from rides along on the error for exactly this branch.
      const fullCommand = (error as { fullCommand?: unknown }).fullCommand;
      if (typeof fullCommand === "string") console.error(`full command: ${fullCommand}`);
    }
    process.exitCode = 1;
  }
}
