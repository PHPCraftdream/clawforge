// The property check of the command spec: every argument that declares `choices` or `parse`,
// given a value it must refuse, is refused by the ONE pipeline at the `parse` stage — on the
// console and on MCP alike — before anything is read, locked or contacted.
//
// Everything is derived from the declarations of openclawCommands (a new command or action is
// covered the moment it is declared; there is no per-command list and no exclusion):
//   argv = the action word + an example for every preceding positional (the kind's
//          `example`) + the argument carrying each of its kind's declared parse-stage
//          samples (a variadic: the sample repeated per its count).
// Expected, per case: stage "parse", an ArgumentError whose `argument` is that argument's name,
// zero transport contacts, and the {"error":…} document only when the chosen action declares a
// `json` flag (then `--json` rides argv; on MCP no document is ever printed).
//
// The MCP product path binds the named input through the console's own binder (bindNamed):
// one refusal voice, "" option values and false flags read as "not given" — that is the
// surface's rule, not an exclusion of a command. The legacy argv bridge (toArgv) remains
// pinned only where marked LEGACY below.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArgumentError, UnknownActionError, bind, bindNamed, bindsAsFlag, requiredArgumentRefusal, specData, specShape, tokenize } from "#framework/core/command/index.ts";
import type { ArgumentSpec } from "#framework/core/command/index.ts";
import { specOf } from "#framework/core/command/spec.ts";
import { toArgv } from "#framework/integration/mcp/legacy.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { unpackArtifactVerified } from "#framework/set/artifacts/install.ts";
import { setManifestId } from "#framework/set/artifacts/model.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { TRANSPORT_SENTINEL } from "#checks/kit/deployment-fixture.ts";
import { withScheduleRunner } from "#framework/commands/operate/schedule.ts";
import type { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { app, controlArtifact, controlManifest, controlValueOf, controlValues, exampleOf, factsOf, fixture, gateUnits, invalidSamplesOf, runCase, runNamed, stages, sweepOn, sweepUnits, units } from "./property-sweep.ts";
let cases = 0;
{
  const unpacked = await unpackArtifactVerified(controlArtifact);
  check("the artifact control is a valid set", unpacked.verified.id, setManifestId(controlManifest));
  await rm(unpacked.staging, { recursive: true, force: true });
}
for (const unit of sweepUnits) {
  const declaresJson = unit.args.some((argument) => argument.name === "json" && argument.kind === "flag");
  const positionals = unit.args.filter((argument) => argument.kind === "positional");
  const lead = unit.action === undefined ? [] : [unit.action];

  for (const argument of unit.args) {
    const samples = invalidSamplesOf(argument);
    if (samples.length === 0) continue;
    // A variadic trails every positional; a positional precedes only the ones before it.
    const preceding = argument.kind === "positional"
      ? positionals.slice(0, positionals.indexOf(argument))
      : positionals;
    for (const invalid of samples) {
      const name = `${unit.label}: ${argument.kind === "positional" ? `<${argument.name}>` : argument.kind === "variadic" ? `<${argument.name}…>` : `--${argument.name}`} ${JSON.stringify(invalid)}`;

      // --json rides before any `--`: everything after it is positional.
      const argv = [
        ...lead,
        ...(declaresJson ? ["--json"] : []),
        ...preceding.map(exampleOf),
        // A flag-looking value rides after a bare `--`: the tokenizer would refuse it
        // as an unknown option before the kind's parse refusal is reached, and the kind —
        // not the tokenizer — is the grammar under test here.
        ...(argument.kind === "positional" ? (bindsAsFlag(invalid) ? ["--", invalid] : [invalid])
          : argument.kind === "variadic"
            ? [...(bindsAsFlag(invalid) ? ["--"] : []), ...Array.from({ length: (argument as { count?: number }).count ?? 1 }, () => invalid)]
            : [`--${argument.name}`, invalid]),
      ];
      const terminal = await runCase(unit.command, argv, "terminal", sweepOn(unit));
      cases += 1;
      stages.case(name, terminal.execution.stage, terminal.execution.error);
      check(`${name}: console stops at the parse stage`, terminal.execution.stage, "parse");
      checkTrue(`${name}: console error is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
      check(`${name}: console error names the argument`, (terminal.execution.error as ArgumentError).argument, argument.name);
      check(`${name}: console never contacts the target`, terminal.contacts, []);
      if (declaresJson) {
        const document = JSON.parse(terminal.output) as { error?: { message?: unknown } };
        checkTrue(`${name}: --json gets the error document`, typeof document.error?.message === "string");
      } else check(`${name}: no --json document without a json flag`, terminal.output, "");

      // An empty string means "not given" on the named path: no case, the surface's
      // documented rule — not an exclusion of a command.
      if (invalid === "") continue;
      const mcpArgs: Record<string, unknown> = {
        ...(unit.action === undefined ? {} : { action: unit.action }),
        ...Object.fromEntries(preceding.map((other) => [other.name, exampleOf(other)])),
        [argument.name]: argument.kind === "variadic" ? Array.from({ length: (argument as { count?: number }).count ?? 1 }, () => invalid) : invalid,
        ...(declaresJson ? { json: true } : {}),
      };
      // An empty string or a false flag reads as "not given": the invalid value IS the
      // case, so it rides as given.
      const mcp = await runNamed(unit.command, mcpArgs, sweepOn(unit));
      cases += 1;
      stages.case(name, mcp.execution.stage, mcp.execution.error);
      check(`${name}: MCP stops at the parse stage`, mcp.execution.stage, "parse");
      checkTrue(`${name}: MCP error is an ArgumentError`, mcp.execution.error instanceof ArgumentError);
      check(`${name}: MCP error names the argument`, (mcp.execution.error as ArgumentError).argument, argument.name);
      check(`${name}: MCP never contacts the target`, mcp.contacts, []);
      check(`${name}: MCP prints no document`, mcp.output, "");
      check(
        `${name}: one voice on both surfaces`,
        (mcp.execution.error as Error).message,
        (terminal.execution.error as Error).message,
      );
    }
  }
}

// The structural guard of the class: argument facts are settled at the parse or prepare
// stage, never after the context is built — by then a real host has already read the target
// (WSL: /etc/wsl.conf) or refused it (LOCAL_TARGET_UNSUPPORTED), either of which masks the
// refusal of the argument itself. Derived from the declarations alone: every value-taking
// argument carries its kind's declared parse-stage samples, and the call is asserted to stop
// no later than prepare — a refusal at the context or run stage fails the assertion. (On a
// host where the context cannot be built at all (no deployment, an unsupported location) the
// run stage is unreachable — the context refusal then masks any later grammar refusal, which
// is exactly the masking this finding describes — so the value section above carries the
// assertion, with its zero-contact and both-surface checks.)
//
// The sweep runs on the kit deployment fixture (a valid temp deployment, recording transport)
// and records every case's pipeline stage in a StageTally; the histogram at the end shows
// where cases actually stopped, and a valid control stopping before run fails the check.
// R2-B-4 — the recording transport answers `description`, so a scheduler control with --apply
// on a pinned linux scheduler reaches the guarded body's first transport contact (host
// independent: the platform is pinned, never read). The fixture root and path separators are normalized out.
const SCHEDULER_FIRST_CONTACT: Readonly<Record<string, string>> = {
  "backup install": "mkdirp <root>/data-locks",
  "backup uninstall": "exec mkdir -p,<root>/data-locks [object Object]",
  "watch install": "mkdirp <root>/data-locks",
  "watch uninstall": "exec mkdir -p,<root>/data-locks [object Object]",
};
for (const unit of sweepUnits) {
  const lead = unit.action === undefined ? [] : [unit.action];
  const factsByName = new Map(factsOf(unit).map((entry) => [entry.argument, entry.fact]));
  const given = controlValues(unit);
  // An exclusive oneOf takes exactly ONE group: a control touching two groups is refused at
  // parse, so a fact argument in a later group of any oneOf rule is simply not given.
  const later = new Set(unit.rules.flatMap((rule) => (rule.rule === "oneOf" ? rule.groups.slice(1).flat() : [])));
  const suppliable = new Set([...factsByName.keys()].filter((name) => !later.has(name)));
  if (given.length > 0) {
    const name = `${unit.label}: control ${given.map(({ argument }) => argument.kind === "positional" ? `<${argument.name}>` : `--${argument.name}`).join(" ")} reaches run`;
    const argv = [...lead, ...given.flatMap(({ argument, value }) => {
      const fact = factsByName.get(argument.name);
      if (fact !== undefined) {
        const real = controlValueOf(fact);
        return argument.kind === "variadic" ? Array.from({ length: Array.isArray(value) ? value.length : 1 }, () => real) : argument.kind === "positional" ? [real] : [`--${argument.name}`, real];
      }
      return argument.kind === "positional" || argument.kind === "variadic" ? (Array.isArray(value) ? value : [value]) : [`--${argument.name}`, value as string];
    })];
    const terminal = await runCase(unit.command, argv, "terminal", sweepOn(unit));
    cases += 1;
    stages.control(name, terminal.execution.stage);
  } else if (suppliable.size > 0) {
    // A bare call that the declaration refuses (required oneOf, no default operands) is not the
    // unit's control: its facts are supplied so the control reaches run.
    const argv = [...lead, ...unit.args.flatMap((argument) => {
      const fact = factsByName.get(argument.name);
      if (fact === undefined || !suppliable.has(argument.name)) return [];
      const real = controlValueOf(fact);
      if (argument.kind === "variadic") return Array.from({ length: (argument as { count?: number }).count ?? 1 }, () => real);
      if (argument.kind === "positional") return [real];
      if (argument.kind === "option") return [`--${argument.name}`, real];
      return [];
    })];
    const terminal = await runCase(unit.command, argv, "terminal", sweepOn(unit));
    cases += 1;
    stages.control(`${unit.label}: control (facts) reaches run`, terminal.execution.stage);
  } else {
    const terminal = await runCase(unit.command, [...lead], "terminal", sweepOn(unit));
    cases += 1;
    stages.control(`${unit.label}: control (bare) reaches run`, terminal.execution.stage);
  }
  const positionals = unit.args.filter((argument) => argument.kind === "positional");
  const options = unit.args.filter((argument) => argument.kind === "option");
  const declaresJson = unit.args.some((argument) => argument.name === "json" && argument.kind === "flag");
  for (const argument of [...positionals, ...options]) {
    for (const invalid of invalidSamplesOf(argument)) {
      const label = argument.kind === "positional" ? `<${argument.name}>` : `--${argument.name}`;
      const name = `${unit.label}: ${label} ${JSON.stringify(invalid)} refused no later than prepare`;
      // a value the pair-rule companion judges must be judged WITH its trigger flag present,
      // so the pair's judgment is exercised, not skipped.
      const triggers = unit.rules.flatMap((rule) =>
        rule.rule === "requires" && rule.any === undefined && rule.with.includes(argument.name)
          ? unit.args.filter((trigger) => trigger.name === rule.name && trigger.kind === "flag")
          : [],
      );
      const argv = [
        ...lead,
        ...positionals.map((other) => (other === argument ? invalid : exampleOf(other))),
        ...options.flatMap((other) => [`--${other.name}`, other === argument ? invalid : exampleOf(other)]),
        ...triggers.map((trigger) => `--${trigger.name}`),
        ...(declaresJson ? ["--json"] : []),
      ];
      const terminal = await runCase(unit.command, argv, "terminal", sweepOn(unit));
      cases += 1;
      stages.case(name, terminal.execution.stage, terminal.execution.error);
      // Structural, not prose: an argument fact settled after the context is built has already
      // read the target (WSL: /etc/wsl.conf) — the refusal must come from parse or prepare.
      checkTrue(`${name}: refused no later than prepare`, terminal.execution.stage === "parse" || terminal.execution.stage === "prepare");
    }
  }
}

// The scheduler controls, run with --apply on a PINNED linux scheduler (never the host's): the
// crontab path is taken with the fixture transport (description "local"), the body runs and
// reaches its first transport contact, where the sentinel ends the run. The substitute local
// runner must never be called — a local scheduler spawn must never run.
const schedulersSeen = new Set<string>();
for (const label of Object.keys(SCHEDULER_FIRST_CONTACT)) {
  const unit = units.find((candidate) => candidate.label === label);
  checkTrue(`${label}: the scheduler unit is declared`, unit !== undefined);
  if (unit === undefined) continue;
  schedulersSeen.add(label);
  const factsByName = new Map(factsOf(unit).map((entry) => [entry.argument, entry.fact]));
  const argv = [...(unit.action === undefined ? [] : [unit.action]), ...controlValues(unit).flatMap(({ argument, value }) => {
    const fact = factsByName.get(argument.name);
    if (fact !== undefined) {
      const real = controlValueOf(fact);
      return argument.kind === "variadic" ? Array.from({ length: Array.isArray(value) ? value.length : 1 }, () => real) : argument.kind === "positional" ? [real] : [`--${argument.name}`, real];
    }
    return argument.kind === "positional" || argument.kind === "variadic" ? (Array.isArray(value) ? value : [value]) : [`--${argument.name}`, value as string];
  }), "--apply"];
  let spawned = 0;
  const substitute: typeof spawnLocal = async () => {
    spawned += 1;
    throw new Error("a local scheduler spawn must never run");
  };
  const terminal = await withScheduleRunner(substitute, () => runCase(unit.command, argv, "terminal"), "linux");
  cases += 1;
  const name = `${label}: control reaches the transport sentinel`;
  stages.control(name, terminal.execution.stage);
  check(`${name}: stage`, terminal.execution.stage, "run");
  check(`${name}: error`, (terminal.execution.error as Error | undefined)?.message, TRANSPORT_SENTINEL);
  check(`${name}: first contact`, terminal.contacts[0]?.replaceAll(fixture.root, "<root>").replaceAll("\\", "/"), SCHEDULER_FIRST_CONTACT[label]);
  check(`${name}: the scheduler runner was never called`, spawned, 0);
}
check("every scheduler control was seen", [...schedulersSeen].sort(), Object.keys(SCHEDULER_FIRST_CONTACT).sort());

// Missing required arguments, derived from the declaration (requiredness is declared once,
// so the parser refuses at parse on every surface — a hand-written prepare-stage usage line
// where the declaration says required slips past the value cases above).
for (const unit of sweepUnits) {
  const lead = unit.action === undefined ? [] : [unit.action];
  const positionals = unit.args.filter((argument) => argument.kind === "positional");
  const required = unit.args.filter((argument) => argument.kind !== "flag" && argument.kind !== "variadic" && argument.required === true);
  for (const argument of required) {
    const dropped = argument.kind === "positional";
    const kept = dropped ? positionals.slice(0, positionals.indexOf(argument)) : positionals;
    const others = unit.args.filter((other) => other.kind === "option" && other !== argument);
    const name = `${unit.label}: missing required ${dropped ? `<${argument.name}>` : `--${argument.name}`}`;
    const argv = [...lead, ...kept.map(exampleOf), ...others.flatMap((other) => [`--${other.name}`, exampleOf(other)])];
    const terminal = await runCase(unit.command, argv, "terminal", sweepOn(unit));
    cases += 1;
    stages.case(name, terminal.execution.stage, terminal.execution.error);
    check(`${name}: console stops at the parse stage`, terminal.execution.stage, "parse");
    checkTrue(`${name}: console error is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
    check(`${name}: console error names the argument`, (terminal.execution.error as ArgumentError).argument, argument.name);
    check(`${name}: console never contacts the target`, terminal.contacts, []);

    const mcpArgs: Record<string, unknown> = {
      ...(unit.action === undefined ? {} : { action: unit.action }),
      ...Object.fromEntries(kept.map((other) => [other.name, exampleOf(other)])),
      ...Object.fromEntries(others.map((other) => [other.name, exampleOf(other)])),
    };
    const mcp = await runNamed(unit.command, mcpArgs, sweepOn(unit));
    cases += 1;
    stages.case(name, mcp.execution.stage, mcp.execution.error);
    check(`${name}: MCP stops at the parse stage`, mcp.execution.stage, "parse");
    checkTrue(`${name}: MCP error is an ArgumentError`, mcp.execution.error instanceof ArgumentError);
    check(`${name}: MCP error names the argument`, (mcp.execution.error as ArgumentError).argument, argument.name);
    check(`${name}: MCP never contacts the target`, mcp.contacts, []);
    check(`${name}: MCP prints no document`, mcp.output, "");
  }
}

// A variadic given while a required positional (or the action word) is omitted: the named
// input goes straight through the console's binder, so the call must be refused at parse —
// in the binder's required voice for a positional, by the action selection for the word.
for (const unit of sweepUnits) {
  const variadic = unit.args.find((argument) => argument.kind === "variadic");
  if (variadic === undefined) continue;
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
    const mcp = await runNamed(unit.command, mcpArgs, sweepOn(unit));
    cases += 1;
    stages.case(name, mcp.execution.stage, mcp.execution.error);
    check(`${name}: MCP stops at the parse stage`, mcp.execution.stage, "parse");
    check(`${name}: MCP never contacts the target`, mcp.contacts, []);
    if (omitted.name === "action") {
      checkTrue(`${name}: MCP refuses the unknown action`, mcp.execution.error !== undefined);
    } else if (omittedArgument !== undefined) {
      check(`${name}: MCP refuses in the binder's required voice`, (mcp.execution.error as Error).message, requiredArgumentRefusal(omittedArgument, `${unit.command} ${unit.action ?? ""}`.trim()));
    }
    const argv = [
      ...(unit.action === undefined || omitted.name === "action" ? [] : [unit.action]),
      ...positionals.filter((other) => other.name !== omitted.name).map(exampleOf),
      ...values,
    ];
    const terminal = await runCase(unit.command, argv, "terminal", sweepOn(unit));
    cases += 1;
    stages.case(name, terminal.execution.stage, terminal.execution.error);
    check(`${name}: console stops at the parse stage`, terminal.execution.stage, "parse");
    check(`${name}: console never contacts the target`, terminal.contacts, []);
  }
}

// Declared presence rules and variadic counts refuse at parse on both surfaces, derived
// from the declarations: the same one pipeline enforces the rules before any phase runs.
for (const unit of sweepUnits) {
  if (unit.rules.length === 0 && !unit.args.some((argument) => argument.kind === "variadic" && argument.count !== undefined)) continue;
  const lead = unit.action === undefined ? [] : [unit.action];
  const declaresJson = unit.args.some((argument) => argument.name === "json" && argument.kind === "flag");
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
    const terminal = await runCase(unit.command, argv, "terminal", sweepOn(unit));
    cases += 1;
    stages.case(kase.name, terminal.execution.stage, terminal.execution.error);
    check(`${kase.name}: console stops at the parse stage`, terminal.execution.stage, "parse");
    checkTrue(`${kase.name}: console error is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
    checkTrue(`${kase.name}: the error names a member of the rule`, kase.members.includes((terminal.execution.error as ArgumentError).argument ?? ""));
    check(`${kase.name}: console never contacts the target`, terminal.contacts, []);
    if (declaresJson) {
      const document = JSON.parse(terminal.output) as { error?: { message?: unknown } };
      checkTrue(`${kase.name}: --json gets the error document`, typeof document.error?.message === "string");
    } else check(`${kase.name}: no --json document without a json flag`, terminal.output, "");

    // Named input addresses the chosen slice directly — no merged view to check against.
    const mcpArgs: Record<string, unknown> = {
      ...(unit.action === undefined ? {} : { action: unit.action }),
      ...Object.fromEntries([...extras, ...kase.given].filter((entry) => entry.argument.kind === "option" || entry.argument.kind === "positional").map(({ argument }) => [argument.name, exampleOf(argument)])),
      ...Object.fromEntries([...extras, ...kase.given].filter((entry) => entry.argument.kind === "flag").map(({ argument }) => [argument.name, true])),
      ...Object.fromEntries([...extras, ...kase.given].filter((entry) => entry.argument.kind === "variadic").map(({ argument, values }) => [argument.name, Array.from({ length: values ?? (argument as { count?: number }).count ?? 1 }, () => exampleOf(argument))])),
      ...(declaresJson ? { json: true } : {}),
    };
    const mcp = await runNamed(unit.command, mcpArgs, sweepOn(unit));
    cases += 1;
    stages.case(kase.name, mcp.execution.stage, mcp.execution.error);
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
  const terminal = await runCase("recipe", [unit.action!], "terminal");
  cases += 1;
  stages.case(unit.label, terminal.execution.stage, terminal.execution.error);
  check(`${unit.label}: bare, console stops at the parse stage`, terminal.execution.stage, "parse");
  check(`${unit.label}: bare, console error names <name>`, (terminal.execution.error as ArgumentError).argument, "name");
  check(`${unit.label}: bare, console never contacts the target`, terminal.contacts, []);
  const mcp = await runNamed("recipe", { action: unit.action });
  cases += 1;
  stages.case(unit.label, mcp.execution.stage, mcp.execution.error);
  check(`${unit.label}: bare, MCP stops at the parse stage`, mcp.execution.stage, "parse");
  check(`${unit.label}: bare, MCP never contacts the target`, mcp.contacts, []);
}

// A positional value that begins with a dash is refused by the VALUE KIND — the same owner
// on both surfaces: the console reaches it through a bare `--`, the named input carries it
// as the property's own value. One voice, derived from the declarations:
// the case exists only where the kind itself declares a parse-stage dash refusal (a path
// kind accepts a dash-leading name — there is nothing to refuse, on either surface).
for (const unit of sweepUnits) {
  const lead = unit.action === undefined ? [] : [unit.action];
  const positionals = unit.args.filter((candidate) => candidate.kind === "positional");
  for (const argument of positionals) {
    if (!invalidSamplesOf(argument).some((sample) => bindsAsFlag(sample))) continue;
    const preceding = positionals.slice(0, positionals.indexOf(argument));
    for (const value of ["--json", "-x"]) {
      const name = `${unit.label}: <${argument.name}> ${value} one voice on both surfaces`;
      const terminal = await runCase(unit.command, [...lead, ...preceding.map(exampleOf), "--", value], "terminal", sweepOn(unit));
      cases += 1;
      stages.case(name, terminal.execution.stage, terminal.execution.error);
      check(`${name}: console stops at the parse stage`, terminal.execution.stage, "parse");
      checkTrue(`${name}: console error is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
      check(`${name}: console error names the argument`, (terminal.execution.error as ArgumentError).argument, argument.name);
      check(`${name}: console never contacts the target`, terminal.contacts, []);
      const mcpArgs = {
        ...(unit.action === undefined ? {} : { action: unit.action }),
        ...Object.fromEntries(preceding.map((other) => [other.name, exampleOf(other)])),
        [argument.name]: value,
      };
      const mcp = await runNamed(unit.command, mcpArgs, sweepOn(unit));
      cases += 1;
      stages.case(name, mcp.execution.stage, mcp.execution.error);
      check(`${name}: MCP stops at the parse stage`, mcp.execution.stage, "parse");
      checkTrue(`${name}: MCP error is an ArgumentError`, mcp.execution.error instanceof ArgumentError);
      check(`${name}: MCP error names the argument`, (mcp.execution.error as ArgumentError).argument, argument.name);
      check(`${name}: MCP never contacts the target`, mcp.contacts, []);
      check(`${name}: MCP prints no document`, mcp.output, "");
      check(`${name}: one voice on both surfaces`, (mcp.execution.error as Error).message, (terminal.execution.error as Error).message);
    }
  }
}
for (const [command, argument, value] of [["accept", "recipe", "--with-model"], ["restore", "archive", "--dry-run"], ["operations", "id", "--json"]] as const) {
  const name = `${command} <${argument}> ${value} one voice on both surfaces`;
  const terminal = await runCase(command, ["--", value], "terminal");
  cases += 1;
  stages.case(name, terminal.execution.stage, terminal.execution.error);
  check(`${name}: console stops at the parse stage`, terminal.execution.stage, "parse");
  checkTrue(`${name}: console error is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
  check(`${name}: console error names the argument`, (terminal.execution.error as ArgumentError).argument, argument);
  check(`${name}: console never contacts the target`, terminal.contacts, []);
  const mcp = await runNamed(command, { [argument]: value });
  cases += 1;
  stages.case(name, mcp.execution.stage, mcp.execution.error);
  check(`${name}: MCP stops at the parse stage`, mcp.execution.stage, "parse");
  checkTrue(`${name}: MCP error is an ArgumentError`, mcp.execution.error instanceof ArgumentError);
  check(`${name}: MCP error names the argument`, (mcp.execution.error as ArgumentError).argument, argument);
  check(`${name}: MCP never contacts the target`, mcp.contacts, []);
  check(`${name}: MCP prints no document`, mcp.output, "");
  check(`${name}: one voice on both surfaces`, (mcp.execution.error as Error).message, (terminal.execution.error as Error).message);
}

// A read-effect flag lowers the call to read, which skips the MCP confirm stage: every pair of
// a read flag and a flag of another effect in one action must be refused at parse, on both
// surfaces, so the stronger flag's action can never run unconfirmed (derived from the effects).
for (const unit of sweepUnits) {
  const flags = unit.args.filter((argument): argument is ArgumentSpec & { kind: "flag"; effect?: string } => argument.kind === "flag");
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
      const mcp = await runNamed(unit.command, mcpArgs, sweepOn(unit));
      cases += 1;
      stages.case(name, mcp.execution.stage, mcp.execution.error);
      check(`${name}: MCP stops at the parse stage, not past the confirm stage`, mcp.execution.stage, "parse");
      checkTrue(`${name}: MCP error is an ArgumentError`, mcp.execution.error instanceof ArgumentError);
      check(`${name}: MCP never contacts the target`, mcp.contacts, []);
    }
  }
}

// A declared `refuse` token is refused by the one pipeline before any tokenizing, with the
// declaration's own reason — on the console. (The named input carries no token shape —
// nothing token-shaped to refuse — so this is a console shape by construction.)
for (const unit of sweepUnits) {
  for (const [token, reason] of Object.entries(unit.refuse)) {
    const terminal = await runCase(unit.command, [...(unit.action === undefined ? [] : [unit.action]), token], "terminal", sweepOn(unit));
    cases += 1;
    stages.case(`${unit.label} ${token}`, terminal.execution.stage, terminal.execution.error);
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
  stages.case(`${command} ${word}`, terminal.execution.stage, terminal.execution.error);
  check(`${command} ${word}: stops at the parse stage`, terminal.execution.stage, "parse");
  checkTrue(`${command} ${word}: is an UnknownActionError`, terminal.execution.error instanceof UnknownActionError);
  check(`${command} ${word}: never contacts the target`, terminal.contacts, []);
  check(`${command} ${word}: prints no --json document`, terminal.output, "");
  const mcp = await runCase(command, [word, "--json"], "mcp");
  stages.case(`${command} ${word}`, mcp.execution.stage, mcp.execution.error);
  check(`${command} ${word}: MCP stops at the parse stage`, mcp.execution.stage, "parse");
  checkTrue(`${command} ${word}: MCP error is an UnknownActionError`, mcp.execution.error instanceof UnknownActionError);
  check(`${command} ${word}: MCP never contacts the target`, mcp.contacts, []);
}


// One scope for positionals: the named input offers the positionals of a spec command per
// action, like the console does. Derived from the declarations for every multi-action
// command: a positional another action declares is refused with an applies-to refusal
// spelling its `<name>` label, a positional given past an absent earlier slot is refused in
// the binder required voice, and toArgv emits the positionals of the chosen action, in its
// own order (review R18; LEGACY argv pin).
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
      let refusal: Error | undefined;
      try {
        bindNamed(specShape(specOf(declaration)!), { kind: "named", args: { action, [foreign.name]: exampleOf(foreign as ArgumentSpec) } }, command);
      } catch (error) {
        refusal = error as Error;
      }
      checkTrue(`${command} ${action}: a positional of another action is refused`, refusal !== undefined);
      const words = (refusal as Error).message.split(" ");
      check(`${command} ${action}: a positional of another action is refused with its label`, words.slice(0, 3), [`<${foreign.name}>`, "applies", "to"]);
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
      let binderRefusal: string | undefined;
      try {
        bindNamed(specShape(specOf(declaration)!), { kind: "named", args: { action, [last.name]: exampleOf(last) } }, command);
      } catch (error) {
        binderRefusal = (error as Error).message;
      }
      check(`${command} ${action}: a positional past an absent earlier slot reads as the console refusal`, binderRefusal, consoleRefusal);
    }
    if (own.length > 0) {
      scoped += 1;
      const scopedArgs: Record<string, unknown> = { action, ...Object.fromEntries(own.map((argument) => [argument.name, exampleOf(argument)])) };
      check(`${command} ${action}: toArgv emits the action's own positionals in its own order`, toArgv(declaration, scopedArgs).slice(1), own.map(exampleOf));
    }
  }
}
checkTrue("the property check derived positional-scope cases from the declarations", scoped > 0);

