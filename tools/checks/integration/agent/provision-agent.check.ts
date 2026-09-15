// `./clawforge provision-agent <recipe>` — covers three layers without a live gateway:
//   - the pure path/argv builders (exact strings, no I/O);
//   - collectRecipeFiles (walks a real temp directory, excludes agent/);
//   - the orchestration logic (ensureAgent/ensureMcpServer/ensureCronJob create-vs-skip
//     decisions, argv, and the scope-upgrade self-heal retry) against a stubbed Context —
//     same idiom as tools/checks/cli-helper.check.ts.

import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  agentWorkspaceTargetDir,
  recipeMirrorTargetDir,
  agentsAddArgv,
  mcpAddArgv,
  cronAddArgv,
  collectRecipeFiles,
  syncRecipeFiles,
  writeWorkspacePromptFiles,
  ensureAgent,
  ensureMcpServer,
  mcpServerSpec,
  mcpServerMatches,
  mcpUnsetArgv,
  ensureCronJob,
  cronJobMatches,
  cronRmArgv,
} from "#framework/commands/management/provision-agent/index.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

function checkTrue(name: string, actual: boolean): void {
  check(name, actual, true);
}

const CONFIG = {
  agentId: "demo-agent",
  mcpServerName: "demo-recipe",
  cronJobName: "demo-refresh",
  cronSchedule: "17 3 * * *",
  cronTimeoutSeconds: 900,
};

/** A live cron job exactly as the declaration above would have created it. */
function liveJob() {
  return {
    id: "job-1",
    name: "demo-refresh",
    agentId: "demo-agent",
    schedule: { expr: "17 3 * * *" },
    sessionTarget: "isolated",
    payload: { message: "scheduled message", timeoutSeconds: 900 },
    delivery: { mode: "none" },
  };
}

// --- path builders ------------------------------------------------------------------------

check("agent workspace path lives under the data dir's workspace mount", agentWorkspaceTargetDir("/srv/clawforge", "demo-agent"), "/srv/clawforge/workspace/demo-agent");
check("recipe mirror path lives under the data dir's workspace mount", recipeMirrorTargetDir("/srv/clawforge", "demo-recipe"), "/srv/clawforge/workspace/mcp-demo-recipe");

// --- argv builders -------------------------------------------------------------------------

{
  const argv = agentsAddArgv(CONFIG);
  check("agents add targets the configured agent id", argv.slice(0, 3), ["agents", "add", "demo-agent"]);
  checkTrue("agents add points --workspace at the container-side mirror path", argv.includes("--workspace") && argv.includes("/home/node/.openclaw/workspace/demo-agent"));
  checkTrue("agents add is non-interactive", argv.includes("--non-interactive"));
}

{
  const argv = mcpAddArgv(CONFIG, "demo-recipe");
  check("mcp add targets the configured server name", argv.slice(0, 3), ["mcp", "add", "demo-recipe"]);
  checkTrue("mcp add spawns node against the recipe's container-side server.ts path", argv.includes("--command") && argv.includes("node") && argv.includes("/home/node/.openclaw/workspace/mcp-demo-recipe/server.ts"));
  checkTrue("mcp add uses --experimental-strip-types", argv.includes("--experimental-strip-types"));
  checkTrue("mcp add skips the connect-and-probe step", argv.includes("--no-probe"));
}

{
  const argv = cronAddArgv(CONFIG, "scheduled message");
  checkTrue("cron add names the configured job", argv.includes("--name") && argv.includes("demo-refresh"));
  checkTrue("cron add targets the configured agent", argv.includes("--agent") && argv.includes("demo-agent"));
  checkTrue("cron add runs in an isolated session, not the main one", argv.includes("--session") && argv.includes("isolated"));
  checkTrue("cron add carries the given message verbatim", argv.includes("--message") && argv.includes("scheduled message"));
  checkTrue("cron add carries the configured timeout", argv.includes("--timeout-seconds") && argv.includes("900"));
  // Without this the job defaults to announce -> "last" channel and fail-closes on every
  // run of a deployment that has no messaging channel configured.
  checkTrue("cron add disables chat delivery", argv.includes("--no-deliver"));
}

