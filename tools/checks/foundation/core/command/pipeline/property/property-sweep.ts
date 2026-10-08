// Shared scaffolding for the pipeline property sweeps: the fixture, the artifact control,
// the units derived from the declarations, and the case helpers. The runner gives each check
// file its own process, so this module's fixture and tally are per-process.

import { executeBody, executeCommand } from "#framework/core/command/execute.ts";
import { specData } from "#framework/core/command/index.ts";
import type { ArgumentRule, ArgumentSpec } from "#framework/core/command/index.ts";
import { specOf, commandBody, defineAction, materializeCommands, multiActionBody, type LocalFact, type ParsedCall } from "#framework/core/command/spec.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { AppCommand, AppDefinition } from "#framework/core/app.ts";
import { checkTrue } from "#checks/kit/harness.ts";
import { createDeploymentFixture, stageTally } from "#checks/kit/deployment-fixture.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { checkoutGateCommands } from "#framework/entry/checkout-gate.ts";
import { makeVersionGateCommand } from "#framework/integration/version.ts";
import { makeCompletionGateCommand } from "#framework/integration/completion/index.ts";
import { makeInitGateCommand } from "#framework/integration/deployment/init.ts";
import type { CommandBody } from "#framework/core/command/spec.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { checksumOf } from "#framework/service/checksums.ts";
import type { SetManifest } from "#framework/set/artifacts/model.ts";
import { packArtifact } from "#checks/sets/pack.ts";

useLinuxHost();
export const fixture = await createDeploymentFixture();

// A control artifact packed by the kit's own assembler: genuinely valid, so the control
// stays valid if the artifact gate ever moves its full check into prepare.
export const controlManifest: SetManifest = {
  version: 1, name: "control", requires: { framework: "0.1.0", image: `image@sha256:${"a".repeat(64)}` },
  files: { "config/desired-state.json": checksumOf("[]") }, recipes: {}, secrets: [], acceptance: {},
};
const artifactTree = join(fixture.root, "control-tree");
await mkdir(join(artifactTree, "config"), { recursive: true });
await writeFile(join(artifactTree, "config", "desired-state.json"), "[]");
export const controlArtifact = join(fixture.root, "control-artifact.tar.gz");
await packArtifact(artifactTree, controlManifest, controlArtifact);

export const stages = stageTally();

export const app: AppDefinition = { name: "property-fixture", description: "fixture", commands: openclawCommands };

/** A capture deployment: every openclawCommands command re-declared with the SAME arguments,
 *  rules and refuse tokens but a recording run, so a row can compare the bound call the
 *  pipeline ACTUALLY passed to run (values, action, given) between the console's argv and an
 *  MCP named call. Per command, exactly this is substituted: effect forced to "read" (no
 *  confirm gate), prepare replaced by a pass-through, run replaced by a recorder, refuse
 *  tokens kept, localFacts and value-kind resolve steps dropped (a resolve reads local facts,
 *  e.g. an artifact path must exist), and needs left undeclared — it defaults to "target", but
 *  the recording transport is only consulted if a fact probes it, and since localFacts are
 *  dropped no command ever does. Arguments and rules are kept verbatim; the parse/bind
 *  machinery is the product's own. */
export interface CapturedCall {
  readonly command: string;
  readonly action?: string;
  readonly values: Record<string, unknown>;
  readonly given: readonly string[];
}
// The argument without its kind's resolve step (the parse/bind grammar is kept).
const unresolved = (args: readonly unknown[] | undefined): unknown[] => (args ?? []).map((arg) => {
  const value = (arg as { value?: { resolve?: unknown } }).value;
  if (value?.resolve === undefined) return arg;
  const kind: Record<string, unknown> = { ...value };
  delete kind.resolve;
  return { ...(arg as object), value: kind };
});

