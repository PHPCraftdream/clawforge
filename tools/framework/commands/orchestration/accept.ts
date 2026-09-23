// `./clawforge accept [<recipe>]` — does this deployment's own work actually work.
//
// `./clawforge smoke` proves the instance is healthy: it answers, it restores, its MCP bridge
// speaks JSON-RPC. It cannot say whether the wiki a recipe serves is reachable, whether the
// agent built from that recipe has the tools it was given, or whether the cron job matches
// what the recipe declares. Those are properties of this deployment, and the framework has
// no business knowing them.
//
// So the recipe declares them and the framework runs them. A recipe states what "working"
// means for it in acceptance.json, using check kinds the framework implements — no code
// travels from a deployment into the framework, which is the same boundary provision-agent
// draws.
//
// Checks that call the model are declared separately and never run unless asked. They cost
// money, they take a turn, and an agent turn has side effects — it writes to its own
// workspace. A suite that quietly did that on every run would be a suite people stop
// running. The count of what was skipped is always reported: a suite that silently omits
// what it did not run is how coverage disappears.

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, warn, die } from "#src/core/log.ts";
import { emit, isCaptured } from "#src/core/output.ts";
import { recipesDir, deploymentName } from "#src/runtime/deployment.ts";
import { openclawCliJson, withModelApproval } from "#src/service/openclaw-cli.ts";
import { recipeServerContainerPath, mcpServerMatches } from "../management/provision-agent/index.ts";
import type { CheckOutcome } from "../check-outcome.ts";
import type { Context } from "#src/core/context.ts";
import { withUnpackedArtifact } from "#src/set/artifacts/install.ts";
import type { VerifiedArtifact } from "#src/set/artifacts/install.ts";
import { withSetSource } from "#src/set/artifacts/source.ts";
import { observeRuntime, runtimeMatches, saveEvidence } from "#src/set/artifacts/evidence.ts";
import { gatherInspection } from "./inspect/gather.ts";
import { isHealthy } from "#src/service/inspection.ts";

/** One declared check. `kind` selects what the framework does; everything else is that
 *  kind's own arguments, kept loose because each kind reads different ones. */
export interface AcceptanceCheck {
  readonly kind: string;
  readonly name?: string;
  /** True when running this check calls the model: costs tokens, takes an agent turn, and
   *  the turn has side effects of its own. Never run unless explicitly asked for. */
  readonly usesModel?: boolean;
  readonly [argument: string]: unknown;
}

/** The acceptance readings of the shared check outcomes. The four values and the reasoning
 *  behind them live in commands/check-outcome.ts, beside the error classes a throw-style
 *  check suite uses to land on them. */
export type AcceptanceStatus = CheckOutcome;

/** Model use is a property of the operation, not a claim made by deployment metadata.
 * `usesModel: false` on `agent_answers` must not make a paid check run accidentally. */
export function requiresModel(kind: unknown): boolean {
  return kind === "agent_answers";
}

export interface AcceptanceResult {
  readonly name: string;
  readonly kind: string;
  readonly status: AcceptanceStatus;
  readonly detail?: string;
}

export interface AcceptanceReport {
  readonly deployment: string;
  readonly recipes: Record<string, AcceptanceResult[]>;
  readonly passed: number;
  readonly failed: number;
  readonly notChecked: number;
  readonly couldNotCheck: number;
  /** One sentence, the same facts the counts already carry — so a coder and an agent read
   *  one answer rather than reconstructing it themselves from the counts. */
  readonly summary: string;
  /** Not merely failed === 0: a suite that could not obtain a verdict for something has not
   *  earned the right to call itself passing either — that is a different, quieter way for
   *  a broken deployment to report success. */
  readonly healthy: boolean;
  readonly receipt?: { id: string; setId: string; verdict: string };
}

/** The one sentence both the prose and the JSON output carry. Exported so `set try`'s own
 *  report can say the same thing about acceptance in the same words. */
export function summarize(passed: number, failed: number, notChecked: number, couldNotCheck: number): string {
  const parts = [`${passed} passed`, `${failed} failed`];
  if (couldNotCheck > 0) parts.push(`${couldNotCheck} could not be checked`);
  if (notChecked > 0) parts.push(`${notChecked} not checked`);
  return parts.join(", ");
}

