// Generic argv parsing driven by a command's own declared `arguments` (core/app.ts's
// CommandArgument) — the same list that already drives help text and the MCP schema
// (mcp-schema.ts's inputSchema/validate/toArgv) — so a flag the declaration knows and the
// CLI parser does not (or the reverse) stops being possible to write by hand.

import { die, UserError } from "#src/core/io/log.ts";
import type { CommandArgument } from "#src/core/app.ts";

/** Damerau-Levenshtein edit distance: a transposition of two adjacent characters (the most
 *  common way to mistype a name — "statsu" for "status") costs one edit, not the two a
 *  plain Levenshtein distance would charge it. */
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

/** The nearest candidate to a typed name, or undefined when nothing is close enough to be
 *  worth guessing at. The threshold scales with length so a couple of wrong letters in a
 *  long name still matches, while two short, unrelated names never suggest one another just
 *  for being short.
 *
 *  Lives here rather than in integration/gate.ts (its original home, for an unknown command
 *  name) because parseDeclaredArgs below needs the exact same match against a declared
 *  argument's name — one edit-distance implementation for both, not two that could drift.
 *  gate.ts re-exports this rather than keeping its own copy. */
export function closestCommand(input: string, candidates: readonly string[]): string | undefined {
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

/** Thrown for a token that matches no declared argument. A UserError, reported and exited
 *  the same way, but distinct so the dispatcher that knows the running command's name
 *  (entry/cli.ts) can point at that command's own --help — parseDeclaredArgs itself never
 *  learns the name it is parsing for. */
export class UnknownArgumentError extends UserError {
  name = "UnknownArgumentError";
}

function dieUnknownArgument(token: string, suggestion?: string): never {
  throw new UnknownArgumentError(
    suggestion === undefined ? `unknown argument: ${token}` : `unknown argument: ${token} (did you mean ${suggestion}?)`,
  );
}

/** An unknown sub-action word; an UnknownArgumentError so entry/cli.ts adds the --help pointer. */
export class UnknownActionError extends UnknownArgumentError {
  name = "UnknownActionError";
}

/** Refuses an unknown sub-action with `message` plus a did-you-mean guess from `choices`. */
export function dieUnknownAction(action: string, message: string, choices: readonly string[]): never {
  const suggestion = closestCommand(action, choices);
  throw new UnknownActionError(suggestion === undefined ? message : `${message} (did you mean ${suggestion}?)`);
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

/** Answers only the syntactic question every hand-written parser answered the same way:
 *  which declared argument does this token belong to, and does every token belong to one.
 *  Throws UnknownArgumentError as `unknown argument: <token>` on an undeclared flag/option
 *  (naming the nearest declared one when it is close enough to be worth guessing at), on
 *  `--flag=value` for a boolean flag (flags carry no value), and on a bare token with no
 *  positional or variadic slot left for it; dies as `--<name> needs a value` when an option
 *  is the last token in argv, with nothing after it to take as its value.
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
      if (argument === undefined) {
        const suggestion = flagToken.startsWith("--")
          ? closestCommand(flagToken.slice(2), [...named.keys()])
          : undefined;
        dieUnknownArgument(token, suggestion === undefined ? undefined : `--${suggestion}`);
      }
      if (argument.kind === "flag") {
        // A flag carries no value — "=value" on one is a mistake worth naming, not a
        // silently ignored suffix.
        if (inlineValue !== undefined) dieUnknownArgument(token);
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
    dieUnknownArgument(token);
  }

  return result;
}
