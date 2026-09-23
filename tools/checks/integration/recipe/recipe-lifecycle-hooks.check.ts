// Checks the P2-12 recipe lifecycle hooks: a recipe that declares quiesce.ts/resume.ts is
// quiesced for exactly the window backup pauses the gateway for, and resumed on every exit
// path; a recipe that declares nothing is unaffected — named by the same warning as before
// this mechanism existed; a failing or hung hook degrades to that same warning instead of
// failing the backup; and the two caller-owned modes (--hot, leaveStopped) call nothing.
//
// No target and no real recipe services: a stub transport drives the real createBackup(),
// and the hooks are real .ts files under a fixture recipes directory, imported through the
// same checksum-versioned loader prepare/verify/onboard use. Hook calls and the archive
// step record into one ordered event array, so the assertions pin ORDER, not just
// occurrence: quiesce between pause and tar, resume after the gateway is healthy.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createBackup } from "#framework/commands/lifecycle/backup.ts";
import type { BackupOptions } from "#framework/commands/lifecycle/backup.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { clearRecipesDir, projectName, useRecipesDir } from "#framework/service/recipe.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(`  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`);
}

useDeployment(resolve(monorepoRoot, "apps", "example app"));

const HOOK_LOG = "__clawforgeRecipeLifecycleEvents";
const dataDir = "/srv/clawforge/data";
const backupDir = "/srv/clawforge/backups";

interface Stub {
  ctx: Context;
  events: string[];
  probed: string[];
}

/** A transport/runtime stub answering every command createBackup() issues against a modeled
 *  target (the same shape convergence/backup.check.ts drives), plus the recipe-stack probes
 *  runningRecipeStacks() makes. The archive step and the runtime transitions record into
 *  `events` — the same array the fixture hooks push to — so hook ordering against
 *  pause/tar/start is assertable as one sequence. */
