// Round 3, LIFO order: with `strictFiles` on, every compose call answers exit 1 "compose
// file not found" unless each --file path exists — and the fixture's remove() deletes the
// privateFiles entries under the removed path. So the PRE-LIFO teardown order (scratch
// home removed first) would starve compose down of its pinned document and the run would
// die; the LIFO order (down first, scratch home LAST) must succeed, and the recorded call
// order must show compose down BEFORE the scratch-home removal.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { ref, trialFixture, useRecipesRoot, type RecordedCall } from "../../fixture.ts";

const root = await useRecipesRoot("clawforge-recipe-trial-lifo");
try {
  await root.write("subject", { description: "A recipe whose down needs its pinned file" });
  const fixture = trialFixture();
  fixture.strictFiles = true;
  fixture.baseConfigJson = JSON.stringify({ services: {
    app: { build: { context: "." }, ports: [{ mode: "ingress", host_ip: "", target: 8080, published: "8080", protocol: "tcp" }] },
  } });

  // One unified timeline: compose down (via either exec path) and transport.remove, in
  // the order they happened.
  const timeline: string[] = [];
  const innerExec = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
  (fixture.ctx.transport as { exec: typeof innerExec }).exec = async (command: string, args: string[], options: unknown) => {
    const composeCall: RecordedCall = { command, args: [...args] };
    if ((command === "docker" || (command === "sh" && args[2] === "recipe-docker")) && composeCall.args.includes("down")) timeline.push("down");
    if (command === "rm" && args[0] === "-rf") timeline.push(`remove:${args[args.length - 1]}`);
    return innerExec(command, args as string[], options as never);
  };

  let error = "";
  try {
    await runTrialAction(fixture.ctx, ref("subject"));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  check("the run succeeds — compose down found its pinned document", error, "");
  checkTrue("the pinned document was written into the scratch home",
    fixture.privateWrites.some((path) => path.endsWith("pinned-compose.json")));
  checkTrue("the scratch home was removed", fixture.removed.some((path) => path.includes(".clawforge-recipe-trial-")));
  const downIndex = timeline.indexOf("down");
  const homeRemoveIndex = timeline.findIndex((entry) => entry.startsWith("remove:") && entry.includes(".clawforge-recipe-trial-"));
  checkTrue("compose down ran", downIndex >= 0);
  checkTrue("the scratch-home removal ran", homeRemoveIndex >= 0);
  checkTrue("compose down ran BEFORE the scratch-home removal (LIFO: first registered, removed last)",
    downIndex < homeRemoveIndex);
} finally {
  await root.dispose();
}

finish("recipe-trial-round3-lifo-order");
