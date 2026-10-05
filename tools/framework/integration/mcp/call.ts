// Call-side transforms for the MCP control server: tool-argument validation, argv
// construction, the structured-output envelope and its masking. Split out of schema.ts, which
// keeps the tool description and input schema; server.ts re-exports both modules.

import { maskSecrets } from "../../core/io/log.ts";
import { effectProfile, specOf, specShape, tokenize } from "../../core/command/index.ts";
import { ConfirmationRequiredError } from "../../core/command/errors.ts";
import type { CallFacts } from "../../core/command/effect.ts";
import type { Advice, CommandAdvice } from "../../core/io/invocation/advice.ts";
import type { Declared, StructuredResult, ToolStep } from "./schema.ts";

function isWarning(problem: unknown): boolean {
  return (problem as { severity?: unknown } | null)?.severity === "warning";
}

/** The envelope's `changed`. With the pipeline's facts: the command's own changedWhen first
 *  (a legacy command), then `read` → false, else the document's boolean, else true. Without
 *  them (a direct call), the old declaration-only rule. */
function changedFact(command: Declared, fields: { changed?: unknown }, args: string[], facts?: CallFacts): boolean {
  if (facts !== undefined) {
    if (facts.changed !== undefined) return facts.changed;
    if (facts.effect === "read") return false;
    return typeof fields.changed === "boolean" ? fields.changed : true;
  }
  return command.changedWhen?.(args) ?? (command.readOnly === true ? false : (typeof fields.changed === "boolean" ? fields.changed : true));
}

/** The tool-argument record for a command's own argv — the inverse of toArgv: the command
 *  word is stripped, the action word lands in the derived `action` positional, a flag
 *  becomes true, an option or positional its string, a variadic its array. Undefined when
 *  the argv does not parse against the declaration — a step is never guessed. */
export function toolArguments(command: Declared, argv: readonly string[]): Record<string, unknown> | undefined {
  if (argv.length === 0) return undefined;
  const verbatim = (command.arguments ?? []).some(
    (argument) => argument.kind === "variadic" && "verbatim" in argument && argument.verbatim === true,
  );
  let entries;
  try {
    entries = tokenize(command.arguments ?? [], argv.slice(1), undefined, verbatim).entries;
  } catch {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const { argument, value } of entries) {
    if (argument.kind === "variadic") {
      const list = result[argument.name];
      if (Array.isArray(list)) list.push(value as string);
      else result[argument.name] = [value as string];
    } else {
      result[argument.name] = value;
    }
  }
  return result;
}

/** The only advice a step can be built from: a clawforge one for this deployment. A
 *  shell or manual step, and an advice naming another deployment explicitly, are not. */
function localAdvice(advice: Advice): CommandAdvice | undefined {
  if (advice.kind !== "clawforge" || advice.app !== undefined) return undefined;
  return advice;
}

/** The envelope's nextSteps: the clawforge advices a document carries, matched against the
 *  tools this server serves. A shell or manual step, an advice naming another deployment
 *  explicitly, and anything without a matching tool are skipped — not guessed. */
export function toolSteps(next: readonly Advice[], lookup: (name: string) => Declared | undefined): ToolStep[] {
  const steps: ToolStep[] = [];
  for (const advice of next) {
    const local = localAdvice(advice);
    if (local === undefined) continue;
    const [tool] = local.argv;
    if (typeof tool !== "string") continue;
    const command = lookup(tool);
    if (command === undefined) continue;
    const args = toolArguments(command, local.argv);
    if (args === undefined) continue;
    steps.push({ tool, arguments: args });
  }
  return steps;
}

/** The structured `next` field a document carries, narrowed to real advice values. */
function adviceList(value: unknown): Advice[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Advice => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const advice = entry as { kind?: unknown; argv?: unknown; text?: unknown; shell?: unknown };
    if (advice.kind === "clawforge") return Array.isArray(advice.argv) && advice.argv.every((word) => typeof word === "string");
    if (advice.kind === "manual") return typeof advice.text === "string";
    if (advice.kind === "shell") return typeof advice.text === "string" && (advice.shell === "posix" || advice.shell === "cmd" || advice.shell === "pwsh");
    return false;
  });
}

