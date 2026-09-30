// Exposing an application's commands as MCP tools.
//
// Not the bridge to the managed service's own channels — that belongs to the application.
// This server offers *control* of the instance: bootstrap, status, backup, secrets.
//
// The surface is a mirror: what `./clawforge` can do from a terminal, a tool call can do.
// Three tiers reach the console and all three are mirrored — the application's own commands
// (app.commands, dispatched in cli.ts); the dispatcher's (help, control-mcp); the gate's,
// which run before a deployment is resolved (check, new-app / init). A command whose
// console behaviour cannot survive being a tool call (it streams, or owns stdio) is
// mirrored in a bounded form declared beside it. What cannot be mirrored at all is listed
// in MCP_EXEMPTIONS below with the reason; tools/checks/mcp-mirror.check.ts fails on
// anything that is neither.
//
// stdout carries JSON-RPC and nothing else. Commands write progress to stderr through the
// log helpers, so that output is captured as the tool result instead of corrupting the
// protocol stream.

import { createInterface } from "node:readline";
import { mcpCommands, type AppCommand, type AppDefinition } from "../../core/app.ts";
import { renderHelp, type GateCommand } from "../gate.ts";
import { createContext } from "../../core/context.ts";
import { clearRecipesDir } from "../../service/recipe.ts";
import { useApplicationRecipesDir } from "../../runtime/deployment.ts";
import { ensureEnvironment } from "../provision.ts";
import { preparesEnvironmentFor } from "../../core/arguments.ts";
import { maskSecrets, UserError } from "../../core/io/log.ts";
import { withOutputSink } from "../../core/io/output.ts";
import { maskStructuredOutput, maskStructuredResult, toolEnvelope, toolDescription, inputSchema, validate, toArgv, STRUCTURED_OUTPUT_SCHEMA, type Declared } from "./schema.ts";
import { recoverEnv, recoverEnvBeforeContext } from "../../commands/operate/recover-env/index.ts";
import { frameworkVersion } from "../../commands/management/lock.ts";

export * from "./schema.ts";

const PROTOCOL_VERSION = "2025-06-18";

/** Console capabilities that deliberately have no tool, and why. Read by
 *  tools/checks/mcp-mirror.check.ts, so an entry here is a decision on the record.
 *
 *  mcp-serve and control-mcp are the same argument at different heights: a stdio JSON-RPC
 *  server cannot be started by a tool call inside a stdio JSON-RPC server — both would own
 *  the same stdout. `help` is not listed here: it is a tool (see HELP_TOOL below), the one
 *  every other tool's shrunk description points at instead of carrying its own `--help`
 *  text whole. */
export const MCP_EXEMPTIONS: Record<string, string> = {
  "mcp-serve": "it is a stdio JSON-RPC server; a client registers it directly (./clawforge mcp-setup does), rather than starting it through another one",
  "control-mcp": "it is this server — a tool that starts the server it runs inside answers nothing",
  "--app": "it selects which deployment this server serves, which is settled when the client launches it (mcp-setup writes the flag into .mcp.json); switching mid-session would change what every other tool in the list refers to",
  "version": "answers a human filing a bug report; a tool would only spend the tools/list byte budget",
  "completion": "prints a shell script for a human's own shell profile; a tool call has no shell to register it in, and the byte budget is better spent on tools an agent actually calls",
};

/** The `help` tool: not a command, answered through renderHelp like `./clawforge help`. */
const HELP_TOOL: Declared = {
  summary: "Full description, usage and argument list for one command, or the command list when none is given",
  arguments: [
    { name: "command", description: "Command name; omit to list every command", kind: "option", valueName: "name" },
  ],
  readOnly: true,
};

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** Runs a command with its output captured, so the caller sees it as the tool result and
 *  stdout stays a pure JSON-RPC stream. A failure returns rather than throws, carrying what
 *  the command had already said — losing those lines would leave a tool call with only the
 *  last sentence of a story it could otherwise tell in full. */
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
        // Same order as the console path: environment completed before the context is
        // built, deployment's own recipes in scope. Gated by preparesEnvironmentFor the
        // same way cli.ts's console path is.
        useApplicationRecipesDir(app.recipesDir);
        clearRecipesDir();
        if (preparesEnvironmentFor(command, argv)) await ensureEnvironment();

        // recover-env repairs OC_DATA_DIR itself, so its MCP path must not build the
        // Context that would reject that missing value before the command can run.
        if (command.run === recoverEnv) {
          await recoverEnvBeforeContext(argv, { service: app.service?.name });
          return { output: chunks.join("").trim(), machineOutput: emitted.join("").trim() || undefined };
        }

        const ctx = await createContext({
          mounts: app.mounts,
          service: app.service,
          settings: app.settings,
          secrets: app.secrets,
          afterBackup: app.afterBackup,
          beforeRestore: app.beforeRestore,
        });
        await command.run(ctx, argv);
        return { output: chunks.join("").trim(), machineOutput: emitted.join("").trim() || undefined };
      } catch (error) {
        const failure = maskSecrets(error instanceof UserError || error instanceof Error
          ? error.message
          : String(error));
        return { output: chunks.join("").trim(), machineOutput: emitted.join("").trim() || undefined, failure };
      }
    },
    (chunk) => { emitted.push(chunk); },
  );
}

