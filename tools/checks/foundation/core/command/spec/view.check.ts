// The per-action slices of multi-action commands (set, backup): each action parses its own
// slice, the declaration shown in --help/completion/MCP is derived from the same table, and every
// schema description is a complete phrase. Split from parse.check.ts (700-line limit).

import { openclawCommands } from "#framework/commands/interface/index.ts";
import type { CommandArgument } from "#framework/core/app.ts";
import { argumentsView, specData, specOf, specShape, bindNamed, defineAction, multiActionBody, commandBody, scopeByAction, argumentScopes, missingArgumentMessage, APPLIES_TO, didYouMeanSuffix, UNKNOWN_ARGUMENT, type ArgumentSpec } from "#framework/core/command/index.ts";
import { inputSchema, schemaArgumentDescription } from "#framework/integration/mcp/server.ts";
import * as kinds from "#framework/core/values/kinds.ts";
import { missingArtifactRefusal } from "#framework/core/values/plan.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

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

  // The refusal with its error-name label stripped (stage 7 S2.5: the resolve refusal at prepare).
  const refusalAfterLabel = async (argv: string[]): Promise<string> => (await outcome(argv)).slice("ArgumentError: ".length);

  check(
    "set build --set is refused at parse, naming the actions that take it",
    (await outcome(["build", "--set", "x.tar.gz"])).includes("--set applies to `validate`, `try`, not `build`"),
    true,
  );
  check("set build --kind is refused at parse", (await outcome(["build", "--kind", "agent"])).includes("--kind applies to `forget`"), true);
  check("set validate --kind is refused at parse", (await outcome(["validate", "--kind", "agent"])).includes("--kind applies to `forget`"), true);
  check("set forget --json is refused at parse", (await outcome(["forget", "--json"])).includes("--json applies to `build`"), true);
  check(
    // Stage 7 S2.5: the missing artifact is the localFile kind's resolve refusal at prepare,
    // an ArgumentError naming the argument — no longer run's artifact reader.
    "set validate --set is refused at prepare by the kind resolve — the parser accepted it",
    (await refusalAfterLabel(["validate", "--set", "missing.tar.gz"])) === missingArtifactRefusal("missing.tar.gz"),
    true,
  );
  check(
    "set forget parses its own slice — refuses the missing --kind as a required argument",
    (await outcome(["forget"])).includes(missingArgumentMessage("set forget", "--kind <kind>")),
    true,
  );
  check("a mistyped set action still gets the did-you-mean", (await outcome(["bild"])).includes(didYouMeanSuffix("build")), true);
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
  check("backup lst suggests list", (await outcome(["lst"])).includes(didYouMeanSuffix("list")), true);
  check(
    "backup --keep 3 names the action --keep belongs to",
    (await outcome(["--keep", "3"])).includes("--keep applies to `prune-replaced`, not `create`"),
    true,
  );
  check("backup list --hot names create", (await outcome(["list", "--hot"])).includes("--hot applies to `create`, not `list`"), true);

}

// --- R31-02 / R32-10: the MCP schema shows the declaration's own text -------------------------
//
// Stage 5 (design 3.1): a schema description is the declared `summary` or the declared
// `description`, whole, plus the actions a multi-action command's argument belongs to — no
// cut, no dropped parenthetical, no `(value: <…>)` tail. The heuristic that produced all
// three is gone, and with it the oracle that recomputed its cut (the R32-10 hole: one
// algorithm could only confirm itself). What is asserted now is what a client sees: the text
// is the declaration's, and no truncation survives anywhere on the surface.

