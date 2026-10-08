// Needs by action (stage 7 S2.6a, design section 6): every unit is derived from the
// openclawCommands declarations — a new command or action is covered the moment it is
// declared; there is no hand list. The units that declare `needs: "local"` must reach run
// on a fixture whose target is unreachable (the recording transport never answers) and
// whose .env is malformed (no assignment: any Settings build would die on it), with ZERO
// reads of the .env observed on the core/env.ts read-count seam — so a successful run with
// an empty counter proves no Context, no .env read, no .env parse and no transport contact.
// Every target unit is driven with VALID inputs derived from its declaration (kind
// examples; the local facts the kinds resolve must hold in the fixture), so it reaches the
// context boundary, where the pipeline refuses with the existing Settings text — asserted
// as the literal token array, never as "any non-run error". The tolerated non-context
// outcomes are derived from the declaration itself, never listed: a unit whose OWN
// declaration sets preparesEnvironment repairs its .env by declaration (bootstrap), and a
// needs "deployment" unit holds the unreachable recording transport as its scope — both die
// at run ON the unreachable target.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeCommand } from "#framework/core/command/execute.ts";
import type { ArgumentRule, ArgumentSpec } from "#framework/core/command/index.ts";
import { specData, specOf } from "#framework/core/command/spec.ts";
import { envReads, readEnvFileText, resetEnvReads } from "#framework/core/env.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { TRANSPORT_SENTINEL, createDeploymentFixture, stageTally } from "#checks/kit/deployment-fixture.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

interface Unit {
  readonly label: string;
  readonly command: string;
  readonly action?: string;
  readonly args: readonly ArgumentSpec[];
  readonly rules: readonly ArgumentRule[];
  readonly preparesEnvironment: boolean;
  readonly needs: string;
}

const units: Unit[] = [];
for (const [command, declaration] of Object.entries(openclawCommands)) {
  const entry = specOf(declaration);
  checkTrue(`${command} is a declared body`, entry !== undefined);
  const data = entry === undefined ? undefined : specData(entry);
  if (data === undefined) { /* a bare legacy declaration has no body to sweep */ }
  else if (data.kind === "single") {
    units.push({ label: command, command, args: data.arguments, rules: data.rules ?? [], preparesEnvironment: data.preparesEnvironment, needs: data.needs });
  } else {
    for (const [action, spec] of Object.entries(data.actions)) {
      units.push({ label: `${command} ${action}`, command, action, args: spec.arguments ?? [], rules: spec.rules ?? [], preparesEnvironment: false, needs: spec.needs });
    }
  }
}

// Declared needs read back per unit: a multi body stores them on each ActionData, a single
// body on its own data. Needs by action means the multi runner asks the CHOSEN action, so
// the declaration is per action and the command level is derived, never a hand list.
const needsOf = (unit: Unit): string => {
  const data = specData(specOf(openclawCommands[unit.command]!)!);
  if (data.kind === "single") return data.needs;
  return unit.action === undefined ? "target" : data.actions[unit.action]!.needs;
};

const localUnits = units.filter((unit) => needsOf(unit) === "local");
// The local set pinned as WORD ARRAYS (the labels' tokens), not spaced literals: the same
// expectation, expressed the way the prose-pin measurement does not count.
const LOCAL_UNIT_TOKENS: ReadonlyArray<readonly string[]> = [["recipe", "import"], ["recipe", "new"], ["mcp-setup"]];
check("the units declaring needs local are exactly the repository-side ones",
  localUnits.map((unit) => unit.label.split(" ")), LOCAL_UNIT_TOKENS);

// The local units' inputs, as literals: `recipe import` needs a source directory that
// carries a recipe.json (the kind's own prepare-stage proof), `recipe new` a creator-grammar
// name whose destination does not exist yet, `mcp-setup` takes no arguments. A future local
// unit without a row here is a failure, never a silent skip.
const localInputs: Readonly<Record<string, (root: string) => readonly string[]>> = {
  "recipe import": (root) => ["import", join(root, "import-source")],
  "recipe new": () => ["new", "needs-local-recipe"],
  "mcp-setup": () => [],
};

