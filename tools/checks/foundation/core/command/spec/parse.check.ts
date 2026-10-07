// Checks the one declaration that feeds help text, MCP schemas and argv.
//
// No instance and no target: these are the pure parts of the contract.

import { openclawCommands } from "#framework/commands/interface/index.ts";
import { reportUnknownArgument } from "#framework/entry/cli.ts";
import { unknownArgumentMessage } from "#framework/core/command/index.ts";
import { commandLine } from "#framework/core/io/invocation/render.ts";
import { renderCommandHelp } from "#framework/core/io/help-render.ts";
import { inputSchema, toArgv, validate } from "#framework/integration/mcp/server.ts";
import {
  parseDeclaredArgs, parseCall, ArgumentError, UnknownArgumentError, UnknownActionError, dieUnknownAction, specOf, specShape, type CallShape,
} from "#framework/core/command/index.ts";
import { ValueError, type ValueParser } from "#framework/core/values/value.ts";
import { choice, count, text } from "#framework/core/values/kinds.ts";
import type { ValueKind } from "#framework/core/values/kind.ts";
import { argumentsView } from "#framework/core/command/view.ts";
import { commandBody, CommandDeclarationError } from "#framework/core/command/spec.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { ruleText } from "#framework/core/command/parse.ts";
import type { CommandArgument } from "#framework/core/app.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

// Multi-member conflicts render as an exhaustive help restriction, with a final `or`.
{
  const args = ["source", "one", "two", "three"].map((name) => ({ name, description: name, kind: "flag" as const }));
  const text = ruleText({ rule: "conflicts", name: "source", with: ["one", "two", "three"] }, args, {}, { mode: "help" });
  check("three-member conflict help names every member, in order", text.match(/--[a-z]+/g), ["--source", "--one", "--two", "--three"]);
  const words = text.split(" ");
  check("it is one any-of clause", words.filter((word, at) => word === "any" && words[at + 1] === "of").length, 1);
  check("the members are not joined by and", words.includes("and"), false);
  check("the last member follows a final or", words.slice(-2), ["or", "--three"]);
}

// --- every declaration is well formed ----------------------------------------

for (const [name, command] of Object.entries(openclawCommands)) {
  for (const argument of command.arguments ?? []) {
    check(
      `${name}.${argument.name} declares a kind`,
      ["positional", "flag", "option", "variadic"].includes(argument.kind),
      true,
    );
    if (argument.kind === "flag") {
      check(`${name}.${argument.name} flag has no choices`, argument.choices, undefined);
    }
    // Every option renders as `--name <valueName>` in --help and the MCP schema — a
    // missing one used to fall back to the meaningless `--name <value>` every option
    // rendered as before valueName existed.
    if (argument.kind === "option") {
      check(`${name}.${argument.name} option declares a valueName`, typeof argument.valueName, "string");
    }
  }

  // A required positional after an optional one can never be supplied.
  const positionals = (command.arguments ?? []).filter((argument) => argument.kind === "positional");
  let seenOptional = false;
  for (const argument of positionals) {
    if (argument.required !== true) seenOptional = true;
    else if (seenOptional) {
      check(`${name}.${argument.name} required positional comes before optional ones`, false, true);
    }
  }
}

// --- schema ------------------------------------------------------------------

const verifySchema = inputSchema(openclawCommands.verify) as {
  properties: Record<string, { type: string; enum?: string[] }>;
  required: string[];
};
check("an option is a string in the schema", verifySchema.properties.profile.type, "string");
check("choices reach the schema", verifySchema.properties.profile.enum, ["full", "migrate", "share"]);
check("a required argument is marked", verifySchema.required.includes("archive"), true);

const pushSchema = inputSchema(openclawCommands.push) as {
  properties: Record<string, { type: string }>;
  required: string[];
};
check("a flag is a boolean in the schema", pushSchema.properties.force.type, "boolean");
// push declares readOnlyWhen (its own --dry-run) now, so confirm is conditional rather than
// unconditionally required in the static schema — same shape restore/apply/rollback already have.
check("destructive commands with readOnlyWhen make confirm conditional, not statically required", pushSchema.required.includes("confirm"), false);

// --- validation --------------------------------------------------------------

