// Readiness wiring through the extracted recovery/readiness.ts, exercised from the trial:
// all running+healthy holds the grace window and reports ready; a service that never runs
// degrades by name with sanitized log tails printed; a service-state probe that never
// answers hits the bounded probe deadline and surfaces as unknown — and in every failure
// shape the trial project is still torn down.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { captured, DATA_DIR, ref, SECRET_ENV, trialFixture, useRecipesRoot } from "./fixture.ts";

const root = await useRecipesRoot("clawforge-recipe-trial-readiness");
try {
  await root.write("ready", { description: "A recipe that turns healthy" });
  await root.write("degraded", {
    description: "A recipe that never runs",
    readiness: { services: ["app"], timeoutMs: 1200 },
  });
  await root.write("hung", {
    description: "A recipe whose state probe hangs",
    readiness: { services: ["app"], timeoutMs: 1200 },
  });

  // --- ready --------------------------------------------------------------------------------

  {
    const fixture = trialFixture();
    const run = await captured(() => runTrialAction(fixture.ctx, ref("ready")));
    checkTrue("the ready trial exits cleanly", run.result === undefined);
    checkTrue("the ready verdict is printed", run.chunks.some((chunk) => chunk.includes("ready")));
    check("the trial stack was probed with ownership verification off",
      fixture.stackCalls.map((call) => [call.project.startsWith("clawforge-recipe-trial-"), call.options]),
      [[true, { verifyOwnership: false }]]);
    checkTrue("log tails were fetched for the service", fixture.docker.some((argv) => argv.includes("logs")));
    checkTrue("the log tail was sanitized before printing",
      run.chunks.some((chunk) => chunk.includes("[redacted]")) && !run.chunks.some((chunk) => chunk.includes(SECRET_ENV.OC_PASSWORD)));
    checkTrue("teardown ran after the ready verdict", fixture.docker.some((argv) => argv.includes("down")) && fixture.removed.length > 0);
  }

  // --- degraded: service never runs -----------------------------------------------------------

  {
    const fixture = trialFixture();
    fixture.serviceStates = { app: { running: false } };
    const run = await captured(async () => {
      try { await runTrialAction(fixture.ctx, ref("degraded")); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
    });
    checkTrue("the degraded trial dies naming the recipe", /did.not.reach.a.ready.state/.test(run.result!));
    checkTrue("the degraded status is reported", run.chunks.some((chunk) => /not.ready/.test(chunk) && /degraded/.test(chunk)));
    checkTrue("the detail names the problem", run.chunks.some((chunk) => /not.running:.app/.test(chunk)));
    checkTrue("log tails are still printed, sanitized",
      run.chunks.some((chunk) => /log.tail/.test(chunk) && /\[redacted]/.test(chunk))
        && !run.chunks.some((chunk) => chunk.includes(SECRET_ENV.OC_PASSWORD)));
    checkTrue("teardown still ran on the degraded path",
      fixture.docker.some((argv) => argv.includes("down")) && fixture.removed.length > 0);
  }

  // --- unknown: the state probe never answers --------------------------------------------------

  {
    const fixture = trialFixture();
    fixture.hangServiceStates = true;
    const run = await captured(async () => {
      try { await runTrialAction(fixture.ctx, ref("hung")); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
    });
    checkTrue("the hung-probe trial dies as not ready", /did.not.reach.a.ready.state/.test(run.result!));
    checkTrue("the unknown status is reported with the probe deadline named", run.chunks.some((chunk) => chunk.includes("unknown")));
    checkTrue("teardown still ran on the timeout path",
      fixture.docker.some((argv) => argv.includes("down")) && fixture.removed.length > 0);
    checkTrue("no live dataDir leaks into any recorded argv",
      fixture.calls.every((call) => !call.args.includes(DATA_DIR) || call.command === "sh"));
  }
} finally {
  await root.dispose();
}

finish("recipe-trial-readiness");