/** Validates the small part of a check declaration the dispatcher relies on. Arguments that
 * belong to a particular kind are validated by that kind at execution time, where a missing
 * target can be reported as `could-not-check` instead of taking down the rest of a suite. */
export function acceptanceSpecError(value: unknown, index?: number): string | undefined {
  const where = index === undefined ? "acceptance check" : `acceptance check ${index + 1}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `${where} must be an object`;
  const check = value as Record<string, unknown>;
  if (typeof check.kind !== "string" || check.kind.trim() === "") return `${where} needs a non-empty string "kind"`;
  if (check.name !== undefined && (typeof check.name !== "string" || check.name.trim() === "")) {
    return `${where} "${check.kind}" has an invalid "name"`;
  }
  if (check.usesModel !== undefined && typeof check.usesModel !== "boolean") {
    return `${where} "${check.kind}" has a non-boolean "usesModel"`;
  }
  const stringField = (field: string): boolean => check[field] === undefined || (typeof check[field] === "string" && (check[field] as string).trim() !== "");
  const requiredString = (field: string): boolean => typeof check[field] === "string" && (check[field] as string).trim() !== "";
  if (check.kind === "mcp_responds" && check.tools !== undefined && (!Array.isArray(check.tools) || check.tools.some((tool) => typeof tool !== "string" || tool.trim() === ""))) {
    return `${where} "mcp_responds" has an invalid "tools" array`;
  }
  if (check.kind === "mcp_tool" && (!requiredString("tool") || !stringField("expect") || (check.arguments !== undefined && (check.arguments === null || typeof check.arguments !== "object" || Array.isArray(check.arguments))))) {
    return `${where} "mcp_tool" has invalid tool, expect or arguments fields`;
  }
  if (check.kind === "agent_has_tools" && (!requiredString("agent") || !requiredString("server"))) {
    return `${where} "agent_has_tools" needs non-empty "agent" and "server" strings`;
  }
  if (check.kind === "cron_matches" && (!requiredString("job") || !stringField("schedule") || !stringField("timezone"))) {
    return `${where} "cron_matches" has an invalid job or schedule`;
  }
  if (check.kind === "agent_answers" && (!requiredString("agent") || !requiredString("message") || !stringField("expect"))) {
    return `${where} "agent_answers" has invalid agent, message or expect fields`;
  }
  return undefined;
}

export async function loadChecks(recipe: string): Promise<AcceptanceCheck[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(resolve(recipesDir(), recipe, "acceptance.json"), "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as { checks?: AcceptanceCheck[] };
  if (!Array.isArray(parsed.checks)) return [];
  const invalid = parsed.checks
    .map((check, index) => acceptanceSpecError(check, index))
    .find((detail) => detail !== undefined);
  if (invalid !== undefined) throw new Error(`recipe "${recipe}": ${invalid}`);
  return parsed.checks;
}

async function recipesWithAcceptance(): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await readdir(recipesDir(), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of entries.sort()) {
    if ((await loadChecks(name)) !== undefined) found.push(name);
  }
  return found;
}

/** Speaks JSON-RPC to a recipe's MCP server the way a client would: inside the container, so
 *  it is the same process the gateway would spawn, reading the same mirrored files.
 *
 *  One exchange per call rather than a session kept open: these checks are few, and a
 *  short-lived process is what proves the server can be started at all, which is half of
 *  what "the MCP server answers" means. */
async function askRecipeServer(
  ctx: Context,
  recipe: string,
  requests: unknown[],
): Promise<{ responses: Record<string, unknown>[]; exitCode: number; stderr: string }> {
  const input = `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;

  const result = await ctx.runtime.runOneOff(
    "gateway",
    ["--experimental-strip-types", recipeServerContainerPath(recipe)],
    { noDeps: true, entrypoint: "node", input, allowFailure: true },
  );

  const responses = result.stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });

  // The exit code travels with the answers on purpose: a server that printed something and
  // then died has not answered, and a check reading only the text would call that a pass.
  return { responses, exitCode: result.code, stderr: result.stderr };
}

function textOf(response: Record<string, unknown> | undefined): string {
  const content = (response?.result as { content?: { text?: string }[] } | undefined)?.content;
  return content?.map((entry) => entry.text ?? "").join("\n") ?? "";
}