export function captureApp(captured: CapturedCall[]): AppDefinition {
  const record = (command: string, action: string | undefined, plan: ParsedCall<Record<string, unknown>>): void => {
    captured.push({ command, ...(action === undefined ? {} : { action }), values: plan.values, given: plan.given });
  };
  const commands: Record<string, AppCommand> = {};
  for (const [name, declaration] of Object.entries(openclawCommands)) {
    const entry = specOf(declaration);
    if (entry === undefined) continue;
    const data = specData(entry);
    // `prepare` passes the ParsedCall through, so run sees given too.
    commands[name] = data.kind === "single"
      ? materializeCommands({
          [name]: {
            ...commandBody({
              effect: "read", arguments: unresolved(data.arguments) as never, rules: data.rules as never, refuse: data.refuse,
              prepare: (call) => call,
              run: async (_on, plan) => record(name, undefined, plan as never),
            }),
            summary: name, group: "low-level",
          },
        })[name]!
      : materializeCommands({
          [name]: {
            ...multiActionBody({
              effect: "read", action: data.action,
              actions: Object.fromEntries(Object.entries(data.actions).map(([action, spec]) => [action, defineAction({
                summary: action, effect: "read", arguments: unresolved(spec.arguments) as never, rules: spec.rules as never, refuse: spec.refuse,
                prepare: (call) => call,
                run: async (_on, plan) => record(name, action, plan as never),
              })])),
            }),
            summary: name, group: "low-level",
          },
        })[name]!;
  }
  return { name: "capture-fixture", description: "fixture", commands };
}

// Guard: the capture really keeps the originals' arguments and rules (derived, sampled).
{
  const capture = captureApp([]);
  const argNames = (slice: { arguments?: readonly { name: string }[] }): readonly string[] =>
    (slice.arguments ?? []).map((argument) => argument.name);
  let sampled = 0;
  for (const [name, declaration] of Object.entries(openclawCommands)) {
    if (sampled >= 2) break;
    const entry = specOf(declaration);
    const captureEntry = specOf(capture.commands[name]!);
    if (entry === undefined || captureEntry === undefined) continue;
    const data = specData(entry);
    const captureData = specData(captureEntry);
    const slices = data.kind === "single"
      ? [{ arguments: data.arguments, rules: data.rules }]
      : Object.values(data.actions);
    const captureSlices = captureData.kind === "single"
      ? [{ arguments: captureData.arguments, rules: captureData.rules }]
      : Object.values(captureData.actions);
    const same = slices.every((slice, index) =>
      JSON.stringify(argNames(slice)) === JSON.stringify(argNames(captureSlices[index]!))
      && (slice.rules ?? []).length === (captureSlices[index]!.rules ?? []).length);
    checkTrue(`${name}: the capture command keeps the declared arguments and rules`, same);
    sampled += 1;
  }
  checkTrue("the captureApp argument guard sampled declared commands", sampled > 0);
}

export interface Unit {
  readonly label: string;
  readonly command: string;
  readonly action?: string;
  readonly args: readonly ArgumentSpec[];
  readonly rules: readonly ArgumentRule[];
  readonly refuse: Readonly<Record<string, string>>;
}

export const units: Unit[] = [];
for (const [command, declaration] of Object.entries(openclawCommands)) {
  const entry = specOf(declaration);
  checkTrue(`${command} is a declared body`, entry !== undefined);
  if (entry === undefined) continue;
  const data = specData(entry);
  if (data.kind === "single") units.push({ label: command, command, args: data.arguments, rules: data.rules ?? [], refuse: data.refuse ?? {} });
  else for (const [action, spec] of Object.entries(data.actions)) units.push({ label: `${command} ${action}`, command, action, args: spec.arguments, rules: spec.rules ?? [], refuse: spec.refuse ?? {} });
}

// --- the gate's units (design D6): the same sweeps, one pipeline (executeBody) ---------------
//
// The gate commands join the common cases derived from declarations. Their bodies are
// `needs: "nothing"`: the sweeps below send only refusals (parse/prepare), so no gate run
// phase ever executes and no control case exists for them (a gate control would create or
// remove real directories).

