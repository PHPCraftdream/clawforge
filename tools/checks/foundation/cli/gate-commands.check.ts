// Commands that run before a deployment exists — check, new-app, init, version.
//
// They used to be hand-dispatched in each gate with their help text written out as literal
// strings, which is why they were invisible over MCP: nothing declared them, so nothing
// could enumerate them. Now they are declarations, and this covers the three things that
// buys — dispatch, help, and the same schema/argv derivation the deployment's own commands
// get, from the same functions.

import { helpEntryLine } from "#framework/core/io/help-render.ts";
import { commandLine } from "#framework/core/io/invocation/render.ts";
import {
  runGateCommand,
  gateHelpLines,
  gateCommandHelp,
  helpWithoutDeployment,
  checkoutSubfolderReport,
  isDeploymentHelpRequest,
  missingDeploymentReport,
  unknownCommandMessage,
  didYouMeanMessage,
  OUTSIDE_APP,
  outsideAppNote,
  outsideAppRefusal,
  CHECKOUT_ROOT_NOTE,
  checkoutListNote,
  NO_APP_TS,
  type GateCommand,
} from "#framework/integration/gate.ts";
import { inputSchema, validate } from "#framework/integration/mcp/server.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { normalizeVersionAlias, versionGateCommand } from "#framework/integration/version.ts";
import { frameworkVersion } from "#framework/commands/management/lock.ts";
import { makeCompletionGateCommand } from "#framework/integration/completion/index.ts";
import { checkoutGateCommands, CHECKOUT_GATE_COMMANDS } from "#framework/entry/checkout-gate.ts";
import { reportUnknownArgument } from "#framework/entry/cli.ts";
import { parseDeclaredArgs, UnknownArgumentError, unknownArgumentMessage } from "#framework/core/command/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

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
  const thrown = "directory already exists";
  const command = sample({
    run: async () => {
      throw new Error(thrown);
    },
  });
  let reported = "";
  const code = await withOutputSink((chunk) => {
    reported += chunk;
  }, async () => runGateCommand([command], ["new-app", "x"]));

  check("a throw becomes a failing exit code", code, 1);
  check("and is reported rather than swallowed", reported.includes(thrown), true);
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
  const declared = sample();
  check("the help comes from the declaration", written.join("").includes(declared.details ?? ""), true);
  check("and shows the declared argument", written.join("").includes(declared.arguments?.[0]?.description ?? ""), true);
}

// --- the command list ------------------------------------------------------------------------

check("no gate commands means no extra lines in the help screen", gateHelpLines([]), []);
check(
  "each gate command gets one aligned line",
  gateHelpLines([sample(), sample({ name: "check", summary: "Run the framework's own checks" })]),
  [helpEntryLine("new-app", "Create a deployment under apps/"), helpEntryLine("check", "Run the framework's own checks")],
);

// --- the same derivation the deployment's commands get -----------------------------------------

