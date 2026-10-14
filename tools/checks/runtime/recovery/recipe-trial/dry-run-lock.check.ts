// --dry-run takes no lock, writes nothing and builds nothing: it prints the plan (project
// name, per-path sizes, the override verbatim) and still refuses over the size bound. The
// real run takes the instance lock — proven behaviorally: under a foreign lock it refuses
// before touching Docker, and the same dry-run sails through the same held lock.

import { takeLock, lockPath } from "#framework/runtime/lock/instance-lock.ts";
import { runTrialDryRun } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { captured, DATA_DIR, messageOf, ref, trialFixture, useRecipesRoot } from "./fixture.ts";

const root = await useRecipesRoot("clawforge-recipe-trial-dryrun");
try {
  await root.write("planned", {
    description: "A recipe the plan describes",
    privatePaths: ["state"],
  });

  // --- dry-run: no lock, no writes, no build/up; the plan is printed ----------------------------

  {
    const fixture = trialFixture();
    fixture.duSizes.set(`${DATA_DIR}/state`, 4096);
    const run = await captured(async () => {
      try { await runTrialDryRun(fixture.ctx, ref("planned")); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
    });
    check("dry-run: the run succeeds", run.result, "");
    checkTrue("dry-run: no mkdirPrivate and no private writes", fixture.mkdirPrivateCalls.length === 0 && fixture.privateWrites.length === 0);
    checkTrue("dry-run: no build or up reached docker", fixture.docker.every((argv) => !argv.includes("build") && !argv.includes("up")));
    checkTrue("dry-run: no scratch home removal", fixture.removed.length === 0);
    const document = JSON.parse(run.chunks.join("")) as {
      dryRun: boolean; changed: boolean; ok: boolean; project: string; scratchHome: string;
      privatePaths: { entry: string; bytes: number | null; state: string }[]; totalBytes: number | null; boundBytes: number; overrideFile: string;
    };
    checkTrue("dry-run: the report says dryRun, unchanged, ok", document.dryRun === true && document.changed === false && document.ok === true);
    checkTrue("dry-run: the report carries the project name", /^clawforge-recipe-trial-[0-9a-f]{12}-[0-9a-f]{8}$/.test(document.project));
    check("dry-run: per-path sizes are reported", document.privatePaths, [{ entry: `${DATA_DIR}/state`, bytes: 4096, state: "measured" }]);
    check("dry-run: the total and the bound are reported", [document.totalBytes, document.boundBytes], [4096, 268435456]);
    checkTrue("dry-run: the override is included verbatim", /^#.recipe.trial:/.test(document.overrideFile) && document.overrideFile.includes("services:"));
    checkTrue("dry-run: the scratch home in the report matches the trial-home shape", document.scratchHome.includes(".clawforge-recipe-trial-"));
  }

  // --- dry-run over the bound still refuses ------------------------------------------------------

  {
    const fixture = trialFixture();
    fixture.duSizes.set(`${DATA_DIR}/state`, 300 * 1024 * 1024);
    const message = await messageOf("dry-run over the bound refuses", () => runTrialDryRun(fixture.ctx, ref("planned")));
    checkTrue("the refusal names the bound", message.includes("268435456"));
    checkTrue("the refusal names the total", message.includes(String(300 * 1024 * 1024)));
    checkTrue("the over-bound dry-run still wrote nothing", fixture.privateWrites.length === 0);
  }

  // --- the real run goes through the instance lock -------------------------------------------------
  // The lock is taken by the command layer (runLocked), not by runTrialAction itself, so
  // these cases drive the full `recipe trial` command.

  {
    const { recipe } = await import("#framework/commands/management/recipe/index.ts");
    const fixture = trialFixture();
    const held = await takeLock(fixture.ctx, "backup", "op-backup");
    const holderBefore = fixture.files.get(`${lockPath(fixture.ctx)}/holder.json`);
    const message = await messageOf("a real trial under a foreign lock refuses", () =>
      captured(() => recipe(fixture.ctx, ["trial", "planned"])));
    checkTrue("the refusal names the instance lock", message.includes("instance-lock"));
    checkTrue("nothing reached docker under someone else's lock", fixture.docker.length === 0);
    checkTrue("nothing was written under someone else's lock", fixture.privateWrites.length === 0);
    check("the holder file is untouched by the refusal", fixture.files.get(`${lockPath(fixture.ctx)}/holder.json`), holderBefore);

    // The same --dry-run runs to completion while the lock is still held: it never asks for it.
    const dryChunks: string[] = [];
    let dryError: unknown;
    try {
      await captured(async () => {
        const { withOutputSink } = await import("#framework/core/io/output.ts");
        await withOutputSink((chunk) => dryChunks.push(chunk), () => recipe(fixture.ctx, ["trial", "planned", "--dry-run"]));
      });
    } catch (error) {
      dryError = error;
    }
    check("dry-run under a foreign lock completes", dryError ?? "", "");
    checkTrue("the dry-run still printed its plan under the lock", dryChunks.length > 0);
    checkTrue("the dry-run still reached no build", fixture.docker.every((argv) => !argv.includes("build")));
    await held.release();

    // With the lock free again (a fresh context — the lock state lives on the transport),
    // the real run proceeds into Docker.
    const free = trialFixture();
    let freeError: unknown;
    try {
      await captured(() => recipe(free.ctx, ["trial", "planned"]));
    } catch (error) {
      freeError = error;
    }
    check("the freed real run completes", freeError ?? "", "");
    checkTrue("the real run reached docker", free.docker.length > 0);
  }
} finally {
  await root.dispose();
}

finish("recipe-trial-dry-run-lock");
