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

import { log, info, reportError } from "../core/io/log.ts";
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

/** What a leading `--app <name>` or `--app=<name>` split off argv, if either was there. */
export interface AppFlagSplit {
  /** The name after --app/--app=, absent when --app did not lead argv at all. */
  readonly value: string | undefined;
  /** --app led argv with no value after it (the very last token) — distinct from "absent" so
   *  the caller can report the same "--app needs a deployment name" it always has, rather
   *  than silently falling through to the default deployment. */
  readonly missingValue: boolean;
  readonly rest: string[];
}

/** Recognises `--app`/`--app=<name>` only as the very first token(s) of argv — after the
 *  command name, an identically-spelled `--app` belongs to that command's own arguments
 *  (`exec`, `cli` and `host` all pass theirs through to something else verbatim), and must
 *  survive untouched rather than being cut out of the middle of argv. */
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

/** Damerau-Levenshtein edit distance: a transposition of two adjacent characters (the most
 *  common way to mistype a command name — "statsu" for "status") costs one edit, not the two
 *  a plain Levenshtein distance would charge it. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => Array.from<number>({ length: cols }).fill(0));
  for (let i = 0; i < rows; i += 1) d[i][0] = i;
  for (let j = 0; j < cols; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[rows - 1][cols - 1];
}

/** The nearest command name to a typed one, or undefined when nothing is close enough to be
 *  worth guessing at. The threshold scales with length so a couple of wrong letters in a long
 *  name still matches, while two short, unrelated names never suggest one another just for
 *  being short. */
export function closestCommand(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best === undefined) return undefined;
  const threshold = Math.min(3, Math.max(1, Math.floor(Math.max(input.length, best.length) / 3)));
  return bestDistance <= threshold ? best : undefined;
}

/** The standard answer to a command name nothing declares: the typo itself, a nearby spelling
 *  when one is close enough to be worth guessing, and a pointer to the real list — never the
 *  full help screen, which is what an operator was presumably trying to avoid scanning by
 *  typing a command in the first place. */
export function reportUnknownCommand(name: string, candidates: string[]): void {
  reportError(`unknown command: ${name}`);
  const suggestion = closestCommand(name, candidates);
  if (suggestion !== undefined) info(`did you mean: ${suggestion}`);
  info("run ./clawforge help to list every command");
}

/** The deployment to use when the requested one is missing: the lone deployment under apps/,
 *  but only when nobody named one explicitly (--app or OC_APP); otherwise undefined. */
export function soleDeploymentFallback(explicit: boolean, available: readonly string[]): string | undefined {
  return !explicit && available.length === 1 ? available[0] : undefined;
}