{
  const command = sample();
  const schema = inputSchema(command) as { properties: Record<string, unknown>; required: string[] };
  check("a gate command's schema comes from its declared arguments", Object.keys(schema.properties), ["name"]);
  check("a required argument is required in the schema too", schema.required, ["name"]);
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

// --- version: --version/-v/version answer without a deployment, spawn-free -----------------

check("--version as the first token normalizes to version", normalizeVersionAlias(["--version"]), ["version"]);
check("-v as the first token normalizes to version", normalizeVersionAlias(["-v"]), ["version"]);
check("trailing arguments survive normalization", normalizeVersionAlias(["--version", "--json"]), ["version", "--json"]);
check("a plain version is left untouched", normalizeVersionAlias(["version"]), ["version"]);
check("--version only counts as the very first token", normalizeVersionAlias(["status", "--version"]), ["status", "--version"]);
check("an unrelated first token is untouched", normalizeVersionAlias(["status"]), ["status"]);

{
  const written: string[] = [];
  const code = await withOutputSink((chunk) => written.push(chunk), async () =>
    runGateCommand([versionGateCommand], ["version"]));
  const expected = await frameworkVersion();
  check("version exits 0", code, 0);
  check(
    "version prints clawforge <version>, read through the same helper inspect/set build use",
    written.join("").trim(),
    `clawforge ${expected}`,
  );
}

{
  const written: string[] = [];
  const code = await withOutputSink((chunk) => written.push(chunk), async () =>
    runGateCommand([versionGateCommand], ["version", "--json"]));
  const expected = await frameworkVersion();
  check("version --json exits 0", code, 0);
  const info = JSON.parse(written.join("")) as Record<string, unknown>;
  check("version --json emits name, version, source and path", Object.keys(info), ["name", "version", "source", "path"]);
  check("naming this copy", [info.name, info.version, info.source], ["clawforge", expected, "checkout"]);
}

{
  // The same refusal shape any declared command's argv gets — see core/command/parse.ts.
  const written: string[] = [];
  const code = await withOutputSink((chunk) => written.push(chunk), async () =>
    runGateCommand([versionGateCommand], ["version", "extra-arg"]));
  check("version extra-arg is refused", code, 1);
  check("with the standard unknown-argument message", written.join("").includes(unknownArgumentMessage("extra-arg")), true);
}

// --- completion: generated shell completion, no deployment needed -------------------------
//
// The model and the rendered scripts are asserted in
// foundation/core/command/completion/completion-behaviour.check.ts, against a real bash and a
// real PowerShell. What is left here is the gate dispatch itself.
{
  const written: string[] = [];
  const command = makeCompletionGateCommand([versionGateCommand], true);
  const code = await withOutputSink((chunk) => written.push(chunk), async () =>
    runGateCommand([command], ["completion", "bash"]));
  check("completion bash exits 0", code, 0);
  check("completion bash prints a bash function", written.join("").includes("_clawforge_complete()"), true);
}

{
  const written: string[] = [];
  const code = await withOutputSink((chunk) => written.push(chunk), async () =>
    runGateCommand([makeCompletionGateCommand([versionGateCommand], true)], ["completion", "ruby"]));
  check("an unsupported shell is refused", code, 1);
  check("naming the accepted ones", written.join("").includes("bash|zsh|pwsh"), true);
}

// --- help where there is no deployment -------------------------------------------------------

{
  const gate = [sample({ name: "init", summary: "Initialise this directory" }), versionGateCommand];
  const context = { deploymentCommands: Object.keys(openclawCommands) };
  const help = async (argv: string[], extra: { checkout?: string } = {}): Promise<{ code: number | undefined; text: string }> => {
    let text = "";
    const code = await withOutputSink((chunk) => {
      text += chunk;
    }, async () => helpWithoutDeployment(gate, argv, { ...context, ...extra }));
    return { code, text };
  };

  const bare = await help([]);
  check("no arguments outside an app lists the gate commands and exits 0", bare.code === 0 && bare.text.includes(gate[0]?.summary ?? ""), true);
  check("a command is no help request", helpWithoutDeployment(gate, ["status"], context), undefined);

  const unknown = await help(["help", "int"]);
  check("help <unknown> outside an app is an unknown command, exit 1", unknown.code === 1 && unknown.text.includes(unknownCommandMessage("int")) && !unknown.text.includes(OUTSIDE_APP), true);
  check("and suggests the nearest known name", unknown.text.includes(didYouMeanMessage("init")), true);
  const deployment = await help(["help", "status"]);
  check("a real deployment command still says it needs an app folder", deployment.code === 1 && deployment.text.includes(outsideAppRefusal("status", undefined)), true);

  // R32-09: with a deploymentHelp renderer (the gates that carry openclawCommands), the same
  // request answers from the built-in declaration, with where the command runs appended.
  const helped = async (argv: string[], extra: { checkout?: string } = {}): Promise<{ code: number | undefined; text: string }> => {
    let text = "";
    const code = await withOutputSink((chunk) => {
      text += chunk;
    }, async () => helpWithoutDeployment(gate, argv, { ...context, ...extra, deploymentHelp: (name) => { text += `HELP-BODY:${name}\n`; } }));
    return { code, text };
  };
  const helpedStatus = await helped(["help", "status"]);
  check("help <deployment command> renders the declaration's help and exits 0", helpedStatus.code === 0 && helpedStatus.text.includes("HELP-BODY:status"), true);
  check("and says where the command runs, outside an app", helpedStatus.text.includes(outsideAppNote("status", undefined)), true);
  const helpedFlagForm = await helped(["status", "--help"]);
  check("<deployment command> --help answers the same way", helpedFlagForm.code === 0 && helpedFlagForm.text.includes("HELP-BODY:status"), true);
  const bareDeployment = await helped(["status"]);
  check("a bare deployment command is still left to the caller", bareDeployment.code === undefined && bareDeployment.text === "", true);
  const helpedInCheckout = await helped(["help", "status"], { checkout: "/some/checkout" });
  check("in a checkout the note points at apps/<name> instead of init", helpedInCheckout.code === 0 && helpedInCheckout.text.includes(outsideAppNote("status", "/some/checkout")), true);
  check("a deployment command is still no typo in a checkout subfolder", checkoutSubfolderReport("status", "/some/checkout"), undefined);

  const inCheckout = await help(["help"], { checkout: "/some/checkout" });
  check("in a checkout the list does not offer init", inCheckout.code === 0 && !inCheckout.text.includes(gate[0]?.summary ?? "") && !inCheckout.text.includes(commandLine(["init"])), true);
  check("and says it is a checkout whose root lists the commands", inCheckout.text.includes(checkoutListNote("/some/checkout")), true);
  const checkoutTypo = await help(["help", "int"], { checkout: "/some/checkout" });
  check("help <typo> in a checkout never suggests init", checkoutTypo.code === 1 && checkoutTypo.text.includes(unknownCommandMessage("int")) && !checkoutTypo.text.includes(didYouMeanMessage("init")), true);
  const typo = await help(["stauts"]);
  check("a mistyped command outside an app is unknown, with a suggestion", typo.code === 1 && typo.text.includes(unknownCommandMessage("stauts")) && typo.text.includes(didYouMeanMessage("status")), true);
  check("an option is left to the caller", helpWithoutDeployment(gate, ["--json"], context), undefined);
  check("a gate command is left to the caller", helpWithoutDeployment(gate, ["version"], context), undefined);
  const checkoutCommand = await help(["help", "status"], { checkout: "/some/checkout" });
  check("help <deployment command> in a checkout does not advise init", checkoutCommand.code === 1 && !checkoutCommand.text.includes(commandLine(["init"])), true);
  // `help <checkout command>` in a subfolder used to say "unknown command" — the same
  // regression R30-02 fixed for typing the command itself, one level deeper.
  const subfolderNote = `list ${CHECKOUT_ROOT_NOTE}`;
  const helpedSubfolder = await help(["help", "list"], { checkout: "/some/checkout with spaces" });
  check(
    "help <checkout command> in a subfolder says it runs at the root, not unknown",
    helpedSubfolder.code === 1 && helpedSubfolder.text.includes(subfolderNote) && !helpedSubfolder.text.includes(unknownCommandMessage("list")),
    true,
  );
  check("and the cd hint quotes a path with spaces", helpedSubfolder.text.includes('cd "/some/checkout with spaces"'), true);
  for (const command of CHECKOUT_GATE_COMMANDS) {
    const helped = await help(["help", command], { checkout: "/some/checkout" });
    const note = `${command} ${CHECKOUT_ROOT_NOTE}`;
    check(`help ${command} in a subfolder points to the checkout root too`, helped.code === 1 && helped.text.includes(note), true);
  }
}

// --- checkout subfolders and help without a resolvable deployment -----------------------------

{
  const checkout = "/some/checkout";
  for (const command of CHECKOUT_GATE_COMMANDS) {
    const report = checkoutSubfolderReport(command, checkout);
    const note = `${command} ${CHECKOUT_ROOT_NOTE}`;
    check(`${command} from a checkout subfolder is answered as a checkout command, not unknown`, report !== undefined && report.message === note && JSON.stringify(report.advice).includes(checkout), true);
  }
  checkTrue("an unknown word gets no checkout-subfolder report", checkoutSubfolderReport("stauts", checkout) === undefined);
  checkTrue("neither does a deployment command", checkoutSubfolderReport("status", checkout) === undefined);

  const deployment = Object.keys(openclawCommands)[0];
  check("a deployment command's --help is a help request without a deployment", isDeploymentHelpRequest([deployment, "--help"], Object.keys(openclawCommands)), true);
  check("a bare command is not", isDeploymentHelpRequest([deployment], Object.keys(openclawCommands)), false);
  check("nor -h, which entry/cli.ts does not treat as help after a command", isDeploymentHelpRequest([deployment, "-h"], Object.keys(openclawCommands)), false);
  check("nor an unknown command's --help", isDeploymentHelpRequest(["stauts", "--help"], Object.keys(openclawCommands)), false);
  // The action form is the natural one for commands with actions, and it used to fall
  // through to "several deployments" — the bug R30-02's fix left behind.
  check("a command's action-level --help is a help request too", isDeploymentHelpRequest([deployment, "install", "--help"], Object.keys(openclawCommands)), true);
  check("so is --help after the command's own flags", isDeploymentHelpRequest([deployment, "--json", "--help"], Object.keys(openclawCommands)), true);
  check("extra arguments after --help still count as help", isDeploymentHelpRequest([deployment, "--help", "x"], Object.keys(openclawCommands)), true);
  check("but -- beyond it ends the scan, like requestsHelp", isDeploymentHelpRequest([deployment, "--", "--help"], Object.keys(openclawCommands)), false);

  const empty = missingDeploymentReport(true, "emptyx", "/some/checkout/apps/emptyx", [], true);
  check("an existing directory without app.ts is offered to new-app, not told to gain an app.ts by hand", empty.message.includes(NO_APP_TS) && JSON.stringify(empty.advice).includes("new-app") && JSON.stringify(empty.advice).includes("emptyx"), true);
}

// --- the declared checkout commands and the derived name list ---------------------------------

{
  // The names every surface reads are derived from the declarations (entry/checkout-gate.ts):
  // there is no second hand list to keep in step with tools/clawforge.ts.
  check("CHECKOUT_GATE_COMMANDS is the declarations' names, sorted", CHECKOUT_GATE_COMMANDS, checkoutGateCommands.map((command) => command.name).sort());
  for (const command of checkoutGateCommands) {
    check(`${command.name} declares the arguments its run parses`, command.arguments !== undefined, true);
  }
}

{
  // `list` parses through parseDeclaredArgs and answers an unknown argument the standard
  // way — the same reporter the dispatcher uses, pointing at the command's own --help.
  const list = checkoutGateCommands.find((command) => command.name === "list");
  if (list === undefined) throw new Error("list is not declared in entry/checkout-gate.ts");
  const actual: string[] = [];
  const code = await withOutputSink((chunk) => actual.push(chunk), async () => list.run(["--bogus"]));
  let reference: string[] = [];
  try {
    parseDeclaredArgs(list.arguments ?? [], ["--bogus"]);
  } catch (error) {
    if (error instanceof UnknownArgumentError) {
      await withOutputSink((chunk) => reference.push(chunk), async () => reportUnknownArgument("list", error));
    } else throw error;
  }
  check("list --bogus is refused", code, 1);
  check("list --bogus answers exactly the standard unknown-argument report", actual, reference);
}

finish("gate-command");