/** Whether the call itself worked, before anything is asked about what it said.
 *
 *  Three ways a call fails and only one of them was being read. A JSON-RPC `error` was
 *  checked; `result.isError` — a tool reporting its own failure, which is how "no such page"
 *  comes back — was not, so a check passed whenever its expected text happened to appear in
 *  the failure message. Neither was the exit code of the process that served it. A check that
 *  cannot fail is worse than no check: it reports success on a broken deployment. */
function callFailure(
  answer: Record<string, unknown> | undefined,
  exitCode: number,
  stderr: string,
): string | undefined {
  if (exitCode !== 0) {
    return `the server exited ${exitCode}${stderr.trim() === "" ? "" : `: ${stderr.trim().split("\n").slice(-2).join(" ")}`}`;
  }
  if (answer === undefined) return "the server sent no answer to the call";
  if (answer.error !== undefined) return `the server refused the call: ${JSON.stringify(answer.error)}`;
  if ((answer.result as { isError?: unknown } | undefined)?.isError === true) {
    return `the tool reported failure: ${JSON.stringify(textOf(answer).slice(0, 160))}`;
  }
  return undefined;
}

/** Runs one declared check. Exported so each kind can be exercised on its own.
 *
 *  Never throws: a call that cannot even reach the instance is exactly what "could not
 *  check" means, not a reason for the whole suite to stop reporting on everything else. The
 *  distinction each branch below makes is the same one throughout — did this get far enough
 *  to obtain an actual answer, whatever that answer turned out to be, or not. Only the first
 *  is a verdict; the second is "could-not-check" regardless of how it happened to fail. */
