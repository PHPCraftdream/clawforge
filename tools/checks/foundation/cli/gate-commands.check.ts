// Commands that run before a deployment exists — check, new-app, init, version.
//
// They used to be hand-dispatched in each gate with their help text written out as literal
// strings, which is why they were invisible over MCP: nothing declared them, so nothing
// could enumerate them. Now they are declarations, and this covers the three things that
// buys — dispatch, help, and the same schema/argv derivation the deployment's own commands
// get, from the same functions.

import { helpEntryLine } from "#framework/core/io/help-render.ts";
import { commandLine, renderAdvice } from "#framework/core/io/invocation/render.ts";
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
  outsideAppNote,
  checkoutInlineNotes,
  CHECKOUT_ROOT_NOTE,
  checkoutListNote,
  NO_APP_TS,
  type GateCommand,
} from "#framework/integration/gate.ts";
import { inputSchema, validate } from "#framework/integration/mcp/server.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { normalizeVersionAlias, versionGateCommand } from "#framework/integration/version.ts";
import { frameworkVersion } from "#framework/commands/management/lock.ts";
import { makeCompletionGateCommand, COMPLETION_SHELLS } from "#framework/integration/completion/index.ts";
import { checkoutGateCommands, CHECKOUT_GATE_COMMANDS } from "#framework/entry/checkout-gate.ts";
import { ArgumentError, UnknownArgumentError, unknownArgumentMessage, missingArgumentMessage } from "#framework/core/command/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { commandRegistry } from "#framework/integration/gate.ts";
import { checkoutGate } from "#framework/entry/registry.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

