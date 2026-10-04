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
import type { ArgumentRule, ArgumentSpec } from "#framework/core/command/index.ts";
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
  readonly rules: readonly ArgumentRule[];
  readonly refuse: Readonly<Record<string, string>>;
}

const units: Unit[] = [];
for (const [command, declaration] of Object.entries(openclawCommands)) {
  const entry = specOf(declaration);
  checkTrue(`${command} is a declared body`, entry !== undefined);
  if (entry === undefined) continue;
  const data = specData(entry);
  if (data.kind === "single") units.push({ label: command, command, args: data.arguments, rules: data.rules ?? [], refuse: data.refuse ?? {} });
  else for (const [action, spec] of Object.entries(data.actions)) units.push({ label: `${command} ${action}`, command, action, args: spec.arguments, rules: spec.rules ?? [], refuse: spec.refuse ?? {} });
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

// Missing required arguments, derived from the declaration (requiredness is declared once,
// so the parser refuses at parse on every surface — a hand-written prepare-stage usage line
// where the declaration says required slips past the value cases above).
for (const unit of units) {
  const lead = unit.action === undefined ? [] : [unit.action];
  const positionals = unit.args.filter((argument) => argument.kind === "positional");
  const required = unit.args.filter((argument) => argument.kind !== "flag" && argument.kind !== "variadic" && argument.required === true);
  for (const argument of required) {
    const dropped = argument.kind === "positional";
    const kept = dropped ? positionals.slice(0, positionals.indexOf(argument)) : positionals;
    const others = unit.args.filter((other) => other.kind === "option" && other !== argument);
    const name = `${unit.label}: missing required ${dropped ? `<${argument.name}>` : `--${argument.name}`}`;
    const argv = [...lead, ...kept.map(exampleOf), ...others.flatMap((other) => [`--${other.name}`, exampleOf(other)])];
    const terminal = await runCase(unit.command, argv, "terminal");
    cases += 1;
    check(`${name}: console stops at the parse stage`, terminal.execution.stage, "parse");
    checkTrue(`${name}: console error is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
    check(`${name}: console error names the argument`, (terminal.execution.error as ArgumentError).argument, argument.name);
    check(`${name}: console never contacts the target`, terminal.contacts, []);

    const mcpArgs: Record<string, unknown> = {
      ...(unit.action === undefined ? {} : { action: unit.action }),
      ...Object.fromEntries(kept.map((other) => [other.name, exampleOf(other)])),
      ...Object.fromEntries(others.map((other) => [other.name, exampleOf(other)])),
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

// Declared presence rules and variadic counts refuse at parse on both surfaces, derived
// from the declarations: the same one pipeline enforces the rules before any phase runs.
for (const unit of units) {
  if (unit.rules.length === 0 && !unit.args.some((argument) => argument.kind === "variadic" && argument.count !== undefined)) continue;
  const lead = unit.action === undefined ? [] : [unit.action];
  const declaresJson = unit.args.some((argument) => argument.name === "json" && argument.kind === "flag");
  const declaration = openclawCommands[unit.command];
  const declaredNames = new Set((declaration.arguments ?? []).map((argument) => argument.name));
  const byName = new Map(unit.args.map((argument) => [argument.name, argument] as const));
  interface GivenEntry {
    readonly argument: ArgumentSpec;
    readonly values?: number;
  }
  interface RuleCase {
    readonly name: string;
    readonly given: readonly GivenEntry[];
    readonly members: readonly string[];
  }
  const ruleCases: RuleCase[] = [];
  for (const rule of unit.rules) {
    if (rule.rule === "requires") {
      ruleCases.push({ name: `${unit.label}: rule requires --${rule.name}`, given: [{ argument: byName.get(rule.name)! }], members: [rule.name, ...rule.with] });
    } else if (rule.rule === "conflicts") {
      for (const member of rule.with) {
        ruleCases.push({ name: `${unit.label}: rule conflicts --${rule.name} with --${member}`, given: [{ argument: byName.get(rule.name)! }, { argument: byName.get(member)! }], members: [rule.name, ...rule.with] });
      }
    } else {
      const members = rule.groups.flat();
      const valuesOf = (name: string): GivenEntry => {
        const argument = byName.get(name)!;
        return { argument, ...(argument.kind === "variadic" && argument.count !== undefined ? { values: argument.count } : {}) };
      };
      ruleCases.push({ name: `${unit.label}: rule oneOf mixes its first two groups`, given: [...rule.groups[0]!.map(valuesOf), valuesOf(rule.groups[1]![0]!)], members });
      for (const group of rule.groups) {
        if (group.length < 2) continue;
        ruleCases.push({ name: `${unit.label}: rule oneOf gives only the first of a ${group.length}-member group`, given: [valuesOf(group[0]!)], members });
      }
      if (rule.required === true) ruleCases.push({ name: `${unit.label}: rule oneOf gives no group at all`, given: [], members });
    }
  }
  for (const argument of unit.args) {
    if (argument.kind !== "variadic" || argument.count === undefined) continue;
    ruleCases.push({ name: `${unit.label}: --${argument.name} gets fewer than its ${argument.count} values`, given: [{ argument, values: argument.count - 1 }], members: [argument.name] });
    ruleCases.push({ name: `${unit.label}: --${argument.name} gets more than its ${argument.count} values`, given: [{ argument, values: argument.count + 1 }], members: [argument.name] });
  }
  for (const kase of ruleCases) {
    const givenNames = new Set(kase.given.map((entry) => entry.argument.name));
    // Required positionals/variadics/options the case does not give itself, so `bind`'s
    // missing-required refusal stays out of the way and the RULE is what fires.
    const extras: GivenEntry[] = unit.args.filter((argument) =>
      !givenNames.has(argument.name)
      && (argument.kind === "positional" || ((argument as { required?: boolean }).required === true && argument.kind !== "flag"))).map((argument) => ({ argument }));
    const argv = [
      ...lead,
      ...[...extras, ...kase.given].filter((entry) => entry.argument.kind === "positional").map(({ argument }) => exampleOf(argument)),
      ...[...extras, ...kase.given].filter((entry) => entry.argument.kind === "flag").map(({ argument }) => `--${argument.name}`),
      ...[...extras, ...kase.given].filter((entry) => entry.argument.kind === "option").flatMap(({ argument }) => [`--${argument.name}`, exampleOf(argument)]),
      ...[...extras, ...kase.given].filter((entry) => entry.argument.kind === "variadic").flatMap(({ argument, values }) => Array.from({ length: values ?? (argument as { count?: number }).count ?? 1 }, () => exampleOf(argument))),
      ...(declaresJson ? ["--json"] : []),
    ];
    const terminal = await runCase(unit.command, argv, "terminal");
    cases += 1;
    check(`${kase.name}: console stops at the parse stage`, terminal.execution.stage, "parse");
    checkTrue(`${kase.name}: console error is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
    checkTrue(`${kase.name}: the error names a member of the rule`, kase.members.includes((terminal.execution.error as ArgumentError).argument ?? ""));
    check(`${kase.name}: console never contacts the target`, terminal.contacts, []);
    if (declaresJson) {
      const document = JSON.parse(terminal.output) as { error?: { message?: unknown } };
      checkTrue(`${kase.name}: --json gets the error document`, typeof document.error?.message === "string");
    } else check(`${kase.name}: no --json document without a json flag`, terminal.output, "");

    // MCP twin from the same arguments object; a rule member the merged view does not carry
    // (set's variadic is per-action) has no MCP case by construction.
    if (kase.members.some((name) => !declaredNames.has(name))) continue;
    const mcpArgs: Record<string, unknown> = {
      ...(unit.action === undefined ? {} : { action: unit.action }),
      ...Object.fromEntries([...extras, ...kase.given].filter((entry) => entry.argument.kind === "option" || entry.argument.kind === "positional").map(({ argument }) => [argument.name, exampleOf(argument)])),
      ...Object.fromEntries([...extras, ...kase.given].filter((entry) => entry.argument.kind === "flag").map(({ argument }) => [argument.name, true])),
      ...Object.fromEntries([...extras, ...kase.given].filter((entry) => entry.argument.kind === "variadic").map(({ argument, values }) => [argument.name, Array.from({ length: values ?? (argument as { count?: number }).count ?? 1 }, () => exampleOf(argument))])),
      ...(declaresJson ? { json: true } : {}),
    };
    const mcp = await runCase(unit.command, toArgv(declaration, mcpArgs), "mcp");
    cases += 1;
    check(`${kase.name}: MCP stops at the parse stage`, mcp.execution.stage, "parse");
    checkTrue(`${kase.name}: MCP error is an ArgumentError`, mcp.execution.error instanceof ArgumentError);
    checkTrue(`${kase.name}: MCP error names a member of the rule`, kase.members.includes((mcp.execution.error as ArgumentError).argument ?? ""));
    check(`${kase.name}: MCP never contacts the target`, mcp.contacts, []);
    check(`${kase.name}: MCP prints no document`, mcp.output, "");
  }
}

// A declared `refuse` token is refused by the one pipeline before any tokenizing, with the
// declaration's own reason — on the console. (MCP's toArgv binds values inline —
// `--funnel=x` — so the bare refused token is a console shape by construction.)
for (const unit of units) {
  for (const [token, reason] of Object.entries(unit.refuse)) {
    const terminal = await runCase(unit.command, [...(unit.action === undefined ? [] : [unit.action]), token], "terminal");
    cases += 1;
    check(`${unit.label} ${token}: stops at the parse stage`, terminal.execution.stage, "parse");
    checkTrue(`${unit.label} ${token}: is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
    check(`${unit.label} ${token}: is refused with the declared reason`, (terminal.execution.error as Error).message, reason);
    check(`${unit.label} ${token}: never contacts the target`, terminal.contacts, []);
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
