// The MCP envelope's structured remedies, driven purely (no server process): a document's
// `next` advice becomes tool steps beside nextActions, a thrown refusal's advice becomes
// the fallback envelope's remedy, and an advice note rides the step (rf6-fix30).
import { structuredResult } from "#framework/integration/mcp/server.ts";
import { toolEnvelope, toolArguments, toolSteps, PRE_RUN_STAGES } from "#framework/integration/mcp/call.ts";
import { toArgv } from "#framework/integration/mcp/legacy.ts";
import { UserError } from "#framework/core/io/log.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { renderAdvice } from "#framework/core/io/invocation/render.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { executeCommand, type Execution } from "#framework/core/command/execute.ts";
import { commandBody, materializeCommands, bindNamed, parseCall, specOf, specShape } from "#framework/core/command/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { ADVICE_ROWS } from "#checks/golden/advice.ts";
import { countValue } from "#framework/core/values/value.ts";
import { count } from "#framework/core/values/kinds.ts";
import type { CallShape } from "#framework/core/command/index.ts";
import type { Declared } from "#framework/integration/mcp/schema.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";

{
  // The structured remedies: a document that carries `next` advice answers with the tool
  // form beside nextActions — matched against the tools this server serves (design 1.4).
  const lookup = (name: string) => (name === "lock" ? { summary: "s", structured: true, arguments: [{ name: "check", description: "c", kind: "flag" as const }, { name: "json", description: "j", kind: "flag" as const }] } : undefined);
  const payload = JSON.stringify({
    healthy: false,
    problems: [{ code: "LOCK_MISSING", severity: "warning", detail: "y", nextAction: "./clawforge lock", next: { kind: "clawforge", argv: ["lock"] } }],
    nextActions: ["./clawforge lock"],
    next: [{ kind: "clawforge", argv: ["lock"] }, { kind: "manual", text: "reconnect the MCP client" }, { kind: "clawforge", argv: ["deploy", "--host", "x"] }],
  });
  const envelope = structuredResult({ summary: "s", structured: true, readOnly: true }, payload, "op-1", [], undefined, lookup);
  check("the remedies come through as tool steps where a tool exists", envelope?.nextSteps, [{ tool: "lock", arguments: {} }]);
}

{
  // rf6-fix30: a refusal that never emitted a document still carries its remedy — the thrown
  // UserError's advice becomes the fallback envelope's nextActions and nextSteps.
  const failLookup = (name: string) => (name === "bootstrap" ? { summary: "s", arguments: [] } : undefined);
  const remedy = command(["bootstrap"], { note: "then start it" });
  const refusal = new UserError("this deployment has never been bootstrapped", { advice: [remedy] });
  const fallback = toolEnvelope({ summary: "s", structured: true }, "", undefined, "op-fail", [], undefined, failLookup, refusal);
  checkTrue("a refusal's fallback envelope renders the remedy", fallback.nextActions[0] === renderAdvice(remedy));
  check("the refusal's remedy also travels as a tool step", fallback.nextSteps, [{ tool: "bootstrap", arguments: {}, note: "then start it" }]);
}

{
  // The advice's own note rides the tool step, when the document's advice carries one.
  const payload = JSON.stringify({ next: [{ kind: "clawforge", argv: ["lock"], note: "write the lock after the check" }] });
  const noted = structuredResult({ summary: "s", structured: true, readOnly: true }, payload, "op-note", [], undefined, (name: string) => (name === "lock" ? { summary: "s", arguments: [] } : undefined));
  check("a document's note rides the tool step", noted?.nextSteps, [{ tool: "lock", arguments: {}, note: "write the lock after the check" }]);
}

{
  // `changed` for a refused destroy call: false for every refusal at a stage before `run`;
  // a refusal at run, or with the stage unknown or omitted, keeps the conservative `true`.
  const destroy = { summary: "s", structured: true };
  const facts = { effect: "destroy" as const };
  const refusal = new UserError("refused");
  const changedAt = (stage: string | undefined, reachedRun = stage === "run", executionFacts = facts): boolean => toolEnvelope(destroy, "", undefined, "op-stage", [], stage === undefined ? undefined : { stage: stage as Execution["stage"], reachedRun, facts: executionFacts }, undefined, refusal).changed;
  check("the pre-run stages are parse, confirm and prepare", [...PRE_RUN_STAGES].sort(), ["confirm", "parse", "prepare"]);
  check("a mutating command refused before run reports changed: false", changedAt("prepare"), false);
  check("environment failure without a completed write reports unchanged", changedAt("environment"), false);
  check("context failure without a completed write reports unchanged", changedAt("context"), false);
  check("environment failure after a completed write reports changed", toolEnvelope(destroy, "", undefined, "op-stage", [], { stage: "environment", reachedRun: false, environmentWrote: true, facts }, undefined, refusal).changed, true);
  check("context failure after a completed write reports changed", toolEnvelope(destroy, "", undefined, "op-stage", [], { stage: "context", reachedRun: false, environmentWrote: true, facts }, undefined, refusal).changed, true);
  for (const stage of PRE_RUN_STAGES) check(`a refusal at ${stage} reports changed: false`, changedAt(stage), false);
  check("run refusal follows run entry even without contradictory reachedRun data", changedAt("run", false), true);
  check("a refusal at run after run was reached keeps changed: true", changedAt("run", true), true);
  check("a refusal with no stage keeps changed: true", changedAt(undefined), true);
  check("a refusal with an unknown stage keeps changed: true", changedAt("somewhere-else"), true);
}