for (const [command, declaration] of Object.entries(openclawCommands)) {
  const data = specData(specOf(declaration)!);
  if (data.kind !== "multi") continue;
  // The one action selection (stage 7 S2.2): an unknown `action` property is the binder's
  // only refusal, in the console's own words, whatever else the call carries — never a
  // silent fall into the default action's slice with the positionals re-read around it.
  const terminal = await runCase(command, ["unknown-action"], "terminal");
  cases += 1;
  stages.case(command, terminal.execution.stage, terminal.execution.error);
  check(`${command}: console unknown action is a parse error`, terminal.execution.stage, "parse");
  checkTrue(`${command}: console unknown action is an UnknownActionError`, terminal.execution.error instanceof UnknownActionError);
  const message = (terminal.execution.error as Error).message;
  const args = { action: "unknown-action", ...Object.fromEntries((declaration.arguments ?? []).filter((argument) => argument.kind === "positional" && argument.name !== "action").map((argument) => [argument.name, exampleOf(argument as ArgumentSpec)])) };
  let binderMessage: string | undefined;
  try {
    bindNamed(specShape(specOf(declaration)!), { kind: "named", args }, command);
  } catch (error) {
    binderMessage = (error as Error).message;
  }
  check(`${command}: unknown action is the binder's only refusal, in the console's words`, binderMessage, message);
  const mcp = await runCase(command, ["unknown-action"], "mcp");
  cases += 1;
  stages.case(command, mcp.execution.stage, mcp.execution.error);
  check(`${command}: MCP unknown action matches the console text byte-for-byte`, (mcp.execution.error as Error | undefined)?.message, message);
  check(`${command}: MCP unknown action never contacts the target`, mcp.contacts, []);
}
{
  const badSource = join(fixture.root, "Bad_Source");
  await mkdir(badSource, { recursive: true });
  await writeFile(join(badSource, "recipe.json"), '{"description":"x"}\n');
  const terminal = await runCase("recipe", ["import", badSource], "terminal");
  cases += 1;
  stages.case("recipe import Bad_Source", terminal.execution.stage, terminal.execution.error);
  check("recipe import of a directory named Bad_Source stops before the run stage", terminal.execution.stage === "prepare" || terminal.execution.stage === "parse", true);
  check("recipe import Bad_Source: console never contacts the target", terminal.contacts, []);
  const mcp = await runNamed("recipe", { action: "import", name: badSource }, app, { confirmed: true });
  cases += 1;
  stages.case("recipe import Bad_Source", mcp.execution.stage, mcp.execution.error);
  check("recipe import Bad_Source: MCP stops before the run stage", mcp.execution.stage === "prepare" || mcp.execution.stage === "parse", true);
  check("recipe import Bad_Source: MCP never contacts the target", mcp.contacts, []);
  check("recipe import Bad_Source: one voice on both surfaces", (mcp.execution.error as Error | undefined)?.message, (terminal.execution.error as Error | undefined)?.message);
}