check("a good call has no problems", validate(openclawCommands.pull, { profile: "share" }), []);
check(
  "an unknown argument is rejected",
  validate(openclawCommands.status, { bogus: "x" }),
  ["unknown argument: bogus"],
);
// A spec command's choices and required belong to the parser, not to validate (which
// checks only the form); the refusal comes in the parser's own words at call time.
function formRefusal(run: () => unknown): (Error & { argument?: string }) | undefined {
  try { run(); return undefined; } catch (error) { return error as Error & { argument?: string }; }
}
check("a spec command's validate is form-only: choices left to the parser", validate(openclawCommands.pull, { profile: "everything" }), []);
{
  const error = formRefusal(() => parseCall(specShape(specOf(openclawCommands.pull)!), ["--profile", "everything"], "pull"));
  check("the parser refuses a choice outside the list, in its own words", [error instanceof ArgumentError, error?.argument, error?.message], [true, "profile", '--profile takes one of full, migrate, share, not "everything"']);
}
check(
  "a wrong type is rejected",
  validate(openclawCommands.backup, { hot: "yes" }),
  ["hot takes true or false"],
);
check("a spec command's validate is form-only: required left to the parser", validate(openclawCommands.verify, {}), []);
{
  const error = formRefusal(() => parseCall(specShape(specOf(openclawCommands.verify)!), [], "verify"));
  check("the parser refuses a missing required argument", [error instanceof ArgumentError, error?.argument, error?.message], [true, "archive", "verify needs <archive>"]);
}

// --- variadic: the arguments of another program ---------------------------------------------

const cliSchema = inputSchema(openclawCommands.cli) as {
  properties: Record<string, { type?: string; items?: { type?: string } }>;
  required: string[];
};
check("a variadic argument is an array in the schema", cliSchema.properties.args?.type, "array");
check("its items are strings", cliSchema.properties.args?.items?.type, "string");
check("a required variadic is required", cliSchema.required.includes("args"), true);

check("a well-formed variadic passes validation", validate(openclawCommands.cli, { args: ["status"] }), []);
check(
  "a variadic given a bare string is refused",
  validate(openclawCommands.cli, { args: "status" }),
  ["args takes a list of non-empty strings"],
);
check(
  "a variadic containing a non-string is refused",
  validate(openclawCommands.cli, { args: ["status", 7] }),
  ["args takes a list of non-empty strings"],
);
check(
  "a variadic containing an empty string is refused",
  validate(openclawCommands.cli, { args: ["status", ""] }),
  ["args takes a list of non-empty strings"],
);
// A spec command's required arguments are the parser's, not validate's: the missing-args
// refusal arrives from parseCall in the parser's own words, one stage later (design 4).
check("a missing required variadic is the parser's refusal, not validate's", validate(openclawCommands.cli, {}), []);

// --- deploy: every flag deploy.ts actually parses is declared, so --help and MCP agree with it ---

check(
  "deploy declares --adopt alongside --path and --no-bootstrap",
  (openclawCommands.deploy.arguments ?? []).map((argument) => argument.name).sort(),
  ["adopt", "dry-run", "json", "no-bootstrap", "path", "target"],
);
check(
  "--adopt passes MCP validation",
  validate(openclawCommands.deploy, { target: "user@host", adopt: true }),
  [],
);

// --- generic parser: every declared flag/option round-trips through argv, an undeclared
// one is refused. Run against the same list help/MCP already build from (not against each
// command's own run()), so this catches a declaration/parser drift for every command,
// converted to parseDeclaredArgs or not — an argument a command's run() accepts without
// declaring it (missing from --help and the MCP schema) is exactly this class of bug. ---

function plausibleValue(argument: CommandArgument): unknown {
  if (argument.kind === "flag") return true;
  if (argument.kind === "variadic") return ["x"];
  return argument.choices?.[0] ?? "x";
}

function parses(declared: CommandArgument[], argv: string[]): boolean {
  try {
    parseDeclaredArgs(declared, argv);
    return true;
  } catch {
    return false;
  }
}

for (const [name, command] of Object.entries(openclawCommands)) {
  const declared = command.arguments ?? [];
  const values: Record<string, unknown> = {};
  for (const argument of declared) values[argument.name] = plausibleValue(argument);
  const argv = toArgv(command, values);

  check(`${name}: an undeclared framework flag is refused before passthrough`, parses(declared, ["--totally-undeclared-flag", ...argv]), false);
}

// --- generic parser: --opt=value, a repeated positional, and a missing option value --------
// die() throws rather than exiting, so the message is the observable.
function deathOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

const OPTION_ARG: CommandArgument = { name: "path", description: "d", kind: "option" };
const FLAG_ARG: CommandArgument = { name: "dry-run", description: "d", kind: "flag" };
const POSITIONAL_ARG: CommandArgument = { name: "host", description: "d", kind: "positional" };

check(
  "--opt=value is accepted, the same inline syntax --app= already understood at the gate",
  parseDeclaredArgs([OPTION_ARG], ["--path=/tmp"]),
  { path: "/tmp" },
);
check(
  "--opt value (two tokens) still works",
  parseDeclaredArgs([OPTION_ARG], ["--path", "/tmp"]),
  { path: "/tmp" },
);
check(
  "--flag=value is refused — a flag carries no value to assign, named as such rather than unknown",
  deathOf(() => parseDeclaredArgs([FLAG_ARG], ["--dry-run=x"])),
  "--dry-run is a flag and takes no value",
);
check(
  "--flag=false is refused the same way — a flag is never given a value, true or otherwise",
  deathOf(() => parseDeclaredArgs([FLAG_ARG], ["--dry-run=false"])),
  "--dry-run is a flag and takes no value",
);
check(
  "a second bare positional is refused, not silently replacing the first",
  deathOf(() => parseDeclaredArgs([POSITIONAL_ARG], ["h1", "h2"])),
  "unknown argument: h2",
);
check(
  "an option with nothing after it dies with one consistent message",
  deathOf(() => parseDeclaredArgs([OPTION_ARG], ["--path"])),
  "--path needs a value",
);