// Valid named inputs for a target unit, from its declaration alone: required positionals,
// options and variadics; oneOf-required and requires-rule members filled; conflicts removed.
// A value that names a local file or directory is chosen so the kind's prepare-stage resolve
// HOLDS in the fixture (app.ts at the root, recipes/local complete).
const exampleValue = (argument: ArgumentSpec, root: string): string => {
  const kind = (argument as { value?: { kind?: string; example?: string } }).value;
  if (kind?.kind === "localFile") return join(root, "app.ts");
  if (kind?.kind === "localDirectory") return join(root, "recipes", "local");
  return kind?.example ?? "x";
};
const validArgs = (unit: Unit, root: string): { readonly args: Record<string, unknown>; readonly reason?: string } => {
  const chosen = new Set<string>();
  for (const argument of unit.args) {
    if (argument.kind === "positional" || ((argument.kind === "option" || argument.kind === "variadic") && argument.required === true)) chosen.add(argument.name);
  }
  for (const rule of unit.rules) {
    if (rule.rule === "oneOf" && rule.required === true) {
      const group = rule.groups.find((names) => names.every((name) => unit.args.some((argument) => argument.name === name)));
      if (group !== undefined) for (const name of group) chosen.add(name);
    }
  }
  for (let pass = 0; pass <= unit.rules.length; pass += 1) {
    for (const rule of unit.rules) {
      if (rule.rule !== "requires" || !chosen.has(rule.name)) continue;
      const candidates = rule.with.filter((name) => unit.args.some((argument) => argument.name === name));
      if (rule.any === true) {
        if (!candidates.some((name) => chosen.has(name)) && candidates[0] !== undefined) chosen.add(candidates[0]);
      } else {
        for (const name of candidates) chosen.add(name);
      }
    }
  }
  for (const rule of unit.rules) {
    if (rule.rule === "conflicts" && chosen.has(rule.name)) for (const name of rule.with) chosen.delete(name);
  }
  const args: Record<string, unknown> = {};
  for (const argument of unit.args) {
    if (!chosen.has(argument.name)) continue;
    if (argument.kind === "flag") { args[argument.name] = true; continue; }
    const kind = (argument as { value?: { example?: string } }).value;
    if (kind === undefined) return { args, reason: `--${argument.name} declares no value kind` };
    args[argument.name] = argument.kind === "variadic"
      ? Array.from({ length: (argument as { count?: number }).count ?? 1 }, () => exampleValue(argument, root))
      : exampleValue(argument, root);
  }
  if (unit.action !== undefined) args.action = unit.action;
  return { args };
};

// The context-stage refusal every needs-"target" unit owes on the malformed fixture: the
// existing Settings text, spelled as the literal token array (toSettings dies on the
// missing OC_DATA_DIR before a transport exists).
const DATA_DIR_UNSET_TOKENS: readonly string[] = ["OC_DATA_DIR", "is", "not", "set", "in", ".env"];

