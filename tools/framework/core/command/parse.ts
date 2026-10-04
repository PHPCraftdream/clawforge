// Argv parsing driven by a command's own declared `arguments` (core/app.ts's CommandArgument)
// — the same list that already drives help text and the MCP schema (mcp/schema.ts's
// inputSchema, mcp/call.ts's validate/toArgv) — so a flag the declaration knows and the
// CLI parser does not (or the reverse) stops being possible to write by hand.
//
// tokenize reads tokens, bind turns them into typed values, parseCall adds the action word;
// parseDeclaredArgs is the syntactic wrapper the hand-written parsers still call.

import type { CommandArgument } from "#src/core/app.ts";
import {
  ArgumentError, closestCommand, dieUnknownAction, dieUnknownArgument, UnknownActionError, UnknownArgumentError,
} from "#src/core/command/errors.ts";
import type { ArgumentSpec, ParsedCall, ValueSpec } from "#src/core/command/spec.ts";
import { scopeByAction } from "#src/core/command/view.ts";
import { ValueError } from "#src/core/values/value.ts";

/** Only for a multi-action command (backup): the action being parsed, and the full
 *  cross-action declaration to check an unrecognized flag against before giving up on it
 *  as wholly unknown — see CommandArgument's own `actions` field. */
interface ActionScope {
  readonly action: string;
  readonly siblings: readonly CommandArgument[];
}

/** The `actions` entry — and the explicit action word — for backup's create: the default
 *  behaviour when no action word is typed, spelled so `backup create --dry-run` parses and
 *  "applies to `create`" names a word the CLI actually takes. */
export const NO_ACTION = "create";

/** The refusals the parser prints; checks assert them by name. */
export const APPLIES_TO = "applies to";

export function missingArgumentMessage(prefix: string, label: string): string {
  return `${prefix} needs ${label}`;
}

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
 *  knows — the one shape an option's value must not swallow (see tokenize). */
function isDeclaredLongFlag(token: string, named: ReadonlyMap<string, CommandArgument>): boolean {
  if (!token.startsWith("--")) return false;
  const eq = token.indexOf("=");
  return named.has(eq === -1 ? token.slice(2) : token.slice(2, eq));
}

/** One token read against a declaration: the argument it belongs to and its text (`true` for a flag). */
export interface TokenEntry {
  readonly argument: CommandArgument;
  readonly value: string | true;
}

export interface Tokens {
  /** Every entry in typing order; a variadic contributes one entry per token. */
  readonly entries: readonly TokenEntry[];
  /** Flags and options, every occurrence, in typing order. */
  readonly given: readonly string[];
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
 *  `verbatimTail` (a declared variadic): the first token that is no declared flag/option and
 *  fills no free positional slot starts the variadic, and everything after it is literal.
 *
 *  Does not enforce `required`, `choices`, or an option's value shape beyond the above —
 *  `bind` does. */
export function tokenize(declared: readonly CommandArgument[], argv: readonly string[], scope?: ActionScope, verbatimTail = false): Tokens {
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
  // True once the variadic has started in verbatim mode: the rest is its, whatever it looks like.
  let tail = false;
  const entries: TokenEntry[] = [];
  const given: string[] = [];
  const seenOptions = new Set<string>();
  let filled = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (tail && variadic !== undefined) {
      entries.push({ argument: variadic, value: token });
      continue;
    }

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
        if (verbatimTail && variadic !== undefined) {
          tail = true;
          entries.push({ argument: variadic, value: token });
          continue;
        }
        const key = flagToken.startsWith("--") ? flagToken.slice(2) : undefined;
        if (key !== undefined && scope !== undefined) {
          const sibling = scope.siblings.find((candidate) => candidate.name === key);
          if (sibling?.actions !== undefined && !sibling.actions.includes(scope.action)) {
            throw new UnknownArgumentError(`--${key} ${APPLIES_TO} ${formatActions(sibling.actions)}, not \`${scope.action}\``, key);
          }
        }
        const suggestion = key === undefined ? undefined : closestCommand(key, [...named.keys()]);
        dieUnknownArgument(token, suggestion === undefined ? undefined : `--${suggestion}`);
      }
      given.push(argument.name);
      if (argument.kind === "flag") {
        // A flag carries no value — "=value" on one is a mistake worth naming, not a
        // silently ignored suffix.
        if (inlineValue !== undefined) throw new ArgumentError(`--${argument.name} is a flag and takes no value`, argument.name);
        entries.push({ argument, value: true });
        continue;
      }
      if (seenOptions.has(argument.name)) throw new ArgumentError(`--${argument.name} given more than once`, argument.name);
      seenOptions.add(argument.name);
      if (inlineValue !== undefined) {
        entries.push({ argument, value: inlineValue });
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || isDeclaredLongFlag(value, named)) throw new ArgumentError(`--${argument.name} needs a value`, argument.name);
      entries.push({ argument, value });
      index += 1;
      continue;
    }

    if (filled < positionals.length) {
      entries.push({ argument: positionals[filled], value: token });
      filled += 1;
      continue;
    }
    if (variadic !== undefined) {
      if (verbatimTail) tail = true;
      entries.push({ argument: variadic, value: token });
      continue;
    }
    dieUnknownArgument(token);
  }

  return { entries, given };
}

