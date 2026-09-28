// Shared `--help` rendering for a declared command — one implementation for both
// entry/cli.ts's AppCommand and integration/gate.ts's GateCommand, so a fix to one (a
// dropped `choices`, a stale `<value>`) cannot happen to only one of them and not the other.

import { log, info } from "./log.ts";
import type { CommandArgument } from "../app.ts";

/** What renderCommandHelp needs from a command — the shape AppCommand and GateCommand both
 *  satisfy, without importing either (they live in entry/ and integration/, downstream of
 *  core/; importing one here would be the cycle this module exists to avoid). */
export interface HelpDeclaration {
  readonly summary: string;
  readonly details?: string;
  readonly arguments?: readonly CommandArgument[];
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
  if (signature !== "") info(`Usage: ./clawforge ${name} ${signature}`);
  for (const argument of command.arguments ?? []) {
    const required = argument.required === true ? " (required)" : "";
    const choices = argument.choices === undefined ? "" : ` [${argument.choices.join("|")}]`;
    info(`  ${argumentLabel(argument).padEnd(USAGE_COLUMN)} ${argument.description}${choices}${required}`);
  }
  if (command.details !== undefined) {
    info("");
    for (const line of command.details.split("\n")) info(line);
  }
}
