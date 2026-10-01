// A destructive command that declares requiresConfirmationWhen without readOnlyWhen asks
// for confirmation only on some calls, so every profile-derived surface reads it as
// "destructive for some actions" — never as the flat always-destroys wording. Before the
// effect-profile rule the markers and the confirm schema read the raw fields and showed
// " !", "(destructive)", "This command replaces or destroys state." and "Must be true:
// destroys state" for exactly this shape. None of the framework's own commands has it
// (every destructive one refines with readOnlyWhen too), so the golden snapshots do not
// cover it — this synthetic declaration does.

import type { AppCommand } from "#framework/core/app.ts";
import { destructiveMarker, destructiveSymbol, renderFullCommandHelp } from "#framework/core/io/help-render.ts";
import { inputSchema } from "#framework/integration/mcp/schema.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const command: AppCommand = {
  summary: "Apply the queued change to the deployment",
  run: async () => {},
  destructive: true,
  requiresConfirmationWhen: (args) => args.includes("--apply"),
  arguments: [{ name: "apply", description: "Apply the queued change", kind: "flag" }],
};

check("list marker is `*`, not the flat `!`", destructiveSymbol(command), " *");
check("tool description marker names the some-actions form", destructiveMarker(command), " (destructive for some actions)");

const schema = inputSchema(command);
const confirm = (schema.properties as Record<string, { description?: string } | undefined>).confirm;
const required = schema.required as string[];
check("confirm reads as advice, not a hard requirement", confirm?.description, "Confirm a destructive action");
checkTrue("confirm is not in required", !required.includes("confirm"));

let help = "";
await withOutputSink((chunk) => {
  help += chunk;
}, async () => renderFullCommandHelp("apply-queued", command));
checkTrue("--help note says the effect depends on the flags given", help.includes("depending on the flags given"));
checkTrue("--help note does not claim every call destroys", !help.includes("replaces or destroys state."));

finish("effect markers and confirm schema for a partly-destructive command");
