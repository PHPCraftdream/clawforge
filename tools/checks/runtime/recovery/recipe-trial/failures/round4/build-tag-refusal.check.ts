// Round 4, merged build-tag prefix rule: the MERGED-document analysis refuses a service
// that has both `build` and an `image` outside the trial's build-tag namespace — the
// override's image line did not reach the merged document. The fixture knob
// `mergedImageFor` models exactly that compose behavior (ports override merged, base image
// kept); the refusal must name the service and the surviving tag. Without the knob the
// computed merge carries the trial tag and the same run succeeds.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { messageOf, ref, trialFixture, useRecipesRoot } from "../../fixture.ts";

const root = await useRecipesRoot("clawforge-recipe-trial-build-tag");
try {
  await root.write("subject", { description: "A recipe whose build service keeps a foreign tag" });
  const base = { services: {
    app: { build: { context: "." }, image: "nginx:1.25",
      ports: [{ mode: "ingress", host_ip: "", target: 8080, published: "8080", protocol: "tcp" }] },
  } };

  // The control: the faithful computed merge carries the trial's own tag.
  const faithful = trialFixture();
  faithful.baseConfigJson = JSON.stringify(base);
  const faithfulOutcome = await (async () => {
    try { await runTrialAction(faithful.ctx, ref("subject")); return ""; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })();
  check("the faithful merge (the trial tag reached the merged doc) succeeds", faithfulOutcome, "");

  // The knob: compose merged the ports override but kept the base image.
  const foreign = trialFixture();
  foreign.baseConfigJson = JSON.stringify(base);
  foreign.mergedImageFor = new Map([["app", "nginx:1.25"]]);
  const leak = await messageOf("the foreign tag", () => runTrialAction(foreign.ctx, ref("subject")));
  checkTrue("the run refuses when the merged build service keeps a foreign image tag",
    /refuses\x20app\.image/.test(leak));
  checkTrue("the refusal names the surviving tag", leak.includes("nginx:1.25"));
  checkTrue("the refusal describes the exact-tag mismatch", /expected.the.exact.trial.tag/.test(leak));
  checkTrue("nothing was built past the refusal", !foreign.docker.some((argv) => argv.includes("build")));
} finally {
  await root.dispose();
}

finish("recipe-trial-round4-build-tag");