{
  // The run-entry fact is the PIPELINE's, not a type-level one: a run that reached its
  // body reports reachedRun, a parse refusal never does.
  const fixture = await createDeploymentFixture();
  try {
    const probe = materializeCommands({ probe: { summary: "probe", group: "change" as const, structured: true, ...commandBody({ effect: "change", arguments: [], needs: "target", run: async () => {} }) } }).probe!;
    const app = { name: "fixture", description: "envelope probe", commands: { probe } };
    const okRun = await executeCommand(app, "probe", { kind: "named", args: { confirm: true } }, { surface: "mcp", transport: fixture.transport() });
    check("a run that reached its body reports reachedRun", okRun.stage === "run" && okRun.reachedRun === true, true);
    const refused = await executeCommand(app, "probe", { kind: "named", args: { __unknown: true } }, { surface: "mcp", transport: fixture.transport() });
    check("a parse refusal reports reachedRun false", refused.stage === "parse" && refused.reachedRun === false, true);
  } finally {
    await fixture.dispose();
  }
}

// R3-B-1: the outgoing inverse must enforce the incoming action slice, kinds and rules.
const shippedLookup = (name: string) => openclawCommands[name as keyof typeof openclawCommands];
const invalidRecipes = [
  ["recipe", "new", "r3-name", "r3-extra"],
  ["backup", "list", "--native"],
  ["watch", "install", "--interval", "bogus-r3"],
  ["secrets", "--print-template", "--template"],
];
const invalidNamed = [
  { action: "new", name: "r3-name", "new-name": "r3-extra" },
  { action: "list", native: true },
  { action: "install", interval: "bogus-r3" },
  { "print-template": true, template: true },
];
for (const [index, argv] of invalidRecipes.entries()) {
  const remedy = command(argv);
  const declared = shippedLookup(argv[0]);
  const shape = specShape(specOf(declared)!);
  let refused = false;
  try { parseCall(shape, argv.slice(1), argv[0]); } catch { refused = true; }
  check(`R3-B-1 ${argv.join(" ")}: strict parse refuses`, refused, true);
  let namedRefused = false;
  try { bindNamed(shape, { kind: "named", args: invalidNamed[index]! }, argv[0]); } catch { namedRefused = true; }
  check(`R3-B-1 ${argv.join(" ")}: named binding refuses`, namedRefused, true);
  check(`R3-B-1 ${argv.join(" ")}: no machine step`, toolSteps([remedy], shippedLookup), []);
  check(`R3-B-1 ${argv.join(" ")}: no inverse arguments`, toolArguments(declared, argv), undefined);
  const human = renderAdvice(remedy);
  const envelope = toolEnvelope(declared, "", undefined, "inverse", [], undefined, shippedLookup, new UserError("refused", { advice: [remedy] }));
  check(`R3-B-1 ${argv.join(" ")}: human remedy unchanged`, envelope.nextActions, [human]);
}
const validRecipes = [
  { argv: ["recipe", "import", "r3-source", "r3-destination"], args: { action: "import", name: "r3-source", "new-name": "r3-destination" } },
  { argv: ["recipe", "new", "r3-name"], args: { action: "new", name: "r3-name" } },
  { argv: ["backup"], args: { action: "create" } },
  { argv: ["backup", "list"], args: { action: "list" } },
  { argv: ["watch", "install", "--interval", "1h"], args: { action: "install", interval: "1h" } },
  { argv: ["logs", "--tail", "12"], args: { tail: "12" } },
  { argv: ["cli", "--", "--version"], args: { args: ["--version"] } },
];
for (const { argv, args } of validRecipes) {
  const declared = shippedLookup(argv[0]);
  const shape = specShape(specOf(declared)!);
  const steps = toolSteps([command(argv, { note: "inverse" })], shippedLookup);
  check(`R3-B-1 ${argv.join(" ")}: exact raw named arguments`, steps, [{ tool: argv[0], arguments: args, note: "inverse" }]);
  if (steps[0] !== undefined) {
    const named = bindNamed(shape, { kind: "named", args: steps[0].arguments }, argv[0]);
    const strict = parseCall(shape, argv.slice(1), argv[0]);
    const roundArgv = toArgv(declared, steps[0].arguments);
    check(`R3-B-1 ${argv.join(" ")}: explicit argv round trip (normalized)`, roundArgv, toArgv(declared, args));
    const reparsed = parseCall(shape, roundArgv, argv[0]);
    check(`R3-B-1 ${argv.join(" ")}: inverse argv values round trip`, reparsed.values, strict.values);
    check(`R3-B-1 ${argv.join(" ")}: inverse argv action round trip`, reparsed.action, strict.action);
    check(`R3-B-1 ${argv.join(" ")}: named and strict values round trip`, named.values, strict.values);
    check(`R3-B-1 ${argv.join(" ")}: named and strict action round trip`, named.action, strict.action);
  }
}
// Cheap producer sample: the existing golden registry, literal argv only; no placeholder
// substitution, prepare, command execution or claim to enumerate every runtime Advice.
let eligible = 0;
let emitted = 0;
for (const { label, advice } of ADVICE_ROWS) {
  if (advice.kind !== "clawforge" || advice.app !== undefined || advice.argv.some((word) => /<[^>]+>/.test(word))) continue;
  const declared = shippedLookup(advice.argv[0]);
  const body = declared === undefined ? undefined : specOf(declared);
  if (body === undefined) continue;
  eligible += 1;
  const shape = specShape(body);
  let strict;
  try { strict = parseCall(shape, advice.argv.slice(1), advice.argv[0]); } catch { /* not machine-bindable */ }
  const steps = toolSteps([advice], shippedLookup);
  check(`R3-B-1 shipped ${label}: emission follows strict parse`, steps.length, strict === undefined ? 0 : 1);
  if (steps[0] !== undefined && strict !== undefined) {
    emitted += 1;
    const named = bindNamed(shape, { kind: "named", args: steps[0].arguments }, advice.argv[0]);
    const roundArgv = toArgv(declared, steps[0].arguments);
    const reparsed = parseCall(shape, roundArgv, advice.argv[0]);
    check(`R3-B-1 shipped ${label}: inverse argv normalization is stable`, toArgv(declared, toolArguments(declared, [advice.argv[0], ...roundArgv])!), roundArgv);
    check(`R3-B-1 shipped ${label}: inverse argv values round trip`, reparsed.values, strict.values);
    check(`R3-B-1 shipped ${label}: inverse argv action round trip`, reparsed.action, strict.action);
    check(`R3-B-1 shipped ${label}: named values round trip`, named.values, strict.values);
  }
}
checkTrue("R3-B-1 shipped enumeration is nonempty", eligible > 0 && emitted > 0);
console.log(`R3-B-1 Advice registry: ${ADVICE_ROWS.length} rows, ${eligible} literal local shipped-spec rows, ${emitted} steps`);