/** Builds the envelope from what a structured command emitted. Returns undefined when the
 *  output is not the single JSON document promised — the text result still stands, so a
 *  broken promise degrades rather than turning a working call into an error. */
export function structuredResult(command: Declared, output: string, operationId: string, args: string[] = [], facts?: CallFacts, lookup?: (name: string) => Declared | undefined): StructuredResult | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object") return undefined;

  const fields = payload as { operationId?: unknown; healthy?: unknown; problems?: unknown; nextActions?: unknown; next?: unknown; changed?: unknown };
  const problems = Array.isArray(fields.problems) ? fields.problems : [];
  const commandOperationId = typeof fields.operationId === "string" && fields.operationId !== ""
    ? fields.operationId
    : operationId;

  return {
    operationId: commandOperationId,
    // A read-only command changes nothing by declaration. Anything else defaults to
    // "changed" when unsaid: an unneeded re-check costs less than a skipped one that was needed.
    changed: changedFact(command, fields, args, facts),
    healthy: typeof fields.healthy === "boolean" ? fields.healthy : undefined,
    problems,
    warnings: problems.filter(isWarning),
    nextActions: Array.isArray(fields.nextActions) ? fields.nextActions.filter((entry): entry is string => typeof entry === "string") : [],
    nextSteps: toolSteps(adviceList(fields.next), lookup ?? (() => undefined)),
    result: payload,
  };
}

/** The envelope a structured tool call returns, whatever the action emitted.
 *  structuredResult keeps the command's own JSON document when emitted; every other
 *  successful output (progress text, a log tail) is wrapped in the same shape instead of
 *  returned bare, since the tool declares one outputSchema for all its actions. A text
 *  action's envelope stays silent where a structured one speaks — no healthy, no problems,
 *  no nextActions — a gap can be seen, a guess cannot be trusted. */
export function toolEnvelope(command: Declared, output: string, machineOutput: string | undefined, operationId: string, args: string[] = [], facts?: CallFacts, lookup?: (name: string) => Declared | undefined): StructuredResult {
  return structuredResult(command, machineOutput ?? output, operationId, args, facts, lookup) ?? {
    operationId,
    changed: changedFact(command, {}, args, facts),
    problems: [],
    warnings: [],
    nextActions: [],
    nextSteps: [],
    result: machineOutput ?? output,
  };
}

/** Masks credential values in a structured error without changing its shape. */
function maskStructuredValue(value: unknown): unknown {
  if (typeof value === "string") return maskSecrets(value);
  if (Array.isArray(value)) return value.map(maskStructuredValue);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    const used = new Set<string>();
    for (const [key, entry] of Object.entries(value)) {
      const base = maskSecrets(key);
      let maskedKey = base;
      let suffix = 2;
      while (used.has(maskedKey)) maskedKey = `${base}#${suffix++}`;
      used.add(maskedKey);
      result[maskedKey] = maskStructuredValue(entry);
    }
    return result;
  }
  return value;
}

/** Masks all nested credential values and keys in a structured error. */
export function maskStructuredResult(result: StructuredResult): StructuredResult {
  return maskStructuredValue(result) as StructuredResult;
}

/** Replaces the command's machine JSON inside captured progress text with its masked form. */
export function maskStructuredOutput(output: string, machineOutput: string | undefined, result: StructuredResult): string {
  if (machineOutput === undefined) return maskSecrets(output);
  const safePayload = JSON.stringify(maskStructuredValue(result.result));
  if (safePayload === undefined) return maskSecrets(output);
  if (!output.includes(machineOutput)) return maskSecrets(output);
  return maskSecrets(output.split(machineOutput).join(safePayload));
}

/** The one voice for a missing required argument, validate's and its checks'. */
export function requiredArgumentMessage(name: string): string {
  return `${name} is required`;
}

/** The refusal a destructive gate command's tool call owes before anything runs — the same
 *  confirmation rule the deployment path enforces in the pipeline's confirm stage
 *  (core/command/execute.ts), read from the gate command's declared effect. */
export function gateConfirmationRefusal(commandName: string, command: Declared, args: Record<string, unknown>): string | undefined {
  if (args.confirm === true) return undefined;
  return effectProfile(command).destructive === true ? new ConfirmationRequiredError(commandName).message : undefined;
}

