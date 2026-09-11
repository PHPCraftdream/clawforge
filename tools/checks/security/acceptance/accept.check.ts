// Declared acceptance checks: each kind, and the rule about the ones that cost money.
//
// Every kind is exercised in both directions, because a check that cannot fail is worse than
// no check — it reports success on a broken deployment. The stub stands in for the target so
// each failure can be provoked deliberately.

import { runCheck, requiresModel, summarize, acceptanceSpecError } from "../../../framework/commands/orchestration/accept.ts";
import type { AcceptanceCheck } from "../../../framework/commands/orchestration/accept.ts";
import type { Context } from "../../../framework/core/context.ts";
import type { ExecResult } from "../../../framework/runtime/transport.ts";

let failed = 0;

check("model use is enforced by kind", requiresModel("agent_answers"), true);
check("ordinary checks do not require the model", requiresModel("mcp_tool"), false);
check("summary names every non-passed category", summarize(2, 1, 3, 4), "2 passed, 1 failed, 4 could not be checked, 3 not checked");
check("a non-object declaration is rejected", acceptanceSpecError(null), "acceptance check must be an object");
check("a declaration without kind is rejected", acceptanceSpecError({}), 'acceptance check needs a non-empty string "kind"');
check("a tool check without a tool is rejected", acceptanceSpecError({ kind: "mcp_tool" }), 'acceptance check "mcp_tool" has invalid tool, expect or arguments fields');

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

interface Answers {
  /** JSON-RPC lines the recipe's MCP server replies with, by request id. */
  mcp?: Record<number, unknown>;
  /** Exit code of the process that served them. */
  exit?: number;
  agents?: { id: string }[];
  servers?: string[];
  cron?: { name?: string; schedule?: { expr?: string } }[];
  agentReply?: string;
}

function stubContext(answers: Answers): Context {
  return {
    settings: { dataDir: "/srv/clawforge" },
    runtime: {
      async runOneOff(service: string, args: string[]): Promise<ExecResult> {
        // The recipe's own server: started the way the gateway would start it.
        if (service === "gateway") {
          const lines = Object.entries(answers.mcp ?? {}).map(([id, result]) =>
            JSON.stringify({ jsonrpc: "2.0", id: Number(id), ...(result as object) }),
          );
          return { code: answers.exit ?? 0, stdout: `${lines.join("\n")}\n`, stderr: answers.exit === undefined ? "" : "server died" };
        }
        const key = args.slice(0, 2).join(" ");
        if (key === "agents list") return { code: 0, stdout: JSON.stringify(answers.agents ?? []), stderr: "" };
        if (key === "mcp list") {
          return { code: 0, stdout: JSON.stringify(Object.fromEntries((answers.servers ?? []).map((name) => [name, {}]))), stderr: "" };
        }
        if (key === "cron list") return { code: 0, stdout: JSON.stringify({ jobs: answers.cron ?? [] }), stderr: "" };
        if (args[0] === "agent") return { code: 0, stdout: answers.agentReply ?? "", stderr: "" };
        return { code: 0, stdout: "{}", stderr: "" };
      },
    },
  } as unknown as Context;
}

function toolsListed(names: string[]) {
  return { 1: { result: {} }, 2: { result: { tools: names.map((name) => ({ name })) } } };
}

function toolAnswered(text: string) {
  return { 1: { result: {} }, 2: { result: { content: [{ type: "text", text }] } } };
}

async function run(answers: Answers, declared: AcceptanceCheck) {
  return runCheck(stubContext(answers), "demo", declared);
}

// --- mcp_responds ------------------------------------------------------------------------------

{
  const passed = await run({ mcp: toolsListed(["example_search", "example_get_page"]) }, { kind: "mcp_responds", tools: ["example_search"] });
  check("a server offering the declared tools passes", passed.status, "passed");

  const missing = await run({ mcp: toolsListed(["example_search"]) }, { kind: "mcp_responds", tools: ["example_search", "example_get_page"] });
  check("a missing tool fails", missing.status, "failed");
  check("and the missing one is named", missing.detail?.includes("example_get_page"), true);

  // A server that does not start at all answers nothing — which must not read as "no tools
  // were required, so it passed".
  const silent = await run({ mcp: {} }, { kind: "mcp_responds", tools: [] });
  check("a server that does not answer cannot be checked even with nothing declared", silent.status, "could-not-check");
  const noTools = await run({ mcp: { 1: { result: {} }, 2: { result: { tools: [] } } } }, { kind: "mcp_responds", tools: [] });
  check("an answering server may legitimately offer no tools", noTools.status, "passed");
}

// --- mcp_tool ------------------------------------------------------------------------------------

{
  const passed = await run({ mcp: toolAnswered("2 result(s) for the query: docs/example.md") }, {
    kind: "mcp_tool",
    tool: "example_search",
    arguments: { query: "example" },
    expect: "docs/example.md",
  });
  check("a tool whose answer contains what was declared passes", passed.status, "passed");

  const wrong = await run({ mcp: toolAnswered("no results for the query") }, {
    kind: "mcp_tool",
    tool: "example_search",
    expect: "docs/example.md",
  });
  check("an answer missing the expected text fails", wrong.status, "failed");
  // The reader needs to see what it actually said, or the next step is running it by hand.
  check("and the failure quotes what it did say", wrong.detail?.includes("no results for the query"), true);

  const refused = await run({ mcp: { 1: { result: {} }, 2: { error: { code: -32602, message: "unknown tool" } } } }, {
    kind: "mcp_tool",
    tool: "nope",
  });
  check("a refused call cannot be checked", refused.status, "could-not-check");

  const empty = await run({ mcp: toolAnswered("") }, { kind: "mcp_tool", tool: "example_search" });
  check("an empty answer cannot be checked even with nothing expected", empty.status, "could-not-check");

  const noTool = await run({}, { kind: "mcp_tool" });
  check("a check that names no tool cannot be checked, not passed", noTool.status, "could-not-check");
}

