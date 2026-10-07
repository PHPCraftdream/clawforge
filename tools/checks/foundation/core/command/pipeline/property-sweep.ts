// Shared scaffolding for the pipeline property sweeps: the fixture, the artifact control,
// the units derived from the declarations, and the case helpers. The runner gives each check
// file its own process, so this module's fixture and tally are per-process.

import { executeCommand } from "#framework/core/command/execute.ts";
import { specData } from "#framework/core/command/index.ts";
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

export async function runCase(command: string, argv: string[], surface: "terminal" | "mcp", on: AppDefinition = app, options: { confirmed?: boolean } = {}) {
  const transport = fixture.transport();
  let output = "";
  const execution = await withOutputSink((chunk) => {
    output += chunk;
  }, () => executeCommand(on, command, argv, { surface, transport, ...(options.confirmed === true ? { confirmed: true } : {}) }));
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
