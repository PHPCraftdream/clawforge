// What the framework owns, and what happens when a set stops declaring it.
//
// Three claims, one per layer: the ledger (set/ledger.ts) can tell an object it created from
// one it did not, and never proposes touching the latter; `./clawforge plan` turns an orphaned
// object into a step, advisory for an agent (removal prunes its memory) and executable for
// an MCP server or cron job (it carries none); `./clawforge apply` — and a coder running the same
// command by hand — actually remove it and stop tracking it, through the identical runner.

import {
  LEDGER_VERSION,
  readLedger,
  recordOwned,
  forgetOwned,
  owns,
  orphanedBy,
  foreign,
} from "../../../framework/set/ownership/ledger.ts";
import type { Ledger, OwnedObject, OwnedKind } from "../../../framework/set/ownership/ledger.ts";
import { removeOwnedObject, agentsDeleteArgv, mcpUnsetArgv, cronRmArgv } from "../../../framework/commands/management/provision-agent.ts";
import { runSteps } from "../../../framework/commands/orchestration/apply.ts";
import { planActions } from "../../../framework/commands/orchestration/plan.ts";
import { problem } from "../../../framework/service/inspection.ts";
import type { Inspection, Problem } from "../../../framework/service/inspection.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import type { Context } from "../../../framework/core/context.ts";

let failed = 0;

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

function jsonResult(value: unknown) {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function owned(kind: OwnedKind, name: string, recipe: string): OwnedObject {
  return { kind, name, recipe, createdAt: "2026-01-01T00:00:00.000Z" };
}

/** A ctx that answers both halves `removeOwnedObject` needs: OpenClaw's own CLI (via
 *  runtime.runOneOff, the same seam ensureAgent/ensureMcpServer/ensureCronJob already use)
 *  and the ledger file on the target (via transport.readFile/writeFile). */
function fakeCtx(files: Map<string, string>, calls: string[][], cronJobs: { id: string; name: string }[] = []) {
  return {
    settings: { dataDir: "/srv/clawforge" },
    runtime: {
      async runOneOff(_service: string, args: string[]) {
        calls.push(args);
        if (args[0] === "cron" && args[1] === "list") return jsonResult({ jobs: cronJobs });
        return jsonResult({});
      },
    },
    transport: {
      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
      },
    },
  } as unknown as Context;
}

// --- the ledger itself: recorded, replaced, forgotten, never guessed at -------------------

{
  const files = new Map<string, string>();
  const ctx = fakeCtx(files, []);

  check("no ledger yet reads as empty", await readLedger(ctx), { version: LEDGER_VERSION, objects: [] });

  await recordOwned(ctx, { kind: "agent", name: "demo-agent", recipe: "demo", setId: "set-abc" });
  const first = await readLedger(ctx);
  check("recording writes exactly one object", first.objects.length, 1);
  check(
    "with the fields given",
    { kind: first.objects[0].kind, name: first.objects[0].name, recipe: first.objects[0].recipe, setId: first.objects[0].setId },
    { kind: "agent", name: "demo-agent", recipe: "demo", setId: "set-abc" },
  );
  check("owns reports it", owns(first, "agent", "demo-agent"), true);
  check("owns is false for a different kind of the same name", owns(first, "mcp-server", "demo-agent"), false);

  // Re-recording is what every later `provision-agent` run does for an object already there:
  // re-runnable, not additive. Two entries for one job would eventually claim it twice.
  await recordOwned(ctx, { kind: "agent", name: "demo-agent", recipe: "demo", setId: "set-def" });
  const reRecorded = await readLedger(ctx);
  check("recording again replaces rather than duplicates", reRecorded.objects.length, 1);
  check("keeping the newer fields", reRecorded.objects[0].setId, "set-def");

  await forgetOwned(ctx, "agent", "demo-agent");
  check("forgetting removes it", (await readLedger(ctx)).objects, []);

  // An object this framework cannot prove it created must never become a deletion
  // candidate — including when the proof itself cannot be read.
  files.set("/srv/clawforge/clawforge-managed.json", "not json at all");
  check("a corrupt ledger reads as empty rather than throwing", await readLedger(ctx), { version: LEDGER_VERSION, objects: [] });
}

// --- orphanedBy: a recipe dropped, a recipe renaming what it declares, a recipe unchanged --