{
  const offenders: string[] = [];
  for (const [name, command] of Object.entries(openclawCommands)) {
    for (const argument of command.arguments ?? []) {
      const scopes = argumentScopes(command, argument.name);
      const actual = schemaArgumentDescription(argument, scopes);
      if (actual === undefined) continue;
      if (actual.includes("…")) offenders.push(`${name}.${argument.name} is cut with an ellipsis: ${actual}`);
      const valueTail = actual.includes("(value:") && actual.includes("<");
      if (valueTail) offenders.push(`${name}.${argument.name} carries a value tail: ${actual}`);
      // One clause per text the actions declare differently, each naming its own actions
      // (R31-03, R32-04) — the parts `argumentsView` composes, read back rather than parsed
      // out of the joined string again.
      const clauses = actual.split("; ");
      if (scopes === undefined) {
        const base = argument.summary ?? argument.description;
        const actions = argument.actions === undefined ? "" : ` (${argument.actions.join(", ")})`;
        if (actual !== `${base}${actions}`) offenders.push(`${name}.${argument.name}: "${actual}" is not its declared text`);
      } else if (clauses.length !== scopes.length) {
        offenders.push(`${name}.${argument.name}: ${clauses.length} clauses for ${scopes.length} texts`);
      } else {
        clauses.forEach((clause, index) => {
          const scope = scopes[index]!;
          const base = scope.summary ?? scope.description;
          if (clause !== `${base} (${scope.actions.join(", ")})`) offenders.push(`${name}.${argument.name}: clause "${clause}" is not ${base}`);
        });
      }
    }
  }
  check("every schema description is the declaration's own text", offenders, []);

  // The R31-02 offenders, by their observable schema text.
  const schemaOf = (commandName: string, argumentName: string): string =>
    (inputSchema(openclawCommands[commandName]) as { properties: Record<string, { description?: string }> }).properties[argumentName].description ?? "";
  check("break-lock's schema line is the declared summary", schemaOf("bootstrap", "break-lock"), "Take lock");
  check("recover-env.adopt-runtime is a complete clause", schemaOf("recover-env", "adopt-runtime"), "Take the running container as authoritative");
  check("expose.apply's summary is the declared phrase, bounded to 60", schemaOf("expose", "apply"), "run tailscale serve on the target (tailscale)");
  check("incident.keep-exposure is a complete phrase", schemaOf("incident", "keep-exposure"), "Proceed with the gateway published on every interface");
  check("backup.apply keeps its declared scope", openclawCommands.backup.arguments?.find((argument) => argument.name === "apply")?.actions, ["prune-replaced", "install", "uninstall"]);
  check("set.keep is a complete phrase", schemaOf("set", "keep").startsWith("keep the throwaway instance instead of removing it"), true);
  check("pull.migrate is a complete phrase", schemaOf("pull", "migrate").startsWith("Migrate profile"), true);
  check("accept.set is a complete phrase", schemaOf("accept", "set").startsWith("Check the verified artifact and save an acceptance receipt"), true);
  check("cli.args is the fixed text, not a cut inside the JSON example", schemaOf("cli", "args"), "Arguments passed to OpenClaw's CLI verbatim");
  check("exec.args is the fixed text", schemaOf("exec", "args"), "Command and arguments to run");
  check("host.args is the fixed text", schemaOf("host", "args"), "Command and arguments to run");
  check("host.root is a complete phrase, not a cut at the colon", schemaOf("host", "root"), "Request root; one half of the elevation consent");
  check("restore.json fits the budget whole", schemaOf("restore", "json"), "Emit restored data and the gateway startup outcome as JSON");
  check("secrets.json no longer reads as refused by itself", schemaOf("secrets", "json"), "Emit the default read-only report as JSON");
  // Lock-takeover descriptions retain their declared action-specific semantics and scope.
  // Action ownership is represented by declaration metadata, not parsed from rendered prose.
  const scopedActions = (commandName: string, argumentName: string) =>
    openclawCommands[commandName].arguments?.find((argument) => argument.name === argumentName)?.actions;
  check("backup.break-lock scopes its action", scopedActions("backup", "break-lock"), ["prune-replaced", "install", "uninstall"]);
  check("backup.break-foreign-lock scopes its action", scopedActions("backup", "break-foreign-lock"), ["prune-replaced", "install", "uninstall"]);
  check("expose.break-lock scopes its action", scopedActions("expose", "break-lock"), ["tailscale"]);
  check("watch.break-lock scopes its actions", scopedActions("watch", "break-lock"), ["install", "uninstall"]);
  check("recipe.break-lock scopes its actions", scopedActions("recipe", "break-lock"), ["verify", "onboard", "diagnose", "install", "remove"]);
  check("set.break-lock scopes its action", scopedActions("set", "break-lock"), ["forget"]);
  // A gate command's argument carries no `summary`: the declared description reaches the
  // schema whole — the cut used to trim both of these, and the option used to gain a
  // `(value: <…>)` tail naming its own valueName.
  check(
    "check.filter, a gate command's argument, is its declared description whole",
    schemaArgumentDescription({ name: "filter", description: "Only run checks whose relative path (e.g. foundation/cli/gate-commands.check.ts) contains this text — repeatable, matches any", kind: "variadic" }),
    "Only run checks whose relative path (e.g. foundation/cli/gate-commands.check.ts) contains this text — repeatable, matches any",
  );
  check(
    "check.jobs keeps the parenthetical whole (a gate command's declared text)",
    schemaArgumentDescription({ name: "jobs", description: "Concurrent check-file processes (default: OC_CHECK_JOBS, else min(4, cores/2))", kind: "flag" }),
    "Concurrent check-file processes (default: OC_CHECK_JOBS, else min(4, cores/2))",
  );

  const declaredBackupInterval = (openclawCommands.backup.arguments ?? []).find((argument) => argument.name === "interval");
  const backupSchema = inputSchema(openclawCommands.backup) as { properties: Record<string, { description?: string }> };
  check("backup.action says what no action word means", backupSchema.properties.action.description, "Omit to create a backup");
  const description = schemaOf("backup", "interval");
  check("backup.interval summary matches its declaration", declaredBackupInterval?.summary, "Interval: default 1d; explicit unit required");
  check("backup.interval schema matches its full declared property", description, schemaArgumentDescription(declaredBackupInterval as CommandArgument));
  const watchSchema = inputSchema(openclawCommands.watch) as { properties: Record<string, { description?: string }> };
  const watchInterval = openclawCommands.watch.arguments?.find((argument) => argument.name === "interval");
  check("watch interval schema matches its full declared property", watchSchema.properties.interval.description, schemaArgumentDescription(watchInterval as CommandArgument, argumentScopes(openclawCommands.watch, "interval")));

}

