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
import { ArgumentError, UnknownActionError, appliesToMessage, bind, requiredArgumentRefusal, specData, tokenize } from "#framework/core/command/index.ts";
import type { ArgumentRule, ArgumentSpec } from "#framework/core/command/index.ts";
import { specOf } from "#framework/core/command/spec.ts";
import { gateConfirmationRefusal, positionalDashMessage, toArgv, validate } from "#framework/integration/mcp/call.ts";
import { inputSchema } from "#framework/integration/mcp/server.ts";
import { CONFIRM_REQUIRED, effectProfile } from "#framework/core/command/index.ts";
import { commandRegistry } from "#framework/integration/gate.ts";
import { checkoutGate, installedGate } from "#framework/entry/registry.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

const app: AppDefinition = { name: "property-fixture", description: "fixture", commands: openclawCommands };

/** Every contact point records; nothing is expected to be reached before `run`. */
const TRANSPORT_SENTINEL = "property check: the transport must not be contacted";
function recordingTransport(): { transport: Transport; contacts: string[] } {
  const contacts: string[] = [];
  const transport = new Proxy({}, {
    get: (_target, property) => (...args: unknown[]) => {
      contacts.push(`${String(property)} ${args.map(String).join(" ")}`);
      throw new Error(TRANSPORT_SENTINEL);
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

async function runCase(command: string, argv: string[], surface: "terminal" | "mcp", on: AppDefinition = app) {
  const { transport, contacts } = recordingTransport();
  let output = "";
  const execution = await withOutputSink((chunk) => {
    output += chunk;
  }, () => executeCommand(on, command, argv, { surface, transport }));
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
    check(`${name}: one voice on both surfaces`, (mcp.execution.error as Error).message, (terminal.execution.error as Error).message);
  }
}

// The structural guard of the class: argument facts are settled at the parse or prepare
// stage, never after the context is built — by then a real host has already read the target
// (WSL: /etc/wsl.conf) or refused it (LOCAL_TARGET_UNSUPPORTED), either of which masks the
// refusal of the argument itself. Derived from the declarations alone: every value-taking
// argument carries a value a grammar of this framework refuses — a declared grammar
// invalidExample, else the shape every safeName grammar refuses — and a failure that happens
// at the context or run stage must not be an argument refusal. (A grammar-less argument
// whose run-stage refusal has fresh wording is not derivable from the declaration; declaring
// its parser is the fix, and the value section above then pins it to the parse stage. On a
// host where the context cannot be built at all (no deployment, an unsupported location) the
// run stage is unreachable — the context refusal then masks any later grammar refusal, which
// is exactly the masking this finding describes — so there the value section above carries the
// assertion, with its zero-contact and both-surface checks.)
const ARGUMENT_REFUSAL_SHAPE = /^invalid .+ (name|id) "/;
function isArgumentShaped(error: unknown, label: string): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof ArgumentError) return true;
  return error.message.startsWith(label) || ARGUMENT_REFUSAL_SHAPE.test(error.message);
}
for (const unit of units) {
  const lead = unit.action === undefined ? [] : [unit.action];
  const positionals = unit.args.filter((argument) => argument.kind === "positional");
  const options = unit.args.filter((argument) => argument.kind === "option");
  const declaresJson = unit.args.some((argument) => argument.name === "json" && argument.kind === "flag");
  for (const argument of [...positionals, ...options]) {
    const declared = invalidOf(argument);
    // An empty string is the no-parser convention (the empty value refusal), not a grammar:
    // the sweep needs a value the grammar-less argument itself cannot survive.
    const invalid = declared === undefined || declared === "" ? "Bad_Name" : declared;
    const label = argument.kind === "positional" ? `<${argument.name}>` : `--${argument.name}`;
    const name = `${unit.label}: ${label} ${JSON.stringify(invalid)} refused no later than prepare`;
    const argv = [
      ...lead,
      ...positionals.map((other) => (other === argument ? invalid : exampleOf(other))),
      ...options.flatMap((other) => [`--${other.name}`, other === argument ? invalid : exampleOf(other)]),
      ...(declaresJson ? ["--json"] : []),
    ];
    const terminal = await runCase(unit.command, argv, "terminal");
    cases += 1;
    if (terminal.execution.stage === "context" || terminal.execution.stage === "run") {
      checkTrue(`${name}: not an argument refusal after the context`, !isArgumentShaped(terminal.execution.error, label));
    }
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

// A variadic given while a required positional (or the action word) is omitted: toArgv puts
// the variadic after a bare `--`, where the tokenizer would fill the gap from its first word,
// so the call must be refused before anything runs — by validate on MCP, by the parser's own
// refusal of the shifted word on the console (checked where the omitted slot has choices).
for (const unit of units) {
  const variadic = unit.args.find((argument) => argument.kind === "variadic");
  if (variadic === undefined) continue;
  const declaration = openclawCommands[unit.command];
  const positionals = unit.args.filter((argument) => argument.kind === "positional");
  const values = Array.from({ length: (variadic as { count?: number }).count ?? 1 }, () => exampleOf(variadic));
  const omissions: Array<{ readonly name: string; readonly choices?: readonly string[] }> = [
    ...(unit.action === undefined ? [] : [{ name: "action" }]),
    ...positionals.filter((argument) => argument.required === true).map((argument) => ({ name: argument.name, choices: (argument as { choices?: readonly string[] }).choices })),
  ];
  for (const omitted of omissions) {
    const name = `${unit.label}: <${variadic.name}…> given, <${omitted.name}> omitted`;
    const mcpArgs: Record<string, unknown> = {
      ...(unit.action === undefined || omitted.name === "action" ? {} : { action: unit.action }),
      ...Object.fromEntries(positionals.filter((other) => other.name !== omitted.name).map((other) => [other.name, exampleOf(other)])),
      [variadic.name]: values,
    };
    const omittedArgument = positionals.find((argument) => argument.name === omitted.name);
    checkTrue(`${name}: MCP validate refuses in the binder voice`, omittedArgument === undefined
      || validate(declaration, mcpArgs, { name: unit.command }).includes(requiredArgumentRefusal(omittedArgument, `${unit.command} ${unit.action ?? ""}`.trim())));
    if (omitted.name !== "action" && omitted.choices === undefined) continue;
    const argv = [
      ...(unit.action === undefined || omitted.name === "action" ? [] : [unit.action]),
      ...positionals.filter((other) => other.name !== omitted.name).map(exampleOf),
      ...values,
    ];
    const terminal = await runCase(unit.command, argv, "terminal");
    cases += 1;
    check(`${name}: console stops at the parse stage`, terminal.execution.stage, "parse");
    check(`${name}: console never contacts the target`, terminal.contacts, []);
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

// The operand of `recipe` is declared required per action, so the bare action word is refused
// at parse on both surfaces — not by a usage line thrown in `run`, after the context (on a WSL
// target: after /etc/wsl.conf was read). Only `list` takes none. Class: no run-stage operand refusal.
for (const unit of units.filter((candidate) => candidate.command === "recipe" && candidate.action !== undefined)) {
  const needsName = unit.args.some((argument) => argument.name === "name");
  check(`${unit.label}: only list takes no <name>`, needsName, unit.action !== "list");
  if (!needsName) continue;
  const declaration = openclawCommands.recipe;
  const terminal = await runCase("recipe", [unit.action!], "terminal");
  cases += 1;
  check(`${unit.label}: bare, console stops at the parse stage`, terminal.execution.stage, "parse");
  check(`${unit.label}: bare, console error names <name>`, (terminal.execution.error as ArgumentError).argument, "name");
  check(`${unit.label}: bare, console never contacts the target`, terminal.contacts, []);
  const mcp = await runCase("recipe", toArgv(declaration, { action: unit.action }), "mcp");
  cases += 1;
  check(`${unit.label}: bare, MCP stops at the parse stage`, mcp.execution.stage, "parse");
  check(`${unit.label}: bare, MCP never contacts the target`, mcp.contacts, []);
}

// A positional value that begins with a dash would be bound as a flag by the tokenizer (toArgv
// emits positionals bare): validate refuses it for every declared positional, on MCP.
for (const unit of units) {
  const declaration = openclawCommands[unit.command];
  for (const argument of unit.args.filter((candidate) => candidate.kind === "positional")) {
    for (const value of ["--json", "-x"]) {
      const mcpArgs = { ...(unit.action === undefined ? {} : { action: unit.action }), [argument.name]: value };
      check(`${unit.label}: <${argument.name}> ${value}: MCP validate refuses`, validate(declaration, mcpArgs).includes(positionalDashMessage(argument.name)), true);
    }
  }
}
for (const [command, args] of [["accept", { recipe: "--with-model" }], ["restore", { archive: "--dry-run" }], ["operations", { id: "--json" }]] as const) {
  check(`${command} ${JSON.stringify(args)}: MCP validate refuses it`, validate(openclawCommands[command], args).length, 1);
}

// A read-effect flag lowers the call to read, which skips the MCP confirm stage: every pair of
// a read flag and a flag of another effect in one action must be refused at parse, on both
// surfaces, so the stronger flag's action can never run unconfirmed (derived from the effects).
for (const unit of units) {
  const flags = unit.args.filter((argument): argument is ArgumentSpec & { kind: "flag"; effect?: string } => argument.kind === "flag");
  const declaration = openclawCommands[unit.command];
  for (const read of flags.filter((flag) => flag.effect === "read")) {
    for (const other of flags.filter((flag) => flag.effect !== undefined && flag.effect !== "read")) {
      const name = `${unit.label}: --${read.name} (read) with --${other.name} (${other.effect})`;
      const extras = unit.args.filter((argument) => argument.kind === "positional" || (argument.kind === "option" && argument.required === true));
      const mcpArgs: Record<string, unknown> = {
        ...(unit.action === undefined ? {} : { action: unit.action }),
        ...Object.fromEntries(extras.map((argument) => [argument.name, exampleOf(argument)])),
        [read.name]: true,
        [other.name]: true,
      };
      const mcp = await runCase(unit.command, toArgv(declaration, mcpArgs), "mcp");
      cases += 1;
      check(`${name}: MCP stops at the parse stage, not past the confirm stage`, mcp.execution.stage, "parse");
      checkTrue(`${name}: MCP error is an ArgumentError`, mcp.execution.error instanceof ArgumentError);
      check(`${name}: MCP never contacts the target`, mcp.contacts, []);
    }
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

// --- gate commands: effect declared, destructive confirmed, required enforced -----------------
//
// Every registry entry of origin "gate", from both gates: the effect is declared once, the
// MCP tool schema's confirm field derives from it, a destructive gate command's tool call is
// refused without confirm: true before anything runs, and required arguments are refused the
// same way the deployment's commands are.
for (const gate of [checkoutGate(), installedGate("<app-root>")]) {
  const registry = commandRegistry({ deployment: {}, gate, appName: "property-fixture" });
  for (const entry of registry.entries) {
    if (entry.origin !== "gate" || entry.gate === undefined) continue;
    const command = entry.gate;
    check(`${entry.name}: the effect is declared`, ["read", "change", "destroy"].includes(command.effect), true);
    const profile = effectProfile(command);
    const schema = inputSchema(command) as { properties: Record<string, unknown>; required: string[] };
    if (profile.destructive) {
      checkTrue(`${entry.name}: the MCP schema declares confirm`, schema.properties.confirm !== undefined);
      if (profile.alwaysDestroys) checkTrue(`${entry.name}: confirm is required in the schema`, schema.required.includes("confirm"));
      check(`${entry.name}: an MCP call without confirm is refused`, gateConfirmationRefusal(entry.name, command, {})?.includes(CONFIRM_REQUIRED), true);
      check(`${entry.name}: confirm: true answers no refusal`, gateConfirmationRefusal(entry.name, command, { confirm: true }), undefined);
    } else {
      checkTrue(`${entry.name}: a non-destructive gate command declares no confirm`, schema.properties.confirm === undefined);
      check(`${entry.name}: no refusal without confirm`, gateConfirmationRefusal(entry.name, command, {}), undefined);
    }
    for (const argument of command.arguments ?? []) {
      if (argument.required !== true) continue;
      let consoleRefusal: string | undefined;
      try {
        bind(command.arguments as readonly ArgumentSpec[], tokenize(command.arguments as readonly ArgumentSpec[], []), { command: entry.name });
      } catch (error) {
        consoleRefusal = (error as Error).message;
      }
      check(`${entry.name}: a missing required ${argument.name} reads as the console refusal`, validate(command, {}, { name: entry.name })[0], consoleRefusal);
    }
  }
}

// One voice for `choices`: for every declared choices argument of every gate command, the
// MCP validate's problem is byte-identical to what the console dispatch throws for the same
// argument and value — the parser's own refusal, one shared builder (review R17).
for (const gate of [checkoutGate(), installedGate("<app-root>")]) {
  for (const entry of gate) {
    for (const argument of entry.arguments ?? []) {
      const choices = (argument as { choices?: readonly string[] }).choices;
      if (choices === undefined || (argument.kind !== "option" && argument.kind !== "positional")) continue;
      let value = "outside-the-list";
      while (choices.includes(value)) value += "-x";
      let consoleRefusal: string | undefined;
      try {
        bind(entry.arguments as readonly ArgumentSpec[], tokenize(entry.arguments as readonly ArgumentSpec[], argument.kind === "positional" ? [value] : [`--${argument.name}`, value]), { command: entry.name });
      } catch (error) {
        consoleRefusal = (error as Error).message;
      }
      check(`${entry.name} ${argument.name}: one choices voice`, validate(entry, { [argument.name]: value }), [consoleRefusal ?? ""]);
    }
  }
}

// One scope for positionals: the MCP view offers the positionals of a spec command per
// action, like the console does. Derived from the declarations for every multi-action
// command: a positional another action declares is refused with an applies-to refusal, a
// positional given past an absent earlier slot is refused in the binder required voice,
// and toArgv emits the positionals of the chosen action, in its own order (review R18).
let scoped = 0;
const positionalsByCommand = new Map<string, Map<string, ArgumentSpec[]>>();
for (const unit of units) {
  if (unit.action === undefined) continue;
  const byAction = positionalsByCommand.get(unit.command) ?? new Map<string, ArgumentSpec[]>();
  byAction.set(unit.action, unit.args.filter((argument) => argument.kind === "positional"));
  positionalsByCommand.set(unit.command, byAction);
}
for (const [command, byAction] of positionalsByCommand) {
  const declaration = openclawCommands[command];
  for (const [action, own] of byAction) {
    const foreign = (declaration.arguments ?? []).filter((argument) => argument.kind === "positional" && argument.name !== "action")
      .find((argument) => !own.some((entry) => entry.name === argument.name));
    if (foreign !== undefined) {
      scoped += 1;
      check(`${command} ${action}: a positional of another action is refused`, validate(declaration, { action, [foreign.name]: exampleOf(foreign) }, { name: command }), [appliesToMessage(foreign.name, (foreign as { actions?: readonly string[] }).actions ?? [], action)]);
    }
    const first = own[0];
    const last = own[own.length - 1];
    if (own.length >= 2 && first !== undefined && (first as { required?: boolean }).required === true && last !== undefined) {
      scoped += 1;
      let consoleRefusal: string | undefined;
      try {
        bind(own, tokenize(own, []), { command, action });
      } catch (error) {
        consoleRefusal = (error as Error).message;
      }
      check(`${command} ${action}: a positional past an absent earlier slot reads as the console refusal`, validate(declaration, { action, [last.name]: exampleOf(last) }, { name: command })[0], consoleRefusal);
    }
    if (own.length > 0) {
      scoped += 1;
      const scopedArgs: Record<string, unknown> = { action, ...Object.fromEntries(own.map((argument) => [argument.name, exampleOf(argument)])) };
      check(`${command} ${action}: toArgv emits the action's own positionals in its own order`, toArgv(declaration, scopedArgs).slice(1), own.map(exampleOf));
    }
  }
}
checkTrue("the property check derived positional-scope cases from the declarations", scoped > 0);

checkTrue("the property check derived cases from the declarations", cases > 0);

finish("pipeline: property — every declared value rule refuses at parse");