function stub(): Stub {
  const events: string[] = [];
  const probed: string[] = [];
  const files = new Set<string>([dataDir]);
  const ctx = {
    settings: { dataDir, backupDir, env: {} },
    transport: {
      description: "recipe-lifecycle-stub",
      async exists(path: string): Promise<boolean> {
        return files.has(path);
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-e") return { code: files.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
        if (command === "tar" && args.includes("-czf")) {
          files.add(args[args.indexOf("-czf") + 1] ?? "");
          events.push("tar");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) {
          return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        }
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) {
          const archives = [...files].filter((path) => path.startsWith(`${backupDir}/`) && path.endsWith(".tar.gz"));
          return { code: 0, stdout: `${archives.join("\n")}\n`, stderr: "" };
        }
        if (command === "mv") {
          const source = args.at(-2) ?? "";
          const destination = args.at(-1) ?? "";
          files.delete(source);
          files.add(destination);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rm") {
          for (const arg of args.filter((value) => !value.startsWith("-"))) {
            for (const path of Array.from(files)) {
              if (path === arg || (args.includes("-rf") && path.startsWith(`${arg}/`))) files.delete(path);
            }
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rmdir") {
          files.delete(args[0] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(): Promise<string> {
        throw new Error("not modeled");
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
    },
    runtime: {
      async isRunning(): Promise<boolean> {
        return true;
      },
      async pause(): Promise<void> {
        events.push("pause");
      },
      async start(): Promise<void> {
        events.push("start");
      },
      async waitForHealth(): Promise<void> {
        events.push("waitForHealth");
      },
      stack(project: string) {
        probed.push(project);
        return {
          async isRunning(): Promise<boolean> {
            return true;
          },
        };
      },
    },
  } as unknown as Context;
  return { ctx, events, probed };
}

/** Fixture hook bodies. Each pushes a "<phase>:<recipe>" event into the shared log. */
const HOOKS: Record<string, string> = {
  "hooked/quiesce.ts": `export function quiesce() { globalThis.${HOOK_LOG}.push("quiesce:hooked"); }\n`,
  "hooked/resume.ts": `export function resume() { globalThis.${HOOK_LOG}.push("resume:hooked"); }\n`,
  "failing/quiesce.ts": `export function quiesce() { globalThis.${HOOK_LOG}.push("quiesce:failing"); throw new Error("refuses to pause today"); }\n`,
  "failing/resume.ts": `export function resume() { globalThis.${HOOK_LOG}.push("resume:failing"); }\n`,
  "hung/quiesce.ts": `export function quiesce() { globalThis.${HOOK_LOG}.push("quiesce:hung"); return new Promise(() => {}); }\n`,
  "hung/resume.ts": `export function resume() { globalThis.${HOOK_LOG}.push("resume:hung"); }\n`,
  "no-resume/quiesce.ts": `export function quiesce() { globalThis.${HOOK_LOG}.push("quiesce:no-resume"); }\n`,
};

/** Writes a fixture recipes root with the named recipes; hook files only for the ones that
 *  declare them ("quiet" deliberately ships none). */
async function recipesWith(names: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clawforge-recipe-lifecycle-"));
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "recipe.json"), JSON.stringify({ description: `${name} fixture` }), "utf8");
  }
  for (const [relativePath, content] of Object.entries(HOOKS)) {
    const owner = relativePath.split("/")[0];
    if (!names.includes(owner)) continue;
    await writeFile(join(root, relativePath), content, "utf8");
  }
  return root;
}

async function run(name: string, options: BackupOptions, recipeNames: string[]): Promise<{ archive: string | undefined; output: string; events: string[]; probed: string[] }> {
  const root = await recipesWith(recipeNames);
  useRecipesDir(root);
  const stubbed = stub();
  (globalThis as unknown as Record<string, unknown>)[HOOK_LOG] = stubbed.events;
  let output = "";
  let archive: string | undefined;
  try {
    archive = await withOutputSink((line) => { output += line; }, () => createBackup(stubbed.ctx, options));
  } catch (error) {
    output += `\nTHROWN: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearRecipesDir();
    delete (globalThis as unknown as Record<string, unknown>)[HOOK_LOG];
    await rm(root, { recursive: true, force: true });
  }
  check(`[fixture] ${name}: no thrown error`, output.includes("THROWN:"), false);
  return { archive, output, events: stubbed.events, probed: stubbed.probed };
}

// (1) A recipe that declares the hooks gets them at the right points: quiesce inside the
// gateway's pause window and before tar, resume only after the gateway is healthy again.
// A recipe that declares nothing runs through unchanged: still probed, still named by the
// pre-existing warning, never called.
{
  const result = await run("declared hooks bracket the archive", {}, ["hooked", "quiet"]);
  check("the backup succeeds", typeof result.archive === "string", true);
  check(
    "quiesce runs between pause and tar, resume after the gateway is healthy",
    result.events,
    ["pause", "quiesce:hooked", "tar", "start", "waitForHealth", "resume:hooked"],
  );
  check(
    "both stacks are probed through their own compose projects",
    [...result.probed].sort(),
    [projectName(deploymentName(), "hooked"), projectName(deploymentName(), "quiet")].sort(),
  );
  check("the undeclared recipe is named by the pre-existing warning", result.output.includes("not quiesced for this backup: quiet"), true);
  check("the declared recipe is not named as uncovered", result.output.includes("not quiesced for this backup: hooked"), false);
  check("the successful quiesce is announced", result.output.includes("hooked: quiesced for the snapshot"), true);
}

// (2) A failing quiesce hook degrades to the warning: the backup completes, the recipe is
// named as uncovered, and no resume is attempted for a quiesce that never completed.
{
  const result = await run("a failing quiesce hook degrades to the warning", {}, ["failing"]);
  check("the backup still succeeds", typeof result.archive === "string", true);
  check("the hook failure is reported with its message", result.output.includes("quiesce hook failed") && result.output.includes("refuses to pause today"), true);
  check("the recipe stays in the uncovered warning", result.output.includes("not quiesced for this backup: failing"), true);
  check("no resume runs for a quiesce that never completed", result.events, ["pause", "quiesce:failing", "tar", "start", "waitForHealth"]);
}

// (3) A hung quiesce hook is bounded by the deadline (CLAWFORGE_RECIPE_HOOK_TIMEOUT_MS,
// the same escape hatch pattern as the import timeout), same degradation as a failure.
{
  process.env.CLAWFORGE_RECIPE_HOOK_TIMEOUT_MS = "250";
  try {
    const result = await run("a hung quiesce hook is bounded by the deadline", {}, ["hung"]);
    check("the backup still succeeds", typeof result.archive === "string", true);
    check("the deadline is reported", result.output.includes("timed out after 250ms"), true);
    check("the recipe stays in the uncovered warning", result.output.includes("not quiesced for this backup: hung"), true);
    check("no resume runs for a timed-out quiesce", result.events, ["pause", "quiesce:hung", "tar", "start", "waitForHealth"]);
  } finally {
    delete process.env.CLAWFORGE_RECIPE_HOOK_TIMEOUT_MS;
  }
}

// (4) A quiesce whose resume is not declared is named: the framework called quiesce, the
// recipe may have stopped its service, and only the hook's author can bring it back.
{
  const result = await run("a quiesce without resume.ts is named", {}, ["no-resume"]);
  check("the quiesce ran", result.events.includes("quiesce:no-resume"), true);
  check("the missing resume is warned about", result.output.includes("stays quiesced") && result.output.includes("no resume.ts"), true);
  check("the covered recipe is NOT in the uncovered warning", result.output.includes("not quiesced for this backup: no-resume"), false);
  check("no resume event is recorded", result.events.filter((entry) => entry.startsWith("resume:")), []);
}

// (5) leaveStopped: the caller (pull, smoke's round trip) owns the transaction that
// continues past this function, so no hook runs — exactly the pre-hook behavior.
{
  const result = await run("leaveStopped owns the transaction and calls no hooks", { leaveStopped: true }, ["hooked"]);
  check("no hook runs when the caller owns the transaction", result.events, ["pause", "tar"]);
  check("the gateway stays stopped for the caller", result.output.includes("leaving the gateway stopped"), true);
  check("the undeclared window keeps its warning", result.output.includes("not quiesced for this backup: hooked"), true);
}

// (6) --hot accepts a torn snapshot by definition: no pause, no hooks, warning kept.
{
  const result = await run("a hot backup calls no hooks either", { hot: true }, ["hooked"]);
  check("a hot backup pauses nothing and calls no hooks", result.events, ["tar"]);
  check("a hot backup still names the running stack", result.output.includes("not quiesced for this backup: hooked"), true);
}

process.stderr.write(failed === 0 ? "all recipe lifecycle hook checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
