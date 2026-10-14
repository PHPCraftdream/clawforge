// Round 3, ambiguous absence fails closed: the presence probe (`sh -s`, existsVia's
// PRESENCE_PROBE) answers exit 1 with EMPTY stderr for a declared privatePath — neither
// exists nor absent. The trial must REFUSE naming the path rather than guess (the old
// `test -e` handling silently treated this shape as a plain absence and copied nothing).

import { runTrialDryRun } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { DATA_DIR, captured, messageOf, ref, trialFixture, useRecipesRoot } from "../../fixture.ts";

const root = await useRecipesRoot("clawforge-recipe-trial-ambiguous");
try {
  await root.write("subject", { description: "A recipe with one declared privatePath", privatePaths: ["state"] });
  const fixture = trialFixture();
  fixture.ambiguousProbe = true;
  const refused = await messageOf("the ambiguous probe run", () =>
    runTrialDryRun(fixture.ctx, ref("subject")));
  checkTrue("an ambiguous presence probe refuses the run (fail closed)",
    /could\x20not\x20be\x20measured/.test(refused));
  checkTrue("the refusal names the unmeasurable path", refused.includes(`${DATA_DIR}/state`));

  // The control: with the probe healthy, the same declared path answers definitively and
  // the dry run completes its plan (the probe is the mechanism the refusal keys on).
  const healthy = trialFixture();
  healthy.absentPaths = [`${DATA_DIR}/state`];
  let healthyError = "";
  const { chunks } = await captured(async () => {
    try {
      await runTrialDryRun(healthy.ctx, ref("subject"));
    } catch (error) {
      healthyError = error instanceof Error ? error.message : String(error);
    }
  });
  check("a definitive absent answer lets the dry run complete", healthyError, "");
  const plan = chunks.join("");
  checkTrue("the absent path is reported as absent, not silently skipped",
    plan.includes(`${DATA_DIR}/state`) && plan.includes(`"state":"absent"`));
} finally {
  await root.dispose();
}

finish("recipe-trial-round3-ambiguous-absence");
