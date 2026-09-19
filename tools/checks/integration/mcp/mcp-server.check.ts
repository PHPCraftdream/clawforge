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

import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createApp, appsDir } from "#framework/integration/scaffold.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { MCP_EXEMPTIONS, inputSchema, structuredResult, toArgv, toolDescription } from "#framework/integration/mcp-server.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

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
  check("a mixed recipe command advertises conditional structured output", byName.get("recipe")?.outputSchema !== undefined, true);
  check("nor does a gate command", byName.get("check")?.outputSchema, undefined);
} finally {
  await rm(resolve(appsDir, deploymentName), { recursive: true, force: true });
}

// Mixed command groups gate only mutating actions. This keeps the MCP contract safe when a
// caller selects `recipe remove --volumes`, while list remains callable without a confirmation.
{
  const recipeDeployment = `mcp-check-recipe-${randomBytes(4).toString("hex")}`;
  const recipeLines = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recipe", arguments: { action: "remove", name: "demo", volumes: true } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recipe", arguments: { action: "remove", name: "demo", volumes: true, confirm: false } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recipe", arguments: { action: "list" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "recipe", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/list" },
  ].map((request) => JSON.stringify(request)).join("\n");

  try {
    await createApp(recipeDeployment);
    const result = await runServer(recipeDeployment, recipeLines);
    const responses = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const byId = new Map(responses.map((response) => [response.id, response]));
    const textOf = (id: number): string => String(((byId.get(id)?.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? [])[0]?.text ?? "");

    check("recipe MCP calls keep the server alive", result.code, 0);
    check("recipe remove without confirm is rejected", textOf(1).includes("pass confirm: true"), true);
    check("recipe remove with confirm false is rejected", textOf(2).includes("pass confirm: true"), true);
    check("read-only recipe list remains available without confirmation", textOf(3).includes("no recipes yet"), true);
    check("bare recipe with no action runs the list default instead of demanding confirmation", textOf(5).includes("no recipes yet"), true);

    const recipeTool = (((byId.get(4)?.result as { tools?: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }> } | undefined)?.tools ?? [])
      .find((tool) => tool.name === "recipe"));
    check("recipe MCP schema leaves conditional confirmation optional", recipeTool?.inputSchema?.required?.includes("confirm"), false);
    check("recipe MCP schema exposes confirmation", recipeTool?.inputSchema?.properties?.confirm !== undefined, true);
    check("recipe MCP description explains conditional confirmation", recipeTool?.description?.includes("read-only actions do not"), true);
    check("declaration and generated description agree", toolDescription(openclawCommands.recipe!).includes("read-only actions do not"), true);
    const required = (inputSchema(openclawCommands.recipe!).required as string[] | undefined) ?? [];
    check("declaration and generated schema agree", required.includes("confirm"), false);
    check("bare recipe arguments are read-only for MCP gating", openclawCommands.recipe!.readOnlyWhen?.([]), true);
    check("recipe list remains read-only for MCP gating", openclawCommands.recipe!.readOnlyWhen?.(["list"]), true);
    check("recipe status remains read-only for MCP gating", openclawCommands.recipe!.readOnlyWhen?.(["status"]), true);
  check("recipe logs remains read-only for MCP gating", openclawCommands.recipe!.readOnlyWhen?.(["logs"]), true);
  check("recipe verify is mutating for MCP gating like onboard", openclawCommands.recipe!.readOnlyWhen?.(["verify"]), false);
  check("recipe onboard is mutating for MCP gating", openclawCommands.recipe!.readOnlyWhen?.(["onboard"]), false);
  check("recipe diagnose is mutating for MCP gating, same reason as verify", openclawCommands.recipe!.readOnlyWhen?.(["diagnose"]), false);
  const recipeProperties = inputSchema(openclawCommands.recipe!).properties as Record<string, { enum?: string[] }> | undefined;
  const recipeActionSchema = recipeProperties?.action;
  deep(
    "recipe MCP schema documents import/verify/onboard/diagnose actions",
    recipeActionSchema?.enum,
    ["list", "import", "install", "remove", "status", "logs", "verify", "onboard", "diagnose"],
  );
  check("recipe help explains app-owned hooks", toolDescription(openclawCommands.recipe!).includes("prepare.ts"), true);
    check("recipe install remains destructive for MCP gating", openclawCommands.recipe!.readOnlyWhen?.(["install"]), false);
    check("recipe remove remains destructive for MCP gating", openclawCommands.recipe!.readOnlyWhen?.(["remove"]), false);

    const setSchema = inputSchema(openclawCommands.set!);
    check("set MCP schema leaves conditional confirmation optional", (setSchema.required as string[]).includes("confirm"), false);
    check("set MCP description explains conditional confirmation", toolDescription(openclawCommands.set!).includes("read-only actions do not"), true);
    check("set build is read-only for MCP gating", openclawCommands.set!.readOnlyWhen?.(["build"]), true);
    check("set try remains destructive for MCP gating", openclawCommands.set!.readOnlyWhen?.(["try"]), false);
    check("lock check is read-only for MCP gating", openclawCommands.lock!.readOnlyWhen?.(["--check"]), true);
    check("lock write remains mutable for MCP gating", openclawCommands.lock!.readOnlyWhen?.([]), false);
  } finally {
    await rm(resolve(appsDir, recipeDeployment), { recursive: true, force: true });
  }
}

