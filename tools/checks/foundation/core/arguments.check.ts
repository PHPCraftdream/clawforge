// Checks the one declaration that feeds help text, MCP schemas and argv.
//
// No instance and no target: these are the pure parts of the contract.

import { openclawCommands } from "#framework/commands/interface/index.ts";
import { reportUnknownArgument } from "#framework/entry/cli.ts";
import { inputSchema, toArgv, validate, schemaArgumentDescription } from "#framework/integration/mcp/server.ts";
import { parseDeclaredArgs, UnknownArgumentError, UnknownActionError, dieUnknownAction, NO_ACTION } from "#framework/core/arguments.ts";
import { BACKUP_ACTION_ARGUMENTS } from "#framework/commands/lifecycle/backup/index.ts";
import { RECIPE_ACTION_ARGUMENTS, validateRecipeArgs } from "#framework/commands/management/recipe/arguments.ts";
import { EXPOSE_ACTION_ARGUMENTS } from "#framework/commands/operate/expose/index.ts";
import { WATCH_ACTION_ARGUMENTS } from "#framework/commands/operate/watch/index.ts";
import { SET_ACTION_ARGUMENTS } from "#framework/commands/interface/groups/openclawCommands.sets.ts";
import { buildCompletionModel, renderCompletion } from "#framework/integration/completion.ts";
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

// --- multi-action commands: declared per-action flags equal what each parser accepts -------
// R29-04: `watch status --interval`, `backup list --hot` were offered by completion/--help/the MCP
// schema and then refused. Each command registers the argument slice every action parses with;
// its declaration is derived from that (scopeByAction), and this drives the real parsers.

{
  type Slices = Readonly<Record<string, readonly CommandArgument[]>>;

  // A new multi-action command must register here, or this check fails for it.
  const REGISTRY: Readonly<Record<string, Slices>> = {
    backup: BACKUP_ACTION_ARGUMENTS,
    recipe: RECIPE_ACTION_ARGUMENTS,
    expose: EXPOSE_ACTION_ARGUMENTS,
    watch: WATCH_ACTION_ARGUMENTS,
    set: SET_ACTION_ARGUMENTS,
  };

  const isNamed = (argument: CommandArgument): boolean => argument.kind === "flag" || argument.kind === "option";

  function tokens(argument: CommandArgument): string[] {
    return argument.kind === "option" ? [`--${argument.name}`, "x"] : [`--${argument.name}`];
  }

  /** Whether the real parser for `action` takes `argument` (syntactically). */
  function accepts(command: string, action: string, slice: readonly CommandArgument[], argument: CommandArgument): boolean {
    try {
      if (command === "recipe") validateRecipeArgs(action, tokens(argument));
      else parseDeclaredArgs(slice, tokens(argument));
      return true;
    } catch {
      return false;
    }
  }

  const completion = new Map(buildCompletionModel([]).map((spec) => [spec.name, spec]));

  for (const [name, command] of Object.entries(openclawCommands)) {
    const actionArgument = (command.arguments ?? []).find((argument) => argument.kind === "positional" && argument.name === "action");
    if (actionArgument?.choices === undefined) continue;
    const slices = REGISTRY[name];
    check(`${name} has actions and registers what each action's parser accepts`, slices !== undefined, true);
    if (slices === undefined) continue;

    const choices = [...actionArgument.choices];
    // Since R30-05 NO_ACTION is the real action word `create` — a registry key AND a choice,
    // so no key is filtered out here.
    const registered = Object.keys(slices);
    check(`${name}: registered actions equal the action choices`, [...registered].sort(), [...choices].sort());

    const declared = (command.arguments ?? []).filter(isNamed);
    const known = new Map<string, CommandArgument>();
    for (const slice of Object.values(slices)) for (const argument of slice.filter(isNamed)) known.set(argument.name, argument);
    check(`${name}: every declared flag is taken by some action`, declared.filter((argument) => !known.has(argument.name)).map((argument) => argument.name), []);

    for (const action of Object.keys(slices)) {
      const slice = slices[action];
      const label = `${name} ${action === NO_ACTION ? "(no action)" : action}`;
      const shown = declared
        .filter((argument) => argument.actions === undefined || argument.actions.includes(action))
        .map((argument) => argument.name)
        .sort();
      const parsed = [...known.values()].filter((argument) => accepts(name, action, slice, argument)).map((argument) => argument.name).sort();
      check(`${label}: declared flags equal what its parser accepts`, shown, parsed);

      const offered = completion.get(name)?.action?.flags[action];
      if (action !== NO_ACTION) {
        check(
          `${label}: completion offers exactly those flags`,
          (offered ?? []).filter((flag) => flag !== "--help").sort(),
          shown.map((flag) => `--${flag}`),
        );
      }
    }
  }
}

// --- R30-04: set's actions each parse their own slice of the declaration --------------------
//
// The dispatcher (set.ts) takes each action's slice from the same SET_ACTION_ARGUMENTS table
// the declaration is derived from — so the check below drives the REAL run (stub context:
// every refusal dies in the parser, before any context use) and demands a non-parse refusal
// for the flags the action does accept. Mis-declaring the table (the registry checking
// itself, the R30-04 hole) fails these, because the real parser would then take the flag.