/** The record parseDeclaredArgs returns: a flag is true once seen, a variadic its tokens. */
function toParsedArgs(entries: readonly TokenEntry[]): ParsedArgs {
  const result: ParsedArgs = {};
  for (const { argument, value } of entries) {
    if (argument.kind === "variadic") {
      const list = result[argument.name] as string[] | undefined;
      if (list === undefined) result[argument.name] = [value as string];
      else list.push(value as string);
    } else result[argument.name] = value;
  }
  return result;
}

/** Syntactic parsing against `declared` — see `tokenize`; `required`, `choices` and value
 *  shapes stay with each command, against the record this returns. */
export function parseDeclaredArgs(declared: readonly CommandArgument[], argv: readonly string[], scope?: ActionScope): ParsedArgs {
  return toParsedArgs(tokenize(declared, argv, scope).entries);
}

function labelOf(argument: ArgumentSpec): string {
  return argument.kind === "positional" ? `<${argument.name}>` : `--${argument.name}`;
}

function joinClause(label: string, clause: string): string {
  return clause.startsWith(":") ? `${label}${clause}` : `${label} ${clause}`;
}

/** One typed value from its text: empty without a parser is refused, `choices` is a closed
 *  list, `parse` has the last word and its ValueError becomes an ArgumentError. */
function convert(argument: ValueSpec<"option"> | ValueSpec<"positional">, raw: string): unknown {
  const label = labelOf(argument);
  if (argument.parse !== undefined) {
    try {
      return argument.parse.parse(raw);
    } catch (error) {
      if (error instanceof ValueError) throw new ArgumentError(joinClause(label, error.clause), argument.name);
      throw error;
    }
  }
  if (raw === "") throw new ArgumentError(`${label} needs a value`, argument.name);
  if (argument.choices !== undefined && !argument.choices.includes(raw)) {
    throw new ArgumentError(`${label} takes one of ${argument.choices.join(", ")}, not "${raw}"`, argument.name);
  }
  return raw;
}

export interface BindContext {
  /** Names the call in a missing-argument refusal: `set forget needs --kind <kind>`. */
  readonly command?: string;
  readonly action?: string;
}

/** Typed values from tokens: the given values in typing order (so the first bad one is the
 *  one reported), then the missing required arguments in declaration order. A flag is false
 *  and a variadic [] when absent. */
