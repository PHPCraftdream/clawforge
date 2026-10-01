// Pure Declared-command ↔ JSON-RPC/CLI-argv transforms for the MCP control server: tool
// description and input schema, argument validation, argv construction, structured-output
// envelope. Split out of server.ts, which keeps the protocol/I-O loop and re-exports this
// module, so external importers keep importing from "./server.ts" unchanged.

import type { CommandArgument } from "../../core/app.ts";
import { actionLabel } from "../../core/arguments.ts";
import { maskSecrets } from "../../core/io/log.ts";
import { destructiveMarker } from "../../core/io/help-render.ts";

/** What the functions below need from a command, and all they need: the description a
 *  client reads, and the arguments the schema, the validation and the argv are derived from.
 *  Both an AppCommand and a GateCommand satisfy it — which is the point, since a client is
 *  offered one surface and should not be able to tell which of the two it is calling. */
export type Declared = {
  readonly summary: string;
  readonly details?: string;
  readonly destructive?: boolean;
  readonly arguments?: CommandArgument[];
  readonly structured?: boolean;
  readonly readOnly?: boolean;
  readonly readOnlyWhen?: (args: string[]) => boolean;
  readonly changedWhen?: (args: string[]) => boolean;
  readonly requiresConfirmationWhen?: (args: string[]) => boolean;
  readonly forceOnConfirmation?: boolean;
};

/** The envelope every structured tool result carries. A text log is written for a person;
 *  an agent has to read prose and guess whether anything changed — these fields answer
 *  that once, in the same shape for every command that produces them. Only what is known
 *  is filled in: a default that looks like an answer is worse than a gap, since a gap can
 *  be seen. */
export interface StructuredResult {
  /** Command operation id when the command reports one; otherwise a transient tool-call id. */
  readonly operationId: string;
  readonly changed: boolean;
  readonly healthy?: boolean;
  readonly problems: unknown[];
  readonly warnings: unknown[];
  readonly nextActions: string[];
  /** The command's own output, whole and unaltered — its JSON document when it emitted
   *  one, its captured text otherwise. The envelope adds to it, never replaces it, so a
   *  caller that wants a field the envelope does not name still has it. */
  readonly result: unknown;
}

/** Declared to clients so the shape is known before a call, not discovered from one. Same
 *  for every structured command — types and required-ness only, since a per-field
 *  description would repeat ~90 bytes on every tool for no gain. Field meanings are in
 *  `help`'s output instead (help-render.ts), reachable once rather than paid for per tool. */
export const STRUCTURED_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    operationId: { type: "string" },
    changed: { type: "boolean" },
    healthy: { type: "boolean" },
    problems: { type: "array" },
    warnings: { type: "array" },
    nextActions: { type: "array", items: { type: "string" } },
    result: {},
  },
  required: ["operationId", "changed", "problems", "warnings", "nextActions", "result"],
} as const;

function isWarning(problem: unknown): boolean {
  return (problem as { severity?: unknown } | null)?.severity === "warning";
}

/** Builds the envelope from what a structured command emitted. Returns undefined when the
 *  output is not the single JSON document promised — the text result still stands, so a
 *  broken promise degrades rather than turning a working call into an error. */
export function structuredResult(command: Declared, output: string, operationId: string, args: string[] = []): StructuredResult | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object") return undefined;

  const fields = payload as { operationId?: unknown; healthy?: unknown; problems?: unknown; nextActions?: unknown; changed?: unknown };
  const problems = Array.isArray(fields.problems) ? fields.problems : [];
  const commandOperationId = typeof fields.operationId === "string" && fields.operationId !== ""
    ? fields.operationId
    : operationId;

  return {
    operationId: commandOperationId,
    // A read-only command changes nothing by declaration. Anything else defaults to
    // "changed" when unsaid: an unneeded re-check costs less than a skipped one that was needed.
    changed: command.changedWhen?.(args) ?? (command.readOnly === true ? false : (typeof fields.changed === "boolean" ? fields.changed : true)),
    healthy: typeof fields.healthy === "boolean" ? fields.healthy : undefined,
    problems,
    warnings: problems.filter(isWarning),
    nextActions: Array.isArray(fields.nextActions) ? fields.nextActions.filter((entry): entry is string => typeof entry === "string") : [],
    result: payload,
  };
}

/** The envelope a structured tool call returns, whatever the action emitted.
 *  structuredResult keeps the command's own JSON document when emitted; every other
 *  successful output (progress text, a log tail) is wrapped in the same shape instead of
 *  returned bare, since the tool declares one outputSchema for all its actions. A text
 *  action's envelope stays silent where a structured one speaks — no healthy, no problems,
 *  no nextActions — a gap can be seen, a guess cannot be trusted. */
