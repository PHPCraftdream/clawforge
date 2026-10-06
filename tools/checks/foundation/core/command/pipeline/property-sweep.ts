// Shared scaffolding for the pipeline property sweeps: the fixture, the artifact control,
// the units derived from the declarations, and the case helpers. The runner gives each check
// file its own process, so this module's fixture and tally are per-process.

import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError, specData } from "#framework/core/command/index.ts";
import type { ArgumentRule, ArgumentSpec } from "#framework/core/command/index.ts";
import { specOf, type LocalFact } from "#framework/core/command/spec.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { checkTrue } from "#checks/kit/harness.ts";
import { createDeploymentFixture, stageTally } from "#checks/kit/deployment-fixture.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { INVALID_ARTIFACT } from "#framework/set/artifacts/install.ts";
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

export function exampleOf(argument: ArgumentSpec): string {
  if (argument.kind === "positional" || argument.kind === "option") {
    if (argument.name === "new-name" && argument.parse !== undefined) return argument.parse.example;
    if (argument.choices !== undefined) return argument.choices[0];
    if (argument.parse !== undefined) return argument.parse.example;
  }
  return "x";
}

/** The value the argument must refuse, or undefined when it refuses nothing by declaration. */
export function invalidOf(argument: ArgumentSpec): string | undefined {
  if (argument.kind !== "positional" && argument.kind !== "option") return undefined;
  if (argument.choices !== undefined) {
    let outside = "outside-the-list";
    while (argument.choices.includes(outside)) outside += "-x";
    return outside;
  }
  if (argument.parse !== undefined) return argument.parse.invalidExample;
  return argument.kind === "option" ? "" : undefined;
}

export async function runCase(command: string, argv: string[], surface: "terminal" | "mcp", on: AppDefinition = app, options: { confirmed?: boolean } = {}) {
  const transport = fixture.transport();
  let output = "";
  const execution = await withOutputSink((chunk) => {
    output += chunk;
  }, () => executeCommand(on, command, argv, { surface, transport, ...(options.confirmed === true ? { confirmed: true } : {}) }));
  return { execution, output, contacts: fixture.contacts() };
}

export const ARGUMENT_REFUSAL_SHAPE = /^invalid .+ (name|id) "/;
export function isArgumentShaped(error: unknown, label: string, value?: string): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof ArgumentError) return true;
  return error.message.startsWith(label) || ARGUMENT_REFUSAL_SHAPE.test(error.message) || error.message.includes(["not", "found"].join(" ")) || error.message.includes(["could", "not", "inspect"].join(" ")) || error.message.includes(INVALID_ARTIFACT)
    || (value !== undefined && value.length >= 4 && error.message.includes(value));
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
    else if (argument.kind === "option" && (argument.required === true || argument.parse !== undefined || argument.choices !== undefined)) chosen.add(argument.name);
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
  return unit.args
    .filter((argument) => chosen.has(argument.name) && (argument.kind === "option" || argument.kind === "positional" || (argument.kind === "variadic" && argument.required === true)))
    .map((argument) => ({ argument, value: argument.kind === "variadic" ? Array.from({ length: (argument as { count?: number }).count ?? 1 }, () => exampleOf(argument)) : exampleOf(argument) }));
}

// The value a fact-bearing control argument carries: the fixture makes each real enough to
// pass prepare, so the control reaches the guarded run where the fact is judged for content.
export function controlValueOf(fact: LocalFact): string {
  if (fact === "artifact") return controlArtifact;
  if (fact === "recipe-source") return join(fixture.root, "recipes", "local");
  return "local";
}
