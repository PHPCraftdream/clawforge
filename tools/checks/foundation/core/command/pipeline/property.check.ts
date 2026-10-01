// The property check of the command spec: every argument that declares `choices` or `parse`,
// given a value it must refuse, is refused by the ONE pipeline at the `parse` stage — on the
// console and on MCP alike — before anything is read, locked or contacted.
//
// Everything is derived from the declarations of openclawCommands (a new command or action is
// covered the moment it is declared; there is no per-command list and no exclusion):
//   argv = the action word + an example for every preceding positional (choices[0], the
//          parser's `example`, else "x") + the argument carrying its `invalidExample`
//          (for `choices`: a value outside the list; an option without `parse`: an empty value).
// Expected, per case: stage "parse", an ArgumentError whose `argument` is that argument's name,
// zero transport contacts, and the {"error":…} document only when the chosen action declares a
// `json` flag (then `--json` rides argv; on MCP no document is ever printed).
//
// MCP's toArgv drops an empty string (the caller did not give the value), so an empty value
// has no MCP case by construction — that is the surface's rule, not an exclusion of a command.

import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError, UnknownActionError, specData } from "#framework/core/command/index.ts";
import type { ArgumentSpec } from "#framework/core/command/index.ts";
import { specOf } from "#framework/core/command/spec.ts";
import { toArgv, validate } from "#framework/integration/mcp/call.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

const app: AppDefinition = { name: "property-fixture", description: "fixture", commands: openclawCommands };

/** Every contact point records; nothing is expected to be reached before `run`. */
function recordingTransport(): { transport: Transport; contacts: string[] } {
  const contacts: string[] = [];
  const transport = new Proxy({}, {
    get: (_target, property) => (...args: unknown[]) => {
      contacts.push(`${String(property)} ${args.map(String).join(" ")}`);
      throw new Error("property check: the transport must not be contacted");
    },
  }) as unknown as Transport;
  return { transport, contacts };
}

interface Unit {
  readonly label: string;
  readonly command: string;
  readonly action?: string;
  readonly args: readonly ArgumentSpec[];
}

const units: Unit[] = [];
for (const [command, declaration] of Object.entries(openclawCommands)) {
  const entry = specOf(declaration);
  checkTrue(`${command} is a declared body`, entry !== undefined);
  if (entry === undefined) continue;
  const data = specData(entry);
  if (data.kind === "single") units.push({ label: command, command, args: data.arguments });
  else for (const [action, spec] of Object.entries(data.actions)) units.push({ label: `${command} ${action}`, command, action, args: spec.arguments });
}

function exampleOf(argument: ArgumentSpec): string {
  if (argument.kind === "positional" || argument.kind === "option") {
    if (argument.choices !== undefined) return argument.choices[0];
    if (argument.parse !== undefined) return argument.parse.example;
  }
  return "x";
}

/** The value the argument must refuse, or undefined when it refuses nothing by declaration. */
function invalidOf(argument: ArgumentSpec): string | undefined {
  if (argument.kind !== "positional" && argument.kind !== "option") return undefined;
  if (argument.choices !== undefined) {
    let outside = "outside-the-list";
    while (argument.choices.includes(outside)) outside += "-x";
    return outside;
  }
  if (argument.parse !== undefined) return argument.parse.invalidExample;
  return argument.kind === "option" ? "" : undefined;
}

async function runCase(command: string, argv: string[], surface: "terminal" | "mcp") {
  const { transport, contacts } = recordingTransport();
  let output = "";
  const execution = await withOutputSink((chunk) => {
    output += chunk;
  }, () => executeCommand(app, command, argv, { surface, transport }));
  return { execution, output, contacts };
}

let cases = 0;
for (const unit of units) {
  const declaresJson = unit.args.some((argument) => argument.name === "json" && argument.kind === "flag");
  const positionals = unit.args.filter((argument) => argument.kind === "positional");
  const lead = unit.action === undefined ? [] : [unit.action];

  for (const argument of unit.args) {
    const invalid = invalidOf(argument);
    if (invalid === undefined) continue;
    const preceding = positionals.slice(0, positionals.indexOf(argument as typeof positionals[number]));
    const name = `${unit.label}: ${argument.kind === "positional" ? `<${argument.name}>` : `--${argument.name}`} ${JSON.stringify(invalid)}`;

    const argv = [
      ...lead,
      ...preceding.map(exampleOf),
      ...(argument.kind === "positional" ? [invalid] : [`--${argument.name}`, invalid]),
      ...(declaresJson ? ["--json"] : []),
    ];
    const terminal = await runCase(unit.command, argv, "terminal");
    cases += 1;
    check(`${name}: console stops at the parse stage`, terminal.execution.stage, "parse");
    checkTrue(`${name}: console error is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
    check(`${name}: console error names the argument`, (terminal.execution.error as ArgumentError).argument, argument.name);
    check(`${name}: console never contacts the target`, terminal.contacts, []);
    if (declaresJson) {
      const document = JSON.parse(terminal.output) as { error?: { message?: unknown } };
      checkTrue(`${name}: --json gets the error document`, typeof document.error?.message === "string");
    } else check(`${name}: no --json document without a json flag`, terminal.output, "");

    if (invalid === "") continue;
    const mcpArgs: Record<string, unknown> = {
      ...(unit.action === undefined ? {} : { action: unit.action }),
      ...Object.fromEntries(preceding.map((other) => [other.name, exampleOf(other)])),
      [argument.name]: invalid,
      ...(declaresJson ? { json: true } : {}),
    };
    const declaration = openclawCommands[unit.command];
    check(`${name}: the MCP argument object is well-formed`, validate(declaration, mcpArgs), []);
    const mcp = await runCase(unit.command, toArgv(declaration, mcpArgs), "mcp");
    cases += 1;
    check(`${name}: MCP stops at the parse stage`, mcp.execution.stage, "parse");
    checkTrue(`${name}: MCP error is an ArgumentError`, mcp.execution.error instanceof ArgumentError);
    check(`${name}: MCP error names the argument`, (mcp.execution.error as ArgumentError).argument, argument.name);
    check(`${name}: MCP never contacts the target`, mcp.contacts, []);
    check(`${name}: MCP prints no document`, mcp.output, "");
  }
}

// The action word is an argument with choices too: an unknown one is refused the same way
// and, being an unknown argument, never gets the --json document.
for (const [command, declaration] of Object.entries(openclawCommands)) {
  const data = specData(specOf(declaration)!);
  if (data.kind !== "multi") continue;
  const word = "outside-the-actions";
  const terminal = await runCase(command, [word, "--json"], "terminal");
  cases += 1;
  check(`${command} ${word}: stops at the parse stage`, terminal.execution.stage, "parse");
  checkTrue(`${command} ${word}: is an UnknownActionError`, terminal.execution.error instanceof UnknownActionError);
  check(`${command} ${word}: never contacts the target`, terminal.contacts, []);
  check(`${command} ${word}: prints no --json document`, terminal.output, "");
  const mcp = await runCase(command, toArgv(declaration, { action: word }), "mcp");
  check(`${command} ${word}: MCP stops at the parse stage`, mcp.execution.stage, "parse");
  checkTrue(`${command} ${word}: MCP error is an UnknownActionError`, mcp.execution.error instanceof UnknownActionError);
  check(`${command} ${word}: MCP never contacts the target`, mcp.contacts, []);
}

checkTrue("the property check derived cases from the declarations", cases > 0);

finish("pipeline: property — every declared value rule refuses at parse");
