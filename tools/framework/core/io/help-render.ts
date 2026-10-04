// Shared `--help` rendering for a declared command — one implementation for both
// entry/cli.ts's AppCommand and integration/gate.ts's GateCommand, so a fix to one (a
// dropped `choices`, a stale `<value>`) cannot happen to only one of them and not the other.

import { log, info } from "./log.ts";
import type { AppCommand, AppDefinition, CommandArgument, CommandGroup } from "../app.ts";
import type { EffectDeclaration } from "../command/index.ts";
import { effectProfile, argumentScopes, argumentRules, ruleText } from "../command/index.ts";
import { commandLine, renderAdvice } from "./invocation/render.ts";
import { command } from "./invocation/advice.ts";
import { invocation, type Invocation } from "./invocation/index.ts";
import { renderProse } from "./invocation/prose.ts";

/** What renderCommandHelp needs from a command — the shape AppCommand and GateCommand both
 *  satisfy, without importing either (they live in entry/ and integration/, downstream of
 *  core/; importing one here would be the cycle this module exists to avoid). */
export interface HelpDeclaration {
  readonly summary: string;
  readonly details?: string;
  readonly arguments?: readonly CommandArgument[];
  /** Only what `argumentScopes` reads of the declaration (a gate command has none). */
  readonly run?: unknown;
}

/** Column an argument's description starts at, wide enough for the longest label this
 *  framework declares without the alignment collapsing into one space. */
const USAGE_COLUMN = 22;

/** How one argument appears on a command line: `--name`, `--name <valueName>`, `<name>`,
 *  `<name…>`. The `valueName ?? argument.name` fallback is only for a bare test fixture —
 *  every real declared option has one (see CommandArgument's own doc comment). */
export function argumentLabel(argument: CommandArgument): string {
  if (argument.kind === "flag") return `--${argument.name}`;
  if (argument.kind === "option") return `--${argument.name} <${argument.valueName ?? argument.name}>`;
  if (argument.kind === "variadic") return `<${argument.name}…>`;
  return `<${argument.name}>`;
}

/** The `Usage: ... <signature>` piece: every declared argument, bracketed when optional. */
export function argumentsSignature(args: readonly CommandArgument[] | undefined): string {
  if (args === undefined || args.length === 0) return "";
  return args.map((argument) => (argument.required === true ? argumentLabel(argument) : `[${argumentLabel(argument)}]`)).join(" ");
}

/** Full `--help` body for one command: summary line, usage line, one line per argument
 *  (label, description, choices, required-ness), then details split on `\n`. Callers append
 *  whatever is specific to their own command shape afterwards — entry/cli.ts's
 *  destructive-state note, for one, which GateCommand has no equivalent of. */
export function renderCommandHelp(name: string, command: HelpDeclaration): void {
  log(`${name} — ${command.summary}`);
  const signature = argumentsSignature(command.arguments);
  if (signature !== "") info(`Usage: ${commandLine([name])} ${signature}`);
  for (const argument of command.arguments ?? []) {
    const required = argument.required === true ? " (required)" : "";
    const choices = argument.choices === undefined ? "" : ` [${argument.choices.join("|")}]`;
    // A multi-action command's argument that belongs to only some of its actions (backup's
    // own --keep, install-only) — see CommandArgument's `actions`. An argument whose actions
    // describe it differently carries its own action list in each part of the composed
    // description, so the whole-command list must not be added again (R32-04).
    const scopes = argumentScopes(command, argument.name);
    const description = argument.description.replace(/^With [\w/-]+: /, "");
    const scope = argument.actions === undefined || scopes !== undefined ? "" : ` (${argument.actions.join(", ")})`;
    info(`  ${argumentLabel(argument).padEnd(USAGE_COLUMN)} ${description}${scope}${choices}${required}`);
  }
  for (const unit of argumentRules(command) ?? []) {
    for (const rule of unit.rules) {
      const prefix = unit.action === undefined ? "" : `${unit.action}: `;
      const marker = rule.rule === "oneOf" && rule.required === true ? " (one required)" : "";
      info(`  ${prefix}${ruleText(rule, unit.arguments, { action: unit.action }, { mode: "help" })}${marker}`);
    }
  }
  if (command.details !== undefined) {
    info("");
    for (const line of renderProse(command.details).split("\n")) info(line);
  }
}

