// Round 4, dry-run configProof disclosure: the dry-run writes nothing, so it cannot run
// the merged-config proof — the report must SAY so, with `configProof` starting "skipped",
// instead of staying silent about the gap.

import { runTrialDryRun } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { captured, ref, trialFixture, useRecipesRoot } from "../../fixture.ts";

const root = await useRecipesRoot("clawwright-recipe-trial-config-proof");
try {
  await root.write("subject", { description: "A recipe whose dry-run must disclose the skipped proof" });
  const fixture = trialFixture();
  const { chunks } = await captured(() => runTrialDryRun(fixture.ctx, ref("subject")));
  const reports = chunks
    .map((chunk) => { try { return JSON.parse(chunk) as Record<string, unknown>; } catch { return undefined; } })
    .filter((value): value is Record<string, unknown> => value !== undefined && value["dryRun"] === true);
  check("the dry-run emitted exactly one JSON report", reports.length, 1);
  const proof = reports[0]?.["configProof"];
  checkTrue("the report carries a configProof disclosure", typeof proof === "string");
  checkTrue("the disclosure says the proof is SKIPPED", String(proof).startsWith("skipped"));
  checkTrue("the disclosure says the real run refuses on failure",
    /the.real.run.refuses.on.failure/.test(String(proof)));
} finally {
  await root.dispose();
}

finish("recipe-trial-round4-config-proof-disclosure");