// --- argument summaries are bounded to 60 characters -----------------------------------------
//
// ArgumentBase documents the contract: each declared summary and emitted schema description is
// at most 60 characters. For composed descriptions, each declared part is bounded without the
// action-scope suffix; the suffix is metadata, not part of the summary budget.

{
  const offenders: string[] = [];
  const emittedOffenders: string[] = [];
  let cases = 0;
  for (const [name, command] of Object.entries(openclawCommands)) {
    const entry = specOf(command);
    if (entry === undefined) continue;
    const data = specData(entry);
    const parts = data.kind === "single" ? [data] : Object.values(data.actions);
    for (const part of parts) {
      for (const argument of part.arguments) {
        cases += 1;
        if (argument.summary !== undefined && argument.summary.length > 60) {
          offenders.push(name + "." + argument.name + ": summary is " + argument.summary.length + " characters (max 60)");
        }
        if (argument.summary === undefined && argument.description.length > 60) {
          offenders.push(name + "." + argument.name + ": needs a summary, its description is longer than 60");
        }
      }
    }
  }
  for (const [name, command] of Object.entries(openclawCommands)) {
    for (const argument of command.arguments ?? []) {
      const scopes = argumentScopes(command, argument.name);
      if (scopes !== undefined) {
        for (const part of scopes) {
          const text = part.summary ?? part.description;
          if (text.length > 60) emittedOffenders.push(`${name}.${argument.name}: composed text is ${text.length} characters (max 60)`);
        }
        continue;
      }
      const description = (inputSchema(command) as { properties: Record<string, { description?: string }> }).properties[argument.name]?.description;
      if (description === undefined) continue;
      if (description.length > 60) emittedOffenders.push(`${name}.${argument.name}: emitted description is ${description.length} characters (max 60)`);
    }
  }
  checkTrue("every declared argument summary is bounded to 60 (" + offenders.length + " offenders: " + offenders.join("; ") + ")", offenders.length === 0);
  checkTrue("the emitted noncomposed description stays bounded", emittedOffenders.length === 0);
  checkTrue(`every emitted composed schema part fits 60 characters (${emittedOffenders.length} offenders: ${emittedOffenders.join("; ")})`, emittedOffenders.length === 0);
  checkTrue("the summary sweep reaches arguments (" + cases + " cases)", cases > 0);
}

