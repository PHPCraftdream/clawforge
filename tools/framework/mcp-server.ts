// Exposing an application's commands as MCP tools.
//
// This is not the bridge to the managed service's own channels — that one belongs to the
// application. This server offers *control* of the instance: bootstrap, status, backup,
// secrets.
//
// The surface is a mirror, and that is a promise rather than an accident: what `./clawforge` can
// do from a terminal, a tool call can do. Three tiers reach the console and all three are
// mirrored —
//   - the application's own commands (app.commands, dispatched in cli.ts);
//   - the dispatcher's (help, control-mcp);
//   - the gate's, which run before a deployment is resolved (check, new-app / init).
// A command whose console behaviour cannot survive being a tool call (it streams, or it
// owns stdio) is mirrored in a bounded form instead, declared beside it. What cannot be
// mirrored at all is listed in MCP_EXEMPTIONS below, with the reason, and
// tools/checks/mcp-mirror.check.ts fails on anything that is neither.
//
// stdout carries JSON-RPC and nothing else. Commands write their progress to stderr
// through the log helpers, so that output is captured and returned as the tool result
// rather than corrupting the protocol stream.

import { createInterface } from "node:readline";
import { mcpCommands, type AppCommand, type AppDefinition, type CommandArgument } from "./app.ts";
import type { GateCommand } from "./gate.ts";
import { createContext } from "./context.ts";
import { useRecipesDir } from "./recipe.ts";
import { recipesDir } from "./deployment.ts";
import { ensureEnvironment } from "./provision.ts";
import { UserError } from "./log.ts";
import { withOutputSink } from "./output.ts";

const PROTOCOL_VERSION = "2025-06-18";

/** Console capabilities that deliberately have no tool, and why. Read by
 *  tools/checks/mcp-mirror.check.ts, so an entry here is a decision on the record rather
 *  than a comment someone can forget to write.
 *
 *  Two of these are the same argument at different heights: a stdio JSON-RPC server cannot
 *  be started by a tool call inside a stdio JSON-RPC server, because both would then own
 *  the same stdout. The other two are redundancy, not impossibility. */
export const MCP_EXEMPTIONS: Record<string, string> = {
  "mcp-serve": "it is a stdio JSON-RPC server; a client registers it directly (./clawforge mcp-setup does), rather than starting it through another one",
  "control-mcp": "it is this server — a tool that starts the server it runs inside answers nothing",
  help: "a client already holds this text: every tool's description is the same summary and details `help <command>` prints, generated from the same declaration",
  "--app": "it selects which deployment this server serves, which is settled when the client launches it (mcp-setup writes the flag into .mcp.json); switching mid-session would change what every other tool in the list refers to",
};

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** What the four functions below need from a command, and all they need: the description a
 *  client reads, and the arguments the schema, the validation and the argv are derived from.
 *  Both an AppCommand and a GateCommand satisfy it — which is the point, since a client is
 *  offered one surface and should not be able to tell which of the two it is calling. */