/** The heading for each CommandGroup, in print order (shared by the console and the MCP `help` tool). */
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

/** Precise, metadata-derived wording instead of a flat "(destructive)" that's only true for
 *  some invocations — derived from the command's effect profile, like every other surface.
 *  Minimal structural shape: AppCommand, a gate command and the MCP tool's Declared all
 *  satisfy it. */
export const DESTRUCTIVE_SOME = " (destructive for some actions)";

export function destructiveMarker(command: EffectDeclaration): string {
  const { destructive, alwaysDestroys } = effectProfile(command);
  if (!destructive) return "";
  return alwaysDestroys ? " (destructive)" : DESTRUCTIVE_SOME;
}

/** Short list marker: `!` destructive, `*` destructive for some actions; renderUsage's
 *  legend line explains both. Empty for a command that is not destructive. */
export function destructiveSymbol(command: EffectDeclaration): string {
  const { destructive, alwaysDestroys } = effectProfile(command);
  if (!destructive) return "";
  return alwaysDestroys ? " !" : " *";
}

/** Name column of every entry in the command list (commands, gate and built-in lines alike). */
export const HELP_NAME_WIDTH = 20;

/** One aligned line of the command list. */
export function helpEntryLine(name: string, summary: string): string {
  return `  ${name.padEnd(HELP_NAME_WIDTH)} ${summary}`;
}

/** The usage screen's own line and the full-description hint under it — exported so the
 *  gate's bare screen and the checks assert the same text the renderer prints. */
export function usageTopLine(on: Invocation = invocation()): string {
  return `Usage: ${renderAdvice(command(["<command>"]), on)} [options]`;
}
export function usageFooterHint(on: Invocation = invocation()): string {
  return `Run \`${renderAdvice(command(["help", "<command>"]), on)}\` or \`${renderAdvice(command(["<command>", "--help"]), on)}\` for its full description.`;
}

/** The top-level `--help` screen, shared by the console and the MCP `help` tool. The footer
 *  is the caller's to compose: the gate's own lines followed by integration/gate.ts's
 *  dispatcherHelpLines(registry). */
export function renderUsage(app: AppDefinition, footer: readonly string[]): void {
  log(`${app.name} — ${app.description}`);
  info("");
  info(usageTopLine());
  info("");

  const byGroup = new Map<CommandGroup, [string, AppCommand][]>();
  // Belt and suspenders: help-groups.check.ts fails the build before an ungrouped command
  // ships, but one that reaches here is still listed rather than silently dropped.
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
      info(helpEntryLine(name, `${command.summary}${destructiveSymbol(command)}`));
    }
    info("");
  };
  for (const group of GROUP_ORDER) {
    const entries = byGroup.get(group);
    if (entries !== undefined && entries.length > 0) printGroup(GROUP_HEADINGS[group], entries);
  }
  if (unknown.length > 0) printGroup("Other", unknown);

  info("Framework:");
  for (const line of footer) info(line);
  info("");
  info("  ! destructive     * destructive for some actions (a read-only or --dry-run form is safe)");
  info("");
  info(usageFooterHint());
}

/** The envelope every structured tool call answers in (mcp/schema.ts's StructuredResult) —
 *  field meanings only, not repeated in the MCP outputSchema (which declares types
 *  identically on every structured tool). Reachable through `help <command>`. */
export const STRUCTURED_ENVELOPE_HELP =
  "Every call answers in one envelope: operationId (a stable id), changed (bool), " +
  "healthy (bool, when known), problems/warnings (findings), nextActions (commands to run " +
  "next), nextSteps (the same remedies as tool calls: {tool, arguments}), result (the " +
  "command's own output, unaltered).";

/** One command's full `--help` body plus the destructive-state note entry/cli.ts's console
 *  path appends after it. */
export function renderFullCommandHelp(name: string, command: AppCommand): void {
  renderCommandHelp(name, command);
  const { destructive, alwaysDestroys, byAction } = effectProfile(command);
  if (destructive) {
    info("");
    info(alwaysDestroys
      ? "This command replaces or destroys state."
      : byAction
        ? "This command can replace or destroy state, depending on the action given."
        : "This command can replace or destroy state, depending on the flags given.");
  }
  if (command.structured === true) {
    info("");
    info(STRUCTURED_ENVELOPE_HELP);
  }
}
