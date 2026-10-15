// Round 4, compose version gate: BOTH the real run and the dry-run refuse a target whose
// Compose is older than v2.24 (the `!override` merge tag needs it) — the refusal names the
// found version and the v2.24 requirement, and nothing was written or built.

import { runTrialAction, runTrialDryRun } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { checkTrue, finish } from "#checks/kit/harness.ts";
import { messageOf, ref, trialFixture, useRecipesRoot } from "../../fixture.ts";

const root = await useRecipesRoot("clawforge-recipe-trial-old-compose");
try {
  await root.write("subject", { description: "A recipe on an old Compose" });

  const real = trialFixture();
  real.composeVersion = "2.23.9";
  const realLeak = await messageOf("the old-compose real run", () => runTrialAction(real.ctx, ref("subject")));
  checkTrue("the REAL run refuses a pre-2.24 Compose",
    /requires.Docker.Compose.v2\.24\.0.or.newer/.test(realLeak));
  checkTrue("the real refusal names the found version", realLeak.includes("2.23.9"));
  checkTrue("the real refusal happens before any write", real.privateWrites.length === 0);
  checkTrue("the real refusal reaches no build", !real.docker.some((argv) => argv.includes("build")));

  const dry = trialFixture();
  dry.composeVersion = "2.23.9";
  const dryLeak = await messageOf("the old-compose dry run", () => runTrialDryRun(dry.ctx, ref("subject")));
  checkTrue("the DRY RUN refuses a pre-2.24 Compose too",
    /requires.Docker.Compose.v2\.24\.0.or.newer/.test(dryLeak));
  checkTrue("the dry-run refusal names the found version", dryLeak.includes("2.23.9"));
  checkTrue("the dry run also reached no build", !dry.docker.some((argv) => argv.includes("build")));
} finally {
  await root.dispose();
}

finish("recipe-trial-round4-old-compose");
