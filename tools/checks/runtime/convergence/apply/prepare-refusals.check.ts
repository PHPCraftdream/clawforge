// Stage-3 migration of the orchestration group: the cross-field rules (apply-config's flag
// conflicts and --force requirement, rollback's --previous-set conflict) and the value
// grammars (--expect, --set, --operation, --limit) live in the declaration and are enforced at
// parse by the ONE pipeline
// with a transport that records every contact and then throws: the stage that refused, the
// named argument, and zero contacts — never prose.

import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError } from "#framework/core/command/index.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { setInvocation } from "#framework/core/io/invocation/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { renderCommandHelp } from "#framework/core/io/help-render.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const UNREACHABLE = "prepare-refusals: no target is reachable here";

/** A transport whose every contact point records and then throws — any entry means the
 *  command reached the target before refusing. */
function recordingTransport(): { transport: Transport; contacts: string[] } {
  const contacts: string[] = [];
  const transport = {
    description: "stub",
    exec(command: string, args: string[]): never {
      contacts.push(`exec ${command} ${args.join(" ")}`);
      throw new Error(UNREACHABLE);
    },
    exists(): never {
      contacts.push("exists");
      throw new Error(UNREACHABLE);
    },
    readFile(): never {
      contacts.push("readFile");
      throw new Error(UNREACHABLE);
    },
    writeFile(): never {
      contacts.push("writeFile");
      throw new Error(UNREACHABLE);
    },
  } as unknown as Transport;
  return { transport, contacts };
}

const app: AppDefinition = {
  name: "orchestration-refusals-fixture",
  description: "fixture",
  commands: Object.fromEntries(
    ["apply", "plan", "rollback", "operations", "apply-config"].map((name) => [name, orchestrationCommands[name]]),
  ),
};

/** The (stage, error, contacts) triple a refused call produces. */
async function refusal(name: string, argv: string[]): Promise<{ stage: string; error: unknown; contacts: string[] }> {
  const { transport, contacts } = recordingTransport();
  const execution = await executeCommand(app, name, argv, { surface: "terminal", transport });
  return { stage: execution.stage, error: execution.error, contacts };
}

// --- parse-stage refusals: the declaration's cross-field rules -----------------------------------

for (const [argv, argument] of [
  [["--dry-run", "--dump"], "dry-run"],
  [["--dump", "--break-lock"], "break-lock"],
  [["--dump", "--break-foreign-lock", "host-id"], "break-foreign-lock"],
  [["--dry-run", "--break-lock"], "break-lock"],
  [["--force"], "force"],
] as const) {
  const { stage, error, contacts } = await refusal("apply-config", [...argv]);
  check(`apply-config ${argv.join(" ")} stops at the parse stage`, stage, "parse");
  checkTrue(`apply-config ${argv.join(" ")} is refused as an argument error`, error instanceof ArgumentError);
  check(`apply-config ${argv.join(" ")} names its argument`, (error as ArgumentError).argument, argument);
  check(`apply-config ${argv.join(" ")} never contacts the target`, contacts, []);
}

for (const argv of [["--previous-set", "--operation", "apply-1"], ["--previous-set", "--no-restart"]]) {
  const { stage, error, contacts } = await refusal("rollback", [...argv]);
  check(`rollback ${argv.join(" ")} stops at the parse stage`, stage, "parse");
  checkTrue(`rollback ${argv.join(" ")} is refused as an argument error`, error instanceof ArgumentError);
  check(`rollback ${argv.join(" ")} names its argument`, (error as ArgumentError).argument, "previous-set");
  check(`rollback ${argv.join(" ")} never contacts the target`, contacts, []);
}

// --- parse-stage refusals: the declared value grammars -------------------------------------------

for (const [name, argv, argument] of [
  ["apply", ["--expect", ""], "expect"],
  ["plan", ["--set", ""], "set"],
  ["operations", ["--limit", "0"], "limit"],
  ["operations", ["--limit", "abc"], "limit"],
  ["rollback", ["--operation", "-x"], "operation"],
] as const) {
  const { stage, error, contacts } = await refusal(name, [...argv]);
  check(`${name} ${argv.join(" ")} stops at the parse stage`, stage, "parse");
  checkTrue(`${name} ${argv.join(" ")} is refused as an argument error`, error instanceof ArgumentError);
  check(`${name} ${argv.join(" ")} names the argument`, (error as ArgumentError).argument, argument);
  check(`${name} ${argv.join(" ")} never contacts the target`, contacts, []);
}

// --- the refusal and the help name the invocation set AFTER import ----------------------------
// The entry sets the invocation once modules are loaded: wording evaluated at import would
// always read the default checkout spelling.

{
  setInvocation({ program: "clawforge", mode: "installed", audience: "terminal", app: { name: "prod", selectedBy: "flag" } });
  try {
    const { error } = await refusal("rollback", ["--previous-set", "--operation", "apply-1"]);
    check(
      "rollback's conflict refusal names the current invocation's apply line",
      (error as Error).message,
      "--previous-set cannot be combined with --operation — rolls back the whole set through clawforge --app prod apply — --operation and --no-restart belong to the single-file path only",
    );
    let printed = "";
    await withOutputSink((chunk) => {
      printed += chunk;
    }, async () => {
      renderCommandHelp("rollback", orchestrationCommands.rollback);
    });
    checkTrue("rollback's help names the current invocation's apply --set", printed.includes("through clawforge --app prod apply --set,"));
    checkTrue("rollback's help never names the default spelling", !printed.includes("./clawforge"));
  } finally {
    setInvocation({ program: "./clawforge", mode: "checkout", audience: "terminal" });
  }
}

finish("orchestration prepare refusals");