// --- R31-03: one name, several actions, several accurate descriptions ------------------------
{
  const setSchema = inputSchema(openclawCommands.set) as { properties: Record<string, { description?: string }> };
  check(
    "set.name names the object for forget and the set for build/validate",
    setSchema.properties.name.description,
    "Set name (build, validate); Object name (forget)",
  );
  check(
    "set.json's schema line keeps each part's own action, not one action's claim for all",
    setSchema.properties.json.description,
    "Emit the manifest and its id as JSON (build); Emit the findings as JSON (validate); Emit JSON (diff); Emit the receipts as JSON (receipts); Emit the trial report as JSON (try)",
  );
  const watchSchema = inputSchema(openclawCommands.watch) as { properties: Record<string, { description?: string }> };
  check("watch.json no longer carries the 'With check/status:' lead-in", watchSchema.properties.json.description, "Emit JSON instead of text (check, status, test)");

  // The refusal names the action a foreign flag belongs to, for EVERY action — including the
  // three (try/diff/receipts) that used to parse without scope and answer "unknown argument".
  const setRun = openclawCommands.set.run!;
  const outcome = async (argv: string[]): Promise<string> => {
    try {
      await setRun({} as Parameters<typeof setRun>[0], argv);
      return "no error";
    } catch (error) {
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  };
  check("set try --kind names forget", (await outcome(["try", "--set", "x.tar.gz", "--kind", "agent"])).includes("--kind applies to `forget`"), true);
  check("set diff --kind names forget", (await outcome(["diff", "--kind", "agent"])).includes("--kind applies to `forget`"), true);
  check("set receipts --set names validate/try", (await outcome(["receipts", "--set", "x.tar.gz"])).includes("--set applies to `validate`"), true);
  check("set receipts still parses its own slice", (await outcome(["receipts", "--receipt", "r", "--json"])).includes("--receipt requires --set-id"), true);
  check("set try still parses its own slice", (await outcome(["try"])).includes(missingArgumentMessage("set try", "--set <artifact>")), true);

  // The drift check must drive the real dispatcher, not the registry against itself: with
  // watch's table declaring the WRONG slice for an action, the declaration offers a flag the
  // real parser refuses — and that must show here. (watch status parses its slice directly
  // in watch/status.ts, so only going through openclawCommands.watch.run sees the drift.)
  const watchRun = openclawCommands.watch.run!;
  const watchOutcome = async (argv: string[]): Promise<string> => {
    try {
      await watchRun({} as Parameters<typeof watchRun>[0], argv);
      return "no error";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  check("watch status --json parses — refused only later, on its context", !(await watchOutcome(["status", "--json"])).includes(UNKNOWN_ARGUMENT), true);
  // The unified other-action-flag text (design 5.6): the refusal names the action that owns
  // the flag, not "unknown argument".
  check("watch status --interval is refused as install's flag", (await watchOutcome(["status", "--interval", "5m"])).includes("--interval applies to `install`, not `status`"), true);
  check("watch check --interval parses — refused only later, on its context", !(await watchOutcome(["check", "--interval", "5m"])).includes(UNKNOWN_ARGUMENT), true);
}

// --- R32-10: declared = accepted, for every action command, through the real dispatcher ------
//
// The registry-vs-registry comparison above cannot see a drift BETWEEN the table and the
// action's own parser (watch status parses its slice in status.ts, not through the table).
// Each declared flag of each action is therefore offered to the command's real run on a
// stub context: a flag the action's slice declares must never die with a parse refusal,
// and a flag scoped to other actions must.

{
  const ACTION_COMMANDS = ["backup", "watch", "expose", "set", "recipe"];
  const parseRefusal = (message: string): boolean => message.includes(UNKNOWN_ARGUMENT) || message.includes(APPLIES_TO);
  for (const name of ACTION_COMMANDS) {
    const command = openclawCommands[name]!;
    const run = command.run!;
    const body = specData(specOf(command)!);
    const defaultAction = body.kind === "multi" ? body.defaultAction : undefined;
    const outcome = async (argv: string[]): Promise<string> => {
      try {
        await run({} as Parameters<typeof run>[0], argv);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const declared = (command.arguments ?? []).filter((argument) => argument.kind === "flag" || argument.kind === "option");
    const actionArgument = (command.arguments ?? []).find(
      (argument): argument is CommandArgument & { choices: readonly string[] } =>
        argument.kind === "positional" && argument.name === "action" && argument.choices !== undefined,
    );
    if (actionArgument === undefined) {
      check(`${name} registers an action positional with choices`, false, true);
      continue;
    }
    // Words before the flag matter only for actions the parser must recognise; the value
    // after an option is its first declared choice, so choice validation cannot misfire.
    const argvFor = (action: string | undefined, argument: CommandArgument): string[] => {
      const value = argument.kind === "option" ? (argument.choices?.[0] ?? "x") : undefined;
      return [...(action === undefined ? [] : [action]), `--${argument.name}`, ...(value === undefined ? [] : [value])];
    };
    // Only the discriminating direction is asserted: a flag the declaration scopes to this
    // action must be ACCEPTED by the real parser. The reverse cannot hold — several real
    // parsers are deliberately more lenient than the declaration (watch check reads
    // --interval; recipe list ignores unknown flags) — and the R32-10 mutation (declaration
    // offers --interval under watch status) is caught exactly here, as an accepted-refusal.
    for (const action of actionArgument.choices) {
      const actionsOf = (argument: CommandArgument): string[] => argvFor(action, argument);
      if (action === defaultAction) {
        // The implicit default action is reached without any action word at all.
        for (const argument of declared) {
          if (argument.actions !== undefined && !argument.actions.includes(action)) continue;
          const message = await outcome(actionsOf(argument));
          check(`${name} (bare): --${argument.name} is accepted by the real parser`, parseRefusal(message), false);
        }
        continue;
      }
      for (const argument of declared) {
        if (argument.actions !== undefined && !argument.actions.includes(action)) continue;
        const message = await outcome(actionsOf(argument));
        check(`${name} ${action}: --${argument.name} is accepted by the real parser`, parseRefusal(message), false);
      }
    }
  }
}

// --- argumentsView: the derived declaration of a multi-action body -----------------------------------

{
  const run = async (): Promise<void> => {};
  const flag = (name: string, description = "d", extra: object = {}): ArgumentSpec => ({ name, kind: "flag", description, ...extra }) as ArgumentSpec;
  const option = (name: string, description = "d", extra: object = {}): ArgumentSpec => ({ name, kind: "option", valueName: "v", description, value: kinds.count(), ...extra }) as ArgumentSpec;
  const positional = (name: string, extra: object = {}): ArgumentSpec => ({ name, kind: "positional", description: "d", value: kinds.text("d", { leadingDash: "allow" }), ...extra }) as ArgumentSpec;

  // Declared: list, forget, create (the default, last). The view orders flags: create, list, forget.
  const SLICES: Record<string, readonly ArgumentSpec[]> = {
    list: [flag("json"), positional("target", { required: true }), option("limit", "d", { required: true })],
    forget: [option("kind", "d", { required: true }), positional("target", { required: true }), option("limit", "d", { required: true }), flag("json")],
    create: [flag("dry-run"), flag("json"), positional("target", { required: true }), option("limit", "d", { required: true }), option("name", "the set", { summary: "set" })],
  };
  const body = multiActionBody({
    effect: "change",
    action: { description: "Omit to create", summary: "Omit to create" },
    defaultAction: "create",
    actions: Object.fromEntries(Object.entries(SLICES).map(([name, args]) => [name, defineAction({ summary: name, arguments: args, run })])),
  });
  const view = argumentsView(body);
  const named = (name: string) => view.find((argument) => argument.name === name);

  check("the first argument is the action word", [view[0].name, view[0].kind], ["action", "positional"]);
  check("its choices are the actions in declaration order", view[0].choices, ["list", "forget", "create"]);
  check("with a default action the word is optional", view[0].required, undefined);
  check("its summary comes from the body", view[0].summary, "Omit to create");
  check(
    "without a default action the word is required",
    argumentsView(multiActionBody({ effect: "read", action: { description: "x" }, actions: { a: defineAction({ summary: "a", run }) } }))[0].required,
    true,
  );

  const strip = (argument: object): object => {
    const { required: _required, summary: _summary, value, ...rest } = argument as Record<string, unknown>;
    // The kind is the spec-side grammar; the view projects it as its parse carrier.
    return value === undefined ? rest : { ...rest, parse: value };
  };
  const scoped = scopeByAction({ create: SLICES.create, list: SLICES.list, forget: SLICES.forget });
  check(
    "flags and options are scopeByAction's, default action first",
    view.filter((argument) => argument.kind === "flag" || argument.kind === "option").map(strip),
    scoped.map(strip),
  );
  check("a flag of every action carries no actions list", named("json")?.actions, undefined);
  check("a flag of one action is scoped to it, in view order", [named("dry-run")?.actions, named("kind")?.actions], [["create"], ["forget"]]);
  check("an option required in every action stays required", named("limit")?.required, true);
  check("an option required in one action only is not required", named("kind")?.required, undefined);
  check("a positional declared by every action is required, unscoped", [named("target")?.required, named("target")?.actions], [true, undefined]);
  check("a positional is merged once", view.filter((argument) => argument.name === "target").length, 1);
  check("a positional missing from some action is not required", argumentsView(multiActionBody({
    effect: "change", action: { description: "x" }, defaultAction: "a",
    actions: { a: defineAction({ summary: "a", arguments: [positional("p", { required: true })], run }), b: defineAction({ summary: "b", run }) },
  })).find((argument) => argument.name === "p")?.required, undefined);
  const kindsOrder = view.map((argument) => argument.kind);
  check("positionals come before flags and options", kindsOrder.lastIndexOf("positional") < kindsOrder.findIndex((kind) => kind !== "positional"), true);
  check("a summary declared once, with one description, is kept", named("name")?.summary, "set");

  // The composed summary: described differently by the actions, declared by every part.
  const described = (summaries: readonly (string | undefined)[], descriptions: readonly string[]) => argumentsView(multiActionBody({
    effect: "change", action: { description: "x" }, defaultAction: "a",
    actions: Object.fromEntries(summaries.map((summary, index) => [["a", "b", "c"][index], defineAction({
      summary: "s", arguments: [option("name", descriptions[index], summary === undefined ? {} : { summary })], run,
    })])),
  })).find((argument) => argument.name === "name");
  check("differing descriptions with every summary compose a summary", described(["s1", "s1", "s2"], ["D1", "D1", "D2"])?.summary, "s1 (a, b); s2 (c)");
  check("and the description composes the same way", described(["s1", "s1", "s2"], ["D1", "D1", "D2"])?.description, "D1 (a, b); D2 (c)");
  check("one part without a summary: no composed summary", described(["s1", "s1", undefined], ["D1", "D1", "D2"])?.summary, undefined);
  check("the same description everywhere keeps its summary", described(["s1", "s1", "s1"], ["D1", "D1", "D1"])?.summary, "s1");

  const single = [flag("json")] as const satisfies readonly ArgumentSpec[];
  check("a single body shows its arguments as declared", argumentsView(commandBody({ effect: "read", arguments: single, run })), single);
}

// --- F1/I4: set's per-action variadic reaches the declaration, the schema and the binder ---
{
  const artifacts = (openclawCommands.set.arguments ?? []).find((argument) => argument.name === "artifacts");
  check("set declares the diff variadic", [artifacts?.kind, artifacts?.description], ["variadic", "Two positional artifacts"]);
  check("it is scoped to the actions that declare it", artifacts?.actions, ["diff"]);
  const setSchema = inputSchema(openclawCommands.set) as { properties: Record<string, { type: string; items?: { type: string } }> };
  check("the MCP schema renders it as a string array", [setSchema.properties.artifacts?.type, setSchema.properties.artifacts?.items?.type], ["array", "string"]);
  const setShape = specShape(specOf(openclawCommands.set)!);
  const binds = (args: Record<string, unknown>) => { try { bindNamed(setShape, { kind: "named", args }, "set"); return true; } catch (error) { return error; } };
  check("the binder accepts two artifacts for set diff", binds({ action: "diff", artifacts: ["a.tar.gz", "b.tar.gz"] }), true);
  const expected = "artifacts takes a list of non-empty strings";
  check("the binder refuses a non-string artifact", (binds({ action: "diff", artifacts: [1] }) as Error).message, expected);
}

finish("action arguments");