// A structured read-only command reports changed:false, while the corresponding write remains
// gated and reports changed:true after an explicit confirmation.
{
  const lockDeployment = `mcp-check-lock-${randomBytes(4).toString("hex")}`;
  const lockLines = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lock", arguments: { check: true, json: true } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lock", arguments: { json: true, confirm: true } } },
  ].map((request) => JSON.stringify(request)).join("\n");

  try {
    await createApp(lockDeployment);
    const result = await runServer(lockDeployment, lockLines);
    const responses = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const byId = new Map(responses.map((response) => [response.id, response]));
    const structured = (id: number): { changed?: boolean } | undefined =>
      (byId.get(id)?.result as { structuredContent?: { changed?: boolean } } | undefined)?.structuredContent;

    check("lock check is callable without confirmation", byId.get(1)?.error, undefined);
    check("lock check reports changed false", structured(1)?.changed, false);
    check("confirmed lock write succeeds", byId.get(2)?.error, undefined);
    check("lock write reports changed true", structured(2)?.changed, true);
  } finally {
    await rm(resolve(appsDir, lockDeployment), { recursive: true, force: true });
  }
}

// --- app-owned verify runs recipe code, so it is gated like onboard -----------------------
//
// verify.ts is an app-owned hook invoked with the full Context — the same access prepare.ts
// gets, and prepare may mutate the target. Being named "verify" is not evidence it is
// read-only, so until something the framework itself verified says otherwise, the call
// demands confirm: true like onboard does, and the envelope may not report changed:false on
// the strength of the action's name alone.
{
  const verifyDeployment = `mcp-check-verify-${randomBytes(4).toString("hex")}`;
  const recipeDir = resolve(appsDir, verifyDeployment, "recipes", "probe");
  const verifyLines = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recipe", arguments: { action: "verify", name: "probe" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recipe", arguments: { action: "verify", name: "probe", confirm: true } } },
  ].map((request) => JSON.stringify(request)).join("\n");

  try {
    await createApp(verifyDeployment);
    await mkdir(recipeDir, { recursive: true });
    await writeFile(resolve(recipeDir, "recipe.json"), JSON.stringify({ description: "Verify gating probe" }), "utf8");
    await writeFile(resolve(recipeDir, "verify.ts"), "export async function verify() { return { ok: true, problems: [] }; }\n", "utf8");
    const result = await runServer(verifyDeployment, verifyLines);
    const responses = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const byId = new Map(responses.map((response) => [response.id, response]));
    const textOf = (id: number): string => String(((byId.get(id)?.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? [])[0]?.text ?? "");

    check("recipe verify without confirm is refused like onboard", textOf(1).includes("pass confirm: true"), true);
    check("the refusal is a tool error reply", (byId.get(1)?.result as { isError?: boolean } | undefined)?.isError, true);
    check("confirmed recipe verify succeeds", byId.get(2)?.error, undefined);
    const structured = (byId.get(2)?.result as { structuredContent?: { changed?: boolean } } | undefined)?.structuredContent;
    // The hook's own JSON says nothing about changed, so the envelope must fall back to
    // "assume it changed something" — never to changed:false, which nothing here can back.
    check("a confirmed verify is not reported as changed:false", structured?.changed, true);
  } finally {
    await rm(resolve(appsDir, verifyDeployment), { recursive: true, force: true });
  }
}

// --- a malformed tools/call params.name must not crash the process ------------------------
//
// String(params.name ?? "") used to throw when params.name was an object whose toString is
// not callable — confirmed directly: String({toString: null}) throws "Cannot convert object
// to primitive value". Uncaught inside the dispatch loop, that took the whole process down
// before any request queued after it (including a later initialize) got answered.

{
  const badCallDeployment = `mcp-check-badcall-${randomBytes(4).toString("hex")}`;
  const malformedCallLines = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":{"toString":null}}}',
    '{"jsonrpc":"2.0","id":3,"method":"initialize"}',
  ];

  try {
    await createApp(badCallDeployment);
    const result = await runServer(badCallDeployment, malformedCallLines.join("\n"));
    const responses = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    check("the process does not crash on a tools/call with a non-string params.name", result.code, 0);
    check("all three requests get a reply", responses.length, 3);

    const badCallReply = responses.find((r) => r.id === 2);
    check("the malformed call gets an ordinary JSON-RPC error, not silence", badCallReply?.error !== undefined, true);

    const secondInit = responses.find((r) => r.id === 3);
    check(
      "the request queued after it still gets answered",
      (secondInit?.result as { serverInfo?: unknown } | undefined)?.serverInfo !== undefined,
      true,
    );
  } finally {
    await rm(resolve(appsDir, badCallDeployment), { recursive: true, force: true });
  }
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
  const envelope = structuredResult(
    { summary: "s", structured: true },
    JSON.stringify({ operationId: "journal-op", changed: true, problems: [], nextActions: [] }),
    "tool-call-id",
  );
  check("a command operation id is promoted to the envelope", envelope?.operationId, "journal-op");
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
