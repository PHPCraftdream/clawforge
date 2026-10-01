// Pure Declared-command → JSON-RPC schema transforms for the MCP control server: tool
// description and input schema. Call-side transforms (validation, argv, envelope) live in
// call.ts. server.ts keeps the protocol/I-O loop and re-exports both modules, so external
// importers keep importing from "./server.ts" unchanged.

import type { CommandArgument } from "../../core/app.ts";
import { destructiveMarker } from "../../core/io/help-render.ts";
import { effectProfile, splitActionScoped } from "../../core/command/index.ts";

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

/** One remedy as a tool call: the inverse of the argv an advice spells out. */
export interface ToolStep {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

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
  /** The remedies as tool calls, when the command's document carries them as advice:
   *  `nextSteps` answers "what do I run" without reparsing nextActions' console text. */
  readonly nextSteps: ToolStep[];
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
    nextSteps: { type: "array" },
    result: {},
  },
  required: ["operationId", "changed", "problems", "warnings", "nextActions", "nextSteps", "result"],
} as const;

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

/** Nested parentheticals stripped to a fixed point: "(default: OC_CHECK_JOBS, else min(4,
 *  cores/2))" left an unclosed outer pair behind when only the inner one was removed. */
function stripParentheticals(description: string): string {
  let stripped = description;
  for (;;) {
    const next = stripped.replace(/\s*\([^()]*\)/g, "");
    if (next === stripped) return stripped.replace(/\s{2,}/g, " ").trim();
    stripped = next;
  }
}

/** First sentence or clause, cut ONLY at a clause boundary (`.`, `;`, `:`, `,`, `—`) within
 *  the budget — never mid-phrase, since a cut like "— refused" flips meaning (R30-06, R31-02).
 *  No boundary in reach → cut at a word and mark the truncation with an ellipsis, so a client
 *  can see the text is partial. `:` is a boundary here, not before: the "With x: " lead-in is
 *  stripped by the caller first. Boundary characters inside (), [] or quotes do not count —
 *  a "," inside a JSON example is not a clause edge (R32-04). `help <command>` keeps the
 *  full text. */
function shortenDescription(description: string): string {
  const stripped = stripParentheticals(description);
  if (stripped.length <= SHORT_DESCRIPTION_LIMIT) return stripped;
  const head = stripped.slice(0, SHORT_DESCRIPTION_LIMIT);
  let depth = 0;
  let quote: string | undefined;
  let last = -1;
  for (let index = 0; index < head.length; index += 1) {
    const character = head[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"') { quote = character; continue; }
    if (character === "(" || character === "[") { depth += 1; continue; }
    if (character === ")" || character === "]") { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    // Not "e.g." / "i.e." — an abbreviation's period is not a clause boundary either.
    const abbrev = head.slice(Math.max(0, index - 3), index + 1);
    if (".;:,—".includes(character) && abbrev !== "e.g." && abbrev !== "i.e." && (index + 1 >= head.length || head[index + 1] === " ")) {
      last = index;
    }
  }
  if (last >= 8) return stripped.slice(0, last).trim();
  const cut = head.lastIndexOf(" ") > SHORT_DESCRIPTION_LIMIT * 0.4 ? head.slice(0, head.lastIndexOf(" ")) : head;
  return `${cut.trim()}…`;
}

/** Arguments repeated on many tools: one terse schema line each (`help` keeps the full text).
 *  A string is the fixed text for every argument of that name; a table keys a description
 *  prefix — the same name on different commands carries different meanings (cli/exec/host's
 *  `args`). These replace the cut, they are not cut: an explicit short sentence is worth more
 *  than a phrase trimmed mid-example (R32-04). */
const SHARED_SCHEMA_DESCRIPTIONS: Readonly<Record<string, string | Readonly<Record<string, string>>>> = {
  "break-lock": "Take over a held instance lock",
  "break-foreign-lock": "Host id of an orphaned lock to take over",
  jobs: "Concurrent check-file processes",
  root: "Request root; one half of the elevation consent",
  args: {
    "Arguments passed to OpenClaw's CLI verbatim": "Arguments passed to OpenClaw's CLI verbatim",
    "Command and arguments to run": "Command and arguments to run",
  },
  json: {
    "Emit restored data": "Emit restored data and the gateway startup outcome as JSON",
  },
};

function sharedSchemaDescription(argument: CommandArgument): string | undefined {
  const shared = SHARED_SCHEMA_DESCRIPTIONS[argument.name];
  if (shared === undefined) return undefined;
  if (typeof shared === "string") return shared;
  for (const [prefix, text] of Object.entries(shared)) {
    if (argument.description.startsWith(prefix)) return text;
  }
  return undefined;
}

/** The argument description in the MCP schema; `--help` and `help` keep it whole. A declared
 *  `summary` wins over the shared table and the heuristic shortening (design section 4; the
 *  table stays as a fallback until stage 5 removes it). The summary replaces the shortened
 *  text — including a composed description's per-part cuts — but not the ` (<actions>)` and
 *  ` (value: <…>)` tails: those the schema appends either way, unless the summary came from
 *  the shared table, whose texts are the whole description (break-foreign-lock). */
export function schemaArgumentDescription(argument: CommandArgument): string | undefined {
  if (isTrivialDescription(argument.name, argument.description)) return undefined;
  const summary = argument.summary;
  const shared = sharedSchemaDescription(argument);
  if (shared !== undefined && (summary === undefined || shared === summary)) return shared;
  // A composed description (scopeByAction: "X (build); Y (validate)") is shortened per part
  // so each part keeps its own actions — shortening the whole string first stripped every
  // part's action list and left one action's text standing for all (R31-03, R32-04).
  const parts = summary === undefined ? splitActionScoped(argument.description, argument.actions) : undefined;
  const short = summary ?? (parts === undefined
    // "With x:" is help-render's lead-in, not content — stripped BEFORE shortening, or it
    // eats the budget and the cut lands mid-phrase (R30-06: watch.interval "a bare number is").
    ? shortenDescription(argument.description.replace(/^With [\w/-]+: /, ""))
    : parts.map(({ description, actions: own }) => `${shortenDescription(description)} (${own.join(", ")})`).join("; "));
  // Without per-part actions: which action(s) of a multi-action command this argument belongs
  // to — same wording help-render.ts prints. `create` is backup's default (no action word
  // needed) and is labelled as such, so a client knows `hot` without an `action` still means
  // a create.
  // A composed summary ("X (build, validate); Y (forget)") already carries its action lists.
  const composed = parts !== undefined || (summary !== undefined && splitActionScoped(summary, argument.actions) !== undefined);
  const scoped = !composed && argument.actions !== undefined
    ? `${short} (${argument.actions.join(", ")})`
    : short;
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
  // trigger by accident than a typed command line. The distinction comes from the effect
  // profile, like every other surface: alwaysDestroys has no safe form, so confirm is
  // required, not just declared.
  const { destructive, alwaysDestroys } = effectProfile(command);
  if (destructive) {
    properties.confirm = {
      type: "boolean",
      description: alwaysDestroys ? "Must be true: destroys state" : "Confirm a destructive action",
    };
    if (alwaysDestroys) required.push("confirm");
  }

  return { type: "object", properties, required };
}
