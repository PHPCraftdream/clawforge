// Running an application from the command line.
//
// The framework owns argument dispatch, help text and error reporting; an application only
// declares its commands. Adding a command to an application must not require touching any
// file in framework/ — that is the property this module exists to guarantee.

import { reportError, UserError, log, info } from "../core/io/log.ts";
import { UnknownArgumentError } from "../core/arguments.ts";
import { createContext } from "../core/context.ts";
import { recoverEnv, recoverEnvBeforeContext } from "../commands/operate/recover-env/index.ts";
import { clearRecipesDir } from "../service/recipe.ts";
import { useApplicationRecipesDir } from "../runtime/deployment.ts";
import { ensureEnvironment } from "../integration/provision.ts";
import { serveMcp } from "../integration/mcp/server.ts";
import { gateCommandHelp, reportUnknownCommand, type GateCommand } from "../integration/gate.ts";
import { renderCommandHelp } from "../core/io/help-render.ts";
import type { AppCommand, AppDefinition, CommandGroup } from "../core/app.ts";

/** Fixed print order and heading for each CommandGroup — an operator scans intent sections
 *  top to bottom, not an alphabetical command list. tools/checks/foundation/cli/help-groups.check.ts
 *  keeps this in lockstep with the CommandGroup union: a group added to one and not the
 *  other fails there, not silently at render time. */
export const GROUP_HEADINGS: Record<CommandGroup, string> = {
  "start-stop": "Start & stop",
  check: "Check",
  change: "Change",
  "save-move": "Save & move",
  "security-access": "Security & access",
  integrations: "Integrations & recovery",
  "low-level": "Low-level",
};
export const GROUP_ORDER = Object.keys(GROUP_HEADINGS) as CommandGroup[];

/** Precise, metadata-derived wording instead of a flat "(destructive)" that is only true for
 *  some invocations — readOnlyWhen already says the command has a safe default and a
 *  destructive one only under certain arguments; the label follows that fact rather than
 *  hard-coding which flag it is per command. Exported so the check that guards this wording
 *  (tools/checks/foundation/cli/help-groups.check.ts) asserts against the real function, not
 *  a copy that could drift from it. */
export function destructiveMarker(command: AppCommand): string {
  if (command.destructive !== true) return "";
  return command.readOnlyWhen === undefined ? " (destructive)" : " (destructive for some actions)";
}

/** Lines shown between the command list and the closing "Run ./clawforge help ..." hint — the one
 *  part of this help screen that is gate-specific (monorepo: --app/new-app; installed: init)
 *  rather than something an AppDefinition or its commands could know. tools/clawforge.ts (several
 *  deployments under apps/<name>) and bin.ts (one deployment, this directory) each pass
 *  their own; this default is tools/clawforge.ts's, unchanged from before this became a parameter. */
const DEFAULT_GATE_HELP = [
  "  --app <name>      pick another deployment, before the command (default: the OC_APP one)",
  "  new-app <name>    create a deployment under apps/",
];

/** The two framework-owned lines every gate's `--help` footer carries beside its own
 *  (check/new-app/list, or init): `control-mcp`, dispatched here rather than declared in
 *  app.commands (see runApp below), and `help`, this dispatcher's own alias. Padded together
 *  so the two stay visually aligned regardless of what a gate's own lines look like. */
function builtinHelpLines(app: AppDefinition): string[] {
  const entries: Array<[string, string]> = [
    ["control-mcp", `expose ${app.name}'s commands as MCP tools — the entry point for agents`],
    ["help <command>", "same as: <command> --help"],
  ];
  const width = Math.max(...entries.map(([name]) => name.length)) + 2;
  return entries.map(([name, summary]) => `  ${name.padEnd(width)}${summary}`);
}

function usage(app: AppDefinition, gateHelp: string[]): void {
  log(`${app.name} — ${app.description}`);
  info("");
  info("Usage: ./clawforge <command> [options]");
  info("");

  const width = Math.max(...Object.keys(app.commands).map((name) => name.length)) + 2;
  const byGroup = new Map<CommandGroup, [string, AppCommand][]>();
  // Belt and suspenders: help-groups.check.ts fails the build before an ungrouped command
  // ships, but a command that reaches here without a known group is still listed rather than
  // silently dropped from --help.
  const unknown: [string, AppCommand][] = [];
  for (const entry of Object.entries(app.commands)) {
    const [, command] = entry;
    if (command.group === undefined || GROUP_HEADINGS[command.group] === undefined) {
      unknown.push(entry);
      continue;
    }
    const bucket = byGroup.get(command.group);
    if (bucket === undefined) byGroup.set(command.group, [entry]);
    else bucket.push(entry);
  }

  const printGroup = (heading: string, entries: [string, AppCommand][]): void => {
    info(`${heading}:`);
    for (const [name, command] of entries) {
      info(`  ${name.padEnd(width)} ${command.summary}${destructiveMarker(command)}`);
    }
    info("");
  };
  for (const group of GROUP_ORDER) {
    const entries = byGroup.get(group);
    if (entries !== undefined && entries.length > 0) printGroup(GROUP_HEADINGS[group], entries);
  }
  if (unknown.length > 0) printGroup("Other", unknown);

  for (const line of gateHelp) info(line);
  for (const line of builtinHelpLines(app)) info(line);
  info("");
  info("Run `./clawforge help <command>` or `./clawforge <command> --help` for its full description.");
}

/** Every name reachable from this dispatcher: the application's own commands, the gate's
 *  (already handled before runApp ever sees argv, but still real commands a typo can be
 *  compared against), and the two the dispatcher itself owns outside app.commands. */
function knownCommandNames(app: AppDefinition, gateCommands: GateCommand[]): string[] {
  return [...Object.keys(app.commands), ...gateCommands.map((command) => command.name), "help", "control-mcp"];
}

function commandHelp(name: string, command: AppCommand): void {
  renderCommandHelp(name, command);
  if (command.destructive === true) {
    info("");
    info(command.readOnlyWhen === undefined
      ? "This command replaces or destroys state."
      : "This command can replace or destroy state, depending on the action given.");
  }
}

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
      reportUnknownCommand(target, knownCommandNames(app, gateCommands));
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
    reportUnknownCommand(name, knownCommandNames(app, gateCommands));
    return 1;
  }

  if (command.passesThroughHelp !== true && args.includes("--help")) {
    commandHelp(name, command);
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

  // Before the context: it parses .env and builds the runtime around it, so a command that
  // is supposed to create that file cannot be the one to run afterwards.
  if (command.preparesEnvironment === true) await ensureEnvironment();

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
    await command.run(ctx, splitInlineOptions(command, args));
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
