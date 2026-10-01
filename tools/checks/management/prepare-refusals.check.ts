// The management group's prepare-stage refusals, through the ONE pipeline (executeCommand)
// with a transport that records every contact: a refusal that depends only on the arguments
// (secrets' cross-flag rules, host's elevation consent, configure-provider's id/variable
// grammars) lands at the prepare stage — before any contact with the target, before the
// instance lock, before a .env write, on every host.

import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError } from "#framework/core/command/index.ts";
import { managementCommands } from "#framework/commands/interface/groups/openclawCommands.management.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

function recordingTransport(): { transport: Transport; contacts: string[] } {
  const contacts: string[] = [];
  const transport = {
    description: "stub",
    exec(command: string, args: string[]): never {
      contacts.push(`exec ${command} ${args.join(" ")}`);
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

const app: AppDefinition = {
  name: "management-prepare-fixture",
  description: "fixture",
  commands: {
    secrets: managementCommands.secrets,
    host: managementCommands.host,
    "configure-provider": managementCommands["configure-provider"],
  },
};

for (const kase of [
  { name: "secrets --json --apply", argv: ["--json", "--apply"], argument: "json" },
  { name: "secrets --break-foreign-lock without --apply", argv: ["--break-foreign-lock", "host-id"], argument: "break-foreign-lock" },
  { name: "host --root without --confirm-root", argv: ["target", "--root", "--", "whoami"], argument: "root" },
  { name: "configure-provider --provider with an invalid id", argv: ["--provider", "BAD ID"], argument: "provider" },
  { name: "configure-provider --env with an invalid variable", argv: ["--env", "1BAD"], argument: "env" },
] as const) {
  const { transport, contacts } = recordingTransport();
  const execution = await executeCommand(app, kase.argv[0] === "target" ? "host" : kase.argv[0] === "--json" || kase.argv[0] === "--break-foreign-lock" ? "secrets" : "configure-provider", [...kase.argv], { surface: "mcp", confirmed: true, transport });
  check(`${kase.name} stops at the prepare stage`, execution.stage, "prepare");
  checkTrue(`${kase.name} is refused as an argument error`, execution.error instanceof ArgumentError);
  check(`${kase.name} names its argument`, (execution.error as ArgumentError).argument, kase.argument);
  check(`${kase.name}: the target was never contacted`, contacts, []);
}

finish("management prepare refusals");