type Declared = {
  readonly summary: string;
  readonly details?: string;
  readonly destructive?: boolean;
  readonly arguments?: CommandArgument[];
  readonly structured?: boolean;
  readonly readOnly?: boolean;
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
interface StructuredResult {
  /** Distinguishes two calls of the same tool in a log. Not persisted anywhere: it names
   *  this call, so a report about it can be matched to it. */
  readonly operationId: string;
  readonly changed: boolean;
  readonly healthy?: boolean;
  readonly problems: unknown[];
  readonly warnings: unknown[];
  readonly nextActions: string[];
  /** The command's own JSON, whole and unaltered — the envelope adds to it, never replaces
   *  it, so a caller that wants a field the envelope does not name still has it. */
  readonly result: unknown;
}

/** Declared to clients so the shape above is known before a call rather than discovered
 *  from one. The same for every structured command, because the envelope is. */
const STRUCTURED_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    operationId: { type: "string", description: "Identifies this call" },
    changed: { type: "boolean", description: "Whether the call may have changed the instance" },
    healthy: { type: "boolean", description: "Whether the instance is doing its job, when the command knows" },
    problems: { type: "array", description: "Findings, each with a stable code, severity, detail and nextAction" },
    warnings: { type: "array", description: "The subset of problems that are not blocking" },
    nextActions: { type: "array", items: { type: "string" }, description: "Commands that resolve the findings" },
    result: { description: "The command's own JSON output, unaltered" },
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

  const fields = payload as { healthy?: unknown; problems?: unknown; nextActions?: unknown; changed?: unknown };
  const problems = Array.isArray(fields.problems) ? fields.problems : [];

  return {
    operationId,
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

/** What a chat client sees for a tool. `details` — the same text `./clawforge help <command>`
 *  prints — is folded in here too: a client picking a tool by name alone is exactly the
 *  situation the longer explanation exists for. */
function toolDescription(command: Declared): string {
  const parts = [command.summary];
  if (command.details !== undefined) parts.push(command.details);
  if (command.destructive === true) parts.push("Destructive: requires confirm: true.");
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
      description: "Must be true: this command replaces or destroys state",
    };
    required.push("confirm");
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

/** Runs a command with its output captured, so the caller sees it as the tool result and
 *  stdout stays a pure JSON-RPC stream.
 *
 *  A failure returns rather than throws, and returns what the command had already said. On
 *  a console those lines are on the screen above the error; losing them here would leave a
 *  tool call with only the last sentence of a story it could otherwise tell in full. */
async function captureRun(
  app: AppDefinition,
  command: AppCommand,
  argv: string[],
): Promise<{ output: string; machineOutput?: string; failure?: string }> {
  const chunks: string[] = [];
  const emitted: string[] = [];

  return withOutputSink(
    (chunk) => {
      chunks.push(chunk);
    },
    async () => {
      try {
        // Same order as the console path: the environment is completed before the context is
        // built from it, and the deployment's own recipes are the ones in scope.
        useRecipesDir(recipesDir());
        if (command.preparesEnvironment === true) await ensureEnvironment();

        const ctx = await createContext({ mounts: app.mounts, service: app.service });
        await command.run(ctx, argv);
        return { output: chunks.join("").trim(), machineOutput: emitted.join("").trim() || undefined };
      } catch (error) {
        const failure = error instanceof UserError || error instanceof Error
          ? error.message
          : String(error);
        return { output: chunks.join("").trim(), machineOutput: emitted.join("").trim() || undefined, failure };
      }
    },
    (chunk) => { emitted.push(chunk); },
  );
}

/** The same capture as captureRun, for a command that runs without a Context. A non-zero
 *  exit is the failure here — a gate command reports by returning a code, the way a process
 *  does, rather than by throwing. */
async function captureGateRun(
  command: GateCommand,
  argv: string[],
): Promise<{ output: string; failure?: string }> {
  const chunks: string[] = [];

  return withOutputSink(
    (chunk) => {
      chunks.push(chunk);
    },
    async () => {
      try {
        const code = await command.run(argv);
        const output = chunks.join("").trim();
        return code === 0 ? { output } : { output, failure: `${command.name} failed (exit ${code})` };
      } catch (error) {
        const failure = error instanceof UserError || error instanceof Error
          ? error.message
          : String(error);
        return { output: chunks.join("").trim(), failure };
      }
    },
  );
}

function send(response: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function reply(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

export async function serveMcp(app: AppDefinition, gateCommands: GateCommand[] = []): Promise<void> {
  const tools = mcpCommands(app);
  // Presented as one list: a client is offered what `./clawforge` can do, not a map of which layer
  // dispatches what. They are kept apart here only because they are invoked differently —
  // a gate command takes no Context, having to run before there is one.
  const gateTools = gateCommands.filter((command) => MCP_EXEMPTIONS[command.name] === undefined);

  const lines = createInterface({ input: process.stdin });

  for await (const line of lines) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Answered with a null id, as JSON-RPC requires: the request that failed to parse
      // has no id to answer with, and a client waiting for a response would otherwise wait
      // forever.
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }

    // `null`, a number, a string, an array — all valid JSON, none a JSON-RPC request. Left
    // unchecked, `request.method` below throws on `null` and crashes the whole loop: every
    // request still waiting on a response, including a well-formed one sent later on the
    // same connection, then gets nothing back, because the process has already exited.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { method?: unknown }).method !== "string") {
      const id = (parsed as { id?: unknown })?.id;
      const validId = typeof id === "string" || typeof id === "number" ? id : null;
      send({ jsonrpc: "2.0", id: validId, error: { code: -32600, message: "invalid request" } });
      continue;
    }

    const request = parsed as JsonRpcRequest;

    switch (request.method) {
      case "initialize":
        reply(request.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `${app.name}-control`, version: "1" },
        });
        break;

      case "notifications/initialized":
        // Notification: no response expected.
        break;

      case "tools/list":
        reply(request.id, {
          tools: [
            ...tools.map(([name, command]) => ({
              name,
              description: toolDescription(command),
              inputSchema: inputSchema(command),
              ...(command.structured === true ? { outputSchema: STRUCTURED_OUTPUT_SCHEMA } : {}),
            })),
            ...gateTools.map((command) => ({
              name: command.name,
              description: toolDescription(command),
              inputSchema: inputSchema(command),
            })),
          ],
        });
        break;

      case "tools/call": {
        const params = request.params ?? {};
        const name = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const entry = tools.find(([toolName]) => toolName === name);

        if (entry === undefined) {
          const gateCommand = gateTools.find((command) => command.name === name);
          if (gateCommand !== undefined) {
            const problems = validate(gateCommand, args);
            if (problems.length > 0) {
              reply(request.id, {
                isError: true,
                content: [{ type: "text", text: `${name}: ${problems.join("; ")}` }],
              });
              break;
            }
            const { output, failure } = await captureGateRun(gateCommand, toArgv(gateCommand, args));
            reply(request.id, {
              ...(failure === undefined ? {} : { isError: true }),
              content: [{
                type: "text",
                text: failure === undefined
                  ? (output === "" ? "(no output)" : output)
                  : (output === "" ? failure : `${output}\n\n${failure}`),
              }],
            });
            break;
          }
          replyError(request.id, -32602, `unknown tool: ${name}`);
          break;
        }

        const [, command] = entry;

        const problems = validate(command, args);
        if (problems.length > 0) {
          reply(request.id, {
            isError: true,
            content: [{ type: "text", text: `${name}: ${problems.join("; ")}` }],
          });
          break;
        }

        if (command.destructive === true && args.confirm !== true) {
          reply(request.id, {
            isError: true,
            content: [{ type: "text", text: `${name} replaces or destroys state — pass confirm: true` }],
          });
          break;
        }

        try {
          const argv = toArgv(command, args);
          const { output, machineOutput, failure } = await captureRun(app, command, argv);
          const effectiveCommand = { ...command, readOnly: command.readOnly === true || command.readOnlyWhen?.(argv) === true };
          // Built from the output alone, never from the output plus the failure text: a
          // command that reports findings and then fails on them — doctor is the one that
          // does — still emitted a valid document, and that is what the caller needs most
          // in exactly that case.
          const structured = command.structured === true
            ? structuredResult(effectiveCommand, machineOutput ?? output, `${name}-${Date.now().toString(36)}`)
            : undefined;

          if (failure === undefined) {
            reply(request.id, {
              content: [{ type: "text", text: output === "" ? "(no output)" : output }],
              ...(structured === undefined ? {} : { structuredContent: structured }),
            });
            break;
          }

          // The command's own output first, then why it stopped — the order a console shows
          // them in, and the order that reads as an explanation rather than a bare verdict.
          reply(request.id, {
            isError: true,
            content: [{ type: "text", text: output === "" ? failure : `${output}\n\n${failure}` }],
            ...(structured === undefined ? {} : { structuredContent: structured }),
          });
        } catch (error) {
          // Left for what captureRun cannot catch: a failure while building the sink itself.
          const message = error instanceof UserError || error instanceof Error
            ? error.message
            : String(error);
          reply(request.id, { isError: true, content: [{ type: "text", text: message }] });
        }
        break;
      }

      default:
        replyError(request.id, -32601, `method not found: ${request.method}`);
    }
  }
}