export function bind(declared: readonly ArgumentSpec[], tokens: Tokens, context: BindContext = {}): Record<string, unknown> {
  const byName = new Map(declared.map((argument) => [argument.name, argument]));
  const values: Record<string, unknown> = {};
  for (const argument of declared) {
    if (argument.kind === "flag") values[argument.name] = false;
    else if (argument.kind === "variadic") values[argument.name] = [];
  }
  for (const { argument: token, value } of tokens.entries) {
    const argument = byName.get(token.name)!;
    if (argument.kind === "flag") values[argument.name] = true;
    else if (argument.kind === "variadic") (values[argument.name] as string[]).push(value as string);
    else values[argument.name] = convert(argument, value as string);
  }
  const prefix = [context.command, context.action].filter((part) => part !== undefined && part !== "").join(" ");
  for (const argument of declared) {
    if (argument.kind === "flag" || argument.required !== true) continue;
    const absent = argument.kind === "variadic" ? (values[argument.name] as string[]).length === 0 : values[argument.name] === undefined;
    if (!absent) continue;
    const label = argument.kind === "option" ? `--${argument.name} <${argument.valueName ?? "value"}>`
      : argument.kind === "variadic" ? `<${argument.name}…>` : `<${argument.name}>`;
    throw new ArgumentError(prefix === "" ? `${label} is required` : missingArgumentMessage(prefix, label), argument.name);
  }
  return values;
}

/** Whether the declared variadic is a pass-through one (`verbatim: true`). */
function isVerbatim(declared: readonly ArgumentSpec[]): boolean {
  return declared.some((argument) => argument.kind === "variadic" && argument.verbatim === true);
}

/** The parse-relevant part of a command: its arguments, or per-action arguments. */
export interface CallShape {
  readonly arguments?: readonly ArgumentSpec[];
  readonly refuse?: Readonly<Record<string, string>>;
  readonly actions?: Readonly<Record<string, { readonly arguments?: readonly ArgumentSpec[]; readonly refuse?: Readonly<Record<string, string>> }>>;
  readonly defaultAction?: string;
}

/** An exact token (before a bare `--`) the declaration refuses with its own reason: an
 *  ArgumentError naming the token without its leading dashes. */
function refuseTokens(refuse: Readonly<Record<string, string>> | undefined, argv: readonly string[]): void {
  if (refuse === undefined) return;
  for (const token of argv) {
    if (token === "--") return;
    if (Object.hasOwn(refuse, token)) throw new ArgumentError(refuse[token], token.replace(/^-+/, ""));
  }
}

/** argv → ParsedCall. With `actions`, `argv[0]` naming an action picks it; no word (or one
 *  starting with `-`) takes `defaultAction` with the whole argv, and without one is refused;
 *  any other word is an unknown action. A flag that another action declares is refused as
 *  belonging to it. */
export function parseCall(shape: CallShape, argv: readonly string[], command = ""): ParsedCall<Record<string, unknown>> {
  if (shape.actions === undefined) {
    const declared = shape.arguments ?? [];
    refuseTokens(shape.refuse, argv);
    const tokens = tokenize(declared, argv, undefined, isVerbatim(declared));
    return { values: bind(declared, tokens, { command }), given: tokens.given };
  }
  const actions = shape.actions;
  const names = Object.keys(actions);
  const first = argv[0];
  let action: string;
  let rest: readonly string[];
  if (first !== undefined && !first.startsWith("-")) {
    if (!names.includes(first)) dieUnknownAction(first, `unknown action: ${first} (expected ${names.join(", ")})`, names, "action");
    action = first;
    rest = argv.slice(1);
  } else if (shape.defaultAction !== undefined) {
    action = shape.defaultAction;
    rest = argv;
  } else {
    throw new UnknownActionError(`${command === "" ? "" : `${command} `}needs an action: ${names.join(", ")}`, "action");
  }
  const declared = actions[action].arguments ?? [];
  refuseTokens(actions[action].refuse, rest);
  const siblings = scopeByAction(Object.fromEntries(names.map((name) => [name, actions[name].arguments ?? []])));
  const tokens = tokenize(declared, rest, { action, siblings }, isVerbatim(declared));
  return { values: bind(declared, tokens, { command, action }), action, given: tokens.given };
}
