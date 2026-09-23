// What the framework owns, and what happens when a set stops declaring it.
//
// Three claims, one per layer: the ledger (set/ledger.ts) can tell an object it created from
// one it did not, and never proposes touching the latter; `./clawforge plan` turns an orphaned
// object into a step, advisory for an agent (removal prunes its memory) and executable for
// an MCP server or cron job (it carries none); `./clawforge apply` — and a coder running the same
// command by hand — actually remove it and stop tracking it, through the identical runner.

import { access, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_VERSION,
  readLedger,
  readLedgerStrict,
  LedgerUnreadableError,
  recordOwned,
  forgetOwned,
  updateOwnedPromptFiles,
  owns,
  orphanedBy,
  foreign,
} from "#framework/set/ownership/ledger.ts";
import type { Ledger, OwnedObject, OwnedKind } from "#framework/set/ownership/ledger.ts";
import { provisionAgent, removeOwnedObject, agentsDeleteArgv, mcpUnsetArgv, cronRmArgv } from "#framework/commands/management/provision-agent/index.ts";
import { apply, runSteps } from "#framework/commands/orchestration/apply.ts";
import { planActions } from "#framework/commands/orchestration/plan.ts";
import { problem } from "#framework/service/inspection.ts";
import type { Inspection, Problem } from "#framework/service/inspection.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import { InstalledSetUnreadableError, readInstalledSetStrict } from "#framework/set/artifacts/install.ts";
import { buildSet } from "#framework/commands/sets/set.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { createFixture } from "./set-lifecycle/fixture.ts";

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

async function checkThrows(name: string, body: () => Promise<unknown>): Promise<void> {
  try {
    await body();
    failed += 1;
    process.stderr.write(`  FAIL ${name}\n    expected a throw, got none\n`);
  } catch (error) {
    if (error instanceof LedgerUnreadableError) {
      process.stderr.write(`  ok   ${name}\n`);
    } else {
      failed += 1;
      process.stderr.write(`  FAIL ${name}\n    expected LedgerUnreadableError, got ${(error as Error)?.name ?? error}\n`);
    }
  }
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
        // --all required, the same way OpenClaw's own cron list itself requires it to show
        // a disabled job (docs.openclaw.ai/cli/cron) — omitting it here would silently make
        // every fixture job "invisible", the exact bug #188 fixed.
        if (args[0] === "cron" && args[1] === "list") return jsonResult({ jobs: args.includes("--all") ? cronJobs : [] });
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
  // candidate — including when the proof itself cannot be read. This tolerant reading is
  // for OBSERVATION only: recordOwned/forgetOwned/updateOwnedPromptFiles never see it, because
  // proceeding on it would overwrite the corrupt file with a ledger that lost every entry it
  // could not prove — see the strict-refuse checks right below.
  files.set("/srv/clawforge/clawforge-managed.json", "not json at all");
  check("a corrupt ledger reads as empty rather than throwing", await readLedger(ctx), { version: LEDGER_VERSION, objects: [] });

  // The strict reader used by every mutating path refuses instead — and none of them may
  // overwrite the corrupt bytes on the way there.
  await checkThrows("readLedgerStrict refuses a corrupt current ledger", () => readLedgerStrict(ctx));
  await checkThrows(
    "recordOwned refuses rather than overwriting a corrupt ledger with a single new entry",
    () => recordOwned(ctx, { kind: "agent", name: "new-agent", recipe: "demo" }),
  );
  await checkThrows(
    "forgetOwned refuses rather than silently discarding a corrupt ledger",
    () => forgetOwned(ctx, "agent", "demo-agent"),
  );
  await checkThrows(
    "updateOwnedPromptFiles refuses rather than silently discarding a corrupt ledger",
    () => updateOwnedPromptFiles(ctx, "demo-agent", ["a.md"]),
  );
  check(
    "none of the refused writes touched the corrupt file",
    files.get("/srv/clawforge/clawforge-managed.json"),
    "not json at all",
  );

  files.clear();
  files.set("/srv/clawforge/oc-managed.json", JSON.stringify({ version: LEDGER_VERSION, objects: [owned("agent", "legacy-agent", "legacy")] }));
  check("the old oc ledger remains readable", (await readLedger(ctx)).objects[0]?.name, "legacy-agent");
  files.set("/srv/clawforge/clawforge-managed.json", "not json at all");
  check("a malformed current ledger is authoritative over the legacy ledger", (await readLedger(ctx)).objects, []);
}

