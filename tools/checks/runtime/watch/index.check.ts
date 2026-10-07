// `./clawforge watch` — the dispatcher (unknown/missing action, routing to the right
// sub-handler), the effect the declaration carries (only install/uninstall --apply mutate),
// and the AppCommand wiring: the derived arguments are well formed, and the MCP schema/argv
// round trip matches every other command's contract.
//
// Routing is proven the way tools/checks/security/expose/index.check.ts proves it: cheap,
// distinguishing ctx per action, so this checks ROUTING without duplicating check.check.ts/
// install.check.ts/status.check.ts's own behavioural coverage. `check`'s own routing is
// proven through its webhook validation, which runs before it ever touches a transport or
// runtime — the cheapest real, distinguishing signal that code path can produce.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { callFactsFor, effectProfile, ArgumentError, UnknownActionError, UnknownArgumentError } from "#framework/core/command/index.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { inputSchema } from "#framework/integration/mcp/server.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Context } from "#framework/core/context.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

async function deathOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/** A transport whose every contact point records and then throws — any entry means the call
 *  reached the target before finishing its own argument parsing. */
function recordingTransport(): { transport: Transport; contacts: string[] } {
  const contacts: string[] = [];
  const transport = {
    description: "stub",
    exec(): never {
      contacts.push("exec");
      throw new Error("ssh:watch-fixture.invalid: connection refused");
    },
    exists(): never {
      contacts.push("exists");
      throw new Error("ssh:watch-fixture.invalid: connection refused");
    },
    readFile(): never {
      contacts.push("readFile");
      throw new Error("ssh:watch-fixture.invalid: connection refused");
    },
  } as unknown as Transport;
  return { transport, contacts };
}

const root = await mkdtemp(join(tmpdir(), "clawforge-watch-index-check-"));
useDeployment(root);

