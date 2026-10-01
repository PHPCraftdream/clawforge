// Generic argv parsing driven by a command's own declared `arguments` (core/app.ts's
// CommandArgument) — the same list that already drives help text and the MCP schema
// (mcp-schema.ts's inputSchema/validate/toArgv) — so a flag the declaration knows and the
// CLI parser does not (or the reverse) stops being possible to write by hand.

import { die, UserError } from "#src/core/io/log.ts";
import type { AppCommand, CommandArgument } from "#src/core/app.ts";

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
 *  long name still matches, while two short unrelated names never suggest each other.
 *  Lives here (not integration/gate.ts, its original home) because parseDeclaredArgs below
 *  needs the exact same match against a declared argument's name; gate.ts re-exports this. */
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

/** Thrown for a token matching no declared argument — a UserError, but distinct so the
 *  dispatcher (entry/cli.ts) can point at that command's own --help. */
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

/** Human label for an `actions` entry. */
export function actionLabel(action: string): string {
  return action;
}

function formatActions(actions: readonly string[]): string {
  return actions.map((name) => `\`${actionLabel(name)}\``).join(", ");
}

/** One multi-action command's flags/options from what each action's own parser accepts:
 *  `actions` is derived (absent when every action takes it), so completion, --help and the MCP
 *  schema cannot offer a flag the chosen action rejects. First declaration of a name wins;
 *  slices must not set `actions` themselves. Positionals/variadics are not scoped, so skipped.
 *  When the slices describe one name differently (set's `--name`: the set for build/validate,
 *  the object for forget), the descriptions are composed with their own action lists instead
 *  of the first one silently standing for every action (R31-03). */
export function scopeByAction(slices: Readonly<Record<string, readonly CommandArgument[]>>): CommandArgument[] {
  const all = Object.keys(slices);
  const merged = new Map<string, { argument: CommandArgument; byDescription: Map<string, string[]>; actions: string[] }>();
  for (const action of all) {
    for (const argument of slices[action]) {
      if (argument.kind !== "flag" && argument.kind !== "option") continue;
      let entry = merged.get(argument.name);
      if (entry === undefined) merged.set(argument.name, entry = { argument, byDescription: new Map(), actions: [] });
      if (!entry.actions.includes(action)) entry.actions.push(action);
      const actions = entry.byDescription.get(argument.description) ?? [];
      if (!actions.includes(action)) actions.push(action);
      entry.byDescription.set(argument.description, actions);
    }
  }
  return [...merged.values()].map(({ argument, byDescription, actions }) => ({
    ...argument,
    ...(byDescription.size > 1
      ? {
        description: [...byDescription.entries()]
          .map(([description, own]) => `${description} (${own.map(actionLabel).join(", ")})`)
          .join("; "),
      }
      : {}),
    ...(actions.length === all.length ? {} : { actions }),
  }));
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