// --- generic parser: U6 report table — a value option does not swallow a following
// declared flag/option, a repeated value option is refused, `--` ends option parsing -------

const GREP_ARG: CommandArgument = { name: "grep", description: "d", kind: "option", valueName: "pattern" };
const JSON_ARG: CommandArgument = { name: "json", description: "d", kind: "flag" };
const TAIL_ARG: CommandArgument = { name: "tail", description: "d", kind: "option", valueName: "n" };
const LOGS_ARGS: CommandArgument[] = [GREP_ARG, JSON_ARG, TAIL_ARG];

check(
  "an option does not swallow a following declared flag as its value (report: logs --grep --json)",
  deathOf(() => parseDeclaredArgs(LOGS_ARGS, ["--grep", "--json"])),
  "--grep needs a value",
);
check(
  "...naming the option that needed the value, not the one it would have swallowed",
  deathOf(() => parseDeclaredArgs(LOGS_ARGS, ["--tail", "--grep", "x"])),
  "--tail needs a value",
);
check(
  "a value that legitimately starts with - still works via the inline =value form",
  parseDeclaredArgs(LOGS_ARGS, ["--grep=-x"]),
  { grep: "-x" },
);
check(
  "a value shaped like a flag but not a DECLARED one is still taken literally, unchanged",
  parseDeclaredArgs(LOGS_ARGS, ["--grep", "-x"]),
  { grep: "-x" },
);
check(
  "and the same holds for a token that merely looks like a long option of another command",
  parseDeclaredArgs(LOGS_ARGS, ["--grep", "--not-declared-here"]),
  { grep: "--not-declared-here" },
);

check(
  "a repeated value option is refused (report: --tail 5 --tail 6 silently kept 6)",
  deathOf(() => parseDeclaredArgs(LOGS_ARGS, ["--tail", "5", "--tail", "6"])),
  "--tail given more than once",
);
check(
  "...the same whether the first occurrence was inline or two tokens",
  deathOf(() => parseDeclaredArgs(LOGS_ARGS, ["--tail=5", "--tail", "6"])),
  "--tail given more than once",
);
check(
  "a repeated FLAG is unaffected — no repeatable notion exists, and none is added for flags",
  parseDeclaredArgs(LOGS_ARGS, ["--json", "--json"]),
  { json: true },
);

check(
  "a bare -- ends option parsing: everything after is positional, flag-shaped or not",
  parseDeclaredArgs([POSITIONAL_ARG], ["--", "--not-a-flag"]),
  { host: "--not-a-flag" },
);
check(
  "-- alone, with nothing after, is consumed without becoming a positional itself",
  parseDeclaredArgs([FLAG_ARG], ["--"]),
  {},
);
check(
  "a command that declares no positional/variadic still refuses the token after --, as today",
  deathOf(() => parseDeclaredArgs([FLAG_ARG], ["--", "extra"])),
  "unknown argument: extra",
);
check(
  "--tail=-1 is accepted by the parser — a negative-looking inline value is the command's own to refuse",
  parseDeclaredArgs([TAIL_ARG], ["--tail=-1"]),
  { tail: "-1" },
);

// --- generic parser: U6 report — a flag declared only for another action of the same
// multi-action command (backup) names that action instead of "unknown argument" -------------

const KEEP_ARG: CommandArgument = { name: "keep", description: "d", kind: "option", valueName: "n", actions: ["prune-replaced"] };
const APPLY_ARG: CommandArgument = { name: "apply", description: "d", kind: "flag", actions: ["prune-replaced", "install", "uninstall"] };
const LIST_ONLY_ARGS: CommandArgument[] = [JSON_ARG];

check(
  "a flag declared only for another action names that action, not 'unknown' (report: backup list --keep)",
  deathOf(() => parseDeclaredArgs(LIST_ONLY_ARGS, ["--keep", "3"], { action: "list", siblings: [...LIST_ONLY_ARGS, KEEP_ARG] })),
  "--keep applies to `prune-replaced`, not `list`",
);
check(
  "an argument shared by several actions lists every one of them",
  deathOf(() => parseDeclaredArgs(LIST_ONLY_ARGS, ["--apply"], { action: "list", siblings: [...LIST_ONLY_ARGS, APPLY_ARG] })),
  "--apply applies to `prune-replaced`, `install`, `uninstall`, not `list`",
);
check(
  "with no scope, the same call falls back to the plain unknown-argument refusal",
  deathOf(() => parseDeclaredArgs(LIST_ONLY_ARGS, ["--keep", "3"])),
  "unknown argument: --keep",
);