try {
  const command = openclawCommands.watch!;
  const app: AppDefinition = { name: "watch-fixture", description: "fixture", commands: { watch: command } };

  // --- dispatch: bad input is refused by the parser, before anything runs ----------------

  {
    const { transport, contacts } = recordingTransport();
    const missing = await executeCommand(app, "watch", { kind: "argv", argv: [] }, { surface: "terminal", transport });
    check("a bare watch stops at the parse stage", missing.stage, "parse");
    checkTrue("a bare watch is refused as an unknown action", missing.error instanceof UnknownActionError);
    check(
      "the refusal names all five valid actions",
      ((missing.error as Error | undefined)?.message ?? "").includes("needs an action: check, install, uninstall, status, test"),
      true,
    );
    check("a bare watch never contacts the target", contacts, []);
  }
  {
    const { transport, contacts } = recordingTransport();
    const unknown = await executeCommand(app, "watch", { kind: "argv", argv: ["bogus"] }, { surface: "terminal", transport });
    check("an unknown action stops at the parse stage", unknown.stage, "parse");
    checkTrue("an unknown action is refused by name", ((unknown.error as Error | undefined)?.message ?? "").includes("unknown action: bogus"));
    checkTrue("the refusal lists the expected words", ((unknown.error as Error | undefined)?.message ?? "").includes("(expected check, install, uninstall, status, test)"));
    check("an unknown action never contacts the target", contacts, []);
  }

  // --- argument refusals land at the parse stage, before any contact ------------------------

  for (const [argv, argument, unknown] of [
    [["install", "--interval", "soon"], "interval", false],
    [["install", "--interval", ""], "interval", false],
    [["install", "--interval", "45m"], "interval", false],
    [["status", "--interval", "5m"], "interval", true],
    [["check", "--apply"], "apply", true],
  ] as const) {
    const { transport, contacts } = recordingTransport();
    const execution = await executeCommand(app, "watch", { kind: "argv", argv: [...argv] }, { surface: "terminal", transport });
    const label = `watch ${argv.join(" ")}`;
    check(`${label}: refused at the parse stage`, execution.stage, "parse");
    check(`${label}: an unknown-argument refusal is ${unknown}`, execution.error instanceof UnknownArgumentError, unknown);
    checkTrue(`${label}: an argument error`, execution.error instanceof ArgumentError);
    check(`${label}: the refusal names its argument`, (execution.error as { argument?: string } | undefined)?.argument, argument);
    check(`${label}: never contacts the target`, contacts, []);
  }

  // --- dispatch: routes to the matching sub-handler, and nothing else -------------------

  {
    // check's own webhook validation runs before gatherInspection ever touches a transport
    // or runtime — a cheap, distinguishing signal that this reached watchCheck specifically.
    const ctx = { settings: { env: { OC_WATCH_WEBHOOK: "ftp://nope" } } } as unknown as Context;
    const message = await deathOf(() => command.run(ctx, ["check"]));
    check("watch check reaches watchCheck", message.includes("OC_WATCH_WEBHOOK must be https"), true);
  }

  {
    const ctx = {
      transport: { description: "wsl:test", clientInvocation: (entry: string, args: string[]) => ({ command: "echo", args: [entry, ...args] }) },
      paths: { async toTarget(path: string): Promise<string> { return path; } },
      settings: {},
    } as unknown as Context;
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), () => command.run(ctx, ["install"]));
    check("watch install reaches watchInstall", written.join("").includes("cannot install an unattended schedule on wsl:test"), true);
  }

  {
    const ctx = {
      transport: { description: "wsl:test", clientInvocation: (entry: string, args: string[]) => ({ command: "echo", args: [entry, ...args] }) },
      paths: { async toTarget(path: string): Promise<string> { return path; } },
      settings: {},
    } as unknown as Context;
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), () => command.run(ctx, ["uninstall"]));
    check("watch uninstall reaches watchUninstall", written.join("").includes("no unattended schedule could have been installed on wsl:test"), true);
  }

  {
    // Under a captured sink, status (like inspect/doctor) always answers as JSON — see
    // status.ts's own isCaptured() branch — so the distinguishing signal is the field name
    // only this action's envelope carries, not prose text.
    const ctx = { settings: { env: {} } } as unknown as Context;
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), () => command.run(ctx, ["status"]));
    check("watch status reaches watchStatus", written.join("").includes("webhookConfigured"), true);
  }

  {
    // Under a captured sink, test (like status) always answers as JSON — same isCaptured()
    // override — so the distinguishing signal is the field name only this action's envelope
    // carries, same reasoning as the status-dispatch check above.
    const ctx = { settings: { env: {} } } as unknown as Context;
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), () => command.run(ctx, ["test"]));
    check("watch test reaches watchTest", written.join("").includes(`"configured"`), true);
  }

  // --- the effect the declaration carries: only install/uninstall --apply mutate --------

  const effectOf = (argv: string[]) => callFactsFor(command, argv).effect;
  check("check is read", effectOf(["check"]), "read");
  check("status is read", effectOf(["status"]), "read");
  check("test is read — it reaches an external webhook/heartbeat, never the target", effectOf(["test"]), "read");
  check("install without --apply is read (print only)", effectOf(["install"]), "read");
  check("install --apply is a destroy", effectOf(["install", "--apply"]), "destroy");
  check("uninstall without --apply is read (print only)", effectOf(["uninstall"]), "read");
  check("uninstall --apply is a destroy", effectOf(["uninstall", "--apply"]), "destroy");
  check("watch's profile is destructive for some actions", effectProfile(command), { destructive: true, alwaysDestroys: false, byAction: true });

  // --- the declared = accepted property, per action (moved here from parse.check.ts) ------
  // What the derived declaration offers for an action is exactly what that action's own
  // parser accepts — a flag of another action is refused as belonging to it.

  {
    check("watch declares the six arguments", (command.arguments ?? []).map((argument) => argument.name), [
      "action", "json", "interval", "apply", "break-lock", "break-foreign-lock",
    ]);
    const action = (command.arguments ?? []).find((argument) => argument.name === "action");
    check("action is a required positional with the five choices", [action?.kind, action?.required, action?.choices], [
      "positional", true, ["check", "install", "uninstall", "status", "test"],
    ]);
    for (const [name, tokens] of [
      ["check", ["--json"]], ["status", ["--json"]], ["test", ["--json"]],
      ["install", ["--interval=30m"]], ["install", ["--apply"]], ["uninstall", ["--apply"]],
      ["install", ["--break-lock"]], ["uninstall", ["--break-foreign-lock=x"]],
    ] as const) {
      checkTrue(`watch ${name} accepts ${tokens.join(" ")}`, acceptsOf(name, [...tokens]));
    }
    for (const [name, tokens] of [
      ["check", ["--apply"]], ["check", ["--interval=30m"]], ["install", ["--json"]], ["uninstall", ["--interval=30m"]], ["status", ["--apply"]],
    ] as const) {
      checkTrue(`watch ${name} refuses another action's ${tokens.join(" ")}`, !acceptsOf(name, [...tokens]));
    }

    function acceptsOf(action: string, tokens: string[]): boolean {
      try {
        callFactsFor(command, [action, ...tokens]);
        return true;
      } catch {
        return false;
      }
    }
  }

  // --- AppCommand wiring: one declaration drives help, MCP schema and argv --------------

  {
    const schema = inputSchema(command) as { properties: Record<string, { type?: string; enum?: string[] }>; required?: string[] };
    check("action is a plain string in the schema", schema.properties.action?.type, "string");
    check("action exposes exactly the five choices", schema.properties.action?.enum, ["check", "install", "uninstall", "status", "test"]);
    check("json/apply are booleans", [schema.properties.json?.type, schema.properties.apply?.type], ["boolean", "boolean"]);
    check("action is the only required schema property (confirm is declared, not required — install/uninstall --apply are the only destroys)", schema.required, ["action"]);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

finish("watch dispatch/wiring");
