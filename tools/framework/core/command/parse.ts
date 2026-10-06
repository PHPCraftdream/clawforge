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
import type { ArgumentRule, ArgumentSpec, ParsedCall, ValueSpec } from "#src/core/command/spec.ts";
import { scopeByAction } from "#src/core/command/view.ts";
import { ValueError } from "#src/core/values/value.ts";

/** Only for a multi-action command (backup): the action being parsed, and the full
 *  cross-action declaration to check an unrecognized flag against before giving up on it
 *  as wholly unknown — see CommandArgument's own `actions` field. */
interface ActionScope {
  readonly action: string;
  readonly siblings: readonly CommandArgument[];
}

/** Whether the tokenizer reads a word (before a bare `--`) as a flag or option rather than a
 *  free word — the one rule, for whoever emits argv the tokenizer will read back. */
export function bindsAsFlag(token: string): boolean {
  return token.startsWith("-");
}

/** The refusals the parser prints; checks assert them by name. */
export const APPLIES_TO = "applies to";

export function missingArgumentMessage(prefix: string, label: string): string {
  return `${prefix} needs ${label}`;
}

/** The one voice for a missing required argument: bind's refusal, word for word — the
 *  parser throws it and the MCP validate routes through it, so a tool call reads the
 *  console's own text instead of a second wording of the same refusal. */
export function requiredArgumentRefusal(argument: ArgumentSpec, command?: string): string {
  const label = argument.kind === "option" ? `--${argument.name} <${argument.valueName ?? "value"}>`
    : argument.kind === "variadic" ? `<${argument.name}…>`
    : argument.kind === "flag" ? `--${argument.name}`
    : `<${argument.name}>`;
  return command === undefined || command === "" ? `${label} is required` : missingArgumentMessage(command, label);
}

/** One argument's label in a rule's text: `--name`, `<name>`, `<name…>`. */
function ruleLabel(declared: ReadonlyMap<string, ArgumentSpec>, name: string): string {
  const argument = declared.get(name);
  if (argument === undefined || argument.kind === "flag" || argument.kind === "option") return `--${name}`;
  return argument.kind === "variadic" ? `<${name}…>` : `<${name}>`;
}

function groupClause(declared: ReadonlyMap<string, ArgumentSpec>, group: readonly string[]): string {
  return group.map((name) => ruleLabel(declared, name)).join(" and ");
}

function groupsClause(declared: ReadonlyMap<string, ArgumentSpec>, groups: readonly (readonly string[])[]): string {
  return groups.map((group) => groupClause(declared, group)).join(" or ");
}

/** The one voice a rule is refused and printed in: the parser's messages on error, the same
 *  clauses without the verb for `--help` (help-render adds its own prefix and marker). */
