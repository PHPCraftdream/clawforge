// Round 3, hung cleanup step: the FIRST per-tag image inspect never resolves (a transport
// exec that answers with a forever-pending promise). The teardown must abandon that step
// at its deadline, record it as a leftover naming the tag, still run the steps AFTER it
// (the later tag's removal, the labelled-image check, the scratch-home removal), and end
// the run non-zero. The check bounds its own wait so it fails rather than hangs on the
// pre-race code.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { checkTrue, finish } from "#checks/kit/harness.ts";
import { ref, captured, messageOf, trialFixture, useRecipesRoot } from "../../fixture.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";

// Test seam: the check needs the timeout BEHAVIOUR, not the 60 s wait; product default unchanged.
process.env.OC_TRIAL_TEARDOWN_TIMEOUT_MS = "1000";

const root = await useRecipesRoot("clawforge-recipe-trial-hang");
/** The check-side ceiling: above the product's own per-step teardown deadline, so the
 *  race wins and the check passes; below it, the old timer-only code would hang here. */
const CHECK_BUDGET_MS = 180_000;
try {
  await root.write("subject", { description: "A recipe with two build services" });
  const fixture = trialFixture();
  fixture.baseConfigJson = JSON.stringify({ services: {
    api: { build: { context: "." }, ports: [{ mode: "ingress", host_ip: "", target: 8080, published: "8080", protocol: "tcp" }] },
    worker: { build: { context: "." } },
  } });

  // The first tag whose rm is attempted hangs on its inspect.
  let hangTag: string | undefined;
  const innerExec = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
  (fixture.ctx.transport as { exec: typeof innerExec }).exec = async (command: string, args: string[], options: unknown) => {
    if (command === "docker" && args[0] === "image" && args[1] === "rm" && hangTag === undefined) {
      hangTag = args[3];
    }
    if (command === "docker" && args[0] === "image" && args[1] === "inspect" && args[2] === hangTag) {
      return new Promise<ExecResult>(() => {});
    }
    return innerExec(command, args as string[], options as never);
  };

  const started = Date.now();
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const run = (): Promise<void> => Promise.race([
    runTrialAction(fixture.ctx, ref("subject")),
    new Promise<never>((_, reject) => { budgetTimer = setTimeout(() => reject(new Error(`CHECK${String.fromCharCode(32)}TIMED${String.fromCharCode(32)}OUT: the run never finished despite a hung cleanup step`)), CHECK_BUDGET_MS); budgetTimer?.unref(); }),
  ]).then(() => undefined);
  const { chunks, result } = await captured(async () => ({ thrown: await messageOf("the hung-step run", run) }));
  const runError = `${chunks.join("")}\n${result.thrown}`;
  checkTrue("the run finished within the check's budget despite the hung step",
    !runError.includes(`CHECK${String.fromCharCode(32)}TIMED${String.fromCharCode(32)}OUT`));
  checkTrue("the leftover is reported naming the hung tag",
    hangTag !== undefined && runError.includes(hangTag));
  checkTrue("the run ends non-zero (teardown left resources behind)", /teardown\x20left\x20resources\x20behind/.test(runError));
  checkTrue("the hung tag is the FIRST tag", fixture.docker.some((argv) => argv[0] === "image" && argv[1] === "rm" && argv[3] === hangTag));
  // The steps AFTER the hung one still ran: the second tag's inspect answered the absence
  // proof, the labelled-image query ran, and the scratch home came down.
  const inspectTags = fixture.docker.filter((argv) => argv[0] === "image" && argv[1] === "inspect").map((argv) => argv[2]);
  checkTrue("the other build tag's removal still ran with its own inspect absence proof",
    inspectTags.some((tag) => tag !== undefined && tag !== hangTag));
  checkTrue("the labelled-image query still ran after the hung step",
    fixture.docker.some((argv) => argv[0] === "images" && argv.some((entry) => entry.includes("label="))));
  checkTrue("the scratch home was still removed after the hung step",
    fixture.removed.some((path) => path.includes(".clawforge-recipe-trial-")));
  checkTrue("the whole affair stayed bounded", Date.now() - started < CHECK_BUDGET_MS);
} finally {
  await root.dispose();
}

finish("recipe-trial-round3-hung-step");
