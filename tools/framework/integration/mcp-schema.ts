// Pure Declared-command ↔ JSON-RPC/CLI-argv transforms for the MCP control server: the
// tool description and input schema a client sees, argument validation, argv construction,
// and the structured-output envelope. Split out of mcp-server.ts, which keeps the actual
// protocol/I-O server (serveMcp and its stdio loop) and re-exports everything here under
// its own name, so every external importer keeps importing from "./mcp-server.ts" unchanged.

import type { CommandArgument } from "../core/app.ts";
import { maskSecrets } from "../core/log.ts";

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
};

/** The envelope every structured tool result carries.
 *
 *  A text log is written for a person: to act on it, an agent has to read prose and guess
 *  whether anything changed and what to do next — and it guesses differently each time. The
 *  fields below are the questions it actually has, answered once, in the same shape for
 *  every command that produces them.
 *
 *  Only what is known is filled in. A command that does not report whether the instance is
 *  healthy leaves `healthy` absent rather than claiming something; the alternative — a
 *  default that looks like an answer — is worse than a gap, because a gap can be seen. */
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

/** Declared to clients so the shape above is known before a call rather than discovered
 *  from one. The same for every structured command, because the envelope is. */
export const STRUCTURED_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    operationId: { type: "string", description: "Command operation id when available; otherwise this tool call id" },
    changed: { type: "boolean", description: "Whether the call may have changed the instance" },
    healthy: { type: "boolean", description: "Whether the instance is doing its job, when the command knows" },
    problems: { type: "array", description: "Findings, each with a stable code, severity, detail and nextAction" },
    warnings: { type: "array", description: "The subset of problems that are not blocking" },
    nextActions: { type: "array", items: { type: "string" }, description: "Commands that resolve the findings" },
    result: { description: "The command's own output, unaltered — its JSON document when it emits one, its text otherwise" },
  },
  required: ["operationId", "changed", "problems", "warnings", "nextActions", "result"],
} as const;

function isWarning(problem: unknown): boolean {
  return (problem as { severity?: unknown } | null)?.severity === "warning";
}

/** Builds the envelope from what a structured command emitted.
 *
 *  Returns undefined when the output is not the single JSON document the command promised —
 *  the text result still stands, so a broken promise degrades to what every other tool
 *  returns instead of turning a working call into an error. */
export function structuredResult(command: Declared, output: string, operationId: string): StructuredResult | undefined {
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
    // A read-only command changes nothing by declaration. Anything else is asked, and when
    // it does not say, taken to have changed something: an agent that re-checks
    // unnecessarily loses a call, one that skips a check it needed loses the thread.
    changed: command.readOnly === true ? false : (typeof fields.changed === "boolean" ? fields.changed : true),
    healthy: typeof fields.healthy === "boolean" ? fields.healthy : undefined,
    problems,
    warnings: problems.filter(isWarning),
    nextActions: Array.isArray(fields.nextActions) ? fields.nextActions.filter((entry): entry is string => typeof entry === "string") : [],
    result: payload,
  };
}

/** The envelope a structured tool call returns, whatever the action emitted.
 *
 *  structuredResult keeps the command's own JSON document when it emitted one. Every other
 *  successful output — progress text, a log tail — is wrapped in the same shape rather
 *  than returned bare, because the tool declares one outputSchema for all of its
 *  responses: a client that calls any action of a structured command gets the envelope,
 *  with the command's own output verbatim in `result` and nothing invented around it. A
 *  text action's envelope stays silent where a structured one speaks — no healthy, no
 *  problems, no nextActions — because a gap can be seen and a guess cannot be trusted. */
export function toolEnvelope(command: Declared, output: string, machineOutput: string | undefined, operationId: string): StructuredResult {
  return structuredResult(command, machineOutput ?? output, operationId) ?? {
    operationId,
    changed: command.readOnly === true ? false : true,
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

/** Builds the description a chat client sees for a tool. */
export function toolDescription(command: Declared): string {
  const parts = [command.summary];
  if (command.details !== undefined) parts.push(command.details);
  if (command.destructive === true) {
    parts.push(command.readOnlyWhen === undefined
      ? "Destructive: requires confirm: true."
      : "Destructive actions require confirm: true; read-only actions do not.");
  }
  return parts.join("\n\n");
}

/** JSON Schema for a command, derived from its declared arguments. */
export function inputSchema(command: Declared): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const argument of command.arguments ?? []) {
    properties[argument.name] = argument.kind === "variadic"
      ? { type: "array", items: { type: "string" }, description: argument.description }
      : {
        type: argument.kind === "flag" ? "boolean" : "string",
        description: argument.description,
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
        ? "Must be true: this command replaces or destroys state"
        : "Must be true when the selected action replaces or destroys state",
    };
    if (command.readOnlyWhen === undefined) required.push("confirm");
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
 *
 *  Positionals come first and in declaration order, because that is how the parsers read
 *  them; options keep their name, which is what used to be lost — `--profile share` arrived
 *  as a bare `share` and was taken for a file name. */
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
    else named.push(`--${argument.name}`, String(value));
  }

  // A destructive command asks for confirmation on a terminal; over MCP the confirmation is
  // the tool argument, so the prompt has to be waived here rather than by a second flag the
  // caller has to know about.
  if (command.destructive === true && declared.some((argument) => argument.name === "force")) {
    if (!named.includes("--force")) named.push("--force");
  }

  return [...positional, ...named, ...trailing];
}
