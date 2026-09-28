// Generic argv parsing driven by a command's own declared `arguments` (core/app.ts's
// CommandArgument) — the same list that already drives help text and the MCP schema
// (mcp-schema.ts's inputSchema/validate/toArgv) — so a flag the declaration knows and the
// CLI parser does not (or the reverse) stops being possible to write by hand.

import { die } from "#src/core/io/log.ts";
import type { CommandArgument } from "#src/core/app.ts";

/** One value per declared argument, keyed by its name (not its `--flag` spelling):
 *   flag        true once seen, otherwise absent
 *   option      the value once seen (from `--opt value` or `--opt=value`); otherwise absent
 *               — a value is never absent for an option that was seen at all, since running
 *               out of argv with nothing to take as the value dies in the parser itself
 *   positional  the token assigned to that slot, once one was; otherwise absent
 *   variadic    every remaining token from where it starts, in order; otherwise absent
 */
export type ParsedArgs = Record<string, string | boolean | string[] | undefined>;

/** Answers only the syntactic question every hand-written parser answered the same way:
 *  which declared argument does this token belong to, and does every token belong to one.
 *  Dies as `unknown argument: <token>` on an undeclared flag/option, on `--flag=value` for
 *  a boolean flag (flags carry no value), and on a bare token with no positional or
 *  variadic slot left for it; dies as `--<name> needs a value` when an option is the last
 *  token in argv, with nothing after it to take as its value.
 *
 *  Deliberately does not enforce `required`, `choices`, or an option's value shape beyond
 *  "some value must follow" (a number, a regex, an enum, "must not look like another
 *  flag") — every command already validates those itself, in its own words, and keeps
 *  doing so against the values this returns. Some options already relied on taking
 *  literally whatever token follows, flag-shaped or not (an artifact path, a store name);
 *  this preserves that by never rejecting a `--opt value` value on the strength of its
 *  shape — only `--opt=value`'s inline form is unambiguous enough to always take. */
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
      if (argument === undefined) die(`unknown argument: ${token}`);
      if (argument.kind === "flag") {
        // A flag carries no value — "=value" on one is a mistake worth naming, not a
        // silently ignored suffix.
        if (inlineValue !== undefined) die(`unknown argument: ${token}`);
        result[argument.name] = true;
        continue;
      }
      if (inlineValue !== undefined) {
        result[argument.name] = inlineValue;
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined) die(`--${argument.name} needs a value`);
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
    die(`unknown argument: ${token}`);
  }

  return result;
}