function sample(overrides: Partial<GateCommand> = {}): GateCommand {
  return {
    name: "new-app",
    summary: "Create a deployment under apps/",
    details: "Writes apps/<name>/ with its own .env.",
    effect: "read",
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

// --- registry name collisions -----------------------------------------------------------------
// Names are claimed once: a deployment command may not take a gate command's name or a
// dispatcher name, and the refusal names both claimants.
{
  const command = openclawCommands.status;
  const gate = checkoutGate();
  const refusal = (deployment: Record<string, typeof command>, gates: readonly GateCommand[]): string => {
    try { commandRegistry({ deployment, gate: gates, appName: "fixture" }); return "accepted"; }
    catch (error) { return (error as Error).message; }
  };
  const gateName = gate[0]!.name;
  check("a clean registry builds", refusal(openclawCommands, gate), "accepted");
  check("a deployment command named like a gate command is refused, naming both", refusal({ ...openclawCommands, [gateName]: command }, gate),
    `command name "${gateName}" is claimed twice: by the deployment's commands and by a gate command`);
  check("a deployment command named help is refused, naming both", refusal({ ...openclawCommands, help: command }, gate),
    `command name "help" is claimed twice: by the deployment's commands and by the dispatcher (reserved)`);
  check("a deployment command named control-mcp is refused, naming both", refusal({ ...openclawCommands, "control-mcp": command }, gate),
    `command name "control-mcp" is claimed twice: by the deployment's commands and by the dispatcher (reserved)`);
  check("a gate command named help is refused", refusal({}, [sample({ name: "help" })]),
    `command name "help" is claimed twice: by a gate command and by the dispatcher (reserved)`);
  check("two gate commands of one name are refused", refusal({}, [sample({ name: "twin" }), sample({ name: "twin" })]),
    `command name "twin" is claimed twice: by a gate command and by a gate command`);
  // The gate rewrites --version/-v onto `version` before dispatch, so a command so named would
  // be unreachable while still appearing in help, the MCP tools list and completion.
  const aliasRefusal = (name: string, deployment: Record<string, typeof command>, gates: readonly GateCommand[]): boolean => {
    const expected =
      `command name "${name}" is the version command's alias — the gate rewrites it to "version" before dispatch, so the command would be unreachable`;
    try { commandRegistry({ deployment, gate: gates, appName: "fixture" }); return false; }
    catch (error) { return (error as Error).message === expected; }
  };
  check("a deployment command named --version is refused", aliasRefusal("--version", { ...openclawCommands, "--version": command }, gate), true);
  check("a deployment command named -v is refused", aliasRefusal("-v", { ...openclawCommands, "-v": command }, gate), true);
  check("a gate command named --version is refused", aliasRefusal("--version", openclawCommands, [sample({ name: "--version" })]), true);
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
  check("an unknown argument is refused", validate(command, { bogus: "x" }), ["unknown argument: bogus", "<name> is required"]);
  check("a missing required argument is reported", validate(command, {}), ["<name> is required"]);
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
  // The declaration's choices, in the parser's own voice (the same refusal an MCP call gets
  // from validate) — not a hand-written usage line.
  const refusedOutput = written.join("");
  check("naming the accepted ones", COMPLETION_SHELLS.every((shell) => refusedOutput.includes(shell))
    && refusedOutput.includes("ruby"), true);
}

// --- the help boundary: -- ends our own scan, like the deployment commands' ----------------

{
  let ran = false;
  const written: string[] = [];
  const filterDescription = "Pass-through filter";
  const command = sample({
    arguments: [{ name: "filter", description: filterDescription, kind: "variadic" }],
    run: async () => { ran = true; return 0; },
  });
  const beforeHelp = await withOutputSink((chunk) => written.push(chunk), async () =>
    runGateCommand([command], ["new-app", "--help"]));
  checkTrue("--help before a -- is still our help", beforeHelp === 0 && !ran);
  checkTrue("it printed the help, not the command", written.join("").includes(filterDescription));

  // After the bare -- the token is the command's own data (here: the filter value), like the
  // deployment commands read it — the scan used to cross the boundary and print help.
  written.length = 0;
  ran = false;
  const afterHelp = await withOutputSink((chunk) => written.push(chunk), async () =>
    runGateCommand([command], ["new-app", "--", "--help"]));
  checkTrue("help after a -- belongs to what the command passes through, not to us", afterHelp === 0 && ran && !written.join("").includes(filterDescription));
}

// --- required and choices, enforced once from the declaration ------------------------------

{
  // Without the declaration's `required` being enforced here, a bare `new-app` used to run
  // the command with no name at all.
  let ran = false;
  const written: string[] = [];
  const command = sample({ run: async () => { ran = true; return 0; } });
  const code = await withOutputSink((chunk) => written.push(chunk), async () =>
    runGateCommand([command], ["new-app"]));
  check("a missing required argument is refused", code, 1);
  check("in the parser's own voice", written.join("").includes(missingArgumentMessage("new-app", "<name>")), true);
  check("the command never ran", ran, false);
}

// --- help where there is no deployment -------------------------------------------------------

{
  const gate = [sample({ name: "init", summary: "Initialise this directory" }), versionGateCommand];
  // deploymentHelp is required: both entries build it, so every answer here carries the
  // built-in renderer too.
  const context = { deploymentCommands: Object.keys(openclawCommands), deploymentHelp: () => {} };
  const help = async (argv: string[], extra: { checkout?: string } = {}): Promise<{ code: number | undefined; text: string }> => {
    let text = "";
    const code = await withOutputSink((chunk) => {
      text += chunk;
    }, async () => helpWithoutDeployment(gate, argv, { ...context, ...extra, deploymentHelp: (name) => { text += `HELP-BODY:${name}\n`; } }));
    return { code, text };
  };

  const bare = await help([]);
  check("no arguments outside an app lists the gate commands and exits 0", bare.code === 0 && bare.text.includes(gate[0]?.summary ?? ""), true);
  check("a command is no help request", helpWithoutDeployment(gate, ["status"], context), undefined);

  const unknown = await help(["help", "int"]);
  check("help <unknown> outside an app is an unknown command, exit 1", unknown.code === 1 && unknown.text.includes(unknownCommandMessage("int")), true);
  check("and suggests the nearest known name", unknown.text.includes(didYouMeanMessage("init")), true);

  // R32-09: a deployment command answers from the built-in declaration, with where the
  // command runs appended.
  const helpedStatus = await help(["help", "status"]);
  check("help <deployment command> renders the declaration's help and exits 0", helpedStatus.code === 0 && helpedStatus.text.includes("HELP-BODY:status"), true);
  check("and says where the command runs, outside an app", helpedStatus.text.includes(outsideAppNote("status", undefined)), true);
  const helpedFlagForm = await help(["status", "--help"]);
  check("<deployment command> --help answers the same way", helpedFlagForm.code === 0 && helpedFlagForm.text.includes("HELP-BODY:status"), true);
  const bareDeployment = await help(["status"]);
  check("a bare deployment command is still left to the caller", bareDeployment.code === undefined && bareDeployment.text === "", true);
  const helpedInCheckout = await help(["help", "status"], { checkout: "/some/checkout" });
  check("in a checkout the note names the checkout-root gate and never offers init", [helpedInCheckout.code, helpedInCheckout.text.includes(renderAdvice(checkoutInlineNotes()[0])), helpedInCheckout.text.includes(commandLine(["init"]))], [0, true, false]);
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
  // `help <checkout command>` in a subfolder used to say "unknown command" — the same
  // regression R30-02 fixed for typing the command itself, one level deeper.
  const subfolderNote = `list ${CHECKOUT_ROOT_NOTE}`;
  const helpedSubfolder = await help(["help", "list"], { checkout: "/some/checkout with spaces" });
  check(
    "help <checkout command> in a subfolder says it runs at the root, not unknown",
    helpedSubfolder.code === 1 && helpedSubfolder.text.includes(subfolderNote) && !helpedSubfolder.text.includes(unknownCommandMessage("list")),
    true,
  );
  check("and the cd hint quotes a path with spaces", helpedSubfolder.text.includes("cd '/some/checkout with spaces'"), true);
  for (const command of CHECKOUT_GATE_COMMANDS) {
    const answered = await help(["help", command], { checkout: "/some/checkout" });
    const note = `${command} ${CHECKOUT_ROOT_NOTE}`;
    check(`help ${command} in a subfolder points to the checkout root too`, answered.code === 1 && answered.text.includes(note), true);
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
  // `list` parses through parseDeclaredArgs and dies on an unknown argument in the parser's
  // own voice: runGateCommand's refuseAgainstDeclaration (and the MCP validate) enforces the
  // declaration before run, so run itself carries no local catch — the same error surfaces
  // whether a caller enforces first or not.
  const list = checkoutGateCommands.find((command) => command.name === "list");
  if (list === undefined) throw new Error("list is not declared in entry/checkout-gate.ts");
  let raised: unknown;
  try {
    await list.run(["--bogus"]);
  } catch (error) {
    raised = error;
  }
  check("list --bogus is refused by the parser", raised instanceof UnknownArgumentError, true);
  check(
    "list --bogus raises the standard unknown-argument message",
    raised instanceof UnknownArgumentError && raised.message,
    unknownArgumentMessage("--bogus", undefined),
  );
}

{
  // --jobs declares a value grammar, so a value it refuses dies in the parser — on every
  // surface, in the one voice the declaration states — instead of coercing to NaN and
  // silently falling back to the default.
  const checkCommand = checkoutGateCommands.find((command) => command.name === "check");
  if (checkCommand === undefined) throw new Error("check is not declared in entry/checkout-gate.ts");
  const grammar = checkCommand.arguments?.find((argument) => argument.name === "jobs")?.parse;
  let refusal: unknown;
  try { await checkCommand.run(["--list", "--jobs", "abc"]); }
  catch (error) { refusal = error; }
  checkTrue("check --jobs abc is refused at the parse stage", refusal instanceof ArgumentError);
  check("check --jobs abc names the argument", (refusal as ArgumentError).argument, "jobs");
  check("check --jobs abc answers in the declared grammar's voice",
    (refusal as Error).message, `--jobs takes ${grammar?.expected}, not "abc"`);
}

finish("gate-command");