{
  const ledger: Ledger = {
    version: LEDGER_VERSION,
    objects: [
      owned("agent", "alpha-agent", "alpha"),
      owned("mcp-server", "alpha-mcp", "alpha"),
      owned("cron-job", "alpha-cron", "alpha"),
      owned("agent", "beta-agent-old", "beta"),
    ],
  };

  const dropped = orphanedBy(ledger, []);
  check(
    "dropping every recipe orphans everything this framework created",
    dropped.map((entry) => `${entry.kind}:${entry.name}`).sort(),
    ["agent:alpha-agent", "agent:beta-agent-old", "cron-job:alpha-cron", "mcp-server:alpha-mcp"],
  );

  const unchanged = orphanedBy(ledger, [
    { kind: "agent", name: "alpha-agent", recipe: "alpha" },
    { kind: "mcp-server", name: "alpha-mcp", recipe: "alpha" },
    { kind: "cron-job", name: "alpha-cron", recipe: "alpha" },
    { kind: "agent", name: "beta-agent-old", recipe: "beta" },
  ]);
  check("a recipe that still declares exactly what it always did orphans nothing", unchanged, []);

  // "beta" still exists — its agent/config.json now names a different agentId. The recipe
  // is still in the set; only the object it no longer names is orphaned.
  const renamed = orphanedBy(ledger, [
    { kind: "agent", name: "alpha-agent", recipe: "alpha" },
    { kind: "mcp-server", name: "alpha-mcp", recipe: "alpha" },
    { kind: "cron-job", name: "alpha-cron", recipe: "alpha" },
    { kind: "agent", name: "beta-agent-new", recipe: "beta" },
  ]);
  check("a renamed agent orphans the old name, even though its recipe is still declared", renamed.map((entry) => entry.name), ["beta-agent-old"]);
}

// --- foreign: present on the instance, absent from the ledger, reported and never touched --

{
  const ledger: Ledger = { version: LEDGER_VERSION, objects: [owned("mcp-server", "ours", "demo")] };
  check("an object the ledger knows about is not foreign", foreign(ledger, "mcp-server", ["ours", "hand-added"]), ["hand-added"]);
  check("an empty ledger calls everything present foreign", foreign({ version: LEDGER_VERSION, objects: [] }, "agent", ["hand-added"]), ["hand-added"]);

  // What "never touched" actually rests on: a name foreign() reports cannot also appear in
  // orphanedBy()'s output, because orphanedBy only ever iterates the ledger's own objects —
  // a name nobody recorded is not in that list to begin with.
  const orphanNames = orphanedBy(ledger, []).map((entry) => entry.name);
  check("nothing foreign() reports can appear in orphanedBy()'s output", foreign(ledger, "mcp-server", ["ours", "hand-added"]).some((name) => orphanNames.includes(name)), false);
}

// --- ./clawforge plan: an orphan becomes a step, advisory only for an agent ----------------------

function inspectionWith(problems: Problem[]): Inspection {
  return {
    declared: { deployment: "example", config: [], image: "example/image:tag", recipes: [] },
    observed: { running: true, health: "healthy", probes: {}, config: {}, secrets: [], agents: [], mcpServers: [], cronJobs: [], foreignObjects: [] },
    problems,
  };
}

{
  const orphanedAgent = problem(
    "SET_OBJECT_ORPHANED",
    "agent \"old-agent\" was created for recipe \"beta\", which the set no longer declares this way — removing it would also prune its workspace and memory",
    "./clawforge set forget --kind agent --name old-agent",
  );
  const actions = planActions(inspectionWith([orphanedAgent]));
  check("an orphaned agent is one step", actions.length, 1);
  check("advisory, so apply will not perform it on its own", actions[0].advisory, true);
  check("with no command for apply to run", actions[0].command, undefined);
  check("the summary states the memory consequence plainly", actions[0].summary.includes("memory"), true);
}

{
  const orphanedMcp = problem(
    "SET_OBJECT_ORPHANED",
    "mcp-server \"old-server\" was created for recipe \"beta\", which the set no longer declares this way",
    "./clawforge set forget --kind mcp-server --name old-server",
  );
  const actions = planActions(inspectionWith([orphanedMcp]));
  check("an orphaned mcp server is one step", actions.length, 1);
  check("executable — it carries no memory of its own", actions[0].advisory, undefined);
  check("with the exact command inspect proposed", actions[0].command, "./clawforge set forget --kind mcp-server --name old-server");
  check("the step id names its kind and name", actions[0].id, "remove-owned:mcp-server:old-server");
}

// --- ./clawforge apply: the same wiring provisioning uses, running the removal for real ----------

