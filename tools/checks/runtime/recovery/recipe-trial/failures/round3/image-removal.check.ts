// Round 3, per-tag image removal independence and the absence-proof shape. Two build
// services: the FIRST tag's `image rm` fails AND its inspect answers with a
// daemon-unreachable stderr (the UNKNOWN shape) — the run must report a leftover naming
// that first tag while still removing the second tag. Separately: rm succeeding with
// inspect exit 1 "No such image" is accepted, while the same inspect code carrying a
// different stderr reports the tag as a leftover. The pre-round-3 build-tag isolation
// block (formerly failures/build-tags.check.ts) lives here too: it failed against the
// one-step removal this file covers.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { captured, ref, trialFixture, trialHashFor, useRecipesRoot } from "../../fixture.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";

const TWO_SERVICES = {
  api: { build: { context: "." }, ports: [{ mode: "ingress", host_ip: "", target: 8080, published: "8080", protocol: "tcp" }] },
  worker: { build: { context: "." } },
};


async function runCaptured(fixture: ReturnType<typeof trialFixture>): Promise<{ output: string; thrown: string }> {
  const { chunks, result } = await captured(async () => {
    try {
      await runTrialAction(fixture.ctx, ref("subject"));
      return { thrown: "" };
    } catch (error) {
      return { thrown: error instanceof Error ? error.message : String(error) };
    }
  });
  return { output: chunks.join(""), thrown: result.thrown };
}

const root = await useRecipesRoot("clawforge-recipe-trial-image-rm");
try {
  await root.write("subject", { description: "A recipe with two build services" });

  // --- independence: the first tag fails, the second is still removed -----------------------
  {
    const fixture = trialFixture();
    fixture.baseConfigJson = JSON.stringify({ services: TWO_SERVICES });
    fixture.mergedConfigJson = null;
    fixture.failFirstImageRm = true;
    let failedTag: string | undefined;
    const innerExec = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
    (fixture.ctx.transport as { exec: typeof innerExec }).exec = async (command: string, args: string[], options: unknown) => {
      if (command === "docker" && args[0] === "image" && args[1] === "rm") {
        if (failedTag === undefined) {
          failedTag = args[3];
          fixture.failInspectTags = [failedTag]; // the failed removal's inspect is UNKNOWN
        }
      }
      return innerExec(command, args as string[], options as never);
    };
    const { output, thrown } = await runCaptured(fixture);
    const tags = fixture.docker.filter((argv) => argv[0] === "image" && argv[1] === "rm").map((argv) => argv[3]);
    checkTrue("both tags' rm argv were recorded", tags.length === 2 && new Set(tags).size === 2);
    checkTrue("the leftover is reported naming the FIRST tag (output and refusal)",
      failedTag !== undefined && `${output}\n${thrown}`.includes(failedTag));
    checkTrue("the second tag's absence proof still ran (inspect after its rm)",
      fixture.docker.some((argv) => argv[0] === "image" && argv[1] === "inspect" && argv[2] !== undefined && argv[2] !== failedTag));
  }

  // --- the absence-proof shape: rm ok + inspect "No such image" at exit 1 is accepted -------
  {
    const fixture = trialFixture();
    fixture.baseConfigJson = JSON.stringify({ services: TWO_SERVICES });
    fixture.mergedConfigJson = null;
    const { thrown } = await runCaptured(fixture);
    checkTrue("a clean removal (inspect exit 1 with the No-such-image evidence) succeeds", thrown === "");
    checkTrue("the inspect absence proof ran per tag",
      fixture.docker.filter((argv) => argv[0] === "image" && argv[1] === "inspect").length === 2);
  }

  // --- a DIFFERENT stderr at the same exit code is a leftover, never success ---------------
  {
    const fixture = trialFixture();
    fixture.baseConfigJson = JSON.stringify({ services: TWO_SERVICES });
    fixture.mergedConfigJson = null;
    let firstTag: string | undefined;
    let intercepted = false;
    const innerExec = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
    (fixture.ctx.transport as { exec: typeof innerExec }).exec = async (command: string, args: string[], options: unknown) => {
      if (!intercepted && command === "docker" && args[0] === "image" && args[1] === "inspect") {
        intercepted = true;
        firstTag = args[2];
        fixture.docker.push([...args]);
        return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" } as ExecResult;
      }
      return innerExec(command, args as string[], options as never);
    };
    const { output, thrown } = await runCaptured(fixture);
    checkTrue("a daemon-unreachable inspect is a leftover naming the tag",
      firstTag !== undefined && `${output}\n${thrown}`.includes(firstTag));
    checkTrue("the ambiguous inspect refuses the run", /teardown\x20left\x20resources\x20behind|remain|unknown/.test(`${output}\n${thrown}`));
  }
} finally {
  await root.dispose();
}

// --- build-tag isolation (moved from failures/build-tags.check.ts) -------------------------
{
  await root.write("built", { description: "A recipe whose base compose builds its image" });
  const LIVE_TAG = "nginx:1.25";
  const fixture = trialFixture();
  fixture.baseConfigJson = JSON.stringify({ services: {
    builder: { image: LIVE_TAG, build: { context: "." }, ports: [{ mode: "ingress", host_ip: "", target: 8080, published: "8080", protocol: "tcp" }] },
    db: { image: "postgres" },
  } });
  let outcome = "";
  try { await runTrialAction(fixture.ctx, ref("built")); } catch (error) { outcome = error instanceof Error ? error.message : String(error); }
  check("the build-service trial succeeds", outcome, "");

  const home = fixture.mkdirPrivateCalls[0] ?? "";
  const overrideDoc = fixture.files.get(`${home}/override.yml`) ?? "";
  const SP4 = String.fromCharCode(32, 32, 32, 32);
  const imageLine = new RegExp("^" + SP4 + "image: (clawforge-recipe-trial-build-[0-9a-f]{12}-[0-9a-f]{8}--builder)$", "m").exec(overrideDoc);
  checkTrue("the override sets image: for the build service to a trial build tag", imageLine !== null || fixture.docker.some((argv) => argv.at(-1)?.startsWith("clawforge-recipe-trial-build-") && argv.at(-1)?.endsWith("--builder")));
  let recordedTag = imageLine?.[1] ?? "";
  if (recordedTag === "") {
    for (const argv of fixture.docker) {
      const candidate = argv.at(-1) ?? "";
      if (candidate.startsWith("clawforge-recipe-trial-build-") && candidate.endsWith("--builder")) recordedTag = candidate;
    }
  }
  checkTrue("the trial tag carries the recipe's hash prefix",
    recordedTag.startsWith(`clawforge-recipe-trial-build-${trialHashFor("built")}-`));

  checkTrue("no docker argv carries the base config's original image tag",
    fixture.docker.every((argv) => !argv.includes(LIVE_TAG)));
  checkTrue("no written file carries the base config's original image tag",
    [...fixture.privateFiles.values()].every((content) => !content.includes(LIVE_TAG)));

  const removals = fixture.docker.filter((argv) => argv[0] === "image" && argv[1] === "rm" && argv[2] === "--force");
  check("teardown removes exactly the recorded tags", removals.map((argv) => argv[3]), [recordedTag]);
  checkTrue("the down keeps --rmi local", fixture.docker.some((argv) => argv.includes("--rmi") && argv.includes("local")));
  checkTrue("the labelled-image check still ran for the trial project",
    fixture.docker.some((argv) => argv.some((arg) => arg.startsWith("label=com.docker.compose.project=clawforge-recipe-trial-"))));
}

finish("recipe-trial-round3-image-removal");
