// Commands that run before a deployment exists — check, new-app, init, version.
//
// They used to be hand-dispatched in each gate with their help text written out as literal
// strings, which is why they were invisible over MCP: nothing declared them, so nothing
// could enumerate them. Now they are declarations, and this covers the three things that
// buys — dispatch, help, and the same schema/argv derivation the deployment's own commands
// get, from the same functions.

import { helpEntryLine } from "#framework/core/io/help-render.ts";
import { runGateCommand, gateHelpLines, gateCommandHelp, helpWithoutDeployment, checkoutSubfolderReport, isDeploymentHelpRequest, missingDeploymentReport, type GateCommand } from "#framework/integration/gate.ts";
import { inputSchema, validate } from "#framework/integration/mcp/server.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { normalizeVersionAlias, versionGateCommand } from "#framework/integration/version.ts";
import { frameworkVersion } from "#framework/commands/management/lock.ts";
import { buildCompletionModel, renderCompletion, makeCompletionGateCommand, COMPLETION_SHELLS } from "#framework/integration/completion.ts";
import { checkoutGateCommands, CHECKOUT_GATE_COMMANDS } from "#framework/entry/checkout-gate.ts";
import { reportUnknownArgument } from "#framework/entry/cli.ts";
import { parseDeclaredArgs, UnknownArgumentError } from "#framework/core/command/index.ts";
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
  check("with the standard unknown-argument message", written.join("").includes("unknown argument: extra-arg"), true);
}

// --- completion: generated shell completion, no deployment needed -------------------------

{
  const gateCommands = [versionGateCommand];
  const model = buildCompletionModel(gateCommands);
  const modelNames = model.map((spec) => spec.name);
  const expectedNames = [...Object.keys(openclawCommands), "help", "control-mcp", "version"].sort();
  check("every live command name is in the model, gate and deployment commands alike", [...modelNames].sort(), expectedNames);

  const backup = model.find((spec) => spec.name === "backup");
  check("backup carries its own action positional", backup?.action !== undefined, true);
  check("--interval sits only under install", backup?.action?.flags.install?.includes("--interval"), true);
  check("--interval is absent from list", backup?.action?.flags.list?.includes("--interval"), false);
  check("--interval is absent from prune-replaced", backup?.action?.flags["prune-replaced"]?.includes("--interval"), false);
  check("--interval is absent from uninstall", backup?.action?.flags.uninstall?.includes("--interval"), false);
  check("--keep sits only under prune-replaced", backup?.action?.flags["prune-replaced"]?.includes("--keep"), true);
  check("--keep is absent from install", backup?.action?.flags.install?.includes("--keep"), false);
  check("--apply sits under prune-replaced, install and uninstall", [
    backup?.action?.flags["prune-replaced"]?.includes("--apply"),
    backup?.action?.flags.install?.includes("--apply"),
    backup?.action?.flags.uninstall?.includes("--apply"),
  ], [true, true, true]);
  check("--apply is absent from list (read-only)", backup?.action?.flags.list?.includes("--apply"), false);

  for (const shell of COMPLETION_SHELLS) {
    const first = renderCompletion(shell, model, true);
    const missing = modelNames.filter((name) => !first.includes(name));
    check(`${shell}: every command name from the live declarations appears`, missing, []);
    check(`${shell}: no timestamp or other per-run value — rendering twice is byte-identical`, renderCompletion(shell, model, true), first);
  }

  // The output text itself, not just the model: --interval lands on the same line as
  // "install", never on list's/prune-replaced's/uninstall's own line.
  const bash = renderCompletion("bash", model, true);
  const installLine = bash.split("\n").find((line) => line.trim().startsWith("install) "));
  const listLine = bash.split("\n").find((line) => line.trim().startsWith("list) "));
  check("bash: the install arm carries --interval", installLine?.includes("--interval"), true);
  check("bash: the list arm does not carry --interval", listLine?.includes("--interval"), false);

  // --app's values: the command as typed (clawforge or ./clawforge, any cwd), never polling targets.
  for (const shell of ["bash", "zsh"] as const) {
    const text = renderCompletion(shell, model, true);
    check(`${shell}: --app values come from the invoked name, without polling targets`,
      text.includes('"${COMP_WORDS[0]}" list --json --no-status'), true);
    check(`${shell}: no hard-wired ./clawforge list call`, text.includes("./clawforge list"), false);
    check(`${shell}: hidden directories are filtered out`, text.includes("grep -v '^[.]'"), true);
  }
  const pwshApp = renderCompletion("pwsh", model, true);
  check("pwsh: --app values come from the invoked name, without polling targets", pwshApp.includes("& $tokens[0] list --json --no-status"), true);
  check("pwsh: no hard-wired ./clawforge list call", pwshApp.includes("./clawforge list"), false);

  const pwsh = renderCompletion("pwsh", model, true);
  const pwshInstallLine = pwsh.split("\n").find((line) => line.trim().startsWith('"install" = @('));
  const pwshListLine = pwsh.split("\n").find((line) => line.trim().startsWith('"list" = @('));
  check("pwsh: the install action table carries --interval", pwshInstallLine?.includes("--interval"), true);
  check("pwsh: the list action table does not carry --interval", pwshListLine?.includes("--interval"), false);
}

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