// The report's own case, through the real declaration backup wires up (not a stand-in) —
// BACKUP_LIST_ARGUMENTS/BACKUP_ALL_ARGUMENTS are what backup/index.ts and list.ts actually
// parse against, so this fails if the real wiring (not just the mechanism above) drifts.
{
  const listArgs = openclawCommands.backup.arguments ?? [];
  check(
    "backup declares --keep only for prune-replaced in its merged declaration",
    listArgs.find((argument) => argument.name === "keep")?.actions,
    ["prune-replaced"],
  );
}

// --- help-render: `backup --help` groups a multi-action command's flags by action -----------

{
  let printed = "";
  await withOutputSink((chunk) => {
    printed += chunk;
  }, async () => {
    renderCommandHelp("backup", openclawCommands.backup);
  });
  check("--keep's help line names the one action it applies to", /--keep <n>\s+.*\(prune-replaced\)/.test(printed), true);
  check("--interval's help line names install, not every action", /--interval <interval>\s+.*\(install\)/.test(printed), true);
  check(
    "--apply's help line lists every action that shares it",
    /--apply\s+.*\(prune-replaced, install, uninstall\)/.test(printed),
    true,
  );
  // An argument with no `actions` (json, hot, break-lock…) prints exactly as before — no
  // stray "()" from an empty group.
  check("an argument with no actions field gets no parenthetical group at all", printed.includes("()"), false);
}

// --- unknown argument: a did-you-mean guess, and entry/cli.ts's --help pointer -----------

check(
  "an unknown flag close to a declared one gets a did-you-mean suggestion",
  deathOf(() => parseDeclaredArgs([OPTION_ARG, FLAG_ARG], ["--pth", "/tmp"])),
  "unknown argument: --pth (did you mean --path?)",
);
check(
  "nothing close enough suggests nothing",
  deathOf(() => parseDeclaredArgs([OPTION_ARG, FLAG_ARG], ["--totally-unrelated"])),
  "unknown argument: --totally-unrelated",
);
check(
  "a bare positional overflow gets no suggestion — only --flag typos do",
  deathOf(() => parseDeclaredArgs([POSITIONAL_ARG], ["h1", "h2"])),
  "unknown argument: h2",
);

{
  let caught: unknown;
  try {
    parseDeclaredArgs([OPTION_ARG], ["--pth", "/tmp"]);
  } catch (error) {
    caught = error;
  }
  check("parseDeclaredArgs throws UnknownArgumentError, not a plain UserError", caught instanceof UnknownArgumentError, true);

  const backupPointer = `run ${commandLine(["backup", "--help"])}`;
  let printed = "";
  await withOutputSink((chunk) => {
    printed += chunk;
  }, async () => {
    reportUnknownArgument("backup", caught as UnknownArgumentError);
  });
  check("reportUnknownArgument prints the refusal, did-you-mean included", printed.includes(unknownArgumentMessage("--pth", "--path")), true);
  check("reportUnknownArgument points at the command's own --help", printed.includes(backupPointer), true);
}

// --- dieUnknownAction: parity for a sub-action dispatcher's own unknown-action refusal ------
//
// watch/set/recipe/expose each write their own "unknown action: X (expected ...)" message by
// hand — dieUnknownAction only needs to add the did-you-mean guess and pick an error type
// entry/cli.ts's existing UnknownArgumentError catch already recognises, so the --help
// pointer reportUnknownArgument prints above comes for free once one of these throws.

{
  let caught: unknown;
  try {
    dieUnknownAction("insatll", "unknown action: insatll (expected check, install, uninstall, status or test)", [
      "check", "install", "uninstall", "status", "test",
    ]);
  } catch (error) {
    caught = error;
  }
  check("dieUnknownAction throws an UnknownActionError", caught instanceof UnknownActionError, true);
  check("and it is an UnknownArgumentError too, so cli.ts's existing catch fires", caught instanceof UnknownArgumentError, true);
  check(
    "the message keeps the site's own wording and adds a did-you-mean guess",
    (caught as Error).message,
    "unknown action: insatll (expected check, install, uninstall, status or test) (did you mean install?)",
  );

  const watchPointer = `run ${commandLine(["watch", "--help"])}`;
  let printed = "";
  await withOutputSink((chunk) => {
    printed += chunk;
  }, async () => {
    reportUnknownArgument("watch", caught as UnknownArgumentError);
  });
  check("reported through the same path as an unknown flag, --help pointer included", printed.includes(watchPointer), true);
}