/** The same capture as captureRun, for a command that runs without a Context. A non-zero
 *  exit is the failure here — a gate command reports by returning a code, like a process,
 *  rather than by throwing. */
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
        const failure = maskSecrets(error instanceof UserError || error instanceof Error
          ? error.message
          : String(error));
        return { output: chunks.join("").trim(), failure };
      }
    },
  );
}

function send(response: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

// A tools/call id lands here the moment `notifications/cancelled` answers it early — the
// call keeps running to completion (no clean abort; the instance lock protects state
// either way) but its own eventual reply is dropped instead of sent twice.
const cancelledIds = new Set<number | string>();

function reply(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return;
  if (cancelledIds.delete(id)) return;
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return;
  if (cancelledIds.delete(id)) return;
  send({ jsonrpc: "2.0", id, error: { code, message: maskSecrets(message) } });
}

async function handleInitialize(id: number | string | undefined, app: AppDefinition): Promise<void> {
  reply(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: `${app.name}-control`, version: (await frameworkVersion()) ?? "unknown" },
  });
}

/** The schema as sent in tools/list: an empty `required` is the JSON Schema default, so it is
 *  not spelled out (saves bytes on every tool without a required argument). */
function wireSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { required, ...rest } = schema;
  return Array.isArray(required) && required.length === 0 ? rest : schema;
}

function handleToolsList(id: number | string | undefined, tools: [string, AppCommand][], gateTools: GateCommand[]): void {
  reply(id, {
    tools: [
      ...tools.map(([name, command]) => ({
        name,
        description: toolDescription(name, command),
        inputSchema: wireSchema(inputSchema(command)),
        // Declared from the command's own metadata alone — a structured tool answers every
        // action in the envelope, so one honest schema covers all of them.
        ...(command.structured === true ? { outputSchema: STRUCTURED_OUTPUT_SCHEMA } : {}),
      })),
      ...gateTools.map((command) => ({
        name: command.name,
        description: toolDescription(command.name, command),
        inputSchema: wireSchema(inputSchema(command)),
      })),
      {
        name: "help",
        description: HELP_TOOL.summary,
        inputSchema: wireSchema(inputSchema(HELP_TOOL)),
      },
    ],
  });
}

/** The `help` tool call: not an AppCommand or a GateCommand, so it never reaches the
 *  `tools`/`gateTools` lookup in handleToolsCall. */
async function handleHelpTool(
  id: number | string | undefined,
  args: Record<string, unknown>,
  app: AppDefinition,
  gateCommands: GateCommand[],
  gateHelp: string[],
): Promise<void> {
  const problems = validate(HELP_TOOL, args);
  if (problems.length > 0) {
    reply(id, {
      isError: true,
      content: [{ type: "text", text: maskSecrets(`help: ${problems.join("; ")}`) }],
    });
    return;
  }
  const target = typeof args.command === "string" && args.command !== "" ? args.command : undefined;
  const chunks: string[] = [];
  await withOutputSink((chunk) => { chunks.push(chunk); }, async () => {
    renderHelp(target, app, gateCommands, gateHelp);
  });
  const output = chunks.join("").trim();
  reply(id, {
    content: [{ type: "text", text: output === "" ? "(no output)" : maskSecrets(output) }],
  });
}

