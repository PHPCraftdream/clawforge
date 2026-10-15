// Round 3, merge mechanism: the fixture's mergeCompose models compose's documented merge
// for the product's own generated override grammar, and the fixture knob
// `overrideBreaksProof` proves the product's merged-config proof path actually fails a
// broken merge: with the knob on, the `!override` tag is stripped from the written
// override INSIDE the merge model, the merge refuses the un-tagged ports block, and the
// config call answers like compose would — exit 1 with the merge error on stderr — so the
// run dies naming the failed proof, NOT with a stale safe document.

import { buildOverride } from "#framework/commands/management/recipe/recovery/trial/ports.ts";
import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { mergeCompose, messageOf, ref, trialFixture, useRecipesRoot } from "../../fixture.ts";

// --- mergeCompose: the generated-grammar merge model ---------------------------------------

const base = {
  services: {
    web: { image: "nginx", ports: [
      { mode: "ingress", host_ip: "", target: 80, published: "8080", protocol: "tcp" },
      { mode: "ingress", host_ip: "", target: 53, published: "9053", protocol: "udp" },
    ] },
    db: { image: "postgres", ports: [{ mode: "ingress", host_ip: "", target: 5432, published: "5432", protocol: "tcp" }] },
  },
};
const tagOverride = "# head\nservices:\n  web:\n    ports: !override []\n  db:\n    ports: !override []\n";
const tagMerged = await mergeCompose(base, tagOverride);
const tagWeb = (tagMerged.services as Record<string, Record<string, unknown>>).web!;
checkTrue("!override [] empties the base service's ports", tagWeb["ports"] === undefined);
check("!override [] leaves the rest of the service untouched", tagWeb["image"], "nginx");

const remapMerged = async (): Promise<string> => {
  try { await mergeCompose(base, "services:\n  db:\n    ports:\n      - \"127.0.0.1::5432\"\n"); return "accepted"; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
};
checkTrue("an un-tagged remap-shaped ports block is refused as a grammar error (the product emits only !override)",
  /cannot.understand.the.override.line/.test(await remapMerged()));
const plainPorts = async (): Promise<string> => {
  try { await mergeCompose(base, "services:\n  db:\n    ports: []\n"); return "accepted"; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
};
checkTrue("a plain ports: [] without the merge tag is refused as a grammar error",
  /cannot.understand.the.override.line/.test(await plainPorts()));

const imageMerged = await mergeCompose(base, "services:\n  web:\n    image: trial-web:1\n    ports: !override []\n") as { services: Record<string, Record<string, unknown>> };
check("an image line replaces the base service's image", imageMerged.services.web!["image"], "trial-web:1");

const added = await mergeCompose(base, "services:\n  extra:\n    ports: !override []\n") as { services: Record<string, unknown> };
checkTrue("a service the base lacks is added", added.services["extra"] !== undefined);

let malformedThrew = false;
try {
  await mergeCompose(base, "services:\n  web:\n    ports: [weird\n");
} catch {
  malformedThrew = true;
}
checkTrue("a malformed override (ports line the parser cannot understand) throws", malformedThrew);

// The product's own output must round-trip through the model: buildOverride's merge-tag
// document, applied to the base document it was derived from, reproduces the stripped
// merged config the proof accepts.
const overrideDoc = buildOverride([
  { name: "web", builds: false, ports: [{ target: "80", protocol: "tcp", hostIp: "", published: "8080" }] },
], new Map());
const roundTripped = await mergeCompose(base, overrideDoc) as { services: Record<string, Record<string, unknown>> };
checkTrue("the product's generated override merges to a document with no published port",
  roundTripped.services.web!["ports"] === undefined);

// --- end to end: the proof catches a merge that ignored the override ------------------------

const root = await useRecipesRoot("clawforge-recipe-trial-merge");
try {
  await root.write("subject", { description: "A recipe whose merge the proof watches" });
  const good = trialFixture();
  good.baseConfigJson = JSON.stringify(base);
  good.mergedConfigJson = JSON.stringify({ services: { web: { image: "nginx" }, db: { image: "postgres" } } });
  let runError = "";
  try {
    await runTrialAction(good.ctx, ref("subject"));
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }
  checkTrue("a faithful merge (proof sees no publications) lets the run succeed", runError === "");

  const broken2 = trialFixture();
  broken2.baseConfigJson = JSON.stringify(base);
  broken2.mergedConfigJson = JSON.stringify({ services: { web: { image: "nginx" }, db: { image: "postgres" } } });
  broken2.overrideBreaksProof = true;
  // Capture the merged-config call's OWN result: the break must answer like compose —
  // exit 1 — not like a successful evaluation of a stale safe document.
  let mergedConfigCode: number | undefined;
  const innerExec = broken2.ctx.transport.exec.bind(broken2.ctx.transport);
  (broken2.ctx.transport as { exec: typeof innerExec }).exec = async (command: string, args: string[], options: unknown) => {
    const result = await innerExec(command, args as string[], options as never);
    if ((command === "docker" || (command === "sh" && args[2] === "recipe-docker")) && args.includes("config")
      && args.filter((entry) => entry === "--file").length > 1) {
      mergedConfigCode = result.code;
    }
    return result;
  };
  const leak = await messageOf("the broken merge", () => runTrialAction(broken2.ctx, ref("subject")));
  checkTrue("a broken override (the merge refuses it) dies in the merged-config proof path",
    /could.not.prove.the.merged.compose.configuration/.test(leak));
  check("the config call answered like compose: the refused merge is exit 1", mergedConfigCode, 1);
  checkTrue("the stale safe document did NOT survive the broken merge",
    !/refuses\x20web\.ports/.test(leak));
} finally {
  await root.dispose();
}

finish("recipe-trial-round3-merge");