{
  // appFlag: false (the installed single-deployment gate, entry/bin.ts) never offers --app.
  const model = buildCompletionModel([versionGateCommand]);
  const bash = renderCompletion("bash", model, false);
  // Word-boundary, not a bare substring match: "--apply" (a real backup/expose/etc. flag)
  // must not be mistaken for "--app".
  check("with no --app, the script never mentions it", /--app\b/.test(bash), false);
  check("and never calls `list --json` to complete its value", bash.includes("list --json"), false);
  for (const shell of COMPLETION_SHELLS) {
    const text = renderCompletion(shell, model, false);
    check(`${shell}: installed gate: no --app and no list call`, [/--app/.test(text), text.includes("list --json")], [false, false]);
  }
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
  check("no arguments outside an app lists the gate commands and exits 0", bare.code === 0 && bare.text.includes("Initialise this directory"), true);
  check("a command is no help request", helpWithoutDeployment(gate, ["status"], context), undefined);

  const unknown = await help(["help", "int"]);
  check("help <unknown> outside an app is an unknown command, exit 1", unknown.code === 1 && unknown.text.includes("unknown command: int") && !unknown.text.includes("deployment command"), true);
  check("and suggests the nearest known name", unknown.text.includes("did you mean:"), true);
  const deployment = await help(["help", "status"]);
  check("a real deployment command still says it needs an app folder", deployment.code === 1 && deployment.text.includes("needs an app folder"), true);

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
  check("and says where the command runs, outside an app", helpedStatus.text.includes('"status" runs inside an app folder') && helpedStatus.text.includes("clawforge init"), true);
  const helpedFlagForm = await helped(["status", "--help"]);
  check("<deployment command> --help answers the same way", helpedFlagForm.code === 0 && helpedFlagForm.text.includes("HELP-BODY:status"), true);
  const bareDeployment = await helped(["status"]);
  check("a bare deployment command is still left to the caller", bareDeployment.code === undefined && bareDeployment.text === "", true);
  const helpedInCheckout = await helped(["help", "status"], { checkout: "/some/checkout" });
  check("in a checkout the note points at apps/<name> instead of init", helpedInCheckout.code === 0 && helpedInCheckout.text.includes("run it from apps/<name>"), true);
  check("a deployment command is still no typo in a checkout subfolder", checkoutSubfolderReport("status", "/some/checkout"), undefined);

  const inCheckout = await help(["help"], { checkout: "/some/checkout" });
  check("in a checkout the list does not offer init", inCheckout.code === 0 && !inCheckout.text.includes("Initialise this directory") && !inCheckout.text.includes("clawforge init"), true);
  check("and says it is a checkout whose root lists the commands", inCheckout.text.includes("ClawForge checkout") && inCheckout.text.includes("./clawforge help"), true);
  const checkoutTypo = await help(["help", "int"], { checkout: "/some/checkout" });
  check("help <typo> in a checkout never suggests init", checkoutTypo.code === 1 && checkoutTypo.text.includes("unknown command: int") && !checkoutTypo.text.includes("did you mean: init"), true);
  const typo = await help(["stauts"]);
  check("a mistyped command outside an app is unknown, with a suggestion", typo.code === 1 && typo.text.includes("unknown command: stauts") && typo.text.includes("did you mean: status"), true);
  check("an option is left to the caller", helpWithoutDeployment(gate, ["--json"], context), undefined);
  check("a gate command is left to the caller", helpWithoutDeployment(gate, ["version"], context), undefined);
  const checkoutCommand = await help(["help", "status"], { checkout: "/some/checkout" });
  check("help <deployment command> in a checkout does not advise init", checkoutCommand.code === 1 && !checkoutCommand.text.includes("clawforge init"), true);
  // `help <checkout command>` in a subfolder used to say "unknown command" — the same
  // regression R30-02 fixed for typing the command itself, one level deeper.
  const helpedSubfolder = await help(["help", "list"], { checkout: "/some/checkout with spaces" });
  check(
    "help <checkout command> in a subfolder says it runs at the root, not unknown",
    helpedSubfolder.code === 1 && helpedSubfolder.text.includes("list is a checkout command") && !helpedSubfolder.text.includes("unknown command"),
    true,
  );
  check("and the cd hint quotes a path with spaces", helpedSubfolder.text.includes('cd "/some/checkout with spaces"'), true);
  for (const command of CHECKOUT_GATE_COMMANDS) {
    const helped = await help(["help", command], { checkout: "/some/checkout" });
    check(`help ${command} in a subfolder points to the checkout root too`, helped.code === 1 && helped.text.includes("checkout command"), true);
  }
}

// --- checkout subfolders and help without a resolvable deployment -----------------------------

{
  const checkout = "/some/checkout";
  for (const command of CHECKOUT_GATE_COMMANDS) {
    const report = checkoutSubfolderReport(command, checkout);
    check(`${command} from a checkout subfolder is answered as a checkout command, not unknown`, report !== undefined && report.message.includes("checkout root") && JSON.stringify(report.advice).includes(checkout), true);
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
  check("an existing directory without app.ts is offered to new-app, not told to gain an app.ts by hand", empty.message.includes("exists but holds no app.ts") && JSON.stringify(empty.advice).includes("new-app") && JSON.stringify(empty.advice).includes("emptyx"), true);
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
