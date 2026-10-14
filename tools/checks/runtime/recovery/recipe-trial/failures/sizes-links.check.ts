// Fail-closed sizing and the symlink audit: a du line missing for a present path, a failing
// du, an unreadable path (probe nonzero WITH stderr) and a known-over-bound total alongside
// an unknown path all refuse; a genuinely absent path is skipped (bytes null) and the run
// proceeds. The symlink audit refuses absolute targets and relative escapes by name and
// allows an in-tree relative link through to the copy.

import { runTrialDryRun, runTrialAction, TRIAL_PRIVATE_PATHS_BOUND_BYTES } from "#framework/commands/management/recipe/recovery/trial/index.ts";

import type { ExecResult } from "#framework/runtime/transport/transport.ts";

import { withOutputSink } from "#framework/core/io/output.ts";

import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { DATA_DIR, messageOf, ref, trialFixture, useRecipesRoot, type TrialFixture } from "../fixture.ts";



const root = await useRecipesRoot("clawforge-recipe-trial-sizes-links");
const MIB = 1024 * 1024;

/** Wraps the fixture transport's exec so `adaptFn` can rewrite specific answers while
 *  everything else passes through untouched. */
function adapt(fixture: TrialFixture, adaptFn: (command: string, args: string[], result: ExecResult) => ExecResult): void {
  const transport = fixture.ctx.transport as { exec: (command: string, args: string[], options?: unknown) => Promise<ExecResult> };
  const original = transport.exec.bind(transport);
  transport.exec = async (command, args, options) => adaptFn(command, args, await original(command, args, options));
}