{
  const files = new Map<string, string>([
    ["/srv/clawforge/clawforge-managed.json", JSON.stringify({ version: LEDGER_VERSION, objects: [owned("mcp-server", "old-server", "beta")] })],
  ]);
  const calls: string[][] = [];
  const ctx = fakeCtx(files, calls);

  const outcome = await withOutputSink(() => {}, () =>
    runSteps(ctx, [{
      id: "remove-owned:mcp-server:old-server",
      summary: "remove the mcp-server \"old-server\"",
      command: "./clawforge set forget --kind mcp-server --name old-server",
      because: ["SET_OBJECT_ORPHANED"],
    }]));
  check("apply runs the removal and reports it done", outcome.map((entry) => ({ id: entry.id, status: entry.status })), [
    { id: "remove-owned:mcp-server:old-server", status: "done" },
  ]);
  check("the call that reached OpenClaw's CLI matches mcpUnsetArgv", calls[0], mcpUnsetArgv("old-server"));
  check("and the ledger no longer carries it afterwards", (await readLedger(ctx)).objects, []);
}

// --- removeOwnedObject: the right CLI call per kind, the ledger forgotten after every one --

{
  const files = new Map<string, string>([["/srv/clawforge/clawforge-managed.json", JSON.stringify({ version: LEDGER_VERSION, objects: [owned("agent", "old-agent", "beta")] })]]);
  const calls: string[][] = [];
  const ctx = fakeCtx(files, calls);
  await removeOwnedObject(ctx, "agent", "old-agent");
  check("removing an agent calls agents delete", calls[0], agentsDeleteArgv("old-agent"));
  check("and forgets it", (await readLedger(ctx)).objects, []);
}

{
  const files = new Map<string, string>([["/srv/clawforge/clawforge-managed.json", JSON.stringify({ version: LEDGER_VERSION, objects: [owned("cron-job", "old-cron", "beta")] })]]);
  const calls: string[][] = [];
  const ctx = fakeCtx(files, calls, [{ id: "job-9", name: "old-cron" }]);
  await removeOwnedObject(ctx, "cron-job", "old-cron");
  check("removing a cron job looks it up by name, then removes it by id", calls.map((entry) => entry.slice(0, 2).join(" ")), ["cron list", "cron rm"]);
  check("the remove targets the live job's id, not its declared name", calls[1], cronRmArgv("job-9"));
  check("and forgets it", (await readLedger(ctx)).objects, []);
}

{
  // Already gone from the instance by some other means — nothing to remove there, but the
  // ledger still stops claiming this framework owns it.
  const files = new Map<string, string>([["/srv/clawforge/clawforge-managed.json", JSON.stringify({ version: LEDGER_VERSION, objects: [owned("cron-job", "vanished-cron", "beta")] })]]);
  const calls: string[][] = [];
  const ctx = fakeCtx(files, calls, []);
  await removeOwnedObject(ctx, "cron-job", "vanished-cron");
  check("a cron job already gone from the instance is not removed twice", calls.map((entry) => entry.slice(0, 2).join(" ")), ["cron list"]);
  check("but is still forgotten", (await readLedger(ctx)).objects, []);
}

// --- end to end: a recipe renames its agent, and only the old name goes -------------------
//
// The three layers in one story: recorded at creation, orphaned once the declaration moved
// on, marked advisory rather than removed on its own, and — when a coder reads the plan and
// runs it themselves — actually gone and no longer claimed.

{
  const files = new Map<string, string>();
  const calls: string[][] = [];
  const ctx = fakeCtx(files, calls);

  await recordOwned(ctx, { kind: "agent", name: "old-agent", recipe: "beta" });

  const declaredNow = [{ kind: "agent" as const, name: "new-agent", recipe: "beta" }];
  const orphans = orphanedBy(await readLedger(ctx), declaredNow);
  check("the renamed agent's old name is orphaned, judged against the current declaration", orphans.map((entry) => entry.name), ["old-agent"]);

  const orphanProblem = problem(
    "SET_OBJECT_ORPHANED",
    "agent \"old-agent\" was created for recipe \"beta\", which the set no longer declares this way",
    "./clawforge set forget --kind agent --name old-agent",
  );
  check("the plan marks it advisory rather than removing it on its own", planActions(inspectionWith([orphanProblem]))[0].advisory, true);

  await removeOwnedObject(ctx, "agent", "old-agent");
  check("running the plan's own command removes the old agent", calls[0], agentsDeleteArgv("old-agent"));
  check("and the ledger agrees with the current declaration again", owns(await readLedger(ctx), "agent", "old-agent"), false);
}

process.stderr.write(failed === 0 ? "all set ledger checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