check(
  "nothing close enough to any choice adds no guess",
  deathOf(() => dieUnknownAction("bogus", "unknown action: bogus (expected check, install, uninstall, status or test)", [
    "check", "install", "uninstall", "status", "test",
  ])),
  "unknown action: bogus (expected check, install, uninstall, status or test)",
);

// --- multi-action commands are declared bodies ----------------------------------------------------
// R29-04: `watch status --interval` was offered by completion/--help/the MCP schema and then refused.
// A body's actions parse their own declared slices (the derived view and parseCall read the same
// declaration), so declared = accepted holds by construction; a multi-action command that is not a
// body would bring the hand-kept slice table back. Per-action cases live in the groups' own checks.

for (const [name, command] of Object.entries(openclawCommands)) {
  const actionArgument = (command.arguments ?? []).find((argument) => argument.kind === "positional" && argument.name === "action");
  if (actionArgument?.choices === undefined) continue;
  check(`${name}: a multi-action command is a spec command`, specOf(command) !== undefined, true);
}

// --- parseCall: tokenize + bind + the action word (design 1.5) ------------------------------------

function refusal(run: () => unknown): Error | undefined {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  return undefined;
}
const argumentOf = (error: unknown): string | undefined => (error instanceof ArgumentError ? error.argument : undefined);

const SINGLE: CallShape = {
  arguments: [
    { name: "file", kind: "positional", description: "d", required: true, value: text("d", { leadingDash: "allow" }) },
    { name: "n", kind: "option", valueName: "n", description: "d", value: count("a number of lines") },
    { name: "mode", kind: "option", valueName: "m", description: "d", value: choice(["a", "b"]) },
    { name: "verbose", kind: "flag", description: "d" },
  ],
};
check("values are typed; a flag absent is false", parseCall(SINGLE, ["f", "--n", "3"]).values, { file: "f", n: 3, verbose: false });
check("given lists flags and options in typing order", parseCall(SINGLE, ["--verbose", "f", "--n=3"]).given, ["verbose", "n"]);
check("given keeps every occurrence of a flag", parseCall(SINGLE, ["f", "--verbose", "--verbose"]).given, ["verbose", "verbose"]);
check("an inline value is taken literally", parseCall(SINGLE, ["f", "--mode=a"]).values.mode, "a");
{
  const error = refusal(() => parseCall(SINGLE, ["f", "--n", "abc"]));
  check("a parse refusal is an ArgumentError naming the argument", [error instanceof ArgumentError, argumentOf(error)], [true, "n"]);
  check("its text is the parser's clause after the label", error?.message, '--n takes a number of lines, not "abc"');
  check("a ValueError never escapes bind", error instanceof ValueError, false);
}
{
  const error = refusal(() => parseCall(SINGLE, ["f", "--mode=c"]));
  check("choices: an ArgumentError naming the argument", argumentOf(error), "mode");
  check("choices: the closed list is the text", error?.message, '--mode takes one of a, b, not "c"');
}
check("given values are bound in typing order: n first", argumentOf(refusal(() => parseCall(SINGLE, ["f", "--n=x", "--mode=c"]))), "n");
check("given values are bound in typing order: mode first", argumentOf(refusal(() => parseCall(SINGLE, ["f", "--mode=c", "--n=x"]))), "mode");
{
  const error = refusal(() => parseCall(SINGLE, ["f", "--mode="]));
  check("an empty value without a parser is refused, naming the argument", [argumentOf(error), error?.message], ["mode", "--mode needs a value"]);
}
{
  const error = refusal(() => parseCall(SINGLE, [], "x"));
  check("a missing required argument is named", [argumentOf(error), error?.message], ["file", "x needs <file>"]);
}
check("a refused given value comes before a missing required one", argumentOf(refusal(() => parseCall(SINGLE, ["--n=x"]))), "n");
check("required are reported in declaration order", argumentOf(refusal(() => parseCall({
  arguments: [
    { name: "a", kind: "option", valueName: "a", description: "d", required: true, value: count() },
    { name: "b", kind: "positional", description: "d", required: true, value: text("d", { leadingDash: "allow" }) },
  ],
}, []))), "a");
check("an option left without a value is an ArgumentError", argumentOf(refusal(() => parseCall(SINGLE, ["f", "--n"]))), "n");
check("an option's value is not another declared flag", refusal(() => parseCall(SINGLE, ["f", "--n", "--verbose"]))?.message, "--n needs a value");
check("a repeated option is refused", argumentOf(refusal(() => parseCall(SINGLE, ["f", "--n=1", "--n=2"]))), "n");
check("--flag=value is refused, naming the flag", argumentOf(refusal(() => parseCall(SINGLE, ["f", "--verbose=1"]))), "verbose");
check("an unknown flag is an UnknownArgumentError", refusal(() => parseCall(SINGLE, ["f", "--nope"])) instanceof UnknownArgumentError, true);
check("a bare -- ends options", parseCall(SINGLE, ["--", "--verbose"]).values.file, "--verbose");

