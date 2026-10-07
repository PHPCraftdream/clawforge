// The MCP envelope's structured remedies, driven purely (no server process): a document's
// `next` advice becomes tool steps beside nextActions, a thrown refusal's advice becomes
// the fallback envelope's remedy, and an advice note rides the step (rf6-fix30).
import { structuredResult } from "#framework/integration/mcp/server.ts";
import { toolEnvelope, PRE_RUN_STAGES } from "#framework/integration/mcp/call.ts";
import { UserError } from "#framework/core/io/log.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { renderAdvice } from "#framework/core/io/invocation/render.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { executeCommand, type Execution } from "#framework/core/command/execute.ts";
import { commandBody, materializeCommands } from "#framework/core/command/index.ts";
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

finish("mcp-envelope");
