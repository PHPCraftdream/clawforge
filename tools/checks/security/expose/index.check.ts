// `./clawforge expose` — the dispatcher (unknown/missing action, routing to the right
// sub-handler), the effect the declaration carries (only tailscale --apply mutates), and the
// AppCommand wiring: the derived arguments and the MCP schema/argv round trip.

import { openclawCommands } from "#framework/commands/interface/index.ts";
import { callFactsFor, effectProfile, ArgumentError, UnknownActionError, UnknownArgumentError } from "#framework/core/command/index.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { inputSchema } from "#framework/integration/mcp/server.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Context } from "#framework/core/context.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const command = openclawCommands.expose!;
const app: AppDefinition = { name: "expose-fixture", description: "fixture", commands: { expose: command } };

/** A transport whose every contact point records and then throws — any entry means the call
 *  reached the target before finishing its own argument parsing. */
function recordingTransport(): { transport: Transport; contacts: string[] } {
  const contacts: string[] = [];
  const transport = {
    description: "stub",
    exec(): never {
      contacts.push("exec");
      throw new Error("ssh:expose-fixture.invalid: connection refused");
    },
    exists(): never {
      contacts.push("exists");
      throw new Error("ssh:expose-fixture.invalid: connection refused");
    },
    readFile(): never {
      contacts.push("readFile");
      throw new Error("ssh:expose-fixture.invalid: connection refused");
    },
  } as unknown as Transport;
  return { transport, contacts };
}

// --- dispatch: bad input is refused by the parser, before anything runs --------------------------

{
  const { transport, contacts } = recordingTransport();
  const missing = await executeCommand(app, "expose", { kind: "argv", argv: [] }, { surface: "terminal", transport });
  check("a bare expose stops at the parse stage", missing.stage, "parse");
  checkTrue("a bare expose is refused as an unknown action", missing.error instanceof UnknownActionError);
  checkTrue("the refusal names the three valid actions", (missing.error as Error).message.includes("needs an action: ssh, tailscale, status"));
  check("a bare expose never contacts the target", contacts, []);
}
{
  const { transport, contacts } = recordingTransport();
  const unknown = await executeCommand(app, "expose", { kind: "argv", argv: ["bogus"] }, { surface: "terminal", transport });
  check("an unknown action stops at the parse stage", unknown.stage, "parse");
  checkTrue("an unknown action is refused by name", (unknown.error as Error).message.includes("unknown action: bogus"));
  checkTrue("the refusal lists the expected words", (unknown.error as Error).message.includes("(expected ssh, tailscale, status)"));
  check("an unknown action never contacts the target", contacts, []);
}

// --- argument refusals land at the parse stage, before any contact ------------------------------

for (const [argv, argument, unknown] of [
  [["ssh", "--local-port", "abc"], "local-port", false],
  [["ssh", "--local-port", "99999"], "local-port", false],
  [["ssh", "--local-port="], "local-port", false],
  [["status", "--run"], "run", true],
] as const) {
  const { transport, contacts } = recordingTransport();
  const execution = await executeCommand(app, "expose", { kind: "argv", argv: [...argv] }, { surface: "terminal", transport });
  const label = `expose ${argv.join(" ")}`;
  check(`${label}: refused at the parse stage`, execution.stage, "parse");
  check(`${label}: an unknown-argument refusal is ${unknown}`, execution.error instanceof UnknownArgumentError, unknown);
  checkTrue(`${label}: an argument error`, execution.error instanceof ArgumentError);
  check(`${label}: the refusal names its argument`, (execution.error as { argument?: string } | undefined)?.argument, argument);
  check(`${label}: never contacts the target`, contacts, []);
}

// --- funnel keeps its reason: refused at the parse stage, before any contact -------------------------

for (const argv of [["tailscale", "--funnel"], ["tailscale", "funnel"], ["tailscale", "--apply", "--funnel"]]) {
  const { transport, contacts } = recordingTransport();
  const execution = await executeCommand(app, "expose", { kind: "argv", argv: argv }, { surface: "terminal", transport });
  const label = `expose ${argv.join(" ")}`;
  check(`${label}: refused at the parse stage`, execution.stage, "parse");
  checkTrue(`${label}: an argument error, not an unknown argument`, execution.error instanceof ArgumentError && !(execution.error instanceof UnknownArgumentError));
  checkTrue(`${label}: the reason is given`, ((execution.error as Error | undefined)?.message ?? "").includes("never runs `tailscale funnel` — funnel shares a service with the public internet"));
  check(`${label}: never contacts the target`, contacts, []);
}