export async function runCheck(ctx: Context, recipe: string, check: AcceptanceCheck): Promise<AcceptanceResult> {
  const name = check.name ?? check.kind;
  const fail = (detail: string): AcceptanceResult => ({ name, kind: check.kind, status: "failed", detail });
  const pass = (detail?: string): AcceptanceResult => ({ name, kind: check.kind, status: "passed", detail });
  const unclear = (detail: string): AcceptanceResult => ({ name, kind: check.kind, status: "could-not-check", detail });

  try {
    switch (check.kind) {
      case "mcp_responds": {
        const expected = Array.isArray(check.tools) ? (check.tools as string[]) : [];
        const { responses, exitCode, stderr } = await askRecipeServer(ctx, recipe, [
          { jsonrpc: "2.0", id: 1, method: "initialize" },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
        ]);
        const initialized = responses.find((response) => response.id === 1);
        const listed = responses.find((response) => response.id === 2);
        const broken = callFailure(initialized, exitCode, stderr) ?? callFailure(listed, exitCode, stderr);
        if (broken !== undefined) return unclear(broken);

        const tools = ((listed?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((tool) => tool.name);
        const absent = expected.filter((tool) => !tools.includes(tool));
        return absent.length === 0
          ? pass(`${tools.length} tool(s): ${tools.join(", ")}`)
          : fail(`missing tool(s): ${absent.join(", ")} — offered ${tools.join(", ")}`);
      }

      case "mcp_tool": {
        const tool = typeof check.tool === "string" ? check.tool : undefined;
        if (tool === undefined) return unclear('the check declares no "tool"');
        const args = (check.arguments ?? {}) as Record<string, unknown>;
        const { responses, exitCode, stderr } = await askRecipeServer(ctx, recipe, [
          { jsonrpc: "2.0", id: 1, method: "initialize" },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
        ]);
        const initialized = responses.find((response) => response.id === 1);
        const answer = responses.find((response) => response.id === 2);

        // Did the call succeed, and only then: does the answer say what was declared. In the
        // other order, a tool answering isError with "no such page" passes whenever the
        // expected text happens to appear in that message.
        const broken = callFailure(initialized, exitCode, stderr) ?? callFailure(answer, exitCode, stderr);
        if (broken !== undefined) return unclear(broken);

        const text = textOf(answer);
        if (text === "") return unclear("the tool answered with nothing");
        if (typeof check.expect === "string" && !text.includes(check.expect)) {
          return fail(`the answer does not contain ${JSON.stringify(check.expect)} — got ${JSON.stringify(text.slice(0, 120))}`);
        }
        return pass(typeof check.expect === "string" ? `contains ${JSON.stringify(check.expect)}` : `${text.length} character(s)`);
      }

      case "agent_has_tools": {
        const agentId = typeof check.agent === "string" ? check.agent : undefined;
        const server = typeof check.server === "string" ? check.server : undefined;
        if (agentId === undefined || server === undefined) return unclear('the check needs both "agent" and "server"');

        // Reaching openclawCliJson at all is an obtained verdict from here on: the instance
        // answered, and either it has the agent/server declared or it does not.
        const agents = await openclawCliJson<Array<{ id: string }>>(ctx, ["agents", "list", "--json"]);
        if (!agents.some((entry) => entry.id === agentId)) return fail(`the instance has no agent "${agentId}"`);

        const servers = await openclawCliJson<Record<string, { command?: unknown; args?: unknown }>>(ctx, ["mcp", "list", "--json"]);
        const entry = servers[server];
        if (entry === undefined) return fail(`MCP server "${server}" is not registered, so agent "${agentId}" cannot call it`);
        // A name present says nothing about whether it still launches the recipe's own
        // server.ts — a hand-edited or stale command registers cleanly and answers nothing.
        if (!mcpServerMatches(entry, recipe)) {
          return fail(`MCP server "${server}" is registered but its command does not match recipe "${recipe}" — it will not serve the recipe's tools`);
        }
        return pass(`agent "${agentId}" and MCP server "${server}" are both registered`);
      }

      case "cron_matches": {
        const jobName = typeof check.job === "string" ? check.job : undefined;
        const schedule = typeof check.schedule === "string" ? check.schedule : undefined;
        if (jobName === undefined) return unclear('the check declares no "job"');

        const listed = await openclawCliJson<{ jobs: { name?: string; schedule?: { expr?: string; tz?: string } }[] }>(ctx, ["cron", "list", "--json"]);
        const job = listed.jobs.find((entry) => entry.name === jobName);
        if (job === undefined) return fail(`no cron job named "${jobName}"`);
        if (schedule !== undefined && job.schedule?.expr !== schedule) {
          return fail(`"${jobName}" runs at ${job.schedule?.expr ?? "(none)"}, declared ${schedule}`);
        }
        if (typeof check.timezone === "string" && job.schedule?.tz !== check.timezone) {
          return fail(`"${jobName}" timezone is ${job.schedule?.tz ?? "(host default)"}, declared ${check.timezone}`);
        }
        return pass(`"${jobName}" at ${job.schedule?.expr ?? "(none)"}`);
      }

      case "agent_answers": {
        // The one kind that costs money. Reaching here means it was explicitly asked for.
        const agentId = typeof check.agent === "string" ? check.agent : undefined;
        const message = typeof check.message === "string" ? check.message : undefined;
        if (agentId === undefined || message === undefined) return unclear('the check needs both "agent" and "message"');

        const result = await ctx.runtime.runOneOff(
          "cli",
          ["agent", "--agent", agentId, "-m", message],
          { profile: "cli", input: "", allowFailure: true },
        );
        if (result.code !== 0) return unclear(`the agent call exited ${result.code}: ${result.stderr.trim().split("\n").slice(-2).join(" ")}`);
        const answer = result.stdout.trim();
        if (answer === "") return unclear("the agent answered with nothing");
        if (typeof check.expect === "string" && !answer.toLowerCase().includes(check.expect.toLowerCase())) {
          return fail(`the answer does not mention ${JSON.stringify(check.expect)} — got ${JSON.stringify(answer.slice(0, 160))}`);
        }
        return pass(`answered ${answer.length} character(s)`);
      }

      default:
        return unclear(`unknown check kind "${check.kind}" — this framework does not implement it`);
    }
  } catch (error) {
    // openclawCliJson throws on a call the instance itself refused (a scope upgrade that
    // never landed, a connection the gateway closed) — reaching the instance failed, which
    // is this check's job to report, not a reason to take the rest of the suite down with it.
    return unclear(error instanceof Error ? error.message : String(error));
  }
}

export async function accept(ctx: Context, args: string[]): Promise<void> {
  const index = args.indexOf("--set");
  if (index === -1) return withModelApproval(args.includes("--with-model"), () => acceptFromSource(ctx, args));
  const artifact = args[index + 1];
  if (artifact === undefined || artifact.startsWith("--")) die("--set needs an artifact path");
  const rest = [...args.slice(0, index), ...args.slice(index + 2)];
  if (rest.includes("--set")) die("--set may be provided only once");
  return withModelApproval(rest.includes("--with-model"), () =>
    withUnpackedArtifact(artifact, (staging, verified) => withSetSource(staging, () => acceptFromSource(ctx, rest, verified))),
  );
}

async function acceptFromSource(ctx: Context, args: string[], verified?: VerifiedArtifact): Promise<void> {
  const startedAt = new Date().toISOString();
  const jsonOnly = args.includes("--json");
  const withModel = args.includes("--with-model");
  let wanted: string | undefined;

  for (const arg of args) {
    if (arg === "--json" || arg === "--with-model") continue;
    if (arg.startsWith("-")) die(`unknown argument: ${arg}`);
    wanted = arg;
  }

  const recipes = wanted === undefined ? await recipesWithAcceptance() : [wanted];
  if (recipes.length === 0) {
    die("no recipe declares acceptance checks — add recipes/<name>/acceptance.json");
  }

  const report: Record<string, AcceptanceResult[]> = {};
  const before = verified === undefined ? undefined : await observeRuntime(ctx, verified.manifest);
  let matchedBefore = false;
  if (verified !== undefined) {
    try { matchedBefore = isHealthy(await gatherInspection(ctx)); } catch { /* Unverified binding. */ }
  }
  let passed = 0;
  let failedCount = 0;
  let notChecked = 0;
  let couldNotCheck = 0;

  for (const recipe of recipes) {
    const checks = await loadChecks(recipe);
    if (checks === undefined) die(`recipe "${recipe}" declares no acceptance checks (recipes/${recipe}/acceptance.json)`);

    const results: AcceptanceResult[] = [];
    for (const check of checks) {
      if ((requiresModel(check.kind) || check.usesModel === true) && !withModel) {
        // Named and counted, never omitted: a suite that quietly drops what it did not run
        // reads as coverage it does not have.
        results.push({
          name: check.name ?? check.kind,
          kind: check.kind,
          status: "not-checked",
          detail: "calls the model — run with --with-model to include it",
        });
        notChecked += 1;
        continue;
      }

      try {
        const result = await runCheck(ctx, recipe, check);
        results.push(result);
        if (result.status === "passed") passed += 1;
        else if (result.status === "failed") failedCount += 1;
        else if (result.status === "could-not-check") couldNotCheck += 1;
        else notChecked += 1;
      } catch (error) {
        results.push({
          name: check.name ?? check.kind,
          kind: check.kind,
          status: "could-not-check",
          detail: error instanceof Error ? error.message : String(error),
        });
        couldNotCheck += 1;
      }
    }
    report[recipe] = results;
  }

  let answer: AcceptanceReport = {
    deployment: deploymentName(),
    recipes: report,
    passed,
    failed: failedCount,
    notChecked,
    couldNotCheck,
    summary: summarize(passed, failedCount, notChecked, couldNotCheck),
    healthy: passed > 0 && failedCount === 0 && notChecked === 0 && couldNotCheck === 0,
  };

  if (verified !== undefined && before !== undefined) {
    const after = await observeRuntime(ctx, verified.manifest);
    let matchedAfter = false;
    try { matchedAfter = isHealthy(await gatherInspection(ctx)); } catch { /* Unverified binding. */ }
    const receipt = await saveEvidence({
      verified, source: "accept", startedAt, withModel, selected: recipes, results: report,
      observed: after, subjectVerified: matchedBefore && matchedAfter && runtimeMatches(verified.manifest, before, after),
    });
    answer = { ...answer, receipt: { id: receipt.receiptId, setId: receipt.setId, verdict: receipt.verdict } };
    if (!jsonOnly && !isCaptured()) info(`receipt: ${receipt.receiptId} (${receipt.verdict})`);
  }

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(answer, null, 2)}\n`);
  } else {
    for (const [recipe, results] of Object.entries(report)) {
      log(`recipe ${recipe}`);
      for (const result of results) {
        const line = `${result.status.toUpperCase().padEnd(7)} ${result.name}${result.detail === undefined ? "" : `  ${result.detail}`}`;
        if (result.status === "failed") warn(line);
        else info(line);
      }
    }
    log(answer.summary);
    if (notChecked > 0 && !withModel) info("the not-checked ones call the model: ./clawforge accept --with-model");
  }

  if (failedCount > 0 || couldNotCheck > 0) {
    throw new Error(`${failedCount + couldNotCheck} acceptance check(s) did not pass`);
  }
}
