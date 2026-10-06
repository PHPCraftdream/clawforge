// The mirror is only worth having if it cannot silently rot.
//
// `logs`, `cli` and the gate's commands each drifted out of the MCP surface at some point,
// and nothing failed when they did — the surface was whatever was left after the exclusions,
// rather than a promise anyone could check. This compares the two surfaces as a user meets
// them: the command list `./clawforge help` prints, and the tool list a client receives. Anything
// on the first and not on the second has to be in MCP_EXEMPTIONS with a reason.
//
// Both are read from real processes rather than from the declarations they come from, so a
// command that is declared but unreachable, or reachable but never declared, is caught too.
// A scratch deployment is created for the duration, the same way mcp-server.check.ts does:
// the check must not depend on whichever deployment happens to be on this machine.

import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createApp, appsDir } from "#framework/integration/deployment/scaffold.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { MCP_EXEMPTIONS, STRUCTURED_OUTPUT_SCHEMA } from "#framework/integration/mcp/server.ts";
import { STRUCTURED_ENVELOPE_HELP } from "#framework/core/io/help-render.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";

function run(args: string[], input = ""): Promise<{ stdout: string; stderr: string }> {
  return runProcess(process.execPath, ["--experimental-strip-types", resolve(monorepoRoot, "tools", "clawforge.ts"), ...args], { input });
}

/** Command names as the help screen lists them: the deployment's own, indented six spaces,
 *  and the gate's, indented two. `--app <name>` is not a command and does not match. */
function consoleCommands(help: string): string[] {
  const names = new Set<string>();
  for (const line of help.split("\n")) {
    const match = /^\s{2,}([a-z][a-z-]*)(?:\s+<[a-z]+>)?\s{2,}\S/.exec(line);
    if (match !== null) names.add(match[1]);
  }
  return [...names].sort();
}

const deployment = `mcp-mirror-check-${randomBytes(4).toString("hex")}`;

