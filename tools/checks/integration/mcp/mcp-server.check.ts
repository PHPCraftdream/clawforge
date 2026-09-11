// Checks that a malformed JSON-RPC line does not take down the whole MCP server.
//
// `null`, a number, a string and an array are all valid JSON but not a JSON-RPC request —
// JSON.parse accepts them, and reading `.method` off `null` used to throw uncaught,
// crashing the process before a later, well-formed request ever got a reply. This spawns
// the real server over real stdio, the same way tools/checks/deploy.check.ts stands in for
// a server that isn't reachable: process survival is not observable through a direct
// function call.
//
// A scratch deployment is created and removed for the duration: control-mcp only needs
// apps/<name>/app.ts to exist (initialize and the malformed lines never reach a command
// that would need a bootstrapped instance), and the check must not depend on whichever
// deployment happens to already be on this machine.

import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createApp, appsDir } from "../../../framework/integration/scaffold.ts";
import { monorepoRoot } from "../../../framework/core/env.ts";
import { MCP_EXEMPTIONS, structuredResult, toArgv } from "../../../framework/integration/mcp-server.ts";
import { openclawCommands } from "../../../framework/commands/interface/index.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

const lines = [
  "null",
  "42",
  '"just a string"',
  "[]",
  "{}", // an object, but no method
  '{"jsonrpc":"2.0","id":9,"method":"initialize"}',
  '{"jsonrpc":"2.0","id":10,"method":"tools/list"}',
];

function runServer(name: string, input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(
      process.execPath,
      ["--experimental-strip-types", resolve(monorepoRoot, "tools", "clawforge.ts"), "--app", name, "control-mcp"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    proc.stdin.end(`${input}\n`);
  });
}

const deploymentName = `mcp-check-${randomBytes(4).toString("hex")}`;

try {
  await createApp(deploymentName);

  const result = await runServer(deploymentName, lines.join("\n"));
  const responses = result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  check("the process does not crash on malformed input", result.code, 0);
  check("one response per line, including the malformed ones", responses.length, lines.length);
  check(
    "every malformed line gets a JSON-RPC invalid-request error, not silence",
    responses.slice(0, 5).every((r) => (r.error as { code?: number } | undefined)?.code === -32600),
    true,
  );

  const initReply = responses.find((r) => r.id === 9);
  check(
    "the well-formed request sent afterward still gets answered",
    (initReply?.result as { serverInfo?: unknown } | undefined)?.serverInfo !== undefined,
    true,
  );

  // The mirror includes the gate's own commands, which are dispatched before a deployment
  // exists and so are not part of app.commands. This runs through the monorepo gate, whose
  // list is check + new-app.
  const listed = responses.find((r) => r.id === 10);
  const toolNames = ((listed?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [])
    .map((tool) => tool.name);

  check("the gate's check command is offered as a tool", toolNames.includes("check"), true);
  check("so is new-app", toolNames.includes("new-app"), true);
  check("the deployment's own commands are still there beside them", toolNames.includes("status"), true);
  check(
    "nothing on the exemption list is offered",
    Object.keys(MCP_EXEMPTIONS).some((name) => toolNames.includes(name)),
    false,
  );

  // --- structured results are declared, so a client knows the shape before calling -------

  const tools = (listed?.result as { tools?: Array<{ name: string; outputSchema?: unknown }> } | undefined)?.tools ?? [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  check("a structured command declares its output schema", byName.get("inspect")?.outputSchema !== undefined, true);
  check("so does doctor", byName.get("doctor")?.outputSchema !== undefined, true);
  // The other twenty tools are unchanged: adding an envelope to the two that produce one
  // must not quietly promise a shape the rest do not return.
  check("a command that returns a log does not claim one", byName.get("status")?.outputSchema, undefined);
  check("nor does a gate command", byName.get("check")?.outputSchema, undefined);
} finally {
  await rm(resolve(appsDir, deploymentName), { recursive: true, force: true });
}

// --- confirming a destructive call is not permission to seize a lock ----------------------
//
// toArgv appends --force for a destructive command that declares it, because over MCP the
// confirm argument IS the confirmation and there is no terminal prompt to answer. That rule
// is right, and it silently widened the moment a command declared --force to mean something
// else: the instance lock's takeover flag. Every confirmed apply would then have taken over
// whatever lock another operation was holding. The takeover has its own name now, and this
// is what keeps the two apart.

{
  const declaredFlags = (name: string): string[] =>
    (openclawCommands[name]?.arguments ?? []).filter((argument) => argument.kind === "flag").map((argument) => argument.name);

  for (const name of ["apply", "rollback", "provision-agent"]) {
    check(`${name} does not call its lock takeover "force"`, declaredFlags(name).includes("force"), false);
    check(`${name} declares the takeover under its own name`, declaredFlags(name).includes("break-lock"), true);
  }

  // The generated argv is what actually reaches the command, so assert on that rather than
  // on the declaration alone.
  const argv = toArgv(openclawCommands.apply!, { confirm: true });
  check("a confirmed apply carries no lock takeover", argv.includes("--break-lock"), false);
  check("and a caller that asks for it still gets it", toArgv(openclawCommands.apply!, { confirm: true, "break-lock": true }).includes("--break-lock"), true);
}

// --- the envelope itself -----------------------------------------------------------------
//
// What an agent reads instead of the log. Built from the command's output alone, so the one
// case that matters most is a command that reports findings and then fails on them: the
// document it emitted is still valid and is still what the caller needs.

function deep(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual), JSON.stringify(expected));
}

