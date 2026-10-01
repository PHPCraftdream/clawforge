// Generic argv parsing driven by a command's own declared `arguments` (core/app.ts's
// CommandArgument) — the same list that already drives help text and the MCP schema
// (mcp-schema.ts's inputSchema/validate/toArgv) — so a flag the declaration knows and the
// CLI parser does not (or the reverse) stops being possible to write by hand.

import { die } from "#src/core/io/log.ts";
import type { AppCommand, CommandArgument } from "#src/core/app.ts";
import { closestCommand, dieUnknownArgument, UnknownArgumentError } from "#src/core/command/errors.ts";

/** Only for a multi-action command (backup): the action being parsed, and the full
 *  cross-action declaration to check an unrecognized flag against before giving up on it
 *  as wholly unknown — see CommandArgument's own `actions` field. */
export interface ActionScope {
  readonly action: string;
  readonly siblings: readonly CommandArgument[];
}

/** The `actions` entry — and the explicit action word — for backup's create: the default
 *  behaviour when no action word is typed, spelled so `backup create --dry-run` parses and
 *  "applies to `create`" names a word the CLI actually takes. */
export const NO_ACTION = "create";

function formatActions(actions: readonly string[]): string {
  return actions.map((name) => `\`${name}\``).join(", ");
}

/** One value per declared argument, keyed by its name (not its `--flag` spelling):
 *   flag        true once seen, otherwise absent
 *   option      the value once seen (from `--opt value` or `--opt=value`); otherwise absent
 *               — a value is never absent for an option that was seen at all, since running
 *               out of argv with nothing to take as the value dies in the parser itself
 *   positional  the token assigned to that slot, once one was; otherwise absent
 *   variadic    every remaining token from where it starts, in order; otherwise absent
 */
export type ParsedArgs = Record<string, string | boolean | string[] | undefined>;

/** Whether `token` is `--name` or `--name=...` for a flag/option this same declaration
 *  knows — the one shape an option's value must not swallow (see parseDeclaredArgs). */
function isDeclaredLongFlag(token: string, named: ReadonlyMap<string, CommandArgument>): boolean {
  if (!token.startsWith("--")) return false;
  const eq = token.indexOf("=");
  return named.has(eq === -1 ? token.slice(2) : token.slice(2, eq));
}

/** Syntactic parsing only: which declared argument each token belongs to, and whether every
 *  token belongs to one. Throws UnknownArgumentError on an undeclared flag/option (naming
 *  the nearest declared one, or — given `scope` — the other action it belongs to), on
 *  `--flag=value` for a boolean flag, and on a bare token with no positional/variadic slot
 *  left. Dies as `--<name> needs a value` when an option is the last token or the next one
 *  is itself a declared flag/option (so a missing value can't swallow the next real
 *  argument — `--opt=-x`'s inline form still takes anything literally), and on a repeated
 *  `--opt`. A bare `--` ends option parsing.
 *
 *  Does not enforce `required`, `choices`, or an option's value shape beyond the above —
 *  each command validates those itself against the values this returns. */
export function parseDeclaredArgs(declared: readonly CommandArgument[], argv: readonly string[], scope?: ActionScope): ParsedArgs {
  const named = new Map<string, CommandArgument>();
  const positionals: CommandArgument[] = [];
  let variadic: CommandArgument | undefined;
  for (const argument of declared) {
    if (argument.kind === "positional") positionals.push(argument);
    else if (argument.kind === "variadic") variadic = argument;
    else named.set(argument.name, argument);
  }

  // True once a bare `--` was seen: every remaining token is positional/variadic, even one
  // that looks like a flag.
  let optionsEnded = false;
  const result: ParsedArgs = {};
  let filled = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && token.startsWith("-")) {
      // --opt=value is split before lookup so --app=name (long understood at the gate)
      // and every other declared option read the same syntax consistently.
      let flagToken = token;
      let inlineValue: string | undefined;
      if (token.startsWith("--")) {
        const eq = token.indexOf("=");
        if (eq !== -1) {
          flagToken = token.slice(0, eq);
          inlineValue = token.slice(eq + 1);
        }
      }
      const argument = flagToken.startsWith("--") ? named.get(flagToken.slice(2)) : undefined;
      if (argument === undefined) {
        const key = flagToken.startsWith("--") ? flagToken.slice(2) : undefined;
        if (key !== undefined && scope !== undefined) {
          const sibling = scope.siblings.find((candidate) => candidate.name === key);
          if (sibling?.actions !== undefined && !sibling.actions.includes(scope.action)) {
            throw new UnknownArgumentError(`--${key} applies to ${formatActions(sibling.actions)}, not \`${scope.action}\``);
          }
        }
        const suggestion = key === undefined ? undefined : closestCommand(key, [...named.keys()]);
        dieUnknownArgument(token, suggestion === undefined ? undefined : `--${suggestion}`);
      }
      if (argument.kind === "flag") {
        // A flag carries no value — "=value" on one is a mistake worth naming, not a
        // silently ignored suffix.
        if (inlineValue !== undefined) die(`--${argument.name} is a flag and takes no value`);
        result[argument.name] = true;
        continue;
      }
      if (result[argument.name] !== undefined) die(`--${argument.name} given more than once`);
      if (inlineValue !== undefined) {
        result[argument.name] = inlineValue;
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || isDeclaredLongFlag(value, named)) die(`--${argument.name} needs a value`);
      result[argument.name] = value;
      index += 1;
      continue;
    }

    if (filled < positionals.length) {
      result[positionals[filled].name] = token;
      filled += 1;
      continue;
    }
    if (variadic !== undefined) {
      const list = result[variadic.name] as string[] | undefined;
      if (list === undefined) result[variadic.name] = [token];
      else list.push(token);
      continue;
    }
    dieUnknownArgument(token);
  }

  return result;
}

/** Whether a `preparesEnvironment` command's preparation (writing .env, generating the token)
 *  should run for `args`: false for a read-only call (readOnlyWhen, e.g. `bootstrap --check`).
 *  Argv the command's parser refuses throws here, before anything is written, so an invalid
 *  flag is reported as such and creates nothing. */
export function preparesEnvironmentFor(command: AppCommand, args: readonly string[]): boolean {
  if (command.preparesEnvironment !== true) return false;
  if (command.readOnlyWhen?.([...args]) === true) return false;
  parseDeclaredArgs(command.arguments ?? [], args);
  return true;
}