/** A tool name not found among the app's own commands: the gate's own list, or -32602. */
async function handleGateToolCall(
  id: number | string | undefined,
  name: string,
  args: Record<string, unknown>,
  gateTools: GateCommand[],
): Promise<void> {
  const gateCommand = gateTools.find((command) => command.name === name);
  if (gateCommand === undefined) {
    replyError(id, -32602, `unknown tool: ${name}`);
    return;
  }
  const problems = validate(gateCommand, args);
  if (problems.length > 0) {
    reply(id, {
      isError: true,
      content: [{ type: "text", text: maskSecrets(`${name}: ${problems.join("; ")}`) }],
    });
    return;
  }
  const { output, failure } = await captureGateRun(gateCommand, toArgv(gateCommand, args));
  // The mask follows the answer, not the exit status: a healthy gate command's output gets
  // the same treatment as its failure.
  reply(id, {
    ...(failure === undefined ? {} : { isError: true }),
    content: [{
      type: "text",
      text: maskSecrets(failure === undefined
        ? (output === "" ? "(no output)" : output)
        : (output === "" ? failure : `${output}\n\n${failure}`)),
    }],
  });
}

async function handleAppToolCall(
  id: number | string | undefined,
  app: AppDefinition,
  name: string,
  command: AppCommand,
  args: Record<string, unknown>,
): Promise<void> {
  const problems = validate(command, args);
  if (problems.length > 0) {
    reply(id, {
      isError: true,
      content: [{ type: "text", text: maskSecrets(`${name}: ${problems.join("; ")}`) }],
    });
    return;
  }

  const argv = toArgv(command, args);
  const readOnly = command.readOnly === true || command.readOnlyWhen?.(argv) === true;
  const requiresConfirmation = command.requiresConfirmationWhen?.(argv) ?? !readOnly;
  if (command.destructive === true && requiresConfirmation && args.confirm !== true) {
    reply(id, {
      isError: true,
      content: [{ type: "text", text: maskSecrets(`${name} replaces or destroys state — pass confirm: true`) }],
    });
    return;
  }

  try {
    const { output, machineOutput, failure } = await captureRun(app, command, argv);
    const effectiveCommand = { ...command, readOnly };
    // Built from the output alone, never output plus failure text: a command that reports
    // findings and then fails on them (doctor does) still emitted a valid document, and
    // that is what the caller needs most in exactly that case. A structured command wraps
    // EVERY action's output in its declared envelope — text included — so the schema stays
    // true of each response rather than of the actions someone remembered to list.
    const structured = command.structured === true
      ? toolEnvelope(effectiveCommand, output, machineOutput, `${name}-${Date.now().toString(36)}`, argv)
      : undefined;
    // Redaction is not an error-path courtesy: a successful diagnostic prints the same
    // logs, hook output and machine JSON a failure would have, so registered values are
    // masked here too. The one exception is declared on the command (mcp-creds): its
    // success is a deliberate reveal. A failure keeps the mask even there.
    const deliberate = command.exportsSecrets === true;
    const responseStructured = structured === undefined || (deliberate && failure === undefined)
      ? structured
      : maskStructuredResult(structured);

    if (failure === undefined) {
      reply(id, {
        content: [{
          type: "text",
          text: output === "" ? "(no output)" : (deliberate ? output : maskSecrets(output)),
        }],
        ...(responseStructured === undefined ? {} : { structuredContent: responseStructured }),
      });
      return;
    }

    // The command's own output first, then why it stopped — the order a console shows
    // them in, reading as an explanation rather than a bare verdict.
    const failureOutput = structured === undefined ? output : maskStructuredOutput(output, machineOutput, structured);
    reply(id, {
      isError: true,
      content: [{
        type: "text",
        text: maskSecrets(failureOutput === "" ? failure : `${failureOutput}\n\n${failure}`),
      }],
      ...(responseStructured === undefined ? {} : { structuredContent: responseStructured }),
    });
  } catch (error) {
    // Left for what captureRun cannot catch: a failure while building the sink itself.
    const message = maskSecrets(error instanceof UserError || error instanceof Error
      ? error.message
      : String(error));
    reply(id, { isError: true, content: [{ type: "text", text: message }] });
  }
}