const throwing = (error: Error): ValueParser<string> => ({ expected: "x", example: "x", invalidExample: "y", parse: () => { throw error; } });
const asKind = (parser: ValueParser<string>): ValueKind<string> => ({ ...parser, kind: "text", invalid: [{ raw: parser.invalidExample, stage: "parse", why: "the parser's own invalid example" }] });
const withParser = (parse: ValueParser<string>): CallShape => ({ arguments: [{ name: "p", kind: "option", valueName: "p", description: "d", value: asKind(parse) }] });
check("a parser's ValueError becomes an ArgumentError", refusal(() => parseCall(withParser(throwing(new ValueError("is wrong"))), ["--p=1"]))?.message, "--p is wrong");
check("a clause starting with : attaches to the label", refusal(() => parseCall(withParser(throwing(new ValueError(": because"))), ["--p=1"]))?.message, "--p: because");
check("a non-ValueError from a parser is not swallowed", refusal(() => parseCall(withParser(throwing(new RangeError("bug"))), ["--p=1"])) instanceof RangeError, true);

const MULTI: CallShape = {
  actions: {
    list: { arguments: [{ name: "json", kind: "flag", description: "d" }] },
    create: { arguments: [{ name: "dry-run", kind: "flag", description: "d" }, { name: "profile", kind: "option", valueName: "p", description: "d", value: choice(["full", "share"]) }] },
    forget: { arguments: [{ name: "kind", kind: "option", valueName: "kind", description: "d", required: true, value: choice(["agent", "cron-job"]) }] },
  },
  defaultAction: "create",
};
check("an action word picks the action", parseCall(MULTI, ["list", "--json"]).action, "list");
check("an action's values are its own", parseCall(MULTI, ["list", "--json"]).values, { json: true });
check("no word takes the default action with the whole argv", [parseCall(MULTI, []).action, parseCall(MULTI, ["--dry-run"]).action, parseCall(MULTI, ["--dry-run"]).given], ["create", "create", ["dry-run"]]);
check("a leading -- takes the default action too", parseCall(MULTI, ["--"]).action, "create");
check("the default action may be named", parseCall(MULTI, ["create", "--profile=share"]).values.profile, "share");
{
  const error = refusal(() => parseCall(MULTI, ["lst"], "backup"));
  check("an unknown word is an UnknownActionError naming 'action'", [error instanceof UnknownActionError, error instanceof UnknownArgumentError, argumentOf(error)], [true, true, "action"]);
  check("it lists the actions and guesses", error?.message, "unknown action: lst (expected list, create, forget) (did you mean list?)");
}
{
  const error = refusal(() => parseCall({ actions: MULTI.actions }, [], "set"));
  check("without a default the word is required", [error instanceof UnknownActionError, argumentOf(error)], [true, "action"]);
  check("and the text lists the actions", error?.message, "set needs an action: list, create, forget");
  check("a flag first is not an action word either", refusal(() => parseCall({ actions: MULTI.actions }, ["--json"], "set")) instanceof UnknownActionError, true);
}
{
  const error = refusal(() => parseCall(MULTI, ["list", "--dry-run"]));
  check("a flag of another action: UnknownArgumentError naming the flag", [error instanceof UnknownArgumentError, argumentOf(error)], [true, "dry-run"]);
  check("its text names both actions", error?.message, "--dry-run applies to `create`, not `list`");
  check("the default action is held to its own flags", refusal(() => parseCall(MULTI, ["--json"]))?.message, "--json applies to `list`, not `create`");
}
check("a flag nobody declares is plain unknown", refusal(() => parseCall(MULTI, ["list", "--zzz"]))?.message, "unknown argument: --zzz");
{
  const error = refusal(() => parseCall(MULTI, ["forget"], "set"));
  check("a required option of an action: named with command and action", [argumentOf(error), error?.message], ["kind", "set forget needs --kind <kind>"]);
}
check("a choice of an action is enforced", argumentOf(refusal(() => parseCall(MULTI, ["forget", "--kind=x"]))), "kind");