try {
  await root.write("sized", { description: "A recipe with two declared privatePaths", privatePaths: ["state", "blobs"] });
  await root.write("linked", { description: "A recipe with one declared privatePath", privatePaths: ["state"] });

  // --- one present path's du line is missing ------------------------------------------------------

  {
    const fixture = trialFixture();
    adapt(fixture, (command, args, result) => {
      if (command === "sh" && args[2] === "recipe-trial-size") {
        const paths = args.slice(3).filter((p) => p !== `${DATA_DIR}/state`);
        return { code: 0, stdout: paths.map((p) => `512\t${p}`).join("\n"), stderr: "" };
      }
      return result;
    });
    const message = await messageOf("a missing du line for a present path refuses", () =>
      runTrialAction(fixture.ctx, ref("sized")));
    check("first size refusal", message.includes(`${DATA_DIR}/state`), true);
    checkTrue("size is unknown", /could.not.be.measured/.test(message));
    check("side effects", [fixture.docker.length, fixture.privateWrites.length], [0, 0]);
  }

  // --- du fails entirely -----------------------------------------------------------------------------

  {
    const fixture = trialFixture();
    adapt(fixture, (command, args, result) =>
      command === "sh" && args[2] === "recipe-trial-size"
        ? { code: 1, stdout: "", stderr: "fixture du failure" }
        : result);
    const message = await messageOf("a failing du refuses", () => runTrialAction(fixture.ctx, ref("sized")));
    checkTrue("size collection failed", /could.not.be.measured/.test(message));
    checkTrue("both declared paths are named", message.includes(`${DATA_DIR}/state`) && message.includes(`${DATA_DIR}/blobs`));
  }

  // --- present but unreadable (the existsVia probe reports a blocked traversal) ------------------------

  {
    const fixture = trialFixture();
    adapt(fixture, (command, args, result) =>
      command === "sh" && args[0] === "-s"
        ? { code: 0, stdout: `blocked ${DATA_DIR}/state\n`, stderr: "" }
        : result);
    const message = await messageOf("an unreadable path refuses instead of skipping", () =>
      runTrialAction(fixture.ctx, ref("sized")));
    checkTrue("unreadable path", message.includes(`${DATA_DIR}/state`));
    checkTrue("size is unknown", /could.not.be.measured/.test(message));
  }

  // --- known total over the bound ALONGSIDE an unknown path ---------------------------------------------

  {
    const fixture = trialFixture();
    adapt(fixture, (command, args, result) => {
      if (command === "sh" && args[2] === "recipe-trial-size") {
        return { code: 0, stdout: `${300 * MIB}\t${DATA_DIR}/state\n`, stderr: "" };
      }
      return result;
    });
    const message = await messageOf("an over-bound total beside an unknown path still fails closed", () =>
      runTrialAction(fixture.ctx, ref("sized")));
    checkTrue("unknown path precedes bound", message.includes(`${DATA_DIR}/blobs`));
    checkTrue("unmeasured priority", /could.not.be.measured/.test(message));
    checkTrue("bound not reached", !message.includes(String(TRIAL_PRIVATE_PATHS_BOUND_BYTES)));
  }

  // --- known over-bound control without unknown paths -----------------------------------------------------
  {
    const fixture = trialFixture();
    await root.write("over", { description: "Known over-bound data", privatePaths: ["state"] });
    fixture.duSizes.set(`${DATA_DIR}/state`, 300 * MIB);
    const message = await messageOf("a known over-bound total refuses on bound wording", () => runTrialAction(fixture.ctx, ref("over")));
    checkTrue("known bound refusal", message.includes(String(TRIAL_PRIVATE_PATHS_BOUND_BYTES)));
    check("measured byte count", message.includes("314572800"), true);
  }

  // --- genuinely absent path: errno-aware presence probe -------------------------------------------------

  {
    const fixture = trialFixture();
    fixture.absentPaths.push(`${DATA_DIR}/blobs`);
    const inner = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
    fixture.ctx.transport.exec = async (command, args, options) => {
      if (command === "sh" && args[0] === "-s") {
        const path = args[3];
        const result = await inner(command, args, options);
        if (path === `${DATA_DIR}/blobs`) return { ...result, stdout: "absent\n" };
        return result;
      }
      return inner(command, args, options);
    };
    const capturedOutput: string[] = [];
    await withOutputSink((chunk) => capturedOutput.push(chunk), () => runTrialDryRun(fixture.ctx, ref("sized")));
    const report = JSON.parse(capturedOutput.find((line) => line.startsWith("{")) ?? "{}") as { privatePaths?: Array<{ entry: string; bytes: number | null; state: string }> };
    const firstPath = report.privatePaths?.find((entry) => entry.entry === `${DATA_DIR}/blobs`);
    check("absence fields", [firstPath !== undefined, firstPath?.bytes, firstPath?.state], [true, null, "absent"]);
    checkTrue("absent path omitted", !fixture.calls.some((call) => call.command === "sh" && call.args[2] === "recipe-trial-size" && call.args.includes(`${DATA_DIR}/blobs`)));
    checkTrue("dry-run absence", capturedOutput.some((line) => line.includes("absent")));
  }

  // --- symlink audit: absolute target ------------------------------------------------------------------

  {
    const fixture = trialFixture();
    adapt(fixture, (command, args, result) =>
      command === "sh" && args[2] === "recipe-trial-symlinks"
        ? { code: 0, stdout: `${DATA_DIR}/state\t/etc/passwd\n`, stderr: "" }
        : result);
    const message = await messageOf("an absolute symlink target refuses", () =>
      runTrialAction(fixture.ctx, ref("linked")));
    checkTrue("absolute-link refusal", message.includes(`${DATA_DIR}/state`));
    checkTrue("absolute target refusal", /absolute.target/.test(message) && message.includes("/etc/passwd"));
    check("pre-copy refusal", fixture.copyArgv.length, 0);
  }

  // --- symlink audit: relative escape ------------------------------------------------------------------

  {
    const fixture = trialFixture();
    adapt(fixture, (command, args, result) =>
      command === "sh" && args[2] === "recipe-trial-symlinks"
        ? { code: 0, stdout: `${DATA_DIR}/state\t../../outside\n`, stderr: "" }
        : result);
    const message = await messageOf("a relative symlink escape refuses", () =>
      runTrialAction(fixture.ctx, ref("linked")));
    checkTrue("relative escape refusal", message.includes(`${DATA_DIR}/state`));
    checkTrue("escape refusal", /escapes.the.declared.path/.test(message) && message.includes("../../outside"));
    check("pre-copy refusal", fixture.copyArgv.length, 0);
  }

  // --- symlink audit: in-tree relative link is allowed ---------------------------------------------------

  {
    const fixture = trialFixture();
    adapt(fixture, (command, args, result) =>
      command === "sh" && args[2] === "recipe-trial-symlinks"
        ? { code: 0, stdout: `${DATA_DIR}/state\t./state/db/keep\n`, stderr: "" }
        : result);
    let outcome = "";
    try { await runTrialAction(fixture.ctx, ref("linked")); } catch (error) { outcome = error instanceof Error ? error.message : String(error); }
    check("in-tree link", outcome, "");
    check("copy invocation", fixture.copyArgv.length, 1);
  }
} finally {
  await root.dispose();
}

finish("recipe-trial-sizes-links");
