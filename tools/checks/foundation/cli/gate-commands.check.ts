// Commands that run before a deployment exists — check, new-app, init.
//
// They used to be hand-dispatched in each gate with their help text written out as literal
// strings, which is why they were invisible over MCP: nothing declared them, so nothing
// could enumerate them. Now they are declarations, and this covers the three things that
// buys — dispatch, help, and the same schema/argv derivation the deployment's own commands
// get, from the same functions.

import { runGateCommand, gateHelpLines, gateCommandHelp, type GateCommand } from "#framework/integration/gate.ts";
import { inputSchema, toArgv, validate } from "#framework/integration/mcp-server.ts";
import { withOutputSink } from "#framework/core/output.ts";

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

function sample(overrides: Partial<GateCommand> = {}): GateCommand {
  return {
    name: "new-app",
    summary: "Create a deployment under apps/",
    details: "Writes apps/<name>/ with its own .env.",
    arguments: [{ name: "name", description: "Deployment name", kind: "positional", required: true }],
    run: async () => 0,
    ...overrides,
  };
}

// --- dispatch --------------------------------------------------------------------------------

{
  let ranWith: string[] | undefined;
  const command = sample({
    run: async (args) => {
      ranWith = args;
      return 0;
    },
  });

  check("a command that is not the gate's is handed on", await runGateCommand([command], ["status"]), undefined);
  check("a matching command runs", await runGateCommand([command], ["new-app", "staging"]), 0);
  check("it receives the arguments after its own name", ranWith, ["staging"]);
}

{
  const command = sample({ run: async () => 3 });
  check("the exit code is the command's own", await runGateCommand([command], ["new-app", "x"]), 3);
}

{
  // A gate has no dispatcher above it to catch a throw: it would otherwise reach the top of
  // the process as an unhandled rejection instead of a reported error.
  const command = sample({
    run: async () => {
      throw new Error("directory already exists");
    },
  });
  let reported = "";
  const code = await withOutputSink((chunk) => {
    reported += chunk;
  }, async () => runGateCommand([command], ["new-app", "x"]));

  check("a throw becomes a failing exit code", code, 1);
  check("and is reported rather than swallowed", reported.includes("directory already exists"), true);
}

{
  let ran = false;
  const command = sample({
    run: async () => {
      ran = true;
      return 0;
    },
  });
  const written: string[] = [];
  const code = await withOutputSink((chunk) => written.push(chunk), async () =>
    runGateCommand([command], ["new-app", "--help"]));

  check("--help answers instead of running the command", ran, false);
  check("--help exits successfully", code, 0);
  check("the help comes from the declaration", written.join("").includes("Writes apps/<name>/"), true);
  check("and shows the declared argument", written.join("").includes("Deployment name"), true);
}

// --- the command list ------------------------------------------------------------------------

check("no gate commands means no extra lines in the help screen", gateHelpLines([]), []);
check(
  "each gate command gets one aligned line",
  gateHelpLines([sample(), sample({ name: "check", summary: "Run the framework's own checks" })]),
  ["  new-app  Create a deployment under apps/", "  check    Run the framework's own checks"],
);

// --- the same derivation the deployment's commands get -----------------------------------------

{
  const command = sample();
  const schema = inputSchema(command) as { properties: Record<string, unknown>; required: string[] };
  check("a gate command's schema comes from its declared arguments", Object.keys(schema.properties), ["name"]);
  check("a required argument is required in the schema too", schema.required, ["name"]);
  check("its argv is rebuilt the same way", toArgv(command, { name: "staging" }), ["staging"]);
  // Every problem at once, not the first one — the same contract the deployment's commands
  // are validated under.
  check("an unknown argument is refused", validate(command, { bogus: "x" }), ["unknown argument: bogus", "name is required"]);
  check("a missing required argument is reported", validate(command, {}), ["name is required"]);
}

{
  // A gate command with nothing to declare still produces a valid, empty schema — a tool
  // with no arguments, not a tool that cannot be called.
  const schema = inputSchema({ summary: "Run the checks" }) as { properties: Record<string, unknown>; required: string[] };
  check("a command with no arguments has an empty schema", schema.properties, {});
  check("and requires nothing", schema.required, []);
}

{
  const written: string[] = [];
  await withOutputSink((chunk) => written.push(chunk), async () => {
    gateCommandHelp(sample({ arguments: undefined, details: undefined }));
  });
  check("help for an argument-less command is just its summary line", written.join("").trim(), "==> new-app — Create a deployment under apps/");
}

process.stderr.write(failed === 0 ? "all gate-command checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