{
  const setRun = openclawCommands.set.run!;
  const outcome = async (argv: string[]): Promise<string> => {
    try {
      await setRun({} as Parameters<typeof setRun>[0], argv);
      return "no error";
    } catch (error) {
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  };

  check(
    "set build --set is refused at parse, naming the actions that take it",
    (await outcome(["build", "--set", "x.tar.gz"])).includes("--set applies to `validate`, `try`, not `build`"),
    true,
  );
  check("set build --kind is refused at parse", (await outcome(["build", "--kind", "agent"])).includes("--kind applies to `forget`"), true);
  check("set validate --kind is refused at parse", (await outcome(["validate", "--kind", "agent"])).includes("--kind applies to `forget`"), true);
  check("set forget --json is refused at parse", (await outcome(["forget", "--json"])).includes("--json applies to `build`"), true);
  check(
    "set validate --set still reaches the artifact reader — the parser accepted it",
    (await outcome(["validate", "--set", "missing.tar.gz"])).startsWith("UserError:"),
    true,
  );
  check(
    "set forget parses its own slice — dies on the missing --kind, not on parsing",
    (await outcome(["forget"])).includes("usage: ./clawforge set forget"),
    true,
  );
  check("a mistyped set action still gets the did-you-mean", (await outcome(["bild"])).includes("did you mean build?"), true);
}

// --- R30-05: backup's `create` is a real action word -----------------------------------------

{
  const backupRun = openclawCommands.backup.run!;
  const outcome = async (argv: string[]): Promise<string> => {
    try {
      await backupRun({} as Parameters<typeof backupRun>[0], argv);
      return "no error";
    } catch (error) {
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  };

  check(
    "backup create --dry-run parses — dies later, on the plan's context, not on `create`",
    (await outcome(["create", "--dry-run"])).startsWith("TypeError:"),
    true,
  );
  check("a bare create parses exactly the same way", (await outcome(["--dry-run"])).startsWith("TypeError:"), true);
  check("backup lst suggests list", (await outcome(["lst"])).includes("did you mean list?"), true);
  check(
    "backup --keep 3 names the action --keep belongs to",
    (await outcome(["--keep", "3"])).includes("--keep applies to `prune-replaced`, not `create`"),
    true,
  );
  check("backup list --hot names create", (await outcome(["list", "--hot"])).includes("--hot applies to `create`, not `list`"), true);

  const model = new Map(buildCompletionModel([]).map((spec) => [spec.name, spec]));
  const backupSpec = model.get("backup")!;
  check("completion offers create as an action word", backupSpec.action!.values.includes("create"), true);
  check(
    "completion offers the create flags under create",
    backupSpec.action!.flags.create,
    ["--dry-run", "--help", "--hot", "--migrate", "--native", "--profile", "--share", "--with-secrets"],
  );
  check(
    "the no-action fallback offers the create flags, not just --help",
    backupSpec.action!.fallback.includes("--hot") && backupSpec.action!.fallback.includes("--dry-run"),
    true,
  );
  const bash = renderCompletion("bash", buildCompletionModel([]), false);
  check("bash's *) arm after an action word offers the create fallback", /\*\) COMPREPLY=\( \$\(compgen -W "[^"]*--hot[^"]*"/.test(bash), true);
  const pwsh = renderCompletion("pwsh", buildCompletionModel([]), false);
  check("pwsh's fallback flag list offers the create flags", pwsh.includes('"backup" = @("--dry-run", "--help", "--hot"'), true);
}

// --- R30-06: no MCP schema description ends mid-phrase ----------------------------------------

{
  // Same word class shortenDescription drops; a description ending on one means the cut
  // landed mid-phrase (or the source text itself dangles).
  const dangling = / (of|is|are|a|an|the|or|and|to|for|with|on|instead|than|that|from|by|at|as|be)$/i;
  const offenders: string[] = [];
  for (const [name, command] of Object.entries(openclawCommands)) {
    for (const argument of command.arguments ?? []) {
      const description = schemaArgumentDescription(argument);
      if (description === undefined) continue;
      // The action suffix and value hint are appended after the shortening — judge the text.
      const bare = description.replace(/\s*\([^()]*\)$/, "").trim();
      if (dangling.test(bare)) offenders.push(`${name}.${argument.name}: ${description}`);
    }
  }
  check("no schema description ends on a dangling word", offenders, []);

  const backupSchema = inputSchema(openclawCommands.backup) as { properties: Record<string, { description?: string }> };
  check("backup.action's schema text keeps the whole action list", backupSchema.properties.action.description, "list, prune-replaced, install, uninstall or create");
  check(
    "backup.interval keeps the explicit-unit rule",
    (backupSchema.properties.interval.description ?? "").includes("explicit unit required"),
    true,
  );
  const watchSchema = inputSchema(openclawCommands.watch) as { properties: Record<string, { description?: string }> };
  check(
    "watch.interval keeps what a bare number means",
    (watchSchema.properties.interval.description ?? "").includes("a bare number is minutes"),
    true,
  );
}

finish("argument");