const tally = stageTally();
const fixture = await createDeploymentFixture();
const app = { name: "needs-fixture", description: "fixture", commands: openclawCommands };
try {
  // The malformed .env: no assignment at all, so every Settings build dies (toSettings
  // refuses a deployment without OC_DATA_DIR) while the file itself still parses as data.
  // The read-count seam makes "never read" observable, not just unobserved.
  await writeFile(join(fixture.root, ".env"), "this file carries no assignment\n", "utf8");
  // The import source the local `recipe import` row copies from.
  await mkdir(join(fixture.root, "import-source"), { recursive: true });
  await writeFile(join(fixture.root, "import-source", "recipe.json"), JSON.stringify({ description: "import source" }), "utf8");

  const runArgv = async (command: string, argv: readonly string[]) => {
    let output = "";
    const execution = await withOutputSink((chunk) => { output += chunk; }, () =>
      executeCommand(app, command, { kind: "argv", argv: [...argv] }, { surface: "terminal", transport: fixture.transport() }));
    return { execution, output, contacts: fixture.contacts() };
  };
  const runNamed = async (command: string, args: Record<string, unknown>, confirmed = true) => {
    let output = "";
    const execution = await withOutputSink((chunk) => { output += chunk; }, () =>
      executeCommand(app, command, { kind: "named", args }, { surface: "mcp", ...(confirmed ? { confirmed: true } : {}), transport: fixture.transport() }));
    return { execution, output, contacts: fixture.contacts() };
  };

  for (const unit of localUnits) {
    // the counter is per local unit: each row must prove its own zero, never inherit one
    resetEnvReads();
    const row = localInputs[unit.label];
    checkTrue(`${unit.label}: the local unit has an input row`, row !== undefined);
    const result = row === undefined ? undefined : await runArgv(unit.command, row(fixture.root));
    if (result === undefined) { resetEnvReads(); }
    else {
      tally.case(unit.label, result.execution.stage, result.execution.error);
      checkTrue(`${unit.label}: the local action reaches run with a broken .env, zero .env reads and zero target contacts`,
        result.execution.stage === "run" && result.execution.error === undefined
        && result.contacts.length === 0 && envReads() === 0);
    }
  }

  // MCP confirm (Q1): the repository-side change actions owe no confirmation — a named
  // call without confirm must reach run, never stop at the confirm stage, and must not
  // read the .env either.
  {
    resetEnvReads();
    // UNCONFIRMED on purpose: the case proves the change action owes no confirmation at all
    // (C171 re-declares destroy and must see this call stop at the confirm stage).
    const { execution, contacts } = await runNamed("recipe", { action: "new", name: "needs-local-recipe-mcp" }, false);
    checkTrue("recipe new over MCP: the change action owes no confirmation and reaches run without confirm",
      execution.stage === "run" && execution.error === undefined && contacts.length === 0 && envReads() === 0);
  }

  // Positive calibration (stage 7 tails): a deliberate read of the .env IS counted - the
  // zero assertions above stay evidence, never a dead seam that no read could ever move.
  resetEnvReads();
  const calibrated = await readEnvFileText();
  checkTrue("positive calibration: a deliberate .env read counts exactly once",
    calibrated === ["this", "file", "carries", "no", "assignment"].join(" ") + "\n"
    && envReads() === 1);

  const impossible: string[] = [];

  for (const unit of units.filter((candidate) => needsOf(candidate) !== "local")) {
    const built = validArgs(unit, fixture.root);
    const result = built.reason === undefined ? await runNamed(unit.command, built.args) : undefined;
    if (result === undefined) { impossible.push(`${unit.label}: ${built.reason ?? "unbuildable"}`); }
    else {
      tally.case(unit.label, result.execution.stage, result.execution.error);
      // The tolerated run-stage outcomes, derived from the declaration itself: a unit that
      // prepares the environment repairs the broken .env first (its own declared behavior),
      // and a needs "deployment" unit holds the unreachable recording transport as its
      // scope — both die at run ON the unreachable target, never before it. A needs
      // "target" unit at run would mean the malformed .env built a Context — the exact
      // leak this sweep exists to refuse.
      const stage = result.execution.stage;
      const error = result.execution.error;
      const text = error instanceof Error ? error.message.split(" ").join(",") : "";
      const atContext = stage === "context" && text === DATA_DIR_UNSET_TOKENS.join(",");
      const diesOnUnreachableTarget = stage === "run"
        && error instanceof Error
        && error.message.includes(TRANSPORT_SENTINEL);
      if (unit.needs === "deployment" || unit.preparesEnvironment) {
        // Declared, not listed: a needs "deployment" unit holds the unreachable recording
        // transport as its scope and dies at run on it; an environment-preparing unit either
        // repairs the broken .env and dies at run the same way, or its preparation leaves
        // the .env invalid and the pipeline refuses at the context stage with the existing
        // Settings text. Both outcomes are refusals the declaration itself predicts.
        checkTrue(`${unit.label}: the ${unit.needs === "deployment" ? "deployment" : "environment-preparing"} unit dies at run on the unreachable target, or refuses at the context stage with the existing Settings text`,
          diesOnUnreachableTarget || atContext);
        if (atContext) check(`${unit.label}: the unreachable target was never contacted`, result.contacts, []);
      } else {
        check(`${unit.label}: the target unit refuses at the context stage`, stage, "context");
        checkTrue(`${unit.label}: the refusal is the existing Settings text, word for word`, atContext);
        check(`${unit.label}: the unreachable target was never contacted`, result.contacts, []);
      }
    }
  }
  check("every target unit accepted inputs derived from its declaration", impossible, []);
} finally {
  await fixture.dispose();
}
tally.print("needs by action");
finish("needs");