export function toolEnvelope(command: Declared, output: string, machineOutput: string | undefined, operationId: string, args: string[] = []): StructuredResult {
  return structuredResult(command, machineOutput ?? output, operationId, args) ?? {
    operationId,
    changed: command.changedWhen?.(args) ?? (command.readOnly === true ? false : true),
    problems: [],
    warnings: [],
    nextActions: [],
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

/** The tool description: one-line summary plus a pointer to the `help` tool for the full text. */
export function toolDescription(name: string, command: Declared): string {
  return `${command.summary}${destructiveMarker(command)}\n\nFull text: call help with command=${name}.`;
}

/** Hard cut for a shortened argument description; `help <command>` keeps the full text. */
const SHORT_DESCRIPTION_LIMIT = 60;

/** True when the description only restates the argument name (exact or after "the/a/an"). */
function isTrivialDescription(name: string, description: string): boolean {
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedName = normalize(name);
  const normalizedDescription = normalize(description).replace(/^(the|a|an) /, "");
  return normalizedDescription === normalizedName;
}

/** First sentence or clause, parentheticals dropped. `:` is not a boundary ("With x: …" would
 *  keep the qualifier and lose what it qualifies); no early boundary → cut at a word, then
 *  drop any function word the cut would end on — a truncated "… instead of" dangles mid-phrase
 *  and reads as if the rest were missing (R30-06). */
function shortenDescription(description: string): string {
  const stripped = description.replace(/\s*\([^()]*\)/g, "").replace(/\s{2,}/g, " ").trim();
  // Not "e.g." / "i.e." — an abbreviation's period is not a clause boundary either.
  const boundary = /(?<!\be\.g)(?<!\bi\.e)[.;](\s|$)/.exec(stripped);
  const clause = boundary !== null && boundary.index >= 8
    ? stripped.slice(0, boundary.index).trim()
    : stripped;
  if (clause.length <= SHORT_DESCRIPTION_LIMIT) return clause;
  const cut = clause.slice(0, SHORT_DESCRIPTION_LIMIT);
  const lastSpace = cut.lastIndexOf(" ");
  let text = (lastSpace > SHORT_DESCRIPTION_LIMIT * 0.4 ? cut.slice(0, lastSpace) : cut).trim();
  const dangling = /\s+(of|is|are|a|an|the|or|and|to|for|with|on|instead|than|that|from|by|at|as|be)$/i;
  while (dangling.test(text)) text = text.replace(dangling, "").trim();
  return text;
}

/** Arguments repeated on many tools: one terse schema line each (`help` keeps the full text). */
const SHARED_SCHEMA_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "break-lock": "Take over a held instance lock",
  "break-foreign-lock": "Host id of an orphaned lock to take over",
};

/** The argument description in the MCP schema; `--help` and `help` keep it whole. */
export function schemaArgumentDescription(argument: CommandArgument): string | undefined {
  if (isTrivialDescription(argument.name, argument.description)) return undefined;
  const shared = SHARED_SCHEMA_DESCRIPTIONS[argument.name];
  if (shared !== undefined) return shared;
  // "With x:" is help-render's lead-in, not content — stripped BEFORE shortening, or it
  // eats the budget and the cut lands mid-phrase (R30-06: watch.interval "a bare number is").
  const short = shortenDescription(argument.description.replace(/^With [\w/-]+: /, ""));
  // Which action(s) of a multi-action command this argument belongs to — same wording
  // help-render.ts prints. `create` is backup's default (no action word needed) and is
  // labelled as such, so a client knows `hot` without an `action` still means a create.
  const scoped = argument.actions === undefined
    ? short
    : `${short} (${argument.actions.map(actionLabel).join(", ")})`;
  return argument.kind === "option" && argument.valueName !== undefined
    ? `${scoped} (value: <${argument.valueName}>)`
    : scoped;
}

/** JSON Schema for a command, derived from its declared arguments. */
export function inputSchema(command: Declared): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const argument of command.arguments ?? []) {
    const description = schemaArgumentDescription(argument);
    properties[argument.name] = argument.kind === "variadic"
      ? { type: "array", items: { type: "string" }, description }
      : {
        type: argument.kind === "flag" ? "boolean" : "string",
        description,
        ...(argument.choices === undefined ? {} : { enum: [...argument.choices] }),
      };
    if (argument.required === true) required.push(argument.name);
  }

  // A destructive command needs an explicit confirmation: a tool call is far easier to
  // trigger by accident than a typed command line.
  if (command.destructive === true) {
    properties.confirm = {
      type: "boolean",
      description: command.readOnlyWhen === undefined
        ? "Must be true: destroys state"
        : "Confirm a destructive action",
    };
    if (command.readOnlyWhen === undefined && command.requiresConfirmationWhen === undefined) required.push("confirm");
  }

  return { type: "object", properties, required };
}

/** Checks tool arguments against the declaration. The client's schema is a courtesy, not a
 *  guarantee: anything may arrive on this stream, and a command's own parser sees argv, not
 *  types. Returns the problems, empty when the call is acceptable. */
export function validate(command: Declared, args: Record<string, unknown>): string[] {
  const declared = new Map((command.arguments ?? []).map((argument) => [argument.name, argument]));
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
    if (argument.choices !== undefined && !argument.choices.includes(value)) {
      problems.push(`${name} must be one of: ${argument.choices.join(", ")}`);
    }
  }

  for (const argument of declared.values()) {
    if (argument.required !== true) continue;
    const value = args[argument.name];
    if (value === undefined || value === "") problems.push(`${argument.name} is required`);
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

  if (command.forceOnConfirmation === true && args.confirm === true && declared.some((argument) => argument.name === "force")) {
    if (!named.includes("--force")) named.push("--force");
  }

  return [...positional, ...named, ...(trailing.length === 0 ? [] : ["--", ...trailing])];
}
