// Round 4, merged-document binding analysis: the refusal scan runs on the MERGED
// (base+override) document with the realpath resolver, so a mount the MERGE introduces —
// the base config was clean — must refuse. mergeCompose cannot honestly produce that from
// the generated override, so the fixture knob `mergedHasBadMount` swaps the computed merged
// services' volume entry to a live bind (source /etc/data, outside every allowed prefix);
// the analysis must refuse naming the bind. With the knob off the same run succeeds.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { messageOf, ref, trialFixture, useRecipesRoot } from "../../fixture.ts";

const root = await useRecipesRoot("clawforge-recipe-trial-merged-mount");
try {
  await root.write("subject", {
    description: "A recipe whose merge introduces a live bind",
    privatePaths: ["state"],
  });
  const base = { services: {
    app: { image: "nginx", ports: [{ mode: "ingress", host_ip: "", target: 8080, published: "8080", protocol: "tcp" }] },
  } };

  // The control: a clean merge lets the run succeed.
  const clean = trialFixture();
  clean.baseConfigJson = JSON.stringify(base);
  const cleanOutcome = await (async () => {
    try { await runTrialAction(clean.ctx, ref("subject")); return ""; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })();
  check("the same recipe with a clean merge succeeds", cleanOutcome, "");

  // The knob: the computed merged document gains a bind outside every allowed prefix.
  const bad = trialFixture();
  bad.baseConfigJson = JSON.stringify(base);
  bad.mergedHasBadMount = true;
  const leak = await messageOf("the merged bad mount", () => runTrialAction(bad.ctx, ref("subject")));
  checkTrue("the run refuses when the MERGED document carries a live bind",
    /refuses\x20app\.volumes/.test(leak));
  checkTrue("the refusal names the bind source", leak.includes("/etc/data"));
  checkTrue("the refusal describes the escape from the allowed dirs",
    /outside.the.trial.scratch.home/.test(leak));
  checkTrue("the refusal came from the merged analysis (after the copy), not the base scan",
    bad.copyArgv.length === 1);
} finally {
  await root.dispose();
}

finish("recipe-trial-round4-merged-mount");
