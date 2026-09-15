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
import { mcpCommands, type AppCommand, type AppDefinition } from "../core/app.ts";
import type { GateCommand } from "./gate.ts";
import { createContext } from "../core/context.ts";
import { useRecipesDir } from "../service/recipe.ts";
import { recipesDir } from "../runtime/deployment.ts";
import { ensureEnvironment } from "./provision.ts";
import { UserError } from "../core/log.ts";
import { withOutputSink } from "../core/output.ts";
import { structuredResult, toolDescription, inputSchema, validate, toArgv, STRUCTURED_OUTPUT_SCHEMA } from "./mcp-schema.ts";

export * from "./mcp-schema.ts";

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
        // Never String(params.name ?? "") — an object whose toString is not callable (e.g.
        // {"toString": null}) makes String() throw ("Cannot convert object to primitive
        // value"), and nothing here catches it: the whole process would exit, answering
        // neither this request nor any queued after it. Anything not already a string is
        // simply not a valid tool name, reported the same way as any other unknown one.
        const name = typeof params.name === "string" ? params.name : "";
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