// Converting public declarations still project raw MCP strings, never typed values.
for (const row of [
  { label: "legacy numeric", arguments: [{ kind: "option" as const, name: "number", description: "n", parse: countValue() }, { kind: "flag" as const, name: "enabled", description: "e" }], argv: ["--number=0012", "--enabled"], raw: { number: "0012", enabled: true }, values: { number: 12, enabled: true } },
  { label: "converting variadic", arguments: [{ kind: "variadic" as const, name: "numbers", description: "n", value: count() }], argv: ["--", "0012", "0003"], raw: { numbers: ["0012", "0003"] }, values: { numbers: [12, 3] } },
]) {
  const declared: Declared = { summary: "probe", arguments: row.arguments };
  const shape = { arguments: row.arguments } as CallShape;
  const argv = ["probe", ...row.argv];
  const steps = toolSteps([command(argv)], (name) => name === "probe" ? declared : undefined);
  check(`R3-B-1 ${row.label}: exact raw named arguments`, steps, [{ tool: "probe", arguments: row.raw }]);
  check(`R3-B-1 ${row.label}: strict converted values`, parseCall(shape, row.argv, "probe").values, row.values);
  if (steps[0] !== undefined) {
    let namedValues;
    try { namedValues = bindNamed(shape, { kind: "named", args: steps[0].arguments }, "probe").values; } catch { /* converted JSON is refused */ }
    check(`R3-B-1 ${row.label}: named converted values`, namedValues, row.values);
    check(`R3-B-1 ${row.label}: exact argv round trip`, toArgv(declared, steps[0].arguments), row.argv);
  }
  check(`R3-B-1 ${row.label}: invalid value suppressed`, toolArguments(declared, ["probe", ...(row.arguments[0].kind === "option" ? ["--number", "bad"] : ["bad"])]), undefined);
}

finish("mcp-envelope");
