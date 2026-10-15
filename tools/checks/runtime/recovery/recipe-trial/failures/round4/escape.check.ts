// Round 4, escape-then-pin: the pinned document is written as
// JSON.stringify(escapeComposeDocument(mergedConfig)) — every `$` in every resolved string
// is doubled ($ → $$) so compose's single un-escape on load leaves the proven values. A
// base config whose service carries a resolved string containing a `$` expression must end
// up DOUBLED in the pinned file; the pre-round-4 plain stringify would have written the
// single-`$` form and failed exactly this.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { ref, trialFixture, useRecipesRoot } from "../../fixture.ts";

const root = await useRecipesRoot("clawwright-recipe-trial-escape");
try {
  await root.write("subject", { description: "A recipe whose resolved value carries a $ expression" });
  const fixture = trialFixture();
  const distinctEnv = "fixture-distinct-value";
  fixture.ctx.settings.env.ECRET = distinctEnv;
  fixture.baseConfigJson = JSON.stringify({ services: {
    app: {
      image: "nginx",
      environment: { TRIAL_TOKEN: "v-$ECRET" },
      ports: [{ mode: "ingress", host_ip: "", target: 8080, published: "8080", protocol: "tcp" }],
    },
  } });

  const outcome = await (async () => {
    try { await runTrialAction(fixture.ctx, ref("subject")); return ""; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })();
  check("the run with a $-carrying resolved value succeeds", outcome, "");

  const home = fixture.mkdirPrivateCalls[0] ?? "";
  const pinned = fixture.privateFiles.get(`${home}/pinned-compose.json`) ?? "";
  checkTrue("the pinned document exists", pinned !== "");
  check("the pinned value carries the DOUBLED $ form",
    (JSON.parse(pinned) as { services: { app: { environment: { TRIAL_TOKEN: string } } } }).services.app.environment.TRIAL_TOKEN, "v-$$ECRET");
  checkTrue("pinned value escapes Compose dollar syntax", pinned.includes("v-$$ECRET"));
  const buildLoaded = fixture.loadedComposeEnvironments.find((entry) => entry.operation === "build")?.services.app?.["environment"] as Record<string, unknown> | undefined;
  const upLoaded = fixture.loadedComposeEnvironments.find((entry) => entry.operation === "up")?.services.app?.["environment"] as Record<string, unknown> | undefined;
  check("Compose build second load preserves literal dollar value", buildLoaded?.["TRIAL_TOKEN"], "v-$ECRET");
  check("Compose up second load preserves literal dollar value", upLoaded?.["TRIAL_TOKEN"], "v-$ECRET");
  checkTrue("distinct ECRET fixture value is set", fixture.ctx.settings.env.ECRET === distinctEnv);

} finally {
  await root.dispose();
}

finish("recipe-trial-round4-escape");
