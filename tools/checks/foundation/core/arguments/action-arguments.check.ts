// The per-action slices of multi-action commands (set, backup): each action parses its own
// slice, the declaration shown in --help/completion/MCP is derived from the same table, and every
// schema description is a complete phrase. Split from arguments.check.ts (700-line limit).

import { openclawCommands } from "#framework/commands/interface/index.ts";
import type { CommandArgument } from "#framework/core/app.ts";
import { NO_ACTION } from "#framework/core/arguments.ts";
import { inputSchema, schemaArgumentDescription } from "#framework/integration/mcp/server.ts";
import { buildCompletionModel, renderCompletion } from "#framework/integration/completion.ts";
import { check, finish } from "#checks/kit/harness.ts";

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

  // R31-07: the FIRST position after a command with an implicit default action offers the
  // create flags too — `backup --h<Tab>` must complete --hot, not only --help.
  const bashFirst = /backup\)\n      if \[\[ \$cword -eq \$\(\(idx \+ 1\)\) \]\]; then\n        COMPREPLY=\( \$\(compgen -W "([^"]*)"/.exec(bash)![1];
  check("bash's first position after backup offers the action words and the create flags", ["create", "--dry-run", "--help", "--hot"].every((word) => bashFirst.split(" ").includes(word)), true);
  const bashOtherFirst = /watch\)\n      if \[\[ \$cword -eq \$\(\(idx \+ 1\)\) \]\]; then\n        COMPREPLY=\( \$\(compgen -W "([^"]*)"/.exec(bash)![1];
  check("a command without a default action keeps words + --help on the first position", bashOtherFirst.trim(), "check install status test uninstall --help");
  check("pwsh offers actions plus flags at the action position", pwsh.includes("@($clawforgeActions[$cmd].Keys) + $clawforgeFlags[$cmd]"), true);
  check("pwsh's new-token and typed-word cases share the between-space scan", pwsh.includes("if ($between.Count -eq 0)"), true);
  check("pwsh's position past a typed action word offers that action's own flags", pwsh.includes("$candidates = $clawforgeActions[$cmd][$between[0]]"), true);
}

// --- R31-02 / R32-10: every MCP schema description holds structurally, verified independently
//
// The oracle no longer recomputes the implementation's cut (the R32-10 hole: the same
// algorithm can only confirm itself). It states properties a well-cut description has
// regardless of how it was computed: the shown text is a prefix of the declaration's own
// text (parentheticals aside), the cut lands on a clause boundary or is marked partial
// with an ellipsis, nothing ends on a dangling word, and the short form keeps the budget.