async function handleToolsCall(
  request: JsonRpcRequest,
  app: AppDefinition,
  tools: [string, AppCommand][],
  gateTools: GateCommand[],
  gateCommands: GateCommand[],
  gateHelp: string[],
): Promise<void> {
  const params = request.params ?? {};
  // Never String(params.name ?? "") — an object whose toString is not callable (e.g.
  // {"toString": null}) makes String() throw, and nothing here catches it: the whole
  // process would exit, answering neither this request nor any queued after it.
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  // Not an AppCommand or a GateCommand — the dispatcher's own alias (see entry/cli.ts) —
  // so it is handled here rather than through the `tools`/`gateTools` lookup below.
  if (name === "help") {
    await handleHelpTool(request.id, args, app, gateCommands, gateHelp);
    return;
  }

  const entry = tools.find(([toolName]) => toolName === name);
  if (entry === undefined) {
    await handleGateToolCall(request.id, name, args, gateTools);
    return;
  }

  const [, command] = entry;
  await handleAppToolCall(request.id, app, name, command, args);
}

export async function serveMcp(app: AppDefinition, gateCommands: GateCommand[] = [], gateHelp: string[] = []): Promise<void> {
  const tools = mcpCommands(app);
  // Presented as one list: a client sees what `./clawforge` can do, not which layer
  // dispatches what. Kept apart here only because they are invoked differently — a gate
  // command takes no Context, having to run before there is one.
  const gateTools = gateCommands.filter((command) => MCP_EXEMPTIONS[command.name] === undefined);

  const lines = createInterface({ input: process.stdin });

  // captureRun's output sink (core/io/output.ts) is one process-global slot, so two
  // tools/call runs executing at once would interleave into each other's captured text.
  // Every tools/call is chained onto this queue instead — one command runs at a time —
  // while every other method (ping, tools/list, initialize, cancellation) is answered
  // straight from the loop below and never waits behind it.
  let callQueue: Promise<unknown> = Promise.resolve();
  const inFlightCallIds = new Set<number | string>();

  for await (const line of lines) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Answered with a null id, as JSON-RPC requires: the request that failed to parse
      // has no id to answer with.
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }

    // `null`, a number, a string, an array — all valid JSON, none a JSON-RPC request. Left
    // unchecked, `request.method` below throws on `null` and crashes the whole loop, so
    // every request still waiting on a response gets nothing back.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { method?: unknown }).method !== "string") {
      const id = (parsed as { id?: unknown })?.id;
      const validId = typeof id === "string" || typeof id === "number" ? id : null;
      send({ jsonrpc: "2.0", id: validId, error: { code: -32600, message: "invalid request" } });
      continue;
    }

    const request = parsed as JsonRpcRequest;

    switch (request.method) {
      case "initialize":
        await handleInitialize(request.id, app);
        break;

      case "notifications/initialized":
        // Notification: no response expected.
        break;

      case "ping":
        reply(request.id, {});
        break;

      case "tools/list":
        handleToolsList(request.id, tools, gateTools);
        break;

      case "tools/call": {
        const id = request.id;
        if (id !== undefined) inFlightCallIds.add(id);
        // Not awaited: queuing (not blocking) this call keeps the loop free to read and
        // answer the next line — a ping, a cancellation, another tools/list.
        callQueue = callQueue
          .then(() => {
            // Cancelled while still queued: never start it.
            if (id !== undefined && cancelledIds.delete(id)) return undefined;
            return handleToolsCall(request, app, tools, gateTools, gateCommands, gateHelp);
          })
          .catch((error) => {
            // handleToolsCall answers its own failures; this only guards a throw from
            // dispatch itself so one bad call cannot break every call queued behind it.
            replyError(id, -32603, error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            if (id !== undefined) inFlightCallIds.delete(id);
          });
        break;
      }

      case "notifications/cancelled": {
        // Notification: no reply to this message itself. Answers the CALL it names
        // instead, immediately, without waiting for it — see cancelledIds above.
        const requestId = (request.params ?? {}).requestId;
        if (
          (typeof requestId === "string" || typeof requestId === "number")
          && inFlightCallIds.has(requestId)
          && !cancelledIds.has(requestId)
        ) {
          cancelledIds.add(requestId);
          send({
            jsonrpc: "2.0",
            id: requestId,
            result: { isError: true, content: [{ type: "text", text: "cancelled" }] },
          });
        }
        break;
      }

      default:
        replyError(request.id, -32601, `method not found: ${request.method}`);
    }
  }

  // stdin closed; the last queued tools/call may still be running (every link already
  // catches its own rejection above, so this never throws). The caller's own await of
  // serveMcp() must answer for it too, not return while it is still in flight.
  await callQueue;
}
