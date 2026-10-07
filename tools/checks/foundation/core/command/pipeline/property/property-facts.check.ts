// The local-fact class: every declared local fact (missing artifact, recipe, agent bundle,
// acceptance file, recipe source) is refused at the prepare stage on console and MCP with the
// producer's own text, and a direct runOnContext call refuses identically. Split from
// property.check.ts for the source layout's line cap; runs on the shared sweep module's
// fixture (its own process, its own fixture root).

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Context } from "#framework/core/context.ts";
import { localFactRefusal, type LocalFact } from "#framework/core/command/spec.ts";
import { ArgumentError, specData, specOf } from "#framework/core/command/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { app, controlValues, exampleOf, factsOf, fixture, runCase, stages, units } from "./property-sweep.ts";

{
  const missingValue = (fact: LocalFact, argument: string): string => fact === "recipe-source" ? join(fixture.root, `missing-${argument}-source`) : `missing-${argument}-recipe`;
  const touched = new Proxy({}, { get: () => { throw new Error("context touched before the facts were refused"); } }) as unknown as Context;
  // The recipeRef resolve (S2.5) now refuses a missing recipe.json before the deeper facts —
  // a case for acceptance/agent-bundle gets an existing recipe.json, so the deeper file is
  // what is missing.
  for (const unit of units) {
    for (const declared of factsOf(unit)) {
      if (declared.fact !== "acceptance" && declared.fact !== "agent-bundle") continue;
      const dir = join(fixture.root, "recipes", `missing-${declared.argument}-recipe`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "recipe.json"), '{"description":"x"}\n');
    }
  }
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
  // The artifact/recipe/recipe-source facts moved onto the value kinds' resolve (stage 7
  // S2.5) — their refusals are exercised by property.check.ts's prepare-stage sweep, derived
  // from the kinds' own prepare samples. What remains declared is pinned here.
  const REQUIRED_FACTS: readonly string[] = ["accept:recipe:acceptance"];
  const observedFacts = new Set(units.flatMap((unit) => factsOf(unit).map((entry) => `${unit.label}:${entry.argument}:${entry.fact}`)));
  for (const required of REQUIRED_FACTS) check(`missing-fact coverage includes ${required}`, observedFacts.has(required), true);
  let migrated = 0;
  for (const unit of units) {
    for (const argument of unit.args) {
      if (argument.kind === "flag") continue;
      const kind = argument.value;
      if (kind === undefined || !["localFile", "localDirectory", "recipeRef"].includes(kind.kind)) continue;
      migrated += 1;
      checkTrue(`${unit.label}:${argument.name}: the kind owns the local fact`, kind.resolve !== undefined && kind.invalid.some((sample) => sample.stage === "prepare"));
    }
  }
  checkTrue("migrated fact-bearing arguments exist", migrated > 0);
  for (const surface of ["console", "MCP", "direct-run"] as const) check(`missing-fact cases exercise ${surface} independently`, factCoverage.has(surface), true);
}

{
  // S2.5, Group 2: the agent-bundle fact is provision-agent's own prepare now — the plan run
  // receives the loaded bundle, and the localFacts loop above no longer sees it. The class is
  // pinned directly: a recipe whose agent/ bundle is missing stops at prepare with the
  // producer's own text, ZERO target contacts, on both surfaces; a recipe with a bundle
  // reaches run (and there contacts the target).
  const data = specData(specOf(openclawCommands["provision-agent"]!)!);
  checkTrue("provision-agent: the agent-bundle fact lives in its own prepare", data.kind === "single" && data.prepare !== undefined && data.localFacts === undefined);
  const bare = join(fixture.root, "recipes", "no-agent-bundle");
  await mkdir(bare, { recursive: true });
  await writeFile(join(bare, "recipe.json"), '{"description":"x"}\n');
  const expected = localFactRefusal("agent-bundle", "no-agent-bundle");
  for (const surface of ["terminal", "mcp"] as const) {
    const outcome = await runCase("provision-agent", ["no-agent-bundle"], surface, app, surface === "mcp" ? { confirmed: true } : {});
    stages.case(`provision-agent <no-agent-bundle> (${surface})`, outcome.execution.stage, outcome.execution.error);
    check(`provision-agent <no-agent-bundle>: ${surface} stops at prepare`, outcome.execution.stage, "prepare");
    checkTrue(`provision-agent <no-agent-bundle>: ${surface} error is an ArgumentError`, outcome.execution.error instanceof ArgumentError);
    check(`provision-agent <no-agent-bundle>: ${surface} error names the argument`, (outcome.execution.error as ArgumentError).argument, "recipe");
    check(`provision-agent <no-agent-bundle>: ${surface} refusal is the producer's text`, (outcome.execution.error as Error | undefined)?.message, expected);
    check(`provision-agent <no-agent-bundle>: ${surface} makes no target contact`, outcome.contacts, []);
  }
  const valid = await runCase("provision-agent", ["local"], "terminal");
  stages.control("provision-agent <local>: a recipe with an agent bundle reaches run", valid.execution.stage);
  checkTrue("provision-agent <local>: the guarded run contacts the target", valid.contacts.length > 0);
}
await fixture.dispose();
stages.print("pipeline: property — local facts are refused at prepare");
finish("pipeline: property — local facts are refused at prepare");