{
  const DANGLING = new Set(["of", "is", "are", "a", "an", "the", "or", "and", "to", "for", "with", "than", "that", "from", "by", "at", "as", "be"]);
  const BOUNDARIES = new Set([".", ";", ":", ",", "—"]);
  // These two names get fixed schema texts regardless of their declaration (the override is
  // data, not cut logic); asserted directly below instead of through the oracle.
  const SHARED_OVERRIDE_NAMES = new Set(["break-lock", "break-foreign-lock"]);

  const offenders: string[] = [];
  for (const [name, command] of Object.entries(openclawCommands)) {
    for (const argument of command.arguments ?? []) {
      if (SHARED_OVERRIDE_NAMES.has(argument.name)) continue;
      const actual = schemaArgumentDescription(argument);
      if (actual === undefined) continue;
      // The schema appends structural suffixes after the short form — strip them, then judge
      // the short form against the declaration's own text, not against a recomputation.
      let core = actual;
      for (;;) {
        const stripped = core.replace(/\s*\([^()]*\)$/, "");
        if (stripped === core) break;
        core = stripped;
      }
      const source = argument.description.replace(/^With [\w/-]+: /, "").replace(/\s*\([^()]*\)/g, "").replace(/\s{2,}/g, " ").trim();
      const partial = core.endsWith("…");
      const shown = partial ? core.slice(0, -1).trimEnd() : core;
      if (!source.startsWith(shown)) offenders.push(`${name}.${argument.name}: "${shown}" is not a prefix of the declaration's text "${source}"`);
      else if (shown !== source) {
        const next = source[shown.length];
        // The cut lands on a clause boundary — the boundary itself kept or dropped, but never
        // inside a word; a mid-phrase cut must be marked with an ellipsis.
        if (!partial && next !== undefined && !BOUNDARIES.has(next) && next !== " ") offenders.push(`${name}.${argument.name}: cut mid-clause before "${next}": ${actual}`);
      }
      if (core.length > 61) offenders.push(`${name}.${argument.name}: short form over budget: ${actual}`);
      // A partial cut cannot control where the budget runs out, so a dangling word is only
      // rejected on a boundary cut.
      if (!partial && DANGLING.has(shown.split(" ").pop()!.toLowerCase())) offenders.push(`${name}.${argument.name} ends on a dangling word: ${actual}`);
    }
  }
  check("every schema description is a clean prefix of its declaration's text", offenders, []);

  // The nine R31-02 offenders, by their observable schema text.
  const schemaOf = (commandName: string, argumentName: string): string =>
    (inputSchema(openclawCommands[commandName]) as { properties: Record<string, { description?: string }> }).properties[argumentName].description ?? "";
  check("the shared break-lock override is the terse fixed text", schemaOf("bootstrap", "break-lock"), "Take over a held instance lock");
  check("recover-env.adopt-runtime is a complete clause", schemaOf("recover-env", "adopt-runtime"), "Take the running container as authoritative");
  check("incident.keep-exposure is a complete phrase", schemaOf("incident", "keep-exposure"), "Proceed with the gateway published on every interface");
  check("backup.apply keeps the contrast", schemaOf("backup", "apply").startsWith("Apply the action instead of only previewing it"), true);
  check("set.keep is a complete phrase", schemaOf("set", "keep").startsWith("keep the throwaway instance running instead of removing it"), true);
  check("pull.migrate is a complete phrase", schemaOf("pull", "migrate").startsWith("Migrate profile"), true);
  check("accept.set is a complete phrase", schemaOf("accept", "set").startsWith("Check the verified artifact and save an acceptance receipt"), true);
  check("cli.args is a complete phrase", schemaOf("cli", "args").startsWith("Arguments passed to OpenClaw's CLI verbatim"), true);
  check(
    "check.filter (a gate command, not openclawCommands) is a complete phrase",
    schemaArgumentDescription({ name: "filter", description: "Only run checks whose relative path (e.g. foundation/cli/gate-commands.check.ts) contains this text — repeatable, matches any", kind: "option", valueName: "text" }),
    "Only run checks whose relative path contains this text (value: <text>)",
  );
  check("secrets.json no longer reads as refused by itself", schemaOf("secrets", "json"), "Emit the default read-only report as JSON");

  const backupSchema = inputSchema(openclawCommands.backup) as { properties: Record<string, { description?: string }> };
  check("backup.action says what no action word means", backupSchema.properties.action.description, "Omit to create a backup");
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

// --- R31-03: one name, several actions, several accurate descriptions ------------------------
{
  const setSchema = inputSchema(openclawCommands.set) as { properties: Record<string, { description?: string }> };
  check(
    "set.name names the object for forget and the set for build/validate",
    setSchema.properties.name.description,
    "Set name; The object's name (build, validate, forget) (value: <name>)",
  );
  check(
    "set.json's schema line is the shortened first action text, not one action's claim for all",
    setSchema.properties.json.description,
    "Emit the manifest and its id as JSON (build, validate, diff, receipts, try)",
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
  check("set try still parses its own slice", (await outcome(["try"])).includes("usage: ./clawforge set try"), true);

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
  check("watch status --json parses — refused only later, on its context", !(await watchOutcome(["status", "--json"])).includes("unknown argument"), true);
  check("watch status --interval is refused by the real parser", (await watchOutcome(["status", "--interval", "5m"])).includes("unknown argument"), true);
  check("watch check --interval parses — refused only later, on its context", !(await watchOutcome(["check", "--interval", "5m"])).includes("unknown argument"), true);
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
  const parseRefusal = (message: string): boolean => message.includes("unknown argument") || message.includes("applies to");
  for (const name of ACTION_COMMANDS) {
    const command = openclawCommands[name]!;
    const run = command.run!;
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
      if (action === NO_ACTION) {
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

finish("action arguments");