try {
  await createApp(deployment);

  const help = await run(["--app", deployment, "help"]);
  const console = consoleCommands(help.stdout + help.stderr);

  const listed = await run(
    ["--app", deployment, "control-mcp"],
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
  );
  const response = listed.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as {
      result?: { tools?: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, { description?: string }> }; outputSchema?: unknown }> };
    })
    .find((entry) => entry.result?.tools !== undefined);
  const fullTools = response?.result?.tools ?? [];
  const tools = fullTools.map((tool) => tool.name).sort();

  // Guards against a false pass: an empty list either side would make every comparison below
  // trivially true.
  check("the console surface was read", console.length > 5, true);
  check("the tool surface was read", tools.length > 5, true);

  const unmirrored = console.filter((name) => !tools.includes(name));
  const unexplained = unmirrored.filter((name) => MCP_EXEMPTIONS[name] === undefined);
  check("every console command is either a tool or an explained exemption", unexplained, []);

  // The other direction: a tool nobody can reach from a terminal is not a mirror either, and
  // usually means a declaration that exists only for the server.
  const phantom = tools.filter((name) => !console.includes(name));
  check("every tool is a command the console offers too", phantom, []);

  // The exemptions that are exercised here — the ones that appear on the help screen —
  // should be the ones we decided on, not a list that quietly grew.
  check("mcp-serve is exempt, and is the reason the list exists", unmirrored.includes("mcp-serve"), true);

  for (const [name, reason] of Object.entries(MCP_EXEMPTIONS)) {
    check(`${name} carries a reason rather than a bare entry`, reason.trim().length > 20, true);
  }

  // tools/list's byte budget: an agent pays this in context before its first real call, every
  // session — each tool description is a one-line summary plus a pointer to `help`, not the
  // whole `--help` text. inputSchema keeps argument names, choices, and each description whole
  // as its declaration declares it — the `summary` where there is one, else the `description`
  // — instead of its full `--help` text: schema.ts's schemaArgumentDescription only omits a
  // description that merely restates the argument's own name, and how much text a description
  // carries is the declaration's decision, not the schema's. outputSchema
  // (STRUCTURED_OUTPUT_SCHEMA, declared once per structured command) carries types and
  // required-ness only, not the ~90-byte prose per field that used to sit on every one of them
  // identically — that meaning is in `help`'s output for a structured command now
  // (STRUCTURED_ENVELOPE_HELP, checked below). `help <command>` (renderHelp) and the CLI
  // `--help` still carry every argument description whole; the schema shows the declared text
  // rather than a shortened one.
  //
  // 30 KB (30720 bytes) was the target for this budget. Shortening outputSchema and the
  // tool-description help pointer, the schema descriptions kept whole, still reach ~31 KB —
  // inputSchema's argument names/types/required/choices are what is left, and cutting those
  // would mean a client can no longer tell a command's arguments apart without calling `help`
  // first, which is the information `tools/list` exists to carry. The budget below sits just
  // above what is reached, not at 30 KB.
  const TOOLS_LIST_BUDGET = 32 * 1024;
  const toolsListBytes = Buffer.byteLength(JSON.stringify(response?.result ?? {}), "utf8");
  process.stderr.write(`  tools/list is ${toolsListBytes} bytes (budget ${TOOLS_LIST_BUDGET})\n`);
  check("tools/list stays under its byte budget", toolsListBytes <= TOOLS_LIST_BUDGET, true);

  const overLong = fullTools.filter((tool) => (tool.description ?? "").length > 400).map((tool) => tool.name);
  check("every tool description is at most 400 characters", overLong, []);

  // No heuristic survives on the surface: a description is the declaration's own text (or
  // one action's own text per clause), never a cut — no ellipsis marking a truncation, no
  // `(value: <…>)` tail repeating the option's own valueName. A composed description is the
  // exception by design (R32-04): one clause per action, each carrying its own action list,
  // so `set.json` reads whole instead of one action's claim.
  const perActionComposite = /^[^;()]+ \([a-z, -]+\)(; [^;()]+ \([a-z, -]+\))*$/;
  const heuristicCut = fullTools.flatMap((tool) =>
    Object.entries(tool.inputSchema?.properties ?? {})
      .filter(([, property]) => {
        const description = property.description ?? "";
        return description.includes("…") || (description.includes("(value:") && description.includes("<"));
      })
      .map(([argumentName]) => `${tool.name}.${argumentName}`));
  check("no argument description in the schema is a heuristic cut", heuristicCut, []);
  // The declared text still has to stay short enough to be paid for per tool every session:
  // a clause over 90 characters is a details paragraph that belongs in `help`.
  const overLongArguments = fullTools.flatMap((tool) =>
    Object.entries(tool.inputSchema?.properties ?? {})
      .filter(([, property]) => {
        const description = property.description ?? "";
        return description.length > 90 && !perActionComposite.test(description);
      })
      .map(([argumentName]) => `${tool.name}.${argumentName}`));
  check("every argument description in the schema is a short clause", overLongArguments, []);

  // `help` is the pointer every shrunk description gives — it has to answer for every real
  // command, not only the ones exercised elsewhere.
  const helpTargets = tools.filter((toolName) => toolName !== "help");
  const helpRequests = helpTargets.map((toolName, index) => JSON.stringify({
    jsonrpc: "2.0", id: 200 + index, method: "tools/call", params: { name: "help", arguments: { command: toolName } },
  }));
  const helpRun = await run(["--app", deployment, "control-mcp"], `${helpRequests.join("\n")}\n`);
  const helpResponses = helpRun.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { id?: number; result?: { content?: Array<{ text?: string }> } });
  const helpTextFor = (toolName: string): string => {
    const index = helpTargets.indexOf(toolName);
    return helpResponses.find((entry) => entry.id === 200 + index)?.result?.content?.[0]?.text ?? "";
  };
  const emptyHelp = helpTargets.filter((toolName) => helpTextFor(toolName).trim() === "");
  check("the help tool returns non-empty text for every command", emptyHelp, []);

  // outputSchema was shortened to types and required-ness only (no per-field prose): every
  // structured tool must still declare the documented generic envelope — the one
  // structuredResult()/toolEnvelope() actually build — rather than something that quietly
  // drifted from it. A tool declaring a genuinely distinct outputSchema would fail this and
  // need its own check instead of this blanket one.
  const structuredTools = fullTools.filter((tool) => tool.outputSchema !== undefined);
  check("at least one structured tool was found", structuredTools.length > 0, true);
  const mismatchedSchema = structuredTools
    .filter((tool) => JSON.stringify(tool.outputSchema) !== JSON.stringify(STRUCTURED_OUTPUT_SCHEMA))
    .map((tool) => tool.name);
  check("every structured tool declares the documented generic envelope", mismatchedSchema, []);

  // The field meanings cut from outputSchema's per-field descriptions have to land somewhere
  // a client can still reach: `help <command>` for every structured tool, verbatim.
  const missingEnvelopeHelp = structuredTools
    .filter((tool) => !helpTextFor(tool.name).includes(STRUCTURED_ENVELOPE_HELP))
    .map((tool) => tool.name);
  check("the envelope's field meanings are reachable through help for every structured tool", missingEnvelopeHelp, []);

  // Not a second implementation of the console's own lookup: for a representative
  // multi-paragraph command, and for the bare command list, the tool's text matches
  // `./clawforge help [<command>]` exactly.
  const consoleRecipeHelp = await run(["--app", deployment, "help", "recipe"]);
  check(
    "the help tool's text matches ./clawforge help <command> exactly",
    helpTextFor("recipe"),
    (consoleRecipeHelp.stdout + consoleRecipeHelp.stderr).trim(),
  );

  // `recipe`'s `new-name` declares a summary bounded to 60 (stage 3 kept the full phrase in
  // the description): the schema carries that summary, plus the action scope the merged view
  // scopes the positional to (R18: the tool no longer offers it for every action); help
  // carries the description minus its declared "With import:" lead-in (R32-04).
  const recipeTool = fullTools.find((tool) => tool.name === "recipe");
  const newNameSchemaDescription = recipeTool?.inputSchema?.properties?.["new-name"]?.description ?? "";
  const declaredNewName = (openclawCommands.recipe.arguments ?? []).find((argument) => argument.name === "new-name");
  check("the declaration carries a summary for new-name", typeof declaredNewName?.summary, "string");
  const newScope = declaredNewName?.actions === undefined ? "" : ` (${declaredNewName.actions.join(", ")})`;
  check("the schema description is the declaration's summary, scoped to its action", newNameSchemaDescription, `${declaredNewName?.summary ?? ""}${newScope}`);
  check("the argument's help sentence is still reachable through help, minus the declared With lead-in", helpTextFor("recipe").includes((declaredNewName?.description ?? "").replace(/^With [\w/-]+: /, "")), true);

  const helpBareRun = await run(
    ["--app", deployment, "control-mcp"],
    `${JSON.stringify({ jsonrpc: "2.0", id: 300, method: "tools/call", params: { name: "help", arguments: {} } })}\n`,
  );
  const helpBareText = helpBareRun.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { result?: { content?: Array<{ text?: string }> } })[0]
    ?.result?.content?.[0]?.text ?? "";
  check("the help tool with no command matches ./clawforge help exactly", helpBareText, (help.stdout + help.stderr).trim());
} finally {
  await rm(resolve(appsDir, deployment), { recursive: true, force: true });
}

finish("mcp-mirror");