const VARIADIC: CallShape = {
  arguments: [
    { name: "context", kind: "positional", description: "d", required: true, value: text("d", { leadingDash: "allow" }) },
    { name: "root", kind: "flag", description: "d" },
    { name: "args", kind: "variadic", verbatim: true, description: "d", required: true, value: text("d", { leadingDash: "allow" }) },
  ],
};
check("a variadic starts at the first undeclared token", parseCall(VARIADIC, ["target", "--root", "ls", "-la"]).values, { context: "target", root: true, args: ["ls", "-la"] });
check("after it everything is literal, declared flags too", parseCall(VARIADIC, ["target", "ls", "--root"]).values, { context: "target", root: false, args: ["ls", "--root"] });
check("an undeclared flag starts the variadic", parseCall(VARIADIC, ["target", "--version"]).values.args, ["--version"]);
check("everything after -- is the variadic", parseCall(VARIADIC, ["target", "--", "--root"]).values, { context: "target", root: false, args: ["--root"] });
check("a -- after the variadic started is literal", parseCall(VARIADIC, ["target", "ls", "--", "x"]).values.args, ["ls", "--", "x"]);
check("a variadic alone takes a leading flag-looking token", parseCall({ arguments: [{ name: "args", kind: "variadic", verbatim: true, description: "d", value: text("d", { leadingDash: "allow" }) }] }, ["--foo", "bar"]).values.args, ["--foo", "bar"]);
check("an absent variadic is []", parseCall({ arguments: [{ name: "args", kind: "variadic", description: "d", value: text("d", { leadingDash: "allow" }) }] }, []).values.args, []);
check("a required variadic must be given", argumentOf(refusal(() => parseCall(VARIADIC, ["target"]))), "args");

// Without `verbatim` a variadic only collects free tokens: flags and options stay recognized anywhere.
const COLLECTING: CallShape = {
  arguments: [
    { name: "from", kind: "option", valueName: "x", description: "d", value: text("d", { leadingDash: "allow" }) },
    { name: "json", kind: "flag", description: "d" },
    { name: "files", kind: "variadic", description: "d", value: text("d", { leadingDash: "allow" }) },
  ],
};
check("a collecting variadic reads a flag after its tokens", parseCall(COLLECTING, ["a", "b", "--json"]).values, { json: true, files: ["a", "b"] });
check("a collecting variadic reads an option between its tokens", parseCall(COLLECTING, ["a", "--from", "x", "b"]).values, { from: "x", json: false, files: ["a", "b"] });
check("a collecting variadic still refuses an undeclared flag", refusal(() => parseCall(COLLECTING, ["a", "--nope"])) instanceof UnknownArgumentError, true);
check("a collecting variadic ends options at --", parseCall(COLLECTING, ["a", "--", "--json"]).values, { json: false, files: ["a", "--json"] });
check("parseDeclaredArgs keeps refusing an undeclared flag before a variadic", refusal(() => parseDeclaredArgs(VARIADIC.arguments as CommandArgument[], ["target", "--version"])) instanceof UnknownArgumentError, true);

// --- refuse: exact tokens refused with their own reason, ahead of tokenizing ----------------------
{
  const REASON = "never that — here is why";
  const SINGLE = { effect: "read", arguments: [{ name: "go", kind: "flag", description: "d" }], refuse: { "--bad": REASON, bad: REASON } } as const;
  for (const argv of [["--bad"], ["bad"], ["--go", "--bad"]]) {
    const error = refusal(() => parseCall(SINGLE, argv));
    check(`refuse: ${argv.join(" ")} is an ArgumentError with the reason`, [error instanceof ArgumentError, error instanceof UnknownArgumentError, (error as Error).message], [true, false, REASON]);
    check(`refuse: ${argv.join(" ")} names the token without dashes`, argumentOf(error), "bad");
  }
  check("refuse: after a bare -- the token is not refused (it is only an unknown positional)", refusal(() => parseCall(SINGLE, ["--", "bad"])) instanceof UnknownArgumentError, true);
  // R9-2: the inline spelling of a refused flag carries the same reason, not unknown-argument.
  {
    const error = refusal(() => parseCall(SINGLE, ["--bad=1"]));
    check("refuse: --bad=1 is an ArgumentError with the reason", [error instanceof ArgumentError, error instanceof UnknownArgumentError, (error as Error).message], [true, false, REASON]);
    check("refuse: --bad=1 names the token without dashes", argumentOf(error), "bad");
  }
  check("refuse: after a bare -- even the inline spelling is not refused", refusal(() => parseCall(SINGLE, ["--", "--bad=1"])) instanceof UnknownArgumentError, true);
  check("refuse: an exact --bad is still refused", (refusal(() => parseCall(SINGLE, ["--bad"])) as Error).message, REASON);
  check("refuse: an unrelated inline value is not a refusal", refusal(() => parseCall(SINGLE, ["--nope=1"])) instanceof UnknownArgumentError, true);
  check("refuse: an unrelated token parses", parseCall(SINGLE, ["--go"]).values.go, true);
  const ACTIONS = { effect: "read", actions: { one: { arguments: [], refuse: { zap: REASON } }, two: { arguments: [] } } } as const;
  check("refuse: an action's own token is refused", (refusal(() => parseCall(ACTIONS, ["one", "zap"])) as Error).message, REASON);
  check("refuse: another action does not inherit it", refusal(() => parseCall(ACTIONS, ["two", "zap"])) instanceof UnknownArgumentError, true);
  // A token the tokenizer binds as an option's value is never refused, whatever it spells.
  {
    const WITH_OPTION = { effect: "read", arguments: [{ name: "holder", kind: "option", valueName: "h", description: "d", value: text("d", { leadingDash: "allow" }) }, { name: "go", kind: "flag", description: "d" }], refuse: { "--bad": REASON, bad: REASON } } as const;
    check("refuse: a refused word bound as an option's value parses", parseCall(WITH_OPTION, ["--holder", "bad"]).values.holder, "bad");
    check("refuse: a refused flag spelling bound as an option's value parses", parseCall(WITH_OPTION, ["--holder", "--bad"]).values.holder, "--bad");
    check("refuse: the inline value spelling parses", parseCall(WITH_OPTION, ["--holder=bad"]).values.holder, "bad");
    check("refuse: the same word standing alone is still refused", (refusal(() => parseCall(WITH_OPTION, ["--holder", "x", "bad"])) as Error).message, REASON);
    const real = specShape(specOf(openclawCommands.expose!)!);
    const holder = parseCall(real, ["tailscale", "--break-foreign-lock", "funnel"]);
    check("refuse: expose tailscale --break-foreign-lock funnel binds funnel as the lock holder", holder.values["break-foreign-lock"], "funnel");
    check("refuse: expose tailscale funnel is still refused", (refusal(() => parseCall(real, ["tailscale", "funnel"])) as Error).message.includes("never runs `tailscale funnel`"), true);
  }
  check("refuse: the funnel tokens are not arguments of expose", (openclawCommands.expose!.arguments ?? []).some((argument) => argument.name.includes("funnel")), false);
}