export function ruleText(
  rule: ArgumentRule,
  declared: readonly ArgumentSpec[],
  context: BindContext = {},
  options: { mode?: "error" | "help"; case?: "mix" | "incomplete" | "empty"; incomplete?: readonly string[] } = {},
): string {
  const byName = new Map(declared.map((argument) => [argument.name, argument]));
  const prefix = [context.command, context.action].filter((part) => part !== undefined && part !== "").join(" ");
  const lead = prefix === "" ? "" : `${prefix} `;
  const withReason = (text: string): string =>
    options.mode !== "help" && rule.reason !== undefined ? `${text} — ${rule.reason}` : text;
  if (rule.rule === "requires") {
    const list = rule.with.map((name) => ruleLabel(byName, name));
    // any-of reads as a choice ("A, B or C"); the default stays the conjunction ("A and B").
    const clause = rule.any === true
      ? (list.length <= 2 ? list.join(" or ") : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`)
      : groupClause(byName, rule.with);
    return withReason(`${ruleLabel(byName, rule.name)} requires ${clause}`);
  }
  if (rule.rule === "conflicts") return withReason(`${ruleLabel(byName, rule.name)} cannot be combined with ${groupClause(byName, options.incomplete ?? rule.with)}`);
  if (options.mode === "help") return groupsClause(byName, rule.groups);
  if (options.case === "mix") return withReason(`${lead}takes ${groupsClause(byName, rule.groups)}, not both`);
  if (options.case === "incomplete") {
    const group = options.incomplete ?? [];
    return withReason(`${lead}needs ${group.length === 2 ? "both " : ""}${groupClause(byName, group)}`);
  }
  return withReason(`${lead}needs ${groupsClause(byName, rule.groups)}`);
}

/** Whether the declared argument is present in the bound values. */
function isGiven(argument: ArgumentSpec | undefined, values: Record<string, unknown>): boolean {
  if (argument === undefined) return false;
  if (argument.kind === "flag") return values[argument.name] === true;
  if (argument.kind === "variadic") return (values[argument.name] as string[]).length > 0;
  return values[argument.name] !== undefined;
}

/** The declaration's cross-field rules against the bound values, in declaration order: the
 *  first violation refuses. Runs after `bind`, so a value error or a missing required
 *  argument is still the first refusal. */
export function enforceRules(
  declared: readonly ArgumentSpec[],
  rules: readonly ArgumentRule[] | undefined,
  values: Record<string, unknown>,
  context: BindContext = {},
): void {
  if (rules === undefined) return;
  const byName = new Map(declared.map((argument) => [argument.name, argument]));
  for (const rule of rules) {
    if (rule.rule === "requires") {
      if (!isGiven(byName.get(rule.name), values)) continue;
      const given = rule.with.map((name) => isGiven(byName.get(name), values));
      const satisfied = rule.any === true ? given.some((entry) => entry) : given.every((entry) => entry);
      if (!satisfied) {
        throw new ArgumentError(ruleText(rule, declared, context), rule.name);
      }
      continue;
    }
    if (rule.rule === "conflicts") {
      if (!isGiven(byName.get(rule.name), values)) continue;
      const other = rule.with.find((name) => isGiven(byName.get(name), values));
      if (other !== undefined) {
        throw new ArgumentError(ruleText(rule, declared, context, { case: "mix", incomplete: [other] }), rule.name);
      }
      continue;
    }
    const touched = rule.groups.filter((group) => group.some((name) => isGiven(byName.get(name), values)));
    if (touched.length > 1) {
      throw new ArgumentError(ruleText(rule, declared, context, { case: "mix" }), touched[1].find((name) => isGiven(byName.get(name), values))!);
    }
    if (touched.length === 1) {
      const group = touched[0];
      if (!group.every((name) => isGiven(byName.get(name), values))) {
        throw new ArgumentError(ruleText(rule, declared, context, { case: "incomplete", incomplete: group }), group.find((name) => !isGiven(byName.get(name), values))!);
      }
      continue;
    }
    if (rule.required === true) {
      throw new ArgumentError(ruleText(rule, declared, context, { case: "empty" }), rule.groups[0][0]);
    }
  }
}

/** The one voice for an argument another action owns: the parser refuses the dashed token
 *  it saw, the MCP validate the JSON property — the same sentence, each surface's own
 *  spelling of the argument. */
export function appliesToMessage(name: string, actions: readonly string[], action: string): string {
  return `${name} ${APPLIES_TO} ${formatActions(actions)}, not \`${action}\``;
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
  /** True once a bare `--` ended the options (a `--` an option swallowed as its value is not one). */
  readonly optionsEnded: boolean;
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
 *  `refuse` (a declaration's own refusals): a token the tokenizer reads as an argument or a
 *  word — never one it bound as an option's value or took into a verbatim tail — that matches
 *  a key is refused with that reason, ahead of any unknown-argument refusal for it.
 *
 *  Does not enforce `required`, `choices`, or an option's value shape beyond the above —
 *  `bind` does. */
export function tokenize(
  declared: readonly CommandArgument[],
  argv: readonly string[],
  scope?: ActionScope,
  verbatimTail = false,
  refuse?: Readonly<Record<string, string>>,
): Tokens {
  return scan(declared, argv, scope, verbatimTail, refuse, false);
}

/** What a lenient scan knows: the tokens read, and the option left waiting for its value
 *  when argv ended on it. */
export interface Scanned extends Tokens {
  readonly pending?: CommandArgument;
}

/** tokenize for a partly typed line (completion): the same reading, but a token the parser
 *  would refuse is skipped instead of thrown, and an option takes the next word as its value
 *  even when it is a declared flag — so what a bare `--`, a verbatim tail or an unfinished
 *  option means is the tokenizer's own answer, whatever else on the line is wrong. */
export function tokenizeLenient(declared: readonly CommandArgument[], argv: readonly string[], verbatimTail = false): Scanned {
  return scan(declared, argv, undefined, verbatimTail, undefined, true);
}

function scan(
  declared: readonly CommandArgument[],
  argv: readonly string[],
  scope: ActionScope | undefined,
  verbatimTail: boolean,
  refuse: Readonly<Record<string, string>> | undefined,
  lenient: boolean,
): Scanned {
  let pending: CommandArgument | undefined;
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

    if (!optionsEnded) refuseToken(refuse, token);

    if (!optionsEnded && bindsAsFlag(token)) {
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
        if (lenient) continue;
        const key = flagToken.startsWith("--") ? flagToken.slice(2) : undefined;
        if (key !== undefined && scope !== undefined) {
          const sibling = scope.siblings.find((candidate) => candidate.name === key);
          if (sibling?.actions !== undefined && !sibling.actions.includes(scope.action)) {
            throw new UnknownArgumentError(appliesToMessage(`--${key}`, sibling.actions, scope.action), key);
          }
        }
        const suggestion = key === undefined ? undefined : closestCommand(key, [...named.keys()]);
        dieUnknownArgument(token, suggestion === undefined ? undefined : `--${suggestion}`);
      }
      given.push(argument.name);
      if (argument.kind === "flag") {
        // A flag carries no value — "=value" on one is a mistake worth naming, not a
        // silently ignored suffix.
        if (inlineValue !== undefined) {
          if (lenient) continue;
          throw new ArgumentError(`--${argument.name} is a flag and takes no value`, argument.name);
        }
        entries.push({ argument, value: true });
        continue;
      }
      if (seenOptions.has(argument.name) && !lenient) throw new ArgumentError(`--${argument.name} given more than once`, argument.name);
      seenOptions.add(argument.name);
      if (inlineValue !== undefined) {
        entries.push({ argument, value: inlineValue });
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined && lenient) {
        pending = argument;
        continue;
      }
      if (value === undefined || (!lenient && isDeclaredLongFlag(value, named))) throw new ArgumentError(`--${argument.name} needs a value`, argument.name);
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
    if (lenient) continue;
    dieUnknownArgument(token);
  }

  return { entries, given, optionsEnded, ...(pending === undefined ? {} : { pending }) };
}

/** The record parseDeclaredArgs returns: a flag is true once seen, a variadic its tokens,
 *  a value with a declared `parse` its parsed value. */
function toParsedArgs(entries: readonly TokenEntry[]): ParsedArgs {
  const result: ParsedArgs = {};
  for (const { argument, value } of entries) {
    if (argument.kind === "variadic") {
      const list = result[argument.name] as string[] | undefined;
      if (list === undefined) result[argument.name] = [value as string];
      else list.push(value as string);
    } else if (argument.kind !== "flag" && argument.parse !== undefined) {
      result[argument.name] = convert(argument as ValueSpec<"option">, value as string) as string;
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

/** The refusal of a value outside a declared `choices` list, in the parser's voice — shared
 *  with the MCP validate of gate commands (integration/mcp/call.ts), which refuses the same
 *  wrong value so both surfaces word the refusal alike. */
export function choicesRefusal(argument: ArgumentSpec, choices: readonly string[], value: string): string {
  return `${labelOf(argument)} takes one of ${choices.join(", ")}, not "${value}"`;
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
    throw new ArgumentError(choicesRefusal(argument, argument.choices, raw), argument.name);
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
  for (const argument of declared) {
    if (argument.kind !== "variadic" || argument.count === undefined) continue;
    const taken = (values[argument.name] as string[]).length;
    // An empty variadic is "not given" — its absence is a rule's or a required argument's
    // to refuse, not the count's.
    if (taken > 0 && taken !== argument.count) {
      throw new ArgumentError(`<${argument.name}…> takes exactly ${argument.count} values, not ${taken}`, argument.name);
    }
  }
  const prefix = [context.command, context.action].filter((part) => part !== undefined && part !== "").join(" ");
  for (const argument of declared) {
    if (argument.kind === "flag" || argument.required !== true) continue;
    const absent = argument.kind === "variadic" ? (values[argument.name] as string[]).length === 0 : values[argument.name] === undefined;
    if (!absent) continue;
    throw new ArgumentError(requiredArgumentRefusal(argument, prefix), argument.name);
  }
  return values;
}

/** Whether the declared variadic is a pass-through one (`verbatim: true`). */
export function isVerbatim(declared: readonly ArgumentSpec[]): boolean {
  return declared.some((argument) => argument.kind === "variadic" && argument.verbatim === true);
}

/** The parse-relevant part of a command: its arguments, or per-action arguments. */
export interface CallShape {
  readonly arguments?: readonly ArgumentSpec[];
  readonly refuse?: Readonly<Record<string, string>>;
  readonly rules?: readonly ArgumentRule[];
  readonly actions?: Readonly<Record<string, { readonly arguments?: readonly ArgumentSpec[]; readonly refuse?: Readonly<Record<string, string>>; readonly rules?: readonly ArgumentRule[] }>>;
  readonly defaultAction?: string;
}

/** An exact token the declaration refuses with its own reason: an ArgumentError naming the
 *  token without its leading dashes. A refused `--flag` also covers its inline spelling
 *  `--flag=...`. Called by tokenize on the tokens it reads, so a value is never refused. */
function refuseToken(refuse: Readonly<Record<string, string>> | undefined, token: string): void {
  if (refuse === undefined) return;
  const eq = token.indexOf("=");
  const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
  if (Object.hasOwn(refuse, name)) throw new ArgumentError(refuse[name], name.replace(/^-+/, ""));
}

/** argv → ParsedCall. With `actions`, `argv[0]` naming an action picks it; no word (or one
 *  starting with `-`) takes `defaultAction` with the whole argv, and without one is refused;
 *  any other word is an unknown action. A flag that another action declares is refused as
 *  belonging to it. */
export function parseCall(shape: CallShape, argv: readonly string[], command = ""): ParsedCall<Record<string, unknown>> {
  if (shape.actions === undefined) {
    const declared = shape.arguments ?? [];
    const tokens = tokenize(declared, argv, undefined, isVerbatim(declared), shape.refuse);
    const values = bind(declared, tokens, { command });
    enforceRules(declared, shape.rules, values, { command });
    return { values, given: tokens.given };
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
  const siblings = scopeByAction(Object.fromEntries(names.map((name) => [name, actions[name].arguments ?? []])));
  const tokens = tokenize(declared, rest, { action, siblings }, isVerbatim(declared), actions[action].refuse);
  const values = bind(declared, tokens, { command, action });
  enforceRules(declared, actions[action].rules, values, { command, action });
  return { values, action, given: tokens.given };
}