export interface GateUnit {
  readonly label: string;
  readonly name: string;
  readonly body: CommandBody;
  readonly args: readonly ArgumentSpec[];
  readonly rules: readonly ArgumentRule[];
}

const gateCommands = [
  ...checkoutGateCommands,
  makeVersionGateCommand(),
  makeCompletionGateCommand([...checkoutGateCommands, makeVersionGateCommand()], true),
  makeInitGateCommand("<app-root>"),
];

export const gateUnits: GateUnit[] = gateCommands.map((command) => {
  const data = specData(command.body);
  if (data.kind !== "single") throw new Error(`gate command ${command.name} is not a single body`);
  return { label: command.name, name: command.name, body: command.body, args: data.arguments, rules: data.rules ?? [] };
});

export async function runGateCase(name: string, argv: string[], surface: "terminal" | "mcp") {
  const unit = gateUnits.find((candidate) => candidate.name === name)!;
  let output = "";
  const execution = await withOutputSink((chunk) => { output += chunk; }, () =>
    executeBody(name, unit.body, { kind: "argv", argv }, { surface }));
  return { execution, output, contacts: [] as unknown[] };
}

export async function runGateNamed(name: string, args: Record<string, unknown>, options: { confirmed?: boolean } = {}) {
  const unit = gateUnits.find((candidate) => candidate.name === name)!;
  let output = "";
  const execution = await withOutputSink((chunk) => { output += chunk; }, () =>
    executeBody(name, unit.body, { kind: "named", args }, { surface: "mcp", ...(options.confirmed === true ? { confirmed: true } : {}) }));
  return { execution, output, contacts: [] as unknown[] };
}

export function exampleOf(argument: ArgumentSpec): string {
  if (argument.kind === "positional" || argument.kind === "option" || argument.kind === "variadic") {
    const kind = (argument as { value?: { example: string } }).value;
    if (kind !== undefined) return kind.example;
    // The public CommandArgument face (a kind projects as its parse carrier).
    const legacy = argument as { parse?: { example: string }; choices?: readonly string[] };
    if (legacy.parse !== undefined) return legacy.parse.example;
    if (legacy.choices !== undefined) return legacy.choices[0]!;
  }
  return "x";
}

/** EVERY parse-stage value the argument's kind refuses, raw; a flag refuses nothing by
 *  declaration. The sweep turns each sample into a case, on both surfaces. */
export function invalidSamplesOf(argument: ArgumentSpec): readonly string[] {
  if (argument.kind === "flag") return [];
  return argument.value.invalid.filter((sample) => sample.stage === "parse").map((sample) => sample.raw);
}

/** Every prepare-stage sample: the value the kind's own resolve refuses (S2.5). */
export function prepareSamplesOf(argument: ArgumentSpec): readonly string[] {
  if (argument.kind === "flag") return [];
  return argument.value.invalid.filter((sample) => sample.stage === "prepare").map((sample) => sample.raw);
}

export async function runCase(command: string, argv: string[], surface: "terminal" | "mcp", on: AppDefinition = app, options: { confirmed?: boolean } = {}) {
  const transport = fixture.transport();
  let output = "";
  const execution = await withOutputSink((chunk) => {
    output += chunk;
  }, () => executeCommand(on, command, { kind: "argv", argv }, { surface, transport, ...(options.confirmed === true ? { confirmed: true } : {}) }));
  return { execution, output, contacts: fixture.contacts() };
}

export async function runNamed(command: string, args: Record<string, unknown>, on: AppDefinition = app, options: { confirmed?: boolean } = {}) {
  const transport = fixture.transport();
  let output = "";
  const execution = await withOutputSink((chunk) => { output += chunk; }, () => executeCommand(on, command, { kind: "named", args }, { surface: "mcp", transport, ...(options.confirmed === true ? { confirmed: true } : {}) }));
  return { execution, output, contacts: fixture.contacts() };
}

