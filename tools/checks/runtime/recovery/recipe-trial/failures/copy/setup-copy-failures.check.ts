// Failures between the first scratch mutation and the build: a private write that throws on
// the SECOND write (the override.yml — compose.env already succeeded) and a copy exec that
// returns nonzero must both refuse AND still tear the scratch home down, with no docker
// build or up ever reaching the target.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { messageOf, ref, trialFixture, useRecipesRoot } from "../../fixture.ts";

const root = await useRecipesRoot("clawwright-recipe-trial-setup-copy-failures");
try {
  await root.write("subject", { description: "A recipe with declared privatePaths", privatePaths: ["state"] });

  // --- the second private write throws ---------------------------------------------------------

  {
    const fixture = trialFixture();
    const transport = fixture.ctx.transport as { exec: (command: string, args: string[], options?: Parameters<typeof fixture.ctx.transport.exec>[2]) => Promise<ExecResult> };
    const original = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
    let writes = 0;
    transport.exec = async (command, args, options): Promise<ExecResult> => {
      if (command === "sh" && args[0] === "-c" && args[1]?.includes("ln -T")) {
        writes += 1;
        if (writes === 2) throw new Error("fixture private write failure");
      }
      return original(command, args, options);
    };
    const message = await messageOf("a failing second private write refuses the run", () =>
      runTrialAction(fixture.ctx, ref("subject")));
    checkTrue("the refusal surfaces the write failure", /fixture.private.write.failure/.test(message));
    checkTrue("the scratch home is still removed", fixture.removed.some((p) => p.includes(".clawwright-recipe-trial-")));
    checkTrue("nothing was built", fixture.docker.every((argv) => !argv.includes("build")));
    checkTrue("nothing was started", fixture.docker.every((argv) => !argv.includes("up")));
    check("exactly one private write landed before the failure", writes, 2);
  }

  // --- the copy exec returns nonzero -------------------------------------------------------------

  {
    const fixture = trialFixture();
    const transport = fixture.ctx.transport as { exec: (command: string, args: string[], options?: Parameters<typeof original>[2]) => Promise<ExecResult> };
    const original = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
    transport.exec = async (command: string, args: string[], options?: Parameters<typeof original>[2]): Promise<ExecResult> => {
      const result = await original(command, args, options);
      if (command === "sh" && args[2] === "recipe-trial-copy") {
        return { code: 1, stdout: "", stderr: "fixture copy failure" };
      }
      return result;
    };
    const message = await messageOf("a failing copy exec refuses the run", () =>
      runTrialAction(fixture.ctx, ref("subject")));
    checkTrue("the refusal names the copy failure", /could.not.copy.privatePaths/.test(message));
    checkTrue("the refusal carries the copy's stderr", /fixture.copy.failure/.test(message));
    checkTrue("the scratch home is still removed", fixture.removed.some((p) => p.includes(".clawwright-recipe-trial-")));
    checkTrue("nothing was built", fixture.docker.every((argv) => !argv.includes("build")));
    checkTrue("nothing was started", fixture.docker.every((argv) => !argv.includes("up")));
    check("the copy ran once", fixture.copyArgv.length, 1);
  }
} finally {
  await root.dispose();
}

finish("recipe-trial-setup-copy-failures");