{
  const payload = JSON.stringify({
    healthy: false,
    problems: [
      { code: "CONFIG_DRIFT", severity: "blocking", detail: "x", nextAction: "./clawforge apply" },
      { code: "LOCK_MISSING", severity: "warning", detail: "y", nextAction: "./clawforge lock" },
    ],
    nextActions: ["./clawforge apply", "./clawforge lock"],
  });

  const envelope = structuredResult({ summary: "s", structured: true, readOnly: true }, payload, "op-1");
  check("a read-only command states it changed nothing", envelope?.changed, false);
  check("the verdict is carried", envelope?.healthy, false);
  check("problems come through whole", envelope?.problems.length, 2);
  deep("warnings are the non-blocking subset", envelope?.warnings, [{ code: "LOCK_MISSING", severity: "warning", detail: "y", nextAction: "./clawforge lock" }]);
  deep("the remedies are a list", envelope?.nextActions, ["./clawforge apply", "./clawforge lock"]);
  check("the call names itself", envelope?.operationId, "op-1");
  check("and the command's own document is kept unaltered", JSON.stringify(envelope?.result), payload);
}

{
  // A command that may change things and does not say: taken to have changed something. An
  // agent that re-checks needlessly loses a call; one that skips a check it needed loses
  // the thread.
  const envelope = structuredResult({ summary: "s", structured: true }, JSON.stringify({ healthy: true }), "op-2");
  check("a mutating command that stays silent is assumed to have changed something", envelope?.changed, true);
  deep("and absent fields stay absent rather than being invented", [envelope?.problems, envelope?.nextActions], [[], []]);
}

{
  const envelope = structuredResult({ summary: "s", structured: true }, JSON.stringify({ changed: false, healthy: true }), "op-3");
  check("a command that says it changed nothing is believed", envelope?.changed, false);
}

{
  // A broken promise degrades to what every other tool returns; the text result still
  // stands, so a working call does not become an error over its envelope.
  check("output that is not JSON produces no envelope", structuredResult({ summary: "s", structured: true }, "==> starting\n", "op-4"), undefined);
  check("nor does JSON that is not a document", structuredResult({ summary: "s", structured: true }, "42", "op-5"), undefined);
}

process.stderr.write(failed === 0 ? "all mcp-server checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