// --- declared value kinds on the spec (S2.4): the binder converts through the kind, the view
// projects it into the legacy CommandArgument shape, and a declaration may not carry both ----

const KINDS: CallShape = {
  arguments: [
    { name: "n", kind: "option", valueName: "n", description: "d", value: count("a non-negative integer") },
    { name: "mode", kind: "option", valueName: "m", description: "d", value: choice(["full", "share"]) },
  ],
};
check("a value kind's parsed type reaches the values", parseCall(KINDS, ["--n", "3"]).values.n, 3);
{
  const error = refusal(() => parseCall(KINDS, ["--n", "abc"]));
  check("a kind's parse error surfaces as an ArgumentError naming the argument", [error instanceof ArgumentError, argumentOf(error)], [true, "n"]);
  check("its text is the kind's clause after the label", error?.message?.split(" "), ["--n", "takes", "a", "non-negative", "integer,", "not", "\"abc\""]);
}
{
  const error = refusal(() => parseCall(KINDS, ["--mode="]));
  checkTrue("a choice kind refuses an empty value naming the argument", argumentOf(error) === "mode");
  check("a choice kind refuses an empty value like the legacy branch", error?.message?.split(" "), ["--mode", "needs", "a", "value"]);
}
{
  const error = refusal(() => parseCall(KINDS, ["--mode=everything"]));
  checkTrue("a choice kind refuses an outsider naming the argument", argumentOf(error) === "mode");
  check("a choice kind refuses an outsider with the choicesRefusal text", error?.message?.split(" "), ["--mode", "takes", "one", "of", "full,", "share,", "not", "\"everything\""]);
}
{
  const declare = (argument: object): unknown => {
    try {
      commandBody({ effect: "read", arguments: [argument] as never, run: async () => {} });
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const optionMissing = declare({ name: "x", kind: "option", valueName: "x", description: "d" }) as CommandDeclarationError | undefined;
  check("an option with no value kind is a declaration error", optionMissing instanceof CommandDeclarationError, true);
  check("its problem code is kind-missing", optionMissing?.problem, "kind-missing");
  const positionalMissing = declare({ name: "x", kind: "positional", description: "d" }) as CommandDeclarationError | undefined;
  check("a positional with no value kind is kind-missing too", positionalMissing instanceof CommandDeclarationError && positionalMissing.problem, "kind-missing");
}
{
  const KIND_BODY = commandBody({
    effect: "read",
    arguments: [
      { name: "n", kind: "option", valueName: "n", description: "d", value: count("a number of lines") },
      { name: "mode", kind: "option", valueName: "m", description: "d", value: choice(["full", "share"]) },
    ],
    run: async () => {},
  });
  const viewed = argumentsView(KIND_BODY);
  const n = viewed.find((argument) => argument.name === "n") as CommandArgument;
  const mode = viewed.find((argument) => argument.name === "mode") as CommandArgument;
  check("the view projects a kind as parse (it is a ValueParser)", [n.parse !== undefined && typeof (n.parse as ValueParser<number>).parse, Object.hasOwn(n, "value")], ["function", false]);
  check("the view projects a choice kind as its list, with no parse and no value", [mode.choices, mode.parse, Object.hasOwn(mode, "value")], [["full", "share"], undefined, false]);
}

finish("argument");
