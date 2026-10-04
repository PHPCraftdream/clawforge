// `set` as a command spec: the declaration equals what the parser accepts per action, the
// action word and `forget`'s required options are the parser's refusals, and every refusal
// that depends only on the arguments — including the cross-field rules of `diff` and
// `receipts`, which land at the parse stage through the declaration's own rules — goes
// executeCommand) with a transport that records every contact — before the target, the
// instance lock or a .env write, on every host.

import { executeCommand } from "#framework/core/command/execute.ts";
import {
  ArgumentError, UnknownActionError, UnknownArgumentError, missingArgumentMessage, parseCall, specOf, specShape,
} from "#framework/core/command/index.ts";
import { setsCommands } from "#framework/commands/interface/groups/openclawCommands.sets.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const command = setsCommands.set;
const shape = specShape(specOf(command)!);

function refusal(argv: string[]): unknown {
  try {
    parseCall(shape, argv, "set");
  } catch (error) {
    return error;
  }
  return undefined;
}

function recordingTransport(): { transport: Transport; contacts: string[] } {
  const contacts: string[] = [];
  const transport = {
    description: "stub",
    exec(program: string, args: string[]): never {
      contacts.push(`exec ${program} ${args.join(" ")}`);
      throw new Error("unreachable");
    },
    exists(): never {
      contacts.push("exists");
      throw new Error("unreachable");
    },
    readFile(): never {
      contacts.push("readFile");
      throw new Error("unreachable");
    },
  } as unknown as Transport;
  return { transport, contacts };
}

const app: AppDefinition = { name: "set-command-fixture", description: "fixture", commands: { set: command } };

// --- declared = accepted, per action ------------------------------------------------------

const declared = command.arguments ?? [];
const actions = [...(declared.find((argument) => argument.name === "action")?.choices ?? [])];
check("the action word's choices, in the order the usage names them", actions, ["build", "validate", "diff", "receipts", "try", "forget"]);
check("the action word is required", declared.find((argument) => argument.name === "action")?.required, true);

const BASE: Record<string, string[]> = { forget: ["--kind", "agent", "--name", "x"] };
for (const action of actions) {
  for (const argument of declared.filter((entry) => entry.kind === "flag" || entry.kind === "option")) {
    const offered = argument.actions === undefined || argument.actions.includes(action);
    const tokens = argument.kind === "option" ? [`--${argument.name}`, "x"] : [`--${argument.name}`];
    const argv = [action, ...(BASE[action] ?? []).filter((token, at, all) => !(token === `--${argument.name}` || all[at - 1] === `--${argument.name}`)), ...tokens];
    const label = `set ${action} --${argument.name}`;
    if (offered) {
      checkTrue(`${label}: declared, so the parser takes it`, !(refusal(argv) instanceof UnknownArgumentError));
    } else {
      // Through the pipeline: diff reads its flags after the artifacts at the prepare stage.
      const { transport, contacts } = recordingTransport();
      const execution = await executeCommand(app, "set", argv, { surface: "mcp", confirmed: true, transport });
      checkTrue(`${label}: not declared for this action, so the pipeline refuses it as that argument`,
        execution.error instanceof UnknownArgumentError && execution.error.argument === argument.name);
      check(`${label}: refused before any contact`, contacts, []);
    }
  }
}

// --- the action word -------------------------------------------------------------------------

check("a bare `set` refuses with an unknown-action error", refusal([]) instanceof UnknownActionError, true);
check("an unknown action refuses with an unknown-action error", refusal(["frobnicate"]) instanceof UnknownActionError, true);
check("a flag first is no action", refusal(["--json"]) instanceof UnknownActionError, true);

// --- forget: --kind and --name are required, --kind takes its choices -----------------------

const missingKind = refusal(["forget", "--name", "n"]) as ArgumentError;
check("set forget without --kind names it", missingKind.argument, "kind");
check("set forget without --kind uses the parser's missing-required text", missingKind.message, "set forget needs --kind <kind>");
const missingName = refusal(["forget", "--kind", "agent"]) as ArgumentError;
check("set forget without --name names it", missingName.argument, "name");
const badKind = refusal(["forget", "--kind", "plugin", "--name", "n"]) as ArgumentError;
check("set forget --kind outside its choices names it", badKind.argument, "kind");
check("set forget with both arguments parses", refusal(["forget", "--kind", "cron-job", "--name", "n"]), undefined);

check("set forget without --kind uses the parser's missing-required text",
  missingKind.message, missingArgumentMessage("set forget", "--kind <kind>"));
// --set is declared required, so the parser refuses before prepare — the usage line the
// prepare phase used to print by hand is gone.
check("set try without --set uses the parser's missing-required text",
  (refusal(["try"]) as ArgumentError).message, missingArgumentMessage("set try", "--set <artifact>"));

// --- the pipeline: refusals before any contact ---------------------------------------------

const CASES: readonly { name: string; argv: string[]; stage: "parse" | "prepare"; argument: string | undefined }[] = [
  { name: "set diff with no artifact", argv: ["diff"], stage: "parse", argument: "artifacts" },
  { name: "set diff with one positional artifact", argv: ["diff", "a.tar.gz"], stage: "parse", argument: "artifacts" },
  { name: "set diff with three positional artifacts", argv: ["diff", "a", "b", "c"], stage: "parse", argument: "artifacts" },
  { name: "set diff --from without --to", argv: ["diff", "--from", "a.tar.gz"], stage: "parse", argument: "to" },
  { name: "set diff --to without --from", argv: ["diff", "--to", "b.tar.gz"], stage: "parse", argument: "from" },
  { name: "set diff --from with a positional artifact", argv: ["diff", "--from", "a", "b"], stage: "parse", argument: "artifacts" },
  { name: "set receipts --receipt without --set-id", argv: ["receipts", "--receipt", "r1"], stage: "parse", argument: "receipt" },
  { name: "set try without --set", argv: ["try"], stage: "parse", argument: "set" },
  { name: "set try --set with a flag in place of its value", argv: ["try", "--set", "--keep"], stage: "parse", argument: "set" },
  { name: "set forget without --kind", argv: ["forget", "--name", "n"], stage: "parse", argument: "kind" },
  { name: "set forget with an unknown kind", argv: ["forget", "--kind", "plugin", "--name", "n"], stage: "parse", argument: "kind" },
  { name: "set build with an empty --name", argv: ["build", "--name="], stage: "parse", argument: "name" },
  { name: "set validate with an empty --set", argv: ["validate", "--set="], stage: "parse", argument: "set" },
  { name: "set build --kind (another action's flag)", argv: ["build", "--kind", "agent"], stage: "parse", argument: undefined },
  { name: "bare set", argv: [], stage: "parse", argument: undefined },
];

for (const kase of CASES) {
  const { transport, contacts } = recordingTransport();
  const execution = await executeCommand(app, "set", kase.argv, { surface: "mcp", confirmed: true, transport });
  check(`${kase.name} stops at the ${kase.stage} stage`, execution.stage, kase.stage);
  checkTrue(`${kase.name} is refused as an argument error`, execution.error instanceof ArgumentError);
  if (kase.argument !== undefined) check(`${kase.name} names its argument`, (execution.error as ArgumentError).argument, kase.argument);
  check(`${kase.name}: the target was never contacted`, contacts, []);
}

finish("set command spec");