export function factsOf(unit: Unit): readonly { readonly argument: string; readonly fact: LocalFact; readonly unless?: string }[] {
  const declaration = openclawCommands[unit.command];
  const data = specData(specOf(declaration)!);
  const slice = data.kind === "single" ? data : (unit.action === undefined ? undefined : data.actions[unit.action]);
  return ((slice as { localFacts?: readonly { argument: string; fact: LocalFact; unless?: string }[] } | undefined)?.localFacts ?? []);
}

export function controlValues(unit: Unit): readonly { readonly argument: ArgumentSpec; readonly value: string | readonly string[] }[] {
  const chosen = new Set<string>();
  for (const rule of unit.rules) {
    if (rule.rule === "oneOf") {
      for (const name of rule.groups[0]!) chosen.add(name);
      for (const group of rule.groups.slice(1)) for (const name of group) chosen.delete(name);
    }
  }
  for (const argument of unit.args) {
    if (argument.kind === "positional") chosen.add(argument.name);
    else if (argument.kind === "option" && (argument.required === true || argument.value !== undefined)) chosen.add(argument.name);
    else if (argument.kind === "variadic" && argument.required === true) chosen.add(argument.name);
  }
  for (const rule of unit.rules) {
    if (rule.rule !== "conflicts") continue;
    if (chosen.has(rule.name)) for (const name of rule.with) chosen.delete(name);
    else if (rule.with.some((name) => chosen.has(name))) chosen.delete(rule.name);
  }
  for (const rule of unit.rules) {
    if (rule.rule === "requires" && chosen.has(rule.name) && !rule.with.some((name) => chosen.has(name))) chosen.delete(rule.name);
  }
  // The two create-actions refuse an existing destination at prepare (S2.5), so a control
  // named like the fixture's own recipe would stop there: their create slots carry names
  // the fixture does not have, and the guarded run really creates them in the temp root.
  // The two create-actions refuse an existing destination at prepare (S2.5), so a control
  // named like the fixture's own recipe would stop there: their create slots carry names
  // the fixture does not have, and the guarded run really creates them in the temp root.
  const createOperandOf = (argument: ArgumentSpec): string | undefined =>
    unit.command === "recipe" && unit.action === "new" && argument.name === "name" ? "control-new"
      : unit.command === "recipe" && unit.action === "import" && argument.name === "new-name" ? "control-import" : undefined;
  return unit.args
    .filter((argument) => chosen.has(argument.name) && (argument.kind === "option" || argument.kind === "positional" || (argument.kind === "variadic" && argument.required === true)))
    .map((argument) => ({
      argument,
      value: argument.kind === "variadic"
        ? Array.from({ length: (argument as { count?: number }).count ?? 1 }, () => resolveControlValueOf(argument))
        : createOperandOf(argument) ?? resolveControlValueOf(argument),
    }));
}

// The value a fact-bearing control argument carries: the fixture makes each real enough to
// pass prepare, so the control reaches the guarded run where the fact is judged for content.
export function controlValueOf(fact: LocalFact): string {
  // The artifact fact moved onto localFile's resolve (S2.5); what remains declared names
  // recipe trees or files under them.
  if (fact === "recipe-source") return join(fixture.root, "recipes", "local");
  return "local";
}

/** The control operand a resolve-capable kind needs: a value whose local fact HOLDS (the
 *  example would not — the resolve refuses it at prepare), so the control reaches run. */
export function resolveControlValueOf(argument: ArgumentSpec): string {
  const kind = argument.kind === "flag" ? undefined : argument.value;
  if (kind?.kind === "localFile") return controlArtifact;
  if (kind?.kind === "localDirectory") return join(fixture.root, "recipes", "local");
  return exampleOf(argument);
}
