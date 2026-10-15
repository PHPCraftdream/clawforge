// `recipe trial` refusal paths and project naming: a recipe whose compose.yml is missing
// dies naming the file; privatePaths over the 256 MiB bound die naming the bound and every
// per-path size; a transport without private-file support is refused before any write; and
// the derived project stays in its own trial namespace — right shape, never the live
// project, unique per run, stable prefix per recipe.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { TRIAL_PRIVATE_PATHS_BOUND_BYTES } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import {
  DATA_DIR, ref, type TrialFixture, liveProjectFor, messageOf, trialFixture, trialHashFor, useRecipesRoot,
} from "./fixture.ts";

const root = await useRecipesRoot("clawwright-recipe-trial-refusals");
try {
  // `null` composes the compose.yml-absent case directly in the fixture — no
  // write-then-remove round trip, so the check tree keeps no unresolved rm target.
  await root.write("no-compose", { description: "Recipe whose compose.yml is absent" }, null);

  // --- compose.yml missing ------------------------------------------------------------------

  {
    const fixture = trialFixture();
    const message = await messageOf("trial of a recipe without compose.yml refuses", () =>
      runTrialAction(fixture.ctx, ref("no-compose")));
    checkTrue("the refusal names compose.yml", message.includes("compose.yml"));
    check("nothing ran: no docker, no mkdirPrivate, no writes", [fixture.docker.length, fixture.mkdirPrivateCalls.length, fixture.privateWrites.length], [0, 0, 0]);
  }

  // --- privatePaths over the bound ------------------------------------------------------------

  await root.write("over-bound", {
    description: "Recipe whose privatePaths exceed the copy bound",
    privatePaths: ["state", "blobs"],
  });
  {
    const fixture = trialFixture();
    // Two paths totalling 300 MiB — 44 MiB over the 256 MiB bound, and per-path sizes both
    // far enough under the bound that only the total can trip it.
    fixture.duSizes.set(`${DATA_DIR}/state`, 200 * 1024 * 1024);
    fixture.duSizes.set(`${DATA_DIR}/blobs`, 100 * 1024 * 1024);
    const message = await messageOf("a trial whose privatePaths total over the bound refuses", () =>
      runTrialAction(fixture.ctx, ref("over-bound")));
    checkTrue("the refusal names the bound in bytes", message.includes(String(TRIAL_PRIVATE_PATHS_BOUND_BYTES)));
    checkTrue("the refusal names the total", message.includes(String(300 * 1024 * 1024)));
    checkTrue("the refusal names the first path's size", message.includes("209715200"));
    checkTrue("the refusal names the second path's size", message.includes("104857600"));
    checkTrue("the refusal names both paths", message.includes(`${DATA_DIR}/state`) && message.includes(`${DATA_DIR}/blobs`));
    check("the refusal happens before any private write or docker call", [fixture.docker.length, fixture.privateWrites.length], [0, 0]);
  }

  // --- target-side private staging is independent of the legacy host private-file helpers ---

  {
    const fixture = trialFixture();
    await root.write("plain", { description: "A plain recipe" });
    const outcome = await messageOf("a failed target-side private mkdir refuses", async () => {
      const original = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
      fixture.ctx.transport.exec = async (command, args, options) => {
        if (command === "mkdir" && args[0] === "-m") return { code: 1, stdout: "", stderr: "denied" };
        return original(command, args, options);
      };
      await runTrialAction(fixture.ctx, ref("plain"));
    });
    checkTrue("the failed private mkdir is named", /scratch.home/.test(outcome));
    check("no private staging write and only the version probe ran", [fixture.privateWrites.length, fixture.docker.filter((argv) => !argv.includes("version")).length], [0, 0]);
  }

  // --- project naming ---------------------------------------------------------------------------

  {
    const first = trialFixture();
    const second = trialFixture();
    await root.write("named", { description: "A recipe for naming checks" });
    const projects: string[] = [];
    for (const fixture of [first, second]) {
      let threw: unknown;
      try {
        await runTrialAction(fixture.ctx, ref("named"));
      } catch (error) {
        threw = error;
      }
      check("each trial run completes without error", threw ?? "", "");
      const down = fixture.docker.find((argv) => argv.includes("--project-name"));
      const project = down?.[down.indexOf("--project-name") + 1] ?? "";
      projects.push(project);
    }
    const pattern = /^clawwright-recipe-trial-[0-9a-f]{12}-[0-9a-f]{8}$/;
    checkTrue("both projects match clawwright-recipe-trial-<12hex>-<8hex>", projects.every((p) => pattern.test(p)));
    checkTrue("different runs carry different random suffixes", projects[0] !== projects[1]);
    checkTrue("both runs share one hash prefix for the same recipe", projects[0]!.slice(0, "clawwright-recipe-trial-".length + 12) === projects[1]!.slice(0, "clawwright-recipe-trial-".length + 12));
    checkTrue("the hash prefix is the one derived from the deployment + recipe pair", projects[0]!.startsWith(`clawwright-recipe-trial-${trialHashFor("named")}-`));
    const live = liveProjectFor("named");
    const legacy = `${"example-deployment"}-recipe-named`;
    checkTrue("the trial project never equals the live recipe project", projects.every((p) => p !== live));
    checkTrue("the trial project never equals a legacy project shape", projects.every((p) => p !== legacy));
    checkTrue("the live project's own name is the un-prefixed hash form (control)", /^clawwright-recipe-[0-9a-f]{64}$/.test(live));
    const teardownArgv = [first, second].flatMap((fixture: TrialFixture) => fixture.docker);
    checkTrue("no teardown argv carries the live project name", teardownArgv.every((argv) => !argv.includes(live)));
  }
} finally {
  await root.dispose();
}

finish("recipe-trial-refusals-naming");
