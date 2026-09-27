// `./clawforge expose` — the dispatcher (unknown/missing action, routing to the right
// sub-handler) and the AppCommand wiring: readOnlyWhen/changedWhen/requiresConfirmationWhen
// agree with exposeActionIsReadOnly, the declared arguments are well formed, and the MCP
// schema/argv round trip matches every other command's contract.

import { expose, exposeActionIsReadOnly } from "#framework/expose/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { inputSchema, toArgv, validate } from "#framework/integration/mcp-server.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

async function deathOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

// --- dispatch: bad input dies before anything runs ----------------------------------------------

check("no action at all is a usage error", (await deathOf(() => expose({} as unknown as Context, []))).includes("usage:"), true);
check("an unknown action is refused by name", (await deathOf(() => expose({} as unknown as Context, ["bogus"]))).includes("unknown action: bogus"), true);
check("the refusal names the three valid actions", (await deathOf(() => expose({} as unknown as Context, ["bogus"]))).includes("ssh, tailscale or status"), true);

// --- dispatch: routes to the matching sub-handler, and nothing else -----------------------------
// Cheap ctx/args per action so this proves ROUTING without duplicating ssh.check.ts/
// tailscale.check.ts/status.check.ts's own behavioural coverage.

{
  const ctx = { settings: { location: "wsl" }, transport: { description: "wsl:Ubuntu-24.04" } } as unknown as Context;
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => expose(ctx, ["ssh"]));
  check("expose ssh reaches exposeSsh", written.join("").includes("no SSH tunnel needed"), true);
}

{
  const ctx = {
    settings: { gatewayPort: "18789" },
    transport: { description: "stub", async exec(command: string) {
      return command === "sh" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    } },
  } as unknown as Context;
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => expose(ctx, ["tailscale"]));
  check("expose tailscale reaches exposeTailscale", written.join("").includes("tailscale serve --bg"), true);
}

{
  const ctx = {
    settings: { bindAddress: "127.0.0.1", gatewayPort: "18789" },
    transport: { description: "stub", async exec(command: string) {
      return command === "sh" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    } },
    runtime: { async runningConnectionFacts() { return undefined; } },
  } as unknown as Context;
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => expose(ctx, ["status"]));
  check("expose status reaches exposeStatus", written.join("").includes("gateway exposure"), true);
}

// --- exposeActionIsReadOnly: only tailscale --apply mutates --------------------------------------

check("no action (dies before this matters) reads as read-only", exposeActionIsReadOnly([]), true);
check("ssh is read-only", exposeActionIsReadOnly(["ssh"]), true);
check("ssh --run is still read-only (a local tunnel, nothing on the target changes)", exposeActionIsReadOnly(["ssh", "--run"]), true);
check("status is read-only", exposeActionIsReadOnly(["status"]), true);
check("tailscale without --apply is read-only (print only)", exposeActionIsReadOnly(["tailscale"]), true);
check("tailscale --apply is the one mutation", exposeActionIsReadOnly(["tailscale", "--apply"]), false);

// --- AppCommand wiring: one declaration drives help, MCP schema and argv -----------------------

const command = openclawCommands.expose!;
check("expose is registered", command !== undefined, true);
check("expose is declared destructive (tailscale --apply mutates)", command.destructive, true);
check("readOnlyWhen matches exposeActionIsReadOnly", [command.readOnlyWhen?.(["status"]), command.readOnlyWhen?.(["tailscale", "--apply"])], [true, false]);
check("changedWhen is readOnlyWhen's negation", [command.changedWhen?.(["status"]), command.changedWhen?.(["tailscale", "--apply"])], [false, true]);
check("requiresConfirmationWhen matches changedWhen", [command.requiresConfirmationWhen?.(["status"]), command.requiresConfirmationWhen?.(["tailscale", "--apply"])], [false, true]);

{
  const names = (command.arguments ?? []).map((argument) => argument.name);
  check("action, local-port, run, apply, break-lock and break-foreign-lock are all declared", names, [
    "action", "local-port", "run", "apply", "break-lock", "break-foreign-lock",
  ]);
  const action = (command.arguments ?? []).find((argument) => argument.name === "action");
  check("action is a required positional with the three choices", [action?.kind, action?.required, action?.choices], ["positional", true, ["ssh", "tailscale", "status"]]);
}

{
  const schema = inputSchema(command) as { properties: Record<string, { type?: string; enum?: string[] }>; required?: string[] };
  check("action is a plain string in the schema", schema.properties.action?.type, "string");
  check("action exposes exactly the three choices", schema.properties.action?.enum, ["ssh", "tailscale", "status"]);
  check("run/apply are booleans", [schema.properties.run?.type, schema.properties.apply?.type], ["boolean", "boolean"]);
  check("action is the only required property (confirm comes from destructive+changedWhen, not a fixed schema field)", schema.required, ["action"]);

  check("toArgv places the action first, then flags", toArgv(command, { action: "tailscale", apply: true }), ["tailscale", "--apply"]);

  check("validate reports a bad action naming the valid ones", validate(command, { action: "bogus" }).join("; ").includes("ssh, tailscale, status"), true);
  check("validate reports the missing required action", validate(command, {}), ["action is required"]);
}

process.stderr.write(failed === 0 ? "all expose dispatch/wiring checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
