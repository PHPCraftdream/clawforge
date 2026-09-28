// `./clawforge watch` — the dispatcher (unknown/missing action, routing to the right
// sub-handler) and the AppCommand wiring: readOnlyWhen/changedWhen/requiresConfirmationWhen
// agree with watchActionIsReadOnly, the declared arguments are well formed, and the MCP
// schema/argv round trip matches every other command's contract.
//
// Routing is proven the way tools/checks/security/expose/index.check.ts proves it: cheap,
// distinguishing ctx per action, so this checks ROUTING without duplicating check.check.ts/
// install.check.ts/status.check.ts's own behavioural coverage. `check`'s own routing is
// proven through its webhook validation, which runs before it ever touches a transport or
// runtime — the cheapest real, distinguishing signal that code path can produce.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch, watchActionIsReadOnly } from "#framework/commands/operate/watch/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { inputSchema, toArgv, validate } from "#framework/integration/mcp/server.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
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

const root = await mkdtemp(join(tmpdir(), "clawforge-watch-index-check-"));
useDeployment(root);

try {
  // --- dispatch: bad input dies before anything runs ------------------------------------

  check("no action at all is a usage error", (await deathOf(() => watch({} as unknown as Context, []))).includes("usage:"), true);
  check("an unknown action is refused by name", (await deathOf(() => watch({} as unknown as Context, ["bogus"]))).includes("unknown action: bogus"), true);
  check("the refusal names the four valid actions", (await deathOf(() => watch({} as unknown as Context, ["bogus"]))).includes("check, install, uninstall or status"), true);

  // --- dispatch: routes to the matching sub-handler, and nothing else -------------------

  {
    // check's own webhook validation runs before gatherInspection ever touches a transport
    // or runtime — a cheap, distinguishing signal that this reached watchCheck specifically.
    const ctx = { settings: { env: { OC_WATCH_WEBHOOK: "ftp://nope" } } } as unknown as Context;
    const message = await deathOf(() => watch(ctx, ["check"]));
    check("watch check reaches watchCheck", message.includes("OC_WATCH_WEBHOOK must be https"), true);
  }

  {
    const ctx = {
      transport: { description: "wsl:test", clientInvocation: (entry: string, args: string[]) => ({ command: "echo", args: [entry, ...args] }) },
      paths: { async toTarget(path: string): Promise<string> { return path; } },
      settings: {},
    } as unknown as Context;
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), () => watch(ctx, ["install"]));
    check("watch install reaches watchInstall", written.join("").includes("cannot install an unattended schedule on wsl:test"), true);
  }

  {
    const ctx = {
      transport: { description: "wsl:test", clientInvocation: (entry: string, args: string[]) => ({ command: "echo", args: [entry, ...args] }) },
      paths: { async toTarget(path: string): Promise<string> { return path; } },
      settings: {},
    } as unknown as Context;
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), () => watch(ctx, ["uninstall"]));
    check("watch uninstall reaches watchUninstall", written.join("").includes("no unattended schedule could have been installed on wsl:test"), true);
  }

  {
    // Under a captured sink, status (like inspect/doctor) always answers as JSON — see
    // status.ts's own isCaptured() branch — so the distinguishing signal is the field name
    // only this action's envelope carries, not prose text.
    const ctx = { settings: { env: {} } } as unknown as Context;
    const written: string[] = [];
    await withOutputSink((chunk) => written.push(chunk), () => watch(ctx, ["status"]));
    check("watch status reaches watchStatus", written.join("").includes("webhookConfigured"), true);
  }

  // --- watchActionIsReadOnly: only install/uninstall --apply mutate ---------------------

  check("no action (dies before this matters) reads as read-only", watchActionIsReadOnly([]), true);
  check("check is read-only", watchActionIsReadOnly(["check"]), true);
  check("status is read-only", watchActionIsReadOnly(["status"]), true);
  check("install without --apply is read-only (print only)", watchActionIsReadOnly(["install"]), true);
  check("install --apply is a mutation", watchActionIsReadOnly(["install", "--apply"]), false);
  check("uninstall without --apply is read-only (print only)", watchActionIsReadOnly(["uninstall"]), true);
  check("uninstall --apply is a mutation", watchActionIsReadOnly(["uninstall", "--apply"]), false);

  // --- AppCommand wiring: one declaration drives help, MCP schema and argv --------------

  const command = openclawCommands.watch!;
  check("watch is registered", command !== undefined, true);
  check("watch is declared destructive (install/uninstall --apply mutate)", command.destructive, true);
  check(
    "readOnlyWhen matches watchActionIsReadOnly",
    [command.readOnlyWhen?.(["status"]), command.readOnlyWhen?.(["install", "--apply"])],
    [true, false],
  );
  check(
    "changedWhen is readOnlyWhen's negation",
    [command.changedWhen?.(["status"]), command.changedWhen?.(["install", "--apply"])],
    [false, true],
  );
  check(
    "requiresConfirmationWhen matches changedWhen",
    [command.requiresConfirmationWhen?.(["status"]), command.requiresConfirmationWhen?.(["uninstall", "--apply"])],
    [false, true],
  );

  {
    const names = (command.arguments ?? []).map((argument) => argument.name);
    check("action, json, interval, apply, break-lock and break-foreign-lock are all declared", names, [
      "action", "json", "interval", "apply", "break-lock", "break-foreign-lock",
    ]);
    const action = (command.arguments ?? []).find((argument) => argument.name === "action");
    check("action is a required positional with the four choices", [action?.kind, action?.required, action?.choices], [
      "positional", true, ["check", "install", "uninstall", "status"],
    ]);
  }

  {
    const schema = inputSchema(command) as { properties: Record<string, { type?: string; enum?: string[] }>; required?: string[] };
    check("action is a plain string in the schema", schema.properties.action?.type, "string");
    check("action exposes exactly the four choices", schema.properties.action?.enum, ["check", "install", "uninstall", "status"]);
    check("json/apply are booleans", [schema.properties.json?.type, schema.properties.apply?.type], ["boolean", "boolean"]);
    check("action is the only required property", schema.required, ["action"]);

    check("toArgv places the action first, then flags", toArgv(command, { action: "install", apply: true }), ["install", "--apply"]);

    check("validate reports a bad action naming the valid ones", validate(command, { action: "bogus" }).join("; ").includes("check, install, uninstall, status"), true);
    check("validate reports the missing required action", validate(command, {}), ["action is required"]);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all watch dispatch/wiring checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