// --- dispatch: routes to the matching sub-handler, and nothing else -----------------------------
// Cheap ctx/args per action so this proves ROUTING without duplicating ssh.check.ts/
// tailscale.check.ts/status.check.ts's own behavioural coverage.

{
  const ctx = { settings: { location: "wsl" }, transport: { description: "wsl:Ubuntu-24.04" } } as unknown as Context;
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => command.run(ctx, ["ssh"]));
  checkTrue("expose ssh reaches exposeSsh", written.join("").includes("no SSH tunnel needed"));
}

{
  const ctx = {
    settings: { gatewayPort: "18789" },
    transport: { description: "stub", async exec(command: string) {
      return command === "sh" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    } },
  } as unknown as Context;
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), () => command.run(ctx, ["tailscale"]));
  checkTrue("expose tailscale reaches exposeTailscale", written.join("").includes("tailscale serve --bg"));
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
  // withOutputSink makes isCaptured() true, so status always answers in JSON here — see
  // status.check.ts for its full text-mode coverage.
  await withOutputSink((chunk) => written.push(chunk), () => command.run(ctx, ["status"]));
  const payload = JSON.parse(written.join("")) as { exposure?: unknown };
  checkTrue("expose status reaches exposeStatus", payload.exposure !== undefined);
}

// --- the effect the declaration carries: only tailscale --apply mutates ---------------------------

const effectOf = (argv: string[]) => callFactsFor(command, argv).effect;
check("ssh is read", effectOf(["ssh"]), "read");
check("ssh --run is still read (a local tunnel, nothing on the target changes)", effectOf(["ssh", "--run"]), "read");
check("status is read", effectOf(["status"]), "read");
check("tailscale without --apply is read (print only)", effectOf(["tailscale"]), "read");
check("tailscale --apply is the one destroy", effectOf(["tailscale", "--apply"]), "destroy");
check("expose's profile is destructive for some actions", effectProfile(command), { destructive: true, alwaysDestroys: false, byAction: true });

// --- the declared = accepted property, per action (moved here from parse.check.ts) ---------------
// What the derived declaration offers for an action is exactly what that action's own parser
// accepts — a flag of another action is refused as belonging to it.

{
  const declared = (command.arguments ?? []).filter((argument) => argument.kind === "flag" || argument.kind === "option");
  check("expose declares the seven arguments", (command.arguments ?? []).map((argument) => argument.name), [
    "action", "local-port", "run", "apply", "break-lock", "break-foreign-lock", "json",
  ]);
  const action = (command.arguments ?? []).find((argument) => argument.name === "action");
  check("action is a required positional with the three choices", [action?.kind, action?.required, action?.choices], ["positional", true, ["ssh", "tailscale", "status"]]);
  for (const [name, tokens] of [
    ["ssh", ["--local-port=8080"]], ["ssh", ["--run"]], ["status", ["--json"]],
    ["tailscale", ["--apply"]], ["tailscale", ["--break-lock"]], ["tailscale", ["--break-foreign-lock=x"]],
  ] as const) {
    checkTrue(`expose ${name} accepts ${tokens.join(" ")}`, acceptsOf(name, [...tokens]));
  }
  for (const [name, tokens] of [
    ["ssh", ["--apply"]], ["ssh", ["--json"]], ["status", ["--run"]], ["tailscale", ["--local-port=x"]], ["tailscale", ["--json"]],
  ] as const) {
    checkTrue(`expose ${name} refuses another action's ${tokens.join(" ")}`, !acceptsOf(name, [...tokens]));
  }
  check("every declared flag belongs to some action", declared.map((argument) => argument.name).sort(), ["apply", "break-foreign-lock", "break-lock", "json", "local-port", "run"].sort());

  function acceptsOf(action: string, tokens: string[]): boolean {
    try {
      const argv = [action, ...tokens];
      callFactsFor(command, argv);
      return true;
    } catch {
      return false;
    }
  }
}

{
  const schema = inputSchema(command) as { properties: Record<string, { type?: string; enum?: string[] }>; required?: string[] };
  check("action is a plain string in the schema", schema.properties.action?.type, "string");
  check("action exposes exactly the three choices", schema.properties.action?.enum, ["ssh", "tailscale", "status"]);
  check("run/apply are booleans", [schema.properties.run?.type, schema.properties.apply?.type], ["boolean", "boolean"]);
  check("action is the only required schema property (confirm is declared, not required — tailscale --apply is the only destroy)", schema.required, ["action"]);
}

finish("expose dispatch/wiring");