// --- the ledger write path is atomic: an interrupted write cannot create a corrupt ledger --

/** Same shape as the atomicCtx in set-install.check.ts: records every write target, moves
 *  files on exec `mv` the way a real target does, and `failWrite` simulates a write
 *  interrupted after partial bytes reached the disk. */
function atomicCtx(
  files: Map<string, string>,
  writes: string[],
  moves: [string, string][],
  failWrite = false,
): Context {
  return {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async exists(path: string): Promise<boolean> { return files.has(path); },
      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        writes.push(path);
        if (failWrite) {
          files.set(path, content.slice(0, 16));
          throw new Error("interrupted mid-write");
        }
        files.set(path, content);
      },
      async remove(path: string): Promise<void> {
        files.delete(path);
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command !== "mv") return { code: 0, stdout: "", stderr: "" };
        const source = args[args.length - 2]!;
        const destination = args[args.length - 1]!;
        moves.push([source, destination]);
        const content = files.get(source);
        if (content === undefined) return { code: 1, stdout: "", stderr: `no such file: ${source}` };
        files.set(destination, content);
        files.delete(source);
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

{
  const files = new Map<string, string>();
  const writes: string[] = [];
  const moves: [string, string][] = [];
  const ledgerPath = "/srv/clawforge/clawforge-managed.json";
  const ctx = atomicCtx(files, writes, moves);

  await recordOwned(ctx, { kind: "agent", name: "atomic-agent", recipe: "demo" });
  check("the ledger published through the staged-rename route reads back", (await readLedgerStrict(ctx)).objects[0]?.name, "atomic-agent");
  check("the publish moved a staged sibling over the final name", moves.length, 1);
  check("the rename landed at the ledger path", moves[0]?.[1], ledgerPath);
  check("the staged sibling sat beside the ledger, same directory", (moves[0]?.[0] ?? "").startsWith(ledgerPath), true);
  check("nothing was ever written directly at the ledger path", writes.includes(ledgerPath), false);

  // An interrupted publish: the staged write lands partial and then fails. The previous
  // valid ledger must still be exactly what it was — never the partial bytes.
  const previousBytes = files.get(ledgerPath);
  const interrupted = atomicCtx(files, writes, moves, true);
  let threw = false;
  try { await recordOwned(interrupted, { kind: "agent", name: "second-agent", recipe: "demo" }); } catch { threw = true; }
  check("an interrupted ledger publish fails loudly", threw, true);
  check("the interrupted write's partial bytes never reached the ledger path", files.get(ledgerPath), previousBytes);
  check("the previous valid ledger is still readable afterwards", (await readLedgerStrict(ctx)).objects.map((entry) => entry.name), ["atomic-agent"]);
  check("the failed publish cleaned up its staged sibling", [...files.keys()].filter((path) => path !== ledgerPath), []);

  // A publish killed outright leaves its staged sibling behind — a stray that must be
  // invisible to every reader of the real name, not read as a corrupt ledger.
  files.set(`${ledgerPath}.clawforge-staged-deadbeefdeadbeef`, "{\"version\":1,\"ob");
  check("a leftover staged sibling from a killed publish does not read as a corrupt ledger", (await readLedgerStrict(ctx)).objects.map((entry) => entry.name), ["atomic-agent"]);
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

{
  // A DISABLED job (not merely absent) is the case #188 fixed: without --all in the lookup,
  // OpenClaw's own cron list hides it entirely (docs.openclaw.ai/cli/cron) — before the fix,
  // that made this indistinguishable from "already gone", so cron rm was never called and
  // the job was left behind, its ownership record deleted regardless.
  const files = new Map<string, string>([["/srv/clawforge/clawforge-managed.json", JSON.stringify({ version: LEDGER_VERSION, objects: [owned("cron-job", "disabled-cron", "beta")] })]]);
  const calls: string[][] = [];
  const ctx = fakeCtx(files, calls, [{ id: "job-42", name: "disabled-cron" }]);
  await removeOwnedObject(ctx, "cron-job", "disabled-cron");
  check("the lookup passes --all, so a disabled job is still found", calls[0]?.includes("--all"), true);
  check("and actually removed, not silently left behind", calls.map((entry) => entry.slice(0, 2).join(" ")), ["cron list", "cron rm"]);
  check("targeting its live id", calls[1], cronRmArgv("job-42"));
  check("and forgotten", (await readLedger(ctx)).objects, []);
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

// --- preflight ordering: a corrupt marker refuses before ANY live work happens -------------
//
// The unit refusals earlier in this file prove the strict readers and writers. These prove
// the orchestration order: the strict read is the first thing under the instance lock, so a
// corrupt marker refuses a run with the target byte-for-byte unchanged — no mirror, no
// prompt writes, no OpenClaw CLI calls, no apply steps, no stored rollback artifact.

{
  const fixture = await createFixture();
  const recipeRoot = await mkdtemp(join(tmpdir(), "clawforge-ledger-preflight-"));
  try {
    await mkdir(join(recipeRoot, "recipes", "demo", "agent"), { recursive: true });
    await writeFile(join(recipeRoot, "recipes", "demo", "server.ts"), "export const server = 'demo';\n");
    await writeFile(join(recipeRoot, "recipes", "demo", "agent", "config.json"), JSON.stringify({ agentId: "preflight-agent", mcpServerName: "preflight-mcp" }));
    await writeFile(join(recipeRoot, "recipes", "demo", "agent", "INTRO.md"), "# preflight\n");

    // The fixture's own data dir for everything, so the markers provisioning writes, the
    // markers apply corrupts, and the paths apply's own preflight reads are all one target.
    const dataDir = fixture.sourceData;
    const ledgerPath = `${dataDir}/clawforge-managed.json`;
    const markerPath = `${dataDir}/clawforge-installed-set.json`;
    fixture.state.running = true;
    const base = fixture.context({ ...fixture.baseEnv });
    const cliCalls: string[][] = [];
    const ctx = {
      ...base,
      runtime: {
        ...base.runtime,
        runOneOff: async (service: string, args: string[]) => {
          cliCalls.push(args);
          return base.runtime.runOneOff(service, args);
        },
      },
    } as unknown as Context;

    // Recipe sources are host-side files read with node:fs directly (never through the
    // transport), so provisioning needs the deployment pointed at the recipe fixture.
    useDeployment(recipeRoot);

    // Corrupt ledger: the preflight must refuse before any live call.
    fixture.files.set(ledgerPath, "not json at all");
    const beforeFiles = JSON.stringify([...fixture.files]);
    const beforeEvents = fixture.events.length;
    const refused = await fixture.captured(() => provisionAgent(ctx, ["demo"]));
    check("provisionAgent refuses a corrupt ownership ledger", refused.error instanceof LedgerUnreadableError, true);
    check("the refused provisioning left the target byte-for-byte unchanged", JSON.stringify([...fixture.files]), beforeFiles);
    check(
      "the refused provisioning made no live call — no CLI call, no mirror or prompt write, no ledger publish",
      cliCalls.length === 0 && fixture.events.slice(beforeEvents).filter((event) => !event.includes("operation.lock")).join("|"),
      "",
    );

    // Positive control: the same provisioning with a readable ledger runs its live calls and
    // records ownership through an atomic publish.
    fixture.files.delete(ledgerPath);
    cliCalls.length = 0;
    const ran = await fixture.captured(() => provisionAgent(ctx, ["demo"]));
    check("provisionAgent with a readable ledger succeeds", ran.error, undefined);
    check("the recipe mirror was written", fixture.files.has(`${dataDir}/workspace/mcp-demo/server.ts`), true);
    check("the workspace prompt file was written", fixture.files.has(`${dataDir}/workspace/preflight-agent/INTRO.md`), true);
    check("the agent was created through the CLI", cliCalls.some((args) => args[0] === "agents" && args[1] === "add"), true);
    check("the MCP server was registered through the CLI", cliCalls.some((args) => args[0] === "mcp" && args[1] === "add"), true);
    check(
      "the ownership ledger was recorded through an atomic publish (mv over the final name)",
      fixture.events.some((event) => event.startsWith("mv:") && event.endsWith(`=>${ledgerPath}`)),
      true,
    );
    check("and the recorded ledger reads back through the strict reader", owns(await readLedgerStrict(ctx), "agent", "preflight-agent"), true);

    // apply --set: a corrupt installed-set marker must refuse before any apply step and
    // before the rollback artifact is stored. buildSet leaves its artifact in sets/ — moved
    // out of the way first, exactly like apply-rollback.check.ts, so a store during apply is
    // detectable.
    useDeployment(fixture.root);
    const built = await buildSet(base, "lifecycle");
    const artifact = join(fixture.root, "incoming.tar.gz");
    await rename(built.artifact, artifact);
    const setsDir = join(fixture.root, "sets");

    // Corrupt marker: the preflight must refuse before anything is stored or executed.
    fixture.files.set(markerPath, "not json at all");
    cliCalls.length = 0;
    const beforeApplyFiles = JSON.stringify([...fixture.files]);
    const beforeApplyEvents = fixture.events.length;
    const corruptMarker = await fixture.captured(() => apply(ctx, ["--set", artifact, "--json"]));
    check("apply --set refuses a corrupt installed-set marker", corruptMarker.error instanceof InstalledSetUnreadableError, true);
    check("the refused apply --set left the target byte-for-byte unchanged", JSON.stringify([...fixture.files]), beforeApplyFiles);
    check(
      "the refused apply --set stored no rollback artifact and made no live call",
      cliCalls.length === 0
        && (await access(join(setsDir, `lifecycle-${built.id}.tar.gz`)).then(() => true, () => false)) === false
        && fixture.events.slice(beforeApplyEvents).filter((event) => !event.includes("operation.lock")).join("|") === "",
      true,
    );

    // Corrupt ledger instead (marker absent again): same refusal, same untouched target.
    fixture.files.delete(markerPath);
    fixture.files.set(ledgerPath, "not json at all");
    cliCalls.length = 0;
    const beforeLedgerRefusal = JSON.stringify([...fixture.files]);
    const beforeLedgerEvents = fixture.events.length;
    const corruptLedger = await fixture.captured(() => apply(ctx, ["--set", artifact, "--json"]));
    check("apply --set refuses a corrupt ownership ledger", corruptLedger.error instanceof LedgerUnreadableError, true);
    check("that refusal also left the target byte-for-byte unchanged", JSON.stringify([...fixture.files]), beforeLedgerRefusal);
    check(
      "and made no live call either",
      cliCalls.length === 0 && fixture.events.slice(beforeLedgerEvents).filter((event) => !event.includes("operation.lock")).join("|") === "",
      true,
    );

    // Positive control: readable control markers — apply --set installs for real and records
    // the marker through the atomic publish route.
    fixture.files.delete(ledgerPath);
    cliCalls.length = 0;
    const beforeInstall = fixture.events.length;
    const installed = await fixture.captured(() => apply(ctx, ["--set", artifact, "--json"]));
    check("apply --set with readable control markers installs", installed.error, undefined);
    check("the set is recorded as installed", (await readInstalledSetStrict(ctx))?.id, built.id);
    check(
      "the installed-set marker was recorded through an atomic publish (mv over the final name)",
      fixture.events.slice(beforeInstall).some((event) => event.startsWith("mv:") && event.endsWith(`=>${markerPath}`)),
      true,
    );
  } finally {
    await fixture.teardown();
    await rm(recipeRoot, { recursive: true, force: true });
  }
}

process.stderr.write(failed === 0 ? "all set ledger checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
