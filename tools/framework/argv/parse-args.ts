// Generic argv parsing driven by a command's own declared `arguments` (core/app.ts's
// CommandArgument) — the same list that already drives help text and the MCP schema
// (mcp-schema.ts's inputSchema/validate/toArgv) — so a flag the declaration knows and the
// CLI parser does not (or the reverse) stops being possible to write by hand.

import { die } from "#src/core/log.ts";
import type { CommandArgument } from "#src/core/app.ts";

/** One value per declared argument, keyed by its name (not its `--flag` spelling):
 *   flag        true once seen, otherwise absent
 *   option      the next argv token verbatim once seen; "" if seen with nothing usable
 *               after it; otherwise absent — the three states a required/shaped option
 *               already had to tell apart ("not given" vs "given, no value" vs "given: x")
 *   positional  the token assigned to that slot, once one was; otherwise absent
 *   variadic    every remaining token from where it starts, in order; otherwise absent
 */
export type ParsedArgs = Record<string, string | boolean | string[] | undefined>;

/** Answers only the syntactic question every hand-written parser answered the same way:
 *  which declared argument does this token belong to, and does every token belong to one.
 *  Dies as `unknown argument: <token>` on an undeclared flag/option and on a bare token
 *  with no positional or variadic slot left for it.
 *
 *  Deliberately does not enforce `required`, `choices`, or an option's value shape (a
 *  number, a regex, an enum, "must not look like another flag") — every command already
 *  validates those itself, in its own words, and keeps doing so against the values this
 *  returns. Some options already relied on taking literally whatever token follows, flag-
 *  shaped or not (an artifact path, a store name); this preserves that by never rejecting
 *  a value on the strength of its shape. */
export function parseDeclaredArgs(declared: readonly CommandArgument[], argv: readonly string[]): ParsedArgs {
  const named = new Map<string, CommandArgument>();
  const positionals: CommandArgument[] = [];
  let variadic: CommandArgument | undefined;
  for (const argument of declared) {
    if (argument.kind === "positional") positionals.push(argument);
    else if (argument.kind === "variadic") variadic = argument;
    else named.set(argument.name, argument);
  }

  const result: ParsedArgs = {};
  let filled = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token.startsWith("-")) {
      const argument = token.startsWith("--") ? named.get(token.slice(2)) : undefined;
      if (argument === undefined) die(`unknown argument: ${token}`);
      if (argument.kind === "flag") {
        result[argument.name] = true;
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined) {
        result[argument.name] = "";
        continue;
      }
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
    if (positionals.length > 0) {
      // No variadic, and every slot already has a value: the newest bare token replaces
      // the last one, the same way every existing single-positional parser let a repeated
      // bare argument silently overwrite the one before it rather than refusing the run.
      result[positionals[positionals.length - 1].name] = token;
      continue;
    }
    die(`unknown argument: ${token}`);
  }

  return result;
}
