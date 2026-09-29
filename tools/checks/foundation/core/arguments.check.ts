// Checks the one declaration that feeds help text, MCP schemas and argv.
//
// No instance and no target: these are the pure parts of the contract.

import { openclawCommands } from "#framework/commands/interface/index.ts";
import { splitInlineOptions, reportUnknownArgument } from "#framework/entry/cli.ts";
import { inputSchema, toArgv, validate } from "#framework/integration/mcp/server.ts";
import { parseDeclaredArgs, UnknownArgumentError, UnknownActionError, dieUnknownAction } from "#framework/core/arguments.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { renderCommandHelp } from "#framework/core/io/help-render.ts";
import type { CommandArgument } from "#framework/core/app.ts";
import { check, finish } from "#checks/kit/harness.ts";

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

// --- argv --------------------------------------------------------------------

check(
  "an option keeps its name and value",
  toArgv(openclawCommands.pull, { profile: "share" }),
  ["--profile", "share"],
);
check(
  "a positional stays bare and comes first",
  toArgv(openclawCommands.verify, { archive: "/tmp/a b.tar.gz", profile: "migrate" }),
  ["/tmp/a b.tar.gz", "--profile", "migrate"],
);
check("a false flag is omitted", toArgv(openclawCommands.backup, { hot: false }), []);
check("a true flag is passed", toArgv(openclawCommands.backup, { hot: true }), ["--hot"]);
check(
  "confirm waives the terminal prompt",
  toArgv(openclawCommands.push, { confirm: true }),
  ["--force"],
);
check(
  "an explicit force is not doubled",
  toArgv(openclawCommands.push, { confirm: true, force: true }),
  ["--force"],
);

// --- validation --------------------------------------------------------------

check("a good call has no problems", validate(openclawCommands.pull, { profile: "share" }), []);
check(
  "an unknown argument is rejected",
  validate(openclawCommands.status, { bogus: "x" }),
  ["unknown argument: bogus"],
);
check(
  "a value outside the choices is rejected",
  validate(openclawCommands.pull, { profile: "everything" }),
  ["profile must be one of: full, migrate, share"],
);
check(
  "a wrong type is rejected",
  validate(openclawCommands.backup, { hot: "yes" }),
  ["hot takes true or false"],
);
check(
  "a missing required argument is rejected",
  validate(openclawCommands.verify, {}),
  ["archive is required"],
);

// --- variadic: the arguments of another program ---------------------------------------------

const cliSchema = inputSchema(openclawCommands.cli) as {
  properties: Record<string, { type?: string; items?: { type?: string } }>;
  required: string[];
};
check("a variadic argument is an array in the schema", cliSchema.properties.args?.type, "array");
check("its items are strings", cliSchema.properties.args?.items?.type, "string");
check("a required variadic is required", cliSchema.required.includes("args"), true);

check(
  "a variadic list becomes argv in order",
  toArgv(openclawCommands.cli, { confirm: true, args: ["config", "get", "gateway.mode"] }),
  ["config", "get", "gateway.mode"],
);
check(
  "values keep their spaces rather than being re-split",
  toArgv(openclawCommands.cli, { confirm: true, args: ["agent", "-m", "two words"] }),
  ["agent", "-m", "two words"],
);
check("an absent variadic contributes nothing", toArgv(openclawCommands.cli, { confirm: true }), []);

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
check("a missing required variadic is reported", validate(openclawCommands.cli, {}), ["args is required"]);

// --- deploy: every flag deploy.ts actually parses is declared, so --help and MCP agree with it ---

check(
  "deploy declares --adopt alongside --path and --no-bootstrap",
  (openclawCommands.deploy.arguments ?? []).map((argument) => argument.name).sort(),
  ["adopt", "dry-run", "json", "no-bootstrap", "path", "target"],
);
check(
  "--adopt reaches deploy's argv as a bare flag",
  toArgv(openclawCommands.deploy, { confirm: true, target: "user@host", adopt: true }),
  ["user@host", "--adopt"],
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

  check(`${name}: every declared flag/option parses from its own toArgv()`, parses(declared, argv), true);
  check(`${name}: an undeclared flag is refused`, parses(declared, [...argv, "--totally-undeclared-flag"]), false);
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

// --- --opt=value reaches every argv reader as two tokens --------------------------------
check("an inline declared option is split", splitInlineOptions(openclawCommands.apply, ["--set=x", "--dry-run"]), ["--set", "x", "--dry-run"]);
check("an undeclared inline flag is left for the parser to refuse", splitInlineOptions(openclawCommands.apply, ["--bogus=1"]), ["--bogus=1"]);
check("a passthrough command's argv is untouched", splitInlineOptions(openclawCommands.exec, ["--set=x"]), ["--set=x"]);

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

  let printed = "";
  await withOutputSink((chunk) => {
    printed += chunk;
  }, async () => {
    reportUnknownArgument("backup", caught as UnknownArgumentError);
  });
  check("reportUnknownArgument prints the refusal, did-you-mean included", printed.includes("unknown argument: --pth (did you mean --path?)"), true);
  check("reportUnknownArgument points at the command's own --help", printed.includes("run ./clawforge backup --help"), true);
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

  let printed = "";
  await withOutputSink((chunk) => {
    printed += chunk;
  }, async () => {
    reportUnknownArgument("watch", caught as UnknownArgumentError);
  });
  check("reported through the same path as an unknown flag, --help pointer included", printed.includes("run ./clawforge watch --help"), true);
}

check(
  "nothing close enough to any choice adds no guess",
  deathOf(() => dieUnknownAction("bogus", "unknown action: bogus (expected check, install, uninstall, status or test)", [
    "check", "install", "uninstall", "status", "test",
  ])),
  "unknown action: bogus (expected check, install, uninstall, status or test)",
);

finish("argument");