/** Checks tool arguments against the declaration. The client's schema is a courtesy, not a
 *  guarantee: anything may arrive on this stream, and a command's own parser sees argv, not
 *  types. For a spec command only the SHAPE is checked here — unknown property and value
 *  types; choices, required and value grammars are the parser's, one stage later, so they
 *  are refused in one voice with the console. Returns the problems, empty when the call is
 *  acceptable. */
export function validate(command: Declared, args: Record<string, unknown>): string[] {
  const declared = new Map((command.arguments ?? []).map((argument) => [argument.name, argument]));
  // specOf keys on the console run function: a gate command's argv-run is never in it.
  const spec = specOf(command as { readonly run?: unknown });
  const problems: string[] = [];

  for (const [name, value] of Object.entries(args)) {
    if (name === "confirm") continue;

    const argument = declared.get(name);
    if (argument === undefined) {
      problems.push(`unknown argument: ${name}`);
      continue;
    }
    if (argument.kind === "flag") {
      if (typeof value !== "boolean") problems.push(`${name} takes true or false`);
      continue;
    }
    if (argument.kind === "variadic") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
        problems.push(`${name} takes a list of non-empty strings`);
      }
      continue;
    }
    if (typeof value !== "string") {
      problems.push(`${name} takes a string`);
      continue;
    }
    if (spec === undefined && argument.choices !== undefined && !argument.choices.includes(value)) {
      problems.push(`${name} must be one of: ${argument.choices.join(", ")}`);
    }
  }

  if (spec !== undefined) {
    // toArgv puts a variadic after a bare `--`, where the tokenizer would fill a missing
    // positional from its first word: with a variadic given, a required positional must be too.
    const variadicGiven = [...declared.values()].some((argument) => {
      const value = args[argument.name];
      return argument.kind === "variadic" && Array.isArray(value) && value.length > 0;
    });
    if (variadicGiven) {
      for (const argument of declared.values()) {
        if (argument.kind !== "positional" || argument.required !== true) continue;
        const value = args[argument.name];
        if (value === undefined || value === "") problems.push(requiredArgumentMessage(argument.name));
      }
    }
    return problems;
  }

  for (const argument of declared.values()) {
    if (argument.required !== true) continue;
    const value = args[argument.name];
    if (value === undefined || value === "") problems.push(requiredArgumentMessage(argument.name));
  }

  return problems;
}

/** Turns tool arguments back into the argv the command already knows how to parse.
 *  Positionals come first, in declaration order, matching how the parsers read them;
 *  options use inline binding so even a value naming another option stays literal. */
export function toArgv(command: Declared, args: Record<string, unknown>): string[] {
  const declared = command.arguments ?? [];
  const positional: string[] = [];
  const named: string[] = [];
  // Appended after everything else: these are the arguments of another program, and
  // anything of ours mixed in among them would be read as theirs.
  const trailing: string[] = [];

  for (const argument of declared) {
    const value = args[argument.name];
    if (value === undefined || value === false || value === "") continue;

    if (argument.kind === "variadic") {
      if (Array.isArray(value)) trailing.push(...value.map(String));
    } else if (argument.kind === "positional") positional.push(String(value));
    else if (argument.kind === "flag") named.push(`--${argument.name}`);
    else named.push(`--${argument.name}=${String(value)}`);
  }

  // A spec command's confirmation-set flags ride the confirmation instead of the caller,
  // read back from the action the call selects (the action word, or the body's default) —
  // never another action's flags.
  const entry = args.confirm === true ? specOf(command as { readonly run?: unknown }) : undefined;
  if (entry !== undefined) {
    const shape = specShape(entry);
    const action = typeof args.action === "string" && shape.actions?.[args.action] !== undefined
      ? args.action
      : shape.defaultAction;
    const slice = shape.actions === undefined
      ? shape.arguments
      : action === undefined ? [] : shape.actions[action]?.arguments;
    for (const argument of slice ?? []) {
      if (argument.kind === "flag" && argument.setByConfirm === true && !named.includes(`--${argument.name}`)) named.push(`--${argument.name}`);
    }
  }

  return [...positional, ...named, ...(trailing.length === 0 ? [] : ["--", ...trailing])];
}