// --- collectRecipeFiles --------------------------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), "clawforge-provision-agent-check-"));
  try {
    await writeFile(resolve(dir, "server.ts"), "// server");
    await mkdir(resolve(dir, "data", "sub"), { recursive: true });
    await writeFile(resolve(dir, "data", "page.md"), "# page");
    await writeFile(resolve(dir, "data", "sub", "nested.md"), "# nested");
    await mkdir(resolve(dir, "agent"), { recursive: true });
    await writeFile(resolve(dir, "agent", "config.json"), "{}");
    await writeFile(resolve(dir, "agent", "AGENTS.md"), "# prompt");

    const found = (await collectRecipeFiles(dir, "agent")).sort();
    check("collects runtime files at any depth, any extension, excludes agent/ entirely", found, ["data/page.md", "data/sub/nested.md", "server.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- the recipe mirror is a mirror: what the recipe dropped is dropped on the target ------
//
// Copying without deleting leaves a withdrawn page on the target, where the recipe's MCP
// server goes on serving it — the agent then answers from instructions that no longer exist
// and nothing anywhere reports a problem. The recipe is a real directory; the target is a
// stub, since the point is which paths get written and removed, not the transport.

{
  const dir = await mkdtemp(join(tmpdir(), "clawforge-recipe-mirror-check-"));
  try {
    await writeFile(resolve(dir, "server.ts"), "// server");
    await mkdir(resolve(dir, "data"), { recursive: true });
    await writeFile(resolve(dir, "data", "page.md"), "# page");
    await mkdir(resolve(dir, "agent"), { recursive: true });
    await writeFile(resolve(dir, "agent", "AGENTS.md"), "# prompt");

    const mirrorDir = "/srv/clawforge/workspace/mcp-demo-recipe";
    const written: string[] = [];
    const removed: string[] = [];
    const ctx = {
      settings: { dataDir: "/srv/clawforge" },
      transport: {
        // What a previous run left: one file the recipe still declares, and two it no
        // longer does — one of them nested, since a stale path is not always at the top.
        async listFiles(target: string): Promise<string[]> {
          return target === mirrorDir ? ["data/page.md", "data/withdrawn.md", "obsolete.ts"] : [];
        },
        async mkdirp(): Promise<void> {},
        async writeFile(path: string): Promise<void> {
          written.push(path);
        },
        async remove(path: string): Promise<void> {
          removed.push(path);
        },
      },
    } as unknown as Context;

    const result = await syncRecipeFiles(ctx, "demo-recipe", dir);

    check("every declared file is written, agent/ excluded", written.sort(), [
      `${mirrorDir}/data/page.md`,
      `${mirrorDir}/server.ts`,
    ]);
    check("what the recipe no longer declares is removed from the target", removed, [
      `${mirrorDir}/data/withdrawn.md`,
      `${mirrorDir}/obsolete.ts`,
    ]);
    check("a file the recipe still declares is left alone", removed.some((path) => path.endsWith("data/page.md")), false);
    check("the command is told what changed", result, { written: 2, removed: ["data/withdrawn.md", "obsolete.ts"] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  // First run: nothing on the target yet. The listing is empty and nothing is removed —
  // an empty mirror must not read as "everything is stale".
  const dir = await mkdtemp(join(tmpdir(), "clawforge-recipe-mirror-first-check-"));
  try {
    await writeFile(resolve(dir, "server.ts"), "// server");
    const removed: string[] = [];
    const ctx = {
      settings: { dataDir: "/srv/clawforge" },
      transport: {
        async listFiles(): Promise<string[]> {
          return [];
        },
        async mkdirp(): Promise<void> {},
        async writeFile(): Promise<void> {},
        async remove(path: string): Promise<void> {
          removed.push(path);
        },
      },
    } as unknown as Context;

    const result = await syncRecipeFiles(ctx, "demo-recipe", dir);
    check("a first run removes nothing", removed, []);
    check("and reports only what it wrote", result, { written: 1, removed: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Prompt cleanup must use ledger proof, never the filename extension. MEMORY.md and a
// user-created note can both live at workspace top level; only a prompt this recipe recorded
// previously may be withdrawn when it disappears from the declaration.
{
  const removed: string[] = [];
  const written: string[] = [];
  const ctx = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async listFiles(): Promise<string[]> {
        return ["MEMORY.md", "custom.md", "AGENTS.md", "memory/old.md"];
      },
      async remove(path: string): Promise<void> { removed.push(path); },
      async mkdirp(): Promise<void> {},
      async writeFile(path: string): Promise<void> { written.push(path); },
    },
  } as unknown as Context;
  await writeWorkspacePromptFiles(ctx, CONFIG, { "AGENTS.md": "new prompt" }, ["AGENTS.md", "custom.md"]);
  check("prompt cleanup removes a formerly-owned prompt", removed, ["/srv/clawforge/workspace/demo-agent/custom.md"]);
  check("prompt cleanup preserves MEMORY.md", removed.some((path) => path.endsWith("MEMORY.md")), false);
  check("prompt cleanup preserves an untracked custom note", (await (async () => {
    removed.length = 0;
    await writeWorkspacePromptFiles(ctx, CONFIG, { "AGENTS.md": "new prompt" }, ["AGENTS.md"]);
    return removed.some((path) => path.endsWith("custom.md"));
  })()), false);
  check("prompt cleanup still writes declared prompts", written, ["/srv/clawforge/workspace/demo-agent/AGENTS.md", "/srv/clawforge/workspace/demo-agent/AGENTS.md"]);
}

// --- orchestration: ensureAgent / ensureMcpServer / ensureCronJob, via a stubbed Context ---

function jsonResult(value: unknown) {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function stubContext(listAnswer: unknown) {
  const calls: string[][] = [];
  const ctx = {
    runtime: {
      async runOneOff(_service: string, args: string[]) {
        calls.push(args);
        return jsonResult(listAnswer);
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

{
  const { ctx, calls } = stubContext([]);
  const created = await ensureAgent(ctx, CONFIG);
  checkTrue("ensureAgent reports creation when the agent is absent", created);
  check("ensureAgent lists then adds — exactly two calls", calls.length, 2);
  check("ensureAgent's add call matches agentsAddArgv()", calls[1], agentsAddArgv(CONFIG));
}
{
  const { ctx, calls } = stubContext([{ id: "demo-agent" }]);
  const created = await ensureAgent(ctx, CONFIG);
  checkTrue("ensureAgent reports no creation when the agent already exists", !created);
  check("ensureAgent only lists, no add call, when already present", calls.length, 1);
}

{
  const { ctx, calls } = stubContext({});
  const state = await ensureMcpServer(ctx, CONFIG, "demo-recipe");
  check("ensureMcpServer reports creation when the server is absent", state, "created");
  check("ensureMcpServer's add call matches mcpAddArgv()", calls[1], mcpAddArgv(CONFIG, "demo-recipe"));
}
{
  const matching = mcpServerSpec("demo-recipe");
  const { ctx, calls } = stubContext({ "demo-recipe": matching });
  const state = await ensureMcpServer(ctx, CONFIG, "demo-recipe");
  check("ensureMcpServer reports the server unchanged when its command already matches", state, "unchanged");
  check("ensureMcpServer only lists, no write call, when already matching", calls.length, 1);
}

// --- mcp reconciliation: a registration whose command drifted is replaced -----------------
//
// Before the fix, presence of the name alone was "already present, no action" — a server
// registered with any command at all, including a broken one, was reported as fine. Mirrors
// ensureCronJob's own drift-and-replace test just above it in spirit.

{
  check("mcpServerMatches accepts an entry equal to the spec", mcpServerMatches(mcpServerSpec("demo-recipe"), "demo-recipe"), true);
  check("a changed command counts as drift", mcpServerMatches({ ...mcpServerSpec("demo-recipe"), command: "missing-program" }, "demo-recipe"), false);
  check("changed args count as drift", mcpServerMatches({ ...mcpServerSpec("demo-recipe"), args: ["--wrong"] }, "demo-recipe"), false);
  check("an absent entry is not a match", mcpServerMatches(undefined, "demo-recipe"), false);
  // A disabled entry excludes itself from tool discovery entirely (OpenClaw's own registry
  // docs) — correct command/args is not enough for it to count as "working".
  check("a disabled entry does not match even with the right command/args", mcpServerMatches({ ...mcpServerSpec("demo-recipe"), enabled: false }, "demo-recipe"), false);
  check("enabled explicitly true still matches", mcpServerMatches({ ...mcpServerSpec("demo-recipe"), enabled: true }, "demo-recipe"), true);
  check("an absent enabled field defaults to matching (conservative default)", mcpServerMatches(mcpServerSpec("demo-recipe"), "demo-recipe"), true);
}

{
  const { ctx, calls } = stubContext({ "demo-recipe": { ...mcpServerSpec("demo-recipe"), enabled: false } });
  const state = await ensureMcpServer(ctx, CONFIG, "demo-recipe");
  check("ensureMcpServer reconciles a disabled-but-otherwise-correct registration", state, "replaced");
  check("it lists, unsets, then re-adds", calls.length, 3);
}

{
  const { ctx, calls } = stubContext({ "demo-recipe": { command: "missing-program", args: [] } });
  const state = await ensureMcpServer(ctx, CONFIG, "demo-recipe");
  check("ensureMcpServer reports replacement when the command has drifted", state, "replaced");
  check("it lists, unsets, then re-adds — exactly three calls", calls.length, 3);
  check("the unset call matches mcpUnsetArgv()", calls[1], mcpUnsetArgv(CONFIG.mcpServerName));
  check("the re-add call matches mcpAddArgv()", calls[2], mcpAddArgv(CONFIG, "demo-recipe"));
}

{
  const { ctx, calls } = stubContext({ jobs: [] });
  const state = await ensureCronJob(ctx, CONFIG, "scheduled message");
  check("ensureCronJob reports creation when the job is absent", state, "created");
  check("ensureCronJob's add call matches cronAddArgv()", calls[1], cronAddArgv(CONFIG, "scheduled message"));
}
{
  const { ctx, calls } = stubContext({ jobs: [liveJob()] });
  const state = await ensureCronJob(ctx, CONFIG, "scheduled message");
  check("ensureCronJob reports the job unchanged when it already matches", state, "unchanged");
  check("ensureCronJob only lists, no write call, when already matching", calls.length, 1);
}

// --- cron reconciliation: a job that drifted from the recipe is replaced ------------------

{
  check("cronJobMatches accepts a job equal to the declaration", cronJobMatches(liveJob(), CONFIG, "scheduled message"), true);
  check("a changed schedule counts as drift", cronJobMatches({ ...liveJob(), schedule: { expr: "0 4 * * *" } }, CONFIG, "scheduled message"), false);
  check("a changed message counts as drift", cronJobMatches(liveJob(), CONFIG, "a different message"), false);
  check("a changed timeout counts as drift", cronJobMatches({ ...liveJob(), payload: { message: "scheduled message", timeoutSeconds: 60 } }, CONFIG, "scheduled message"), false);
  check("a changed agent counts as drift", cronJobMatches({ ...liveJob(), agentId: "someone-else" }, CONFIG, "scheduled message"), false);
  check("a job left on chat delivery counts as drift", cronJobMatches({ ...liveJob(), delivery: { mode: "announce" } }, CONFIG, "scheduled message"), false);
  check("a job left on the main session counts as drift", cronJobMatches({ ...liveJob(), sessionTarget: "main" }, CONFIG, "scheduled message"), false);
  // --all (task #188) makes a disabled job visible to ensureCronJob at all — it must not
  // also count as "still matching" just because every other declared field agrees, or a
  // disabled job would sit disabled forever with nothing ever noticing.
  check("a disabled job does not match even with every other field agreeing", cronJobMatches({ ...liveJob(), enabled: false }, CONFIG, "scheduled message"), false);
  check("enabled explicitly true still matches", cronJobMatches({ ...liveJob(), enabled: true }, CONFIG, "scheduled message"), true);
  check("an absent enabled field defaults to matching (conservative default)", cronJobMatches(liveJob(), CONFIG, "scheduled message"), true);
}

{
  const { ctx, calls } = stubContext({ jobs: [{ ...liveJob(), enabled: false }] });
  const state = await ensureCronJob(ctx, CONFIG, "scheduled message", { allowUpdate: true });
  check("ensureCronJob reconciles a disabled-but-otherwise-correct job", state, "updated");
  check(
    "reconciling a disabled job means remove then add, same as any other drift",
    calls.map((c) => c.slice(0, 2).join(" ")),
    ["cron list", "cron rm", "cron add"],
  );
}

{
  const { ctx, calls } = stubContext({ jobs: [{ ...liveJob(), schedule: { expr: "0 4 * * *" } }] });
  const state = await ensureCronJob(ctx, CONFIG, "scheduled message", { allowUpdate: true });
  check("a drifted job is replaced rather than left alone", state, "updated");
  check(
    "replacing means remove then add, in that order",
    calls.map((c) => c.slice(0, 2).join(" ")),
    ["cron list", "cron rm", "cron add"],
  );
  check("the remove targets the live job's id", calls[1], cronRmArgv("job-1"));
  check("the add carries the declaration", calls[2], cronAddArgv(CONFIG, "scheduled message"));
}

// The scope-upgrade self-heal these commands rely on lives in openclaw-cli.ts and is
// covered by openclaw-cli.check.ts — not duplicated here.

process.stderr.write(failed === 0 ? "all provision-agent checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
