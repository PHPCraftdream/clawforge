// Teardown on EVERY outcome: success, build failure, up failure, readiness death and a
// plain thrown error must all leave the fake transport having seen compose down
// --volumes --remove-orphans --rmi local scoped to the trial project plus the scratch-home
// removal — never any live project name. A failing teardown is reported with the exact
// leftover project and path, and a leftover-labelled image is named by ID.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { captured, ref, trialFixture, useRecipesRoot } from "../fixture.ts";

const root = await useRecipesRoot("clawwright-recipe-trial-teardown");
/** The live project the recipe WOULD have — the string that must appear in no teardown argv. */
const LIVE = `clawwright-recipe-${"a".repeat(0)}live-name-control`;

async function outcome(fixture: ReturnType<typeof trialFixture>, name: string): Promise<{ error: string; output: string[] }> {
  const run = await captured(async () => {
    try { await runTrialAction(fixture.ctx, ref(name)); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
  });
  return { error: run.result!, output: run.chunks };
}

function trialProject(fixture: ReturnType<typeof trialFixture>): string {
  const argv = fixture.docker.find((entry) => entry.includes("--project-name"));
  return argv?.[argv.indexOf("--project-name") + 1] ?? "";
}

function checkTeardown(name: string, fixture: ReturnType<typeof trialFixture>): void {
  const project = trialProject(fixture);
  checkTrue(`${name}: the trial project was derived`, project.startsWith("clawwright-recipe-trial-"));
  const downs = fixture.docker.filter((argv) => argv[0] === "compose" && argv.includes("down"));
  check(`${name}: exactly one compose down ran`, downs.length, 1);
  const down = downs[0] ?? [];
  checkTrue(`${name}: the down is scoped to the trial project`,
    down.includes("--project-name") && down[down.indexOf("--project-name") + 1] === project);
  check(`${name}: the down flags are exactly volumes+orphans+local-rmi`,
    down.slice(down.indexOf("down")), ["down", "--volumes", "--remove-orphans", "--rmi", "local"]);
  checkTrue(`${name}: the images filter is labelled for the trial project`,
    fixture.docker.some((argv) => argv.includes(`label=com.docker.compose.project=${project}`)));
  check(`${name}: the scratch home was removed`, fixture.removed.filter((p) => p.includes(".clawwright-recipe-trial-")).length, 1);
  checkTrue(`${name}: no teardown argv carries a live project name`,
    fixture.docker.every((argv) => !argv.includes(LIVE) && !argv.some((arg) => arg.startsWith("clawwright-recipe-2") || arg === "clawwright-recipe-live")));
}

try {
  await root.write("subject", { description: "A recipe to tear down" });
  await root.write("never-ready", {
    description: "A recipe that dies in readiness",
    readiness: { services: ["app"], timeoutMs: 1000 },
  });

  // --- success ---------------------------------------------------------------------------------

  {
    const fixture = trialFixture();
    const result = await outcome(fixture, "subject");
    check("success: the run throws nothing", result.error, "");
    checkTeardown("success", fixture);
  }

  // --- build failure -----------------------------------------------------------------------------

  {
    const fixture = trialFixture();
    fixture.failBuild = true;
    const result = await outcome(fixture, "subject");
    checkTrue("build failure: the run dies with the docker failure", /Docker.operation.failed/.test(result.error));
    checkTeardown("build failure", fixture);
  }

  // --- evidence collection failure preserves the start failure and masks diagnostics ----------------
  {
    const fixture = trialFixture();
    fixture.failBuild = true;
    fixture.failEvidenceTransport = true;
    const result = await outcome(fixture, "subject");
    checkTrue("build failure remains the primary error", /trial.build.or.start.failed/.test(result.error) && /Docker.operation.failed/.test(result.error));
    checkTrue("evidence transport failure is disclosed", /fixture.evidence.transport/.test(result.error));
    checkTrue("evidence transport secret is masked", !result.error.includes("trial-secret-env"));
    checkTeardown("evidence transport failure", fixture);
  }

  // --- successful evidence collection masks process diagnostics ----------------------------------
  {
    const fixture = trialFixture();
    fixture.failBuild = true;
    fixture.failPsSecret = true;
    const result = await outcome(fixture, "subject");
    checkTrue("failure evidence includes masked ps row", result.error.includes("fixture-ps-user") && !result.error.includes("fixture-ps-secret"));
    checkTeardown("evidence ps diagnostics", fixture);
  }

  // --- up failure (error thrown after build, mid-body) ---------------------------------------------

  {
    const fixture = trialFixture();
    // Make up fail after build succeeded: compose up carries --detach, build does not.
    fixture.docker.length = 0;
    const original = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
    const intercept = fixture.ctx.transport as { exec: typeof original };
    intercept.exec = async (command, args, options) => {
      const result = await original(command, args, options);
      // Fail the compose up (config evaluation also runs compose twice, read-only, before
      // the build, so compose calls are not counted — the up is matched directly).
      if (command === "sh" && args[2] === "recipe-docker" && args[3] === "compose" && args.includes("up")) {
        return { code: 1, stdout: "", stderr: "fixture up failure" };
      }
      return result;
    };
    const result = await outcome(fixture, "subject");
    checkTrue("up failure: the run dies with the docker failure", /Docker.operation.failed/.test(result.error));
    checkTrue("up failure: build had succeeded before the failure", fixture.docker.some((argv) => argv.includes("build")));
    checkTeardown("up failure", fixture);
  }

  // --- readiness death (die inside the body) --------------------------------------------------------

  {
    const fixture = trialFixture();
    fixture.serviceStates = { app: { running: false } };
    const result = await outcome(fixture, "never-ready");
    checkTrue("readiness death: the run dies naming the state", /did.not.reach.a.ready.state/.test(result.error));
    checkTeardown("readiness death", fixture);
  }

  // --- teardown failure reporting --------------------------------------------------------------------

  {
    const fixture = trialFixture();
    fixture.failDown = true;
    const result = await outcome(fixture, "subject");
    const project = trialProject(fixture);
    checkTrue("failing down: the leftover project is named exactly", result.error.includes(project));
    checkTrue("failing down: the scratch home is named exactly",
      result.error.includes(fixture.removed[0] ?? ""));
    checkTrue("failing down: the original down stderr surfaces", result.output.some((chunk) => /fixture.compose.down.failure/.test(chunk)));
    check("failing down: remove of the home was still attempted", fixture.removed.length, 1);
  }

  {
    const fixture = trialFixture();
    fixture.leftoverImages = "abc123def456\n";
    const result = await outcome(fixture, "subject");
    checkTrue("leftover images: the labelled-image branch reports the image IDs",
      result.output.some((chunk) => /images.labelled.for.trial.project/.test(chunk) && chunk.includes("abc123def456")));
    checkTrue("leftover images: the run still refuses with the leftover summary", /teardown.left.resources.behind/.test(result.error));
    checkTeardown("leftover images", fixture);
  }
} finally {
  await root.dispose();
}

finish("recipe-trial-teardown");