// The value sweep above takes its sample from the declared kind, so a kind swap re-labels
// its case instead of failing it; this hand-pinned case holds apply --expect's own grammar
// (a declaration checksum is 64 hexadecimal digits, refused at parse) so removing the kind
// is a failing negative control, not a rename (I11).
{
  const terminal = await runCase("apply", ["--expect", "zz"], "terminal");
  cases += 1;
  stages.case("apply --expect zz", terminal.execution.stage, terminal.execution.error);
  check(`apply --expect "zz": console stops at the parse stage`, terminal.execution.stage, "parse");
  checkTrue(`apply --expect "zz": console error is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
  check(`apply --expect "zz": console error names the argument`, (terminal.execution.error as ArgumentError).argument, "expect");
  check(`apply --expect "zz": console never contacts the target`, terminal.contacts, []);
}

checkTrue("the property check derived cases from the declarations", cases > 0);
await fixture.dispose();
stages.print("pipeline: property");

// Grammar obligation (review tails W1 item 12b): every gate argument that takes a value
// pins a refusal the plain text kind would ACCEPT — grammar beyond emptiness and the dash
// rule. Replacing a gate argument's declared kind with kinds.text therefore fails here
// (negative control C190: remove-app's <name> kind -> text), unless the argument is
// declared text AND listed as plain.
const PLAIN_TEXT_GATE_ARGUMENTS = new Set(["check --require", "check <filter…>"]);
// oxlint-disable-next-line no-control-regex -- Raw C0/DEL samples are refused by plain text too.
const RAW_CONTROL = /[\u0000-\u001f\u007f]/;
for (const unit of gateUnits) {
  for (const argument of unit.args) {
    if (argument.kind === "flag") continue;
    const beyond = invalidSamplesOf(argument).some((sample) => sample !== "" && !bindsAsFlag(sample) && !RAW_CONTROL.test(sample));
    if (beyond) continue;
    const label = `${unit.label} ${argument.kind === "variadic" ? `<${argument.name}…>` : argument.kind === "positional" ? `<${argument.name}>` : `--${argument.name}`}`;
    check(`${label} pins a grammar beyond the plain text kind`, PLAIN_TEXT_GATE_ARGUMENTS.has(label), true);
  }
}

finish("pipeline: property — every declared value rule refuses at parse");
