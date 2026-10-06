// The MCP envelope's structured remedies, driven purely (no server process): a document's
// `next` advice becomes tool steps beside nextActions, a thrown refusal's advice becomes
// the fallback envelope's remedy, and an advice note rides the step (rf6-fix30).
import { structuredResult } from "#framework/integration/mcp/server.ts";
import { toolEnvelope } from "#framework/integration/mcp/call.ts";
import { UserError } from "#framework/core/io/log.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { renderAdvice } from "#framework/core/io/invocation/render.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

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

finish("mcp-envelope");