// --- a failed call is a failed check, whatever the text says ------------------------------
//
// Three ways a call fails and only one was read. A tool answering isError with "no such
// page" passed whenever the expected text happened to appear in that message — a check that
// cannot fail reports success on a broken deployment, which is worse than having no check.

{
  const isErrorAnswer = { 1: { result: {} }, 2: { result: { isError: true, content: [{ type: "text", text: "no such page: docs/example.md" }] } } };

  const failedCall = await run({ mcp: isErrorAnswer }, {
    kind: "mcp_tool",
    tool: "example_get_page",
    // The expected text IS present — in the failure message. This is the exact shape that
    // used to pass.
    expect: "docs/example.md",
  });
  check("a tool reporting its own failure cannot be checked", failedCall.status, "could-not-check");
  check("even though the expected text appears in the error", failedCall.detail?.includes("reported failure"), true);

  const died = await run({ mcp: toolAnswered("2 result(s) for the query: docs/example.md"), exit: 1 }, {
    kind: "mcp_tool",
    tool: "example_search",
    expect: "docs/example.md",
  });
  check("a server that printed an answer and then died cannot be checked", died.status, "could-not-check");
  check("naming the exit code", died.detail?.includes("exited 1"), true);

  // The listing side reads the same way: a crash must not be read as "no tools offered".
  const listDied = await run({ mcp: toolsListed(["example_search"]), exit: 2 }, { kind: "mcp_responds", tools: ["example_search"] });
  check("a crashed server cannot be checked by mcp_responds", listDied.status, "could-not-check");
  check("as an exit, not as a missing tool", listDied.detail?.includes("exited 2"), true);

  // And the ordinary case still passes: the guard must not reject working answers.
  const fine = await run({ mcp: toolAnswered("2 result(s) for the query: docs/example.md") }, {
    kind: "mcp_tool",
    tool: "example_search",
    expect: "docs/example.md",
  });
  check("a successful call with the declared text still passes", fine.status, "passed");
}

// --- agent_has_tools ------------------------------------------------------------------------------

{
  const passed = await run({ agents: [{ id: "example-agent" }], servers: ["example-recipe"] }, {
    kind: "agent_has_tools",
    agent: "example-agent",
    server: "example-recipe",
  });
  check("an agent and its server both registered passes", passed.status, "passed");

  const noAgent = await run({ agents: [{ id: "main" }], servers: ["example-recipe"] }, {
    kind: "agent_has_tools",
    agent: "example-agent",
    server: "example-recipe",
  });
  check("a missing agent fails", noAgent.status, "failed");

  const noServer = await run({ agents: [{ id: "example-agent" }], servers: [] }, {
    kind: "agent_has_tools",
    agent: "example-agent",
    server: "example-recipe",
  });
  check("a registered agent with no server fails", noServer.status, "failed");
  check("saying it cannot call it", noServer.detail?.includes("cannot call"), true);
}

// --- cron_matches ------------------------------------------------------------------------------------

{
  const passed = await run({ cron: [{ name: "example-refresh", schedule: { expr: "17 3 * * *" } }] }, {
    kind: "cron_matches",
    job: "example-refresh",
    schedule: "17 3 * * *",
  });
  check("a job on the declared schedule passes", passed.status, "passed");

  const drifted = await run({ cron: [{ name: "example-refresh", schedule: { expr: "0 4 * * *" } }] }, {
    kind: "cron_matches",
    job: "example-refresh",
    schedule: "17 3 * * *",
  });
  check("a job on a different schedule fails", drifted.status, "failed");
  check("with both schedules named", drifted.detail?.includes("0 4 * * *") && drifted.detail?.includes("17 3 * * *"), true);

  const absent = await run({ cron: [] }, { kind: "cron_matches", job: "example-refresh" });
  check("an absent job fails", absent.status, "failed");
}

// --- agent_answers: the one that costs money ------------------------------------------------------------

{
  const passed = await run({ agentReply: "You will need VPN, the tracker and the wiki." }, {
    kind: "agent_answers",
    agent: "example-agent",
    message: "what access does a new engineer need?",
    expect: "VPN",
    usesModel: true,
  });
  check("an agent whose answer mentions what was declared passes", passed.status, "passed");

  const silent = await run({ agentReply: "" }, { kind: "agent_answers", agent: "example-agent", message: "x", usesModel: true });
  check("an agent that says nothing cannot be checked", silent.status, "could-not-check");
}

// Metadata cannot opt an agent_answers check into an unpaid run. The dispatcher owns this
// decision; the declaration's optional usesModel field is only descriptive.
{
  check("agent_answers still identifies a model check when metadata lies", requiresModel("agent_answers"), true);
}

// --- an unknown kind is a failure, not a pass -------------------------------------------------------------

{
  const unknown = await run({}, { kind: "teleport_the_instance" });
  check("a kind the framework does not implement cannot be checked", unknown.status, "could-not-check");
  // Skipping it silently would let a recipe declare anything it liked and always be green.
  check("naming the kind it does not know", unknown.detail?.includes("teleport_the_instance"), true);
}

process.stderr.write(failed === 0 ? "all acceptance checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
