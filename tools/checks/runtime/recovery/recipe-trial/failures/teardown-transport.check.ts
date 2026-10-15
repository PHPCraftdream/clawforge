// A failing teardown step must never skip the rest: the product's scratch-removal seam
// (`ctx.transport.remove`) fails here both ways a promise-based transport can — a
// synchronous throw and an asynchronous rejection (the product's remove answers void, so a
// rejected promise IS its error result; there is no separate error-result channel). Both
// must be reported naming the scratch path and project, leave the run non-zero, and leave
// the OTHER teardown steps (compose down, the labelled-image check) executed.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { captured, ref, trialFixture, useRecipesRoot } from "../fixture.ts";

const root = await useRecipesRoot("clawwright-recipe-trial-teardown-transport");
try {
  await root.write("subject", { description: "A recipe whose scratch removal fails" });

  // --- remove throws synchronously ----------------------------------------------------------------

  {
    const fixture = trialFixture();
    const original = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
    fixture.ctx.transport.exec = async (command, args, options) => {
      if (command === "rm" && args[0] === "-rf") {
        fixture.removed.push(args[args.length - 1] ?? "");
        throw new Error("fixture remove transport error");
      }
      return original(command, args, options);
    };
    const outcome = await captured(async () => {
      try { await runTrialAction(fixture.ctx, ref("subject")); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
    });
    checkTrue("a thrown remove leaves the run non-zero", /teardown.left.resources.behind/.test(outcome.result ?? ""));
    checkTrue("the leftover report names the scratch home path shape",
      /\.clawwright-recipe-trial-[0-9a-f]{12}-[0-9a-f]{8}/.test(outcome.result ?? ""));
    checkTrue("the attempted removal was recorded against the named path",
      (outcome.result ?? "").includes(fixture.removed[0] ?? ""));
    checkTrue("the leftover report names the trial project", /project."clawwright-recipe-trial-/.test(outcome.result ?? ""));
    checkTrue("the thrown error is reported in the output", outcome.chunks.some((chunk) => /fixture.remove.transport.error/.test(chunk)));
    checkTrue("compose down still ran", fixture.docker.some((argv) => argv.includes("down")));
    checkTrue("the labelled-image check still ran", fixture.docker.some((argv) => argv.includes("images")));
  }

  // --- remove rejects asynchronously (its error result) ---------------------------------------------

  {
    const fixture = trialFixture();
    const original = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
    fixture.ctx.transport.exec = async (command, args, options) => {
      if (command === "rm" && args[0] === "-rf") {
        fixture.removed.push(args[args.length - 1] ?? "");
        return Promise.reject(new Error("fixture remove rejection"));
      }
      return original(command, args, options);
    };
    const outcome = await captured(async () => {
      try { await runTrialAction(fixture.ctx, ref("subject")); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
    });
    checkTrue("a rejected remove leaves the run non-zero", /teardown.left.resources.behind/.test(outcome.result ?? ""));
    checkTrue("the rejection is reported in the output", outcome.chunks.some((chunk) => /fixture.remove.rejection/.test(chunk)));
    checkTrue("compose down still ran", fixture.docker.some((argv) => argv.includes("down")));
    checkTrue("the labelled-image check still ran", fixture.docker.some((argv) => argv.includes("images")));
    check("the removal was still attempted exactly once", fixture.removed.length, 1);
  }
} finally {
  await root.dispose();
}

finish("recipe-trial-teardown-transport");
