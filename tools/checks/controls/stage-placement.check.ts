// The stage-placement pin the pipeline property sweep cannot carry for `destroy`: its sweep
// case dies in `run` on a fixture transport error, which masks where the --confirm-name VALUE
// refusal actually sits (R18-11). The value match against the deployment's own name is judged
// at prepare — before the context, the lock and the target — never after the context, in run.

import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError } from "#framework/core/command/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const fixture = await createDeploymentFixture();
try {
  const app: AppDefinition = { name: "stage-placement-fixture", description: "fixture", commands: { destroy: openclawCommands.destroy } };
  let output = "";
  const execution = await withOutputSink((chunk) => {
    output += chunk;
  }, () => executeCommand(app, "destroy", ["--yes", "--confirm-name", "not-this-deployment"], { surface: "mcp", confirmed: true, transport: fixture.transport() }));
  check("destroy refuses a wrong --confirm-name value at the prepare stage", execution.stage, "prepare");
  checkTrue("the refusal is an ArgumentError naming the argument", execution.error instanceof ArgumentError && (execution.error as ArgumentError).argument === "confirm-name");
  check("nothing ran: no document, no transport contact", [output, fixture.contacts().length], ["", 0]);
} finally {
  await fixture.dispose();
}
finish("controls: stage placement — destroy's --confirm-name value refusal sits at prepare");
