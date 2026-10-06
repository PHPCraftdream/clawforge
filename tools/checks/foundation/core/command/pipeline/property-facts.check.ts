// The local-fact class: every declared local fact (missing artifact, recipe, agent bundle,
// acceptance file, recipe source) is refused at the prepare stage on console and MCP with the
// producer's own text, and a direct runOnContext call refuses identically. Split from
// property.check.ts for the source layout's line cap; runs on the shared sweep module's
// fixture (its own process, its own fixture root).

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Context } from "#framework/core/context.ts";
import { localFactRefusal, type LocalFact } from "#framework/core/command/spec.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { app, controlValues, exampleOf, factsOf, fixture, runCase, stages, units } from "./property-sweep.ts";

{
  const missingValue = (fact: LocalFact, argument: string): string => fact === "artifact" ? join(fixture.root, `missing-${argument}-artifact.tar.gz`) : fact === "recipe-source" ? join(fixture.root, `missing-${argument}-source`) : `missing-${argument}-recipe`;
  const touched = new Proxy({}, { get: () => { throw new Error("context touched before the facts were refused"); } }) as unknown as Context;
  let factCases = 0;
  const factCoverage = new Set<string>();
  for (const unit of units) {
    for (const declared of factsOf(unit)) {
      const base = new Map(controlValues(unit).map(({ argument }) => [argument.name, argument]));
      const want = new Set<string>([declared.argument]);
      for (const rule of unit.rules) {
        if (rule.rule !== "oneOf") continue;
        const group = rule.groups.find((names) => names.includes(declared.argument));
        if (group === undefined) continue;
        for (const name of group) want.add(name);
        for (const other of rule.groups) if (other !== group) for (const name of other) base.delete(name);
      }
      for (const rule of unit.rules) {
        if (rule.rule === "requires" && want.has(rule.name) && !rule.with.some((name) => want.has(name) || base.has(name))) want.add(rule.with[0]!);
        if (rule.rule !== "conflicts") continue;
        if (want.has(rule.name)) for (const name of rule.with) base.delete(name);
        else if (rule.with.some((name) => want.has(name))) base.delete(rule.name);
      }
      if (declared.unless !== undefined) base.delete(declared.unless);
      const lead = unit.action === undefined ? [] : [unit.action];
      const missing = missingValue(declared.fact, declared.argument);
      const counterpart = (argument: string) => argument === "from" || argument === "to" ? join(fixture.root, "present-artifact.tar.gz") : missingValue(declared.fact, argument);
      let refused: string | undefined;
      const values: Record<string, string | readonly string[]> = {};
      for (const argument of unit.args) {
        if (!want.has(argument.name) && !base.has(argument.name)) continue;
        const factual = want.has(argument.name);
        const value = factual ? (argument.name === declared.argument ? missing : counterpart(argument.name)) : exampleOf(argument);
        if (factual && argument.name !== declared.argument && declared.fact === "artifact") await writeFile(value, "fixture artifact");
        if (argument.name === declared.argument) refused = value;
        const given = argument.kind === "variadic" ? Array.from({ length: (argument as { count?: number }).count ?? 1 }, () => value) : value;
        values[argument.name] = given;
      }
      const positionalsFirst = unit.args.filter((argument) => argument.kind !== "option" && (want.has(argument.name) || base.has(argument.name)));
      const ordered = [...positionalsFirst.flatMap((argument) => { const v = values[argument.name]!; return Array.isArray(v) ? v : [v as string]; }), ...unit.args.filter((argument) => argument.kind === "option" && (want.has(argument.name) || base.has(argument.name))).flatMap((argument) => [`--${argument.name}`, values[argument.name] as string])];
      const argv = [...lead, ...ordered];
      const where = `${unit.label} ${declared.argument} (${declared.fact})`;
      const expected = localFactRefusal(declared.fact, refused!);
      const terminal = await runCase(unit.command, argv, "terminal");
      const mcp = await runCase(unit.command, argv, "mcp", app, { confirmed: true });
      stages.case(where, terminal.execution.stage, terminal.execution.error);
      stages.case(where, mcp.execution.stage, mcp.execution.error);
      for (const [surface, outcome] of [["console", terminal], ["MCP", mcp]] as const) {
        factCoverage.add(surface === "console" ? "console" : "MCP");
        check(`${where}: ${surface} refuses at prepare`, outcome.execution.stage, "prepare");
        check(`${where}: ${surface} refusal is the producer's text`, (outcome.execution.error as Error | undefined)?.message, expected);
        check(`${where}: ${surface} makes no target contact`, outcome.contacts, []);
      }
      const direct = await openclawCommands[unit.command].run!(touched, argv).then(() => "no refusal", (error: unknown) => (error as Error).message);
      factCoverage.add("direct-run");
      check(`${where}: a direct runOnContext call is refused the same way`, direct, expected);
      factCases += 1;
    }
  }
  const REQUIRED_FACTS: readonly string[] = [
    "set validate:set:artifact", "set diff:artifacts:artifact", "set diff:from:artifact", "set diff:to:artifact",
    "accept:recipe:acceptance", "accept:set:artifact", "provision-agent:recipe:agent-bundle", "recipe import:name:recipe-source",
    "recipe verify:name:recipe", "recipe onboard:name:recipe", "recipe diagnose:name:recipe", "recipe install:name:recipe",
    "recipe remove:name:recipe", "set try:set:artifact", "plan:set:artifact", "apply:set:artifact" ];
  const observedFacts = new Set(units.flatMap((unit) => factsOf(unit).map((entry) => `${unit.label}:${entry.argument}:${entry.fact}`)));
  for (const required of REQUIRED_FACTS) check(`missing-fact coverage includes ${required}`, observedFacts.has(required), true);
  for (const surface of ["console", "MCP", "direct-run"] as const) check(`missing-fact cases exercise ${surface} independently`, factCoverage.has(surface), true);
}
await fixture.dispose();
stages.print("pipeline: property — local facts are refused at prepare");
finish("pipeline: property — local facts are refused at prepare");
