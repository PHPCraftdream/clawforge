// The management group's argument-only refusals, through the ONE pipeline (executeCommand)
// with a transport that records every contact: the secrets' cross-flag rules and
// configure-provider's id/variable kinds land at the parse stage (S2.4), while host's elevation
// consent moved to the declaration's rules at the parse stage — all before any contact with
// the target, before the instance lock, before a .env write, on every host. deploy's own
// local facts are pinned here too (S2.5): a bad --path is a parse-stage kind refusal and the
// missing-checkout sentence is a prepare-stage refusal — both with zero contacts.

import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError } from "#framework/core/command/index.ts";
import { managementCommands } from "#framework/commands/interface/groups/openclawCommands.management.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// The --path sentence validatedRemoteRoot owns, pinned here as tokens for its first line
// plus the continuation line this check owns a copy of.
const PATH_FIRST_LINE = (value: string): string =>
  ["--path", "must", "be", "an", "absolute", "POSIX", "path", "—", JSON.stringify(value), "is", "not."].join(" ");
const PATH_SENTENCE = (value: string): string =>
  `${PATH_FIRST_LINE(value)}\n` +
  "Deploy mirrors this directory on the server with rsync --delete, so it needs a real, fully specified path there: " +
  "POSIX form (/opt/openclaw), not a relative path, not a Windows drive or share path.";

const app: AppDefinition = {
  name: "management-prepare-fixture",
  description: "fixture",
  commands: {
    secrets: managementCommands.secrets,
    host: managementCommands.host,
    "configure-provider": managementCommands["configure-provider"],
    deploy: managementCommands.deploy,
  },
};

for (const kase of [
  { name: "secrets --json --apply", command: "secrets", argv: ["--json", "--apply"], stage: "parse", argument: "json" },
  { name: "secrets --break-foreign-lock without --apply", command: "secrets", argv: ["--break-foreign-lock", "host-id"], stage: "parse", argument: "break-foreign-lock" },
  { name: "host --root without --confirm-root", command: "host", argv: ["target", "--root", "--", "whoami"], stage: "parse", argument: "root" },
  { name: "configure-provider --provider with an invalid id", command: "configure-provider", argv: ["--provider", "BAD ID"], stage: "parse", argument: "provider" },
  { name: "configure-provider --env with an invalid variable", command: "configure-provider", argv: ["--env", "1BAD"], stage: "parse", argument: "env" },
  { name: "deploy --path relative/x", command: "deploy", argv: ["deployer@server", "--path", "relative/x"], stage: "parse", argument: "path" },
] as const) {
  const { transport, contacts } = recordingTransport();
  const execution = await executeCommand(app, kase.command, { kind: "argv", argv: [...kase.argv] }, { surface: "mcp", confirmed: true, transport });
  check(`${kase.name} stops at the ${kase.stage} stage`, execution.stage, kase.stage);
  checkTrue(`${kase.name} is refused as an argument error`, execution.error instanceof ArgumentError);
  check(`${kase.name} names its argument`, (execution.error as ArgumentError).argument, kase.argument);
  check(`${kase.name}: the target was never contacted`, contacts, []);
}

// deploy's missing-checkout sentence is a local fact, so the prepare stage raises it (S2.5):
// the check-only source-root seam points at an empty temp directory, the parse succeeds, and
// the refusal lands before any contact and without a Context. The sentence itself stays
// pinned in checkout-policy.check.ts (INSTALLED_PACKAGE_MODE), which owns that text.
{
  const empty = await mkdtemp(join(tmpdir(), "clawforge-no-checkout-"));
  const previous = process.env["CLAWFORGE_CHECKS_SOURCE_ROOT"];
  process.env["CLAWFORGE_CHECKS_SOURCE_ROOT"] = empty;
  try {
    useDeployment(empty); // prepare reads the deployment's .env before the checkout sentence
    const { transport, contacts } = recordingTransport();
    const execution = await executeCommand(app, "deploy", { kind: "argv", argv: ["deployer@server"] }, { surface: "mcp", confirmed: true, transport });
    check("deploy without a checkout stops at the prepare stage", execution.stage, "prepare");
    checkTrue("deploy without a checkout is refused, not run", execution.error instanceof Error);
    check("deploy without a checkout: the target was never contacted", contacts, []);
  } finally {
    if (previous === undefined) delete process.env["CLAWFORGE_CHECKS_SOURCE_ROOT"];
    else process.env["CLAWFORGE_CHECKS_SOURCE_ROOT"] = previous;
    await rm(empty, { recursive: true, force: true });
  }
}

// deploy's run path layers the application's OC_REMOTE_PATH UNDER the .env (buildSettings:
// extra merged under base), and that layered value is what the run actually uses — so it is
// judged on the run path (S2.5): an INVALID app-supplied path refuses there, before any
// contact with the target, and a VALID one proceeds past validation to the connection
// attempt. The fixture's deployment directory carries no .env at all, so the app setting is
// the effective layer.
{
  const isolated = await mkdtemp(join(tmpdir(), "clawforge-deploy-settings-"));
  await writeFile(join(isolated, ".env"), "OC_DATA_DIR=/srv/openclaw/data\n"); // no OC_REMOTE_PATH: the app-settings layer is effective
  useDeployment(isolated);
  const settingsApp = (ocRemotePath: string): AppDefinition => ({
    ...app,
    name: "management-prepare-fixture-settings",
    settings: () => ({ OC_REMOTE_PATH: ocRemotePath }),
  });
  try {
    const { transport: invalidTransport, contacts: invalidContacts } = recordingTransport();
    const invalid = await executeCommand(settingsApp("relative/x"), "deploy", { kind: "argv", argv: ["deployer@server"] }, { surface: "mcp", confirmed: true, transport: invalidTransport });
    check("deploy app-settings invalid path stops at the run stage", invalid.stage, "run");
    checkTrue("deploy app-settings invalid path is refused, not run", invalid.error instanceof Error);
    checkTrue(
      "deploy app-settings invalid path pins the --path sentence",
      (invalid.error as Error | undefined)?.message === PATH_SENTENCE("relative/x"),
    );
    checkTrue("deploy app-settings invalid path: the target was never contacted", invalidContacts.length === 0);

    const { transport: validTransport, contacts } = recordingTransport();
    const valid = await executeCommand(settingsApp("/opt/clawforge-fixture"), "deploy", { kind: "argv", argv: ["deployer@server"] }, { surface: "mcp", confirmed: true, transport: validTransport });
    checkTrue("deploy app-settings valid path proceeds past validation to the connection attempt", contacts.length > 0);
    checkTrue("deploy app-settings valid path is not refused by the --path sentence", (valid.error as Error | undefined)?.message !== PATH_SENTENCE("/opt/clawforge-fixture"));
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

finish("management prepare refusals");
