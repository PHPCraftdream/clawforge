// Shell completion BEHAVES, not just renders. Every scenario here states "given the words and
// the cursor state, these candidates come out" — against completionCandidates (the one decision
// both emitted scripts implement), against the bash script ACTUALLY SOURCED by a real bash, and
// against the pwsh script EXECUTED by a real PowerShell through TabExpansion2. All three must
// agree. What this file replaces pinned script substrings (bash's `-W` list, pwsh's
// `"install" = @(` line, the position-past-an-action-word regex) — and those checks PASSED the
// R32-02 regression, a prefix typed at the top level offering nothing; behavioural checks
// cannot (R33-10).

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { completionCandidates, completionData } from "#framework/integration/completion/table.ts";
import { makeCompletionGateCommand, renderCompletion } from "#framework/integration/completion/index.ts";
import { APP_SKIP_PAIR, APP_VALUES_BLOCK } from "#framework/integration/completion/bash.ts";
import { defaultActionOf, scanCall } from "#framework/core/command/parse/scan.ts";
import type { CallShape } from "#framework/core/command/parse/index.ts";
import type { CommandArgument } from "#framework/core/app.ts";
import { checkDivergences, mergedReadingFor, scanContracts } from "./scan-contracts.ts";
import { modelScenarios } from "./model-scenarios.ts";
import { checkHelpInstallFragments } from "./help-install-prose.ts";
import { invocation, setInvocation, type Invocation } from "#framework/core/io/invocation/index.ts";
import { renderProse } from "#framework/core/io/invocation/prose.ts";
import { SHIM_PROGRAM } from "#framework/core/io/invocation/render.ts";
import { surfaceRegistry } from "#framework/entry/registry.ts";
import { completionScenarios, type CompletionScenario } from "./scenarios.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { tokenizeLine } from "#checks/kit/shells.ts";
import { pwshCommand } from "#checks/kit/capabilities/capabilities.ts";
import type { GateCommand } from "#framework/integration/gate.ts";

// The table is built from the one registry every other surface reads — help, the docs table,
// the MCP tool list — not a hand-written gate list beside them, so a command completes because
// it is declared there. The completion command itself is a registry entry (registry.ts closes
// the gate over the finished array), which is what makes its own shell choices completable.
const gateCommands: GateCommand[] = [];
gateCommands.push(makeCompletionGateCommand(gateCommands, true));
const registry = surfaceRegistry();
const data = completionData(registry, true);
const installed = completionData(registry, false);

/** --app's own value: what every candidate list below and both scripts must end up with. The
 *  stub each differential runs also answers a HIDDEN name, which both scripts filter out — so
 *  the post-filter list is the model's answer, and a script that stopped filtering hidden
 *  directories fails the differential. */
const appNames = (): readonly string[] => ["app-one", "app-two"];
const actionWordsOf = (command: string): string[] =>
  [...data.after.keys()]
    .filter((key) => key.startsWith(`${command} `) && key !== `${command} *`)
    .map((key) => key.slice(command.length + 1));
/** The action words a command declares, read off its own `after` rows — so a word that is one
 *  command's action and another command's name (backup's `list` vs the gate's `list`) is never
 *  mistaken for a command name leaking into a command's own candidates. */
const STUB_JSON = '[{"name":"app-one"},{"name":"app-two"},{"name":".hidden"}]';
const norm = (values: readonly string[]): string[] => [...new Set(values)].sort();

// --- 1. the data: structure instead of script text ------------------------------------------
//
// These are properties of the CompletionData table. They moved here from
// gate-commands.check.ts's completion section and spec/view.check.ts's R31-07 block, where the
// same facts were read out of generated script text — a substring in the right place says
// nothing about what the completer answers.

{
  const row = (command: string, action: string): readonly string[] => data.after.get(`${command} ${action}`) ?? [];

  // A flag one action declares must not leak into the others' rows: completion is derived from
  // the same declaration --help and the parser read, so a row is wrong exactly when a flag's
  // `actions` list is.
  check("backup install carries --interval",
    ["install", "list", "prune-replaced", "uninstall"].map((action) => row("backup", action).includes("--interval")),
    [true, false, false, false]);
  check("--keep is only under backup prune-replaced",
    ["install", "list", "prune-replaced", "uninstall"].filter((action) => row("backup", action).includes("--keep")),
    ["prune-replaced"]);
  check("--apply is under prune-replaced, install and uninstall",
    ["prune-replaced", "install", "uninstall"].map((action) => row("backup", action).includes("--apply")),
    [true, true, true]);
  check("--apply is not under list, which is read-only", row("backup", "list").includes("--apply"), false);

  // backup's action positional is OPTIONAL, so a bare `backup` is the implicit default action
  // (create): its flags are the fallback for the no-action and unknown-action cases, where the
  // shell cannot tell which was meant — not just --help.
  check("backup's \"backup *\" fallback carries the create flags",
    ["--dry-run", "--hot", "--migrate", "--native", "--profile", "--share", "--with-secrets"]
      .every((flag) => row("backup", "*").includes(flag)), true);

  // R31-07: the word right after the command offers the action words AND the create flags, so
  // `backup --h<Tab>` completes --hot rather than only --help.
  check("backup's first position offers the action words and the create flags (R31-07)",
    [...data.first.get("backup")!], [...new Set([...actionWordsOf("backup"), ...row("backup", "*")])].sort());
  // A command with no default action keeps its action words plus --help, and nothing else. The
  // old unsorted pin ("check install status test uninstall --help") belonged to the removed
  // generated arm; the table is sorted, so this is the sorted set.
  check("watch's first position is its action words plus --help, and nothing else",
    [...data.first.get("watch")!], ["--help", "check", "install", "status", "test", "uninstall"]);

  // R33-10: the action word already typed scopes an option's values, so `set try` (no --kind)
  // never sees forget's kind values while `set forget --kind` does.
  const kindRow = data.values.find((entry) => entry.command === "set" && entry.scope === "forget" && entry.option === "--kind");
  check("set forget --kind's row carries the kind values", [...kindRow?.values ?? []].sort(), ["agent", "cron-job", "mcp-server"]);
  check("set try has no --kind row (R33-10)",
    data.values.find((entry) => entry.command === "set" && entry.scope === "try" && entry.option === "--kind"), undefined);

  // help's positional takes every registry name as its choices, so its first position IS the
  // command list — one declaration, read by the completer like any other positional.
  check("help's first position offers every command name",
    registry.names.filter((name) => !(data.first.get("help") ?? []).includes(name)), []);
  check("every registry name is in the top level", registry.names.filter((name) => !data.top.includes(name)), []);
  check("--app is listed last at the top level, where the gate has one", data.top.at(-1), "--app");
  // R4-2: the --version/-v alias is declared on the version gate command (GateCommand.aliases),
  // so completion offers it at the top level instead of the alias living only in prose.
  check("the declared version aliases complete at the top level",
    [data.top.includes("--version"), data.top.includes("-v")], [true, true]);

  for (const shell of ["bash", "zsh", "pwsh"] as const) {
    const once = renderCompletion(shell, data);
    check(`${shell}: no per-run value — rendering twice is byte-identical`, renderCompletion(shell, data), once);
  }

  // --app's values come from whichever of the system-wide command or the checkout shim was typed,
  // asked for lazily from inside the completer — never a hard-wired ./clawforge, never polling
  // targets, and hidden directories (.r28) are not deployments, so they are filtered out.
  // The exact interpreter lines (the lazy `list --json` call, the hidden-directory filters)
  // are held byte for byte by expected/completion-scripts.txt — same renderer, same output.
  const text = renderCompletion("bash", data);
  const pwshText = renderCompletion("pwsh", data);
  check("bash/zsh: the lazy --app values call is parameterised by the invoked name", text.includes("${COMP_WORDS[0]}"), true);
  check("pwsh: the lazy --app values call reads the caller's tokens", pwshText.includes("$tokens[0]"), true);

  // Design section 9: `valueOptions` is exact per command only while no argument name is an
  // option in one action and a flag in another — the emitted interpreters key their mirrors
  // on the name alone. One check over every multi-action entry, naming the offender.
  const kindClashes: string[] = [];
  for (const entry of registry.entries) {
    if (entry.shape.actions === undefined) continue;
    const kinds = new Map<string, string>();
    for (const unit of Object.values(entry.shape.actions)) {
      for (const argument of unit.arguments ?? []) {
        const seen = kinds.get(argument.name);
        if (seen !== undefined && seen !== argument.kind) kindClashes.push(`${entry.name} ${argument.name}`);
        kinds.set(argument.name, argument.kind);
      }
    }
  }
  check("no argument name changes kind between actions", kindClashes, []);
}

{
  // The installed single-deployment gate (entry/bin.ts) has no --app selector. The table offers
  // it nowhere, and bash/zsh emit the interpreter's --app snippets only where the gate declares
  // one — so an installed script names it neither as a candidate nor in the lazy `list --json`
  // call that would fill it. pwsh keeps ONE fixed interpreter body (section 4): its --app branch
  // and that call live in it, guarded at run time by $clawforgeApp, so what the declarations
  // reach it through — the flag line and the five data tables — is what must be free of --app.
  check("the installed top level carries no --app", installed.top.includes("--app"), false);
  for (const shell of ["bash", "zsh"] as const) {
    const text = renderCompletion(shell, installed);
    // Word boundary, never a substring: `--apply` is a real flag of backup/expose/watch/secrets
    // and must not be read as `--app`. The absence of the lazy `list --json` call is held by
    // expected/completion-scripts.txt's installed sections, byte for byte.
    check(`${shell}: the installed script mentions no --app`, /--app\b/.test(text), false);
  }
  const flagLineMarker = "$clawforgeApp = ";
  const pwshInstalled = renderCompletion("pwsh", installed);
  const appFlagLine = pwshInstalled.split("\n").find((line) => line.includes(flagLineMarker));
  check("pwsh: the installed script's --app flag line is false", appFlagLine, "$clawforgeApp = $false");
  check("pwsh: the installed script's data block names no --app",
    /"--app"/.test(pwshInstalled.slice(0, pwshInstalled.indexOf("$clawforgeCompleter"))), false);
  const pwshCheckoutAppLine = renderCompletion("pwsh", data).split("\n").find((line) => line.includes(flagLineMarker));
  check("pwsh: --app's flag line is true where the gate has one", pwshCheckoutAppLine, "$clawforgeApp = $true");
}

// --- 2. the reference model, scenario by scenario (R32-02 / R31-07 / R33-10) ------------------
//
// `words` is every token after the program name and `cword` the index of the word being
// completed IN IT — so the tokens before the cursor are `words.slice(0, cword)` and the partial
// word is never read as a typed command. A shell driver that prepends the program name (below)
// passes one further along.

function at(shape: typeof data, words: readonly string[], cword: number): readonly string[] {
  return completionCandidates(shape, words, cword, appNames);
}


modelScenarios(data, installed, appNames);
// --- 2b. the lenient scan itself: the evidence the negative controls aim at -------------------
//
// The scanCall refusal contracts live in ./scan-contracts.ts (split out at S2.8 for the
// 700-line layout limit); the entry they run against is derived here.
scanContracts(registry, data, at, norm);

// The PRE-fix interpreter reading the differentials are judged against where the design
// documents the two shells' divergence (section 9): there the scenario is marked instead of
// failed — held to its own pre-fix reading — and every mark must be a documented family.
const mergedReading = mergedReadingFor(data, appNames);
const bashDivergent: string[] = [];
const pwshDivergent: string[] = [];
const shellsRan: string[] = [];
const answerSetsAgree = (left: readonly string[], right: readonly string[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

// --- 3. the differential: the same scenarios through a real bash and a real PowerShell -------
//
// The scenarios are GENERATED from the table (scenarios.ts), never hand-listed, so a command the
// registry declares is covered because it is a row there. The expected answer is always the
// model's; where a shell disagrees the check fails — that is the whole point of running two
// real interpreters against one reference.

const scenarios = completionScenarios(data);
/** The model's answer for one scenario, after the filter the shells apply themselves (compgen
 *  -W … -- "$cur", `-like "$wordToComplete*"`). Both sides are normalised, because bash's compgen
 *  keeps the table's own order and pwsh's Sort-Object orders by culture: what is compared is the
 *  SET of answers, never an ordering rule the model does not own. */
function expected(scenario: CompletionScenario): string[] {
  const partial = scenario.words[scenario.cword] ?? "";
  return norm(completionCandidates(data, scenario.words, scenario.cword, appNames)).filter((value) => value.startsWith(partial));
}

/** One shell's answers, scenario by scenario: normally the model's own decision holds; where
 *  the design documents the frozen interpreters' merging (section 9) the scenario is marked
 *  divergent and held to its own pre-fix reading instead, and the marks are audited. */
function assertShellAnswers(shell: string, answers: Map<string, string[]>, into: string[]): void {
  const divergent: string[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const observed = norm(answers.get(String(index)) ?? []);
    const partial = scenario.words[scenario.cword] ?? "";
    const merged = norm(mergedReading(scenario)).filter((value) => value.startsWith(partial));
    if (answerSetsAgree(merged, expected(scenario))) {
      check(`${shell}: ${scenario.name} matches the model's decision`, observed, expected(scenario));
    } else {
      divergent.push(scenario.name);
      check(`${shell}: ${scenario.name} — the frozen interpreter merges where the binder refuses (design section 9)`, observed, merged);
    }
  }
  into.push(...divergent);
  shellsRan.push(shell);
  checkDivergences(shell, scenarios, divergent, data);
}

// scenarios.ts names the cursor by the word being completed's index in `words`; every driver
// below prepends the program name, so its own cursor index is one further along.
check("every scenario's cword is the index of its last word, the one being completed",
  scenarios.every((scenario) => scenario.cword === scenario.words.length - 1), true);

// --- 2c. the oracle: the same scenarios answered off the registry, no table -------------------
//
// For EVERY scenario the shell differentials run, the expected candidates are derived a second
// way: straight off the REGISTRY entry's own declaration through scanCall — no CompletionData
// field consulted (no top, declared, shapes, values; only registry.entries, registry.names and
// the appNames stub). The table is built from the same declarations, so a disagreement below
// is either an oracle bug (fix the oracle, say so) or a real model/table divergence (report
// every disagreeing scenario, never smooth it over).

{
  // The gate's own --app selector — entry/registry.ts's checkoutGate owns it (appFlag true for
  // this checkout gate) — stepped over exactly as the model steps over it, both spellings.
  const appFlag = true;
  const choicesOf = (argument: CommandArgument): readonly string[] =>
    (argument as { choices?: readonly string[] }).choices
      ?? (argument.value as { choices?: readonly string[] } | undefined)?.choices ?? [];
  const flagNameOf = (argument: CommandArgument): string => `--${argument.name}`;
  const sharedFlags = (args: readonly CommandArgument[]): string[] =>
    args.filter((argument) => (argument.kind === "flag" || argument.kind === "option") && argument.actions === undefined).map(flagNameOf);
  const scopedFlags = (args: readonly CommandArgument[], word: string): string[] =>
    args.filter((argument) => (argument.kind === "flag" || argument.kind === "option") && argument.actions?.includes(word) === true).map(flagNameOf);
  /** The command's own flag row: shared flags, the default action's flags when the shape
   *  names one, and --help. */
  const flagRow = (args: readonly CommandArgument[], shape: CallShape<CommandArgument>): string[] => {
    const defaultAction = defaultActionOf(shape as CallShape);
    const defaultFlags = defaultAction !== undefined && shape.actions !== undefined && Object.hasOwn(shape.actions, defaultAction)
      ? scopedFlags(args, defaultAction)
      : [];
    return [...new Set([...sharedFlags(args), ...defaultFlags, "--help"])].sort();
  };
  const oracle = (words: readonly string[], cword: number): readonly string[] => {
    const scan = words.slice(0, cword);
    let i = 0;
    while (appFlag && (scan[i] === "--app" || scan[i]?.startsWith("--app=") === true)) i += scan[i] === "--app" ? 2 : 1;
    if (i >= scan.length) {
      if (scan.at(-1) === "--app") return appNames();
      const top = [...registry.names].sort();
      for (const entry of registry.entries) top.push(...(entry.gate?.aliases ?? []));
      top.push("--app");
      return top;
    }
    const cmd = scan[i]!;
    const entry = registry.entries.find((candidate) => candidate.name === cmd);
    if (entry === undefined) return [];
    const args = entry.arguments ?? [];
    const shape = entry.shape as CallShape<CommandArgument>;
    const verbatimTail = args.some(
      (argument) => argument.kind === "variadic" && "verbatim" in argument && argument.verbatim === true);
    const between = scan.slice(i + 1);
    if (between.length === 0) {
      // The word being completed is the command's first positional: the action words, or a
      // declared positional `choices` / the registry names for a commandName positional.
      let words: readonly string[] = [];
      if (shape.actions !== undefined) words = Object.keys(shape.actions);
      else {
        const positional = args.find(
          (argument): argument is CommandArgument & { choices: readonly string[] } =>
            argument.kind === "positional" && (argument as { choices?: readonly string[] }).choices !== undefined);
        const offersRegistryNames = args.some(
          (argument) => argument.kind === "positional" && (argument.parse as { kind?: string } | undefined)?.kind === "commandName");
        words = positional?.choices ?? (offersRegistryNames ? registry.names : []);
      }
      return [...new Set([...words, ...flagRow(args, shape)])].sort();
    }
    // The model scans the SELECTED action's own slice: the oracle reads the same declaration
    // (the entry's own shape and arguments) — no slice widening anywhere.
    const scanned = scanCall(shape, between, cmd, { verbatimTail, fallback: args });
    if (scanned.optionsEnded) return [];
    if (verbatimTail && scanned.entries.some((token) => token.argument.kind === "variadic")) return [];
    if (scanned.pending !== undefined) {
      // The choice values the ENTRY's declaration offers here: the pending argument is found
      // by name in the entry's own arguments, its choices carrier or its declared value
      // kind's, scoped by the DECLARATION — offered everywhere when it names no `actions`,
      // else at the selected action, or at scope "" only under the declared default action.
      const pending = args.find((argument) => argument.name === scanned.pending!.name);
      const choices = pending === undefined ? [] : choicesOf(pending);
      if (pending === undefined || choices.length === 0) return [];
      const action = scanned.selected.name ?? "";
      const scope = pending.actions;
      if (scope === undefined) return [...choices];
      if (action !== "") return scope.includes(action) ? [...choices] : [];
      const fallback = defaultActionOf(shape as CallShape);
      return fallback !== undefined && scope.includes(fallback) ? [...choices] : [];
    }
    if (shape.actions !== undefined && Object.hasOwn(shape.actions, between[0] ?? "")) {
      return [...new Set([...sharedFlags(args), ...scopedFlags(args, between[0]!), "--help"])].sort();
    }
    return flagRow(args, shape);
  };
  for (const scenario of scenarios) {
    const partial = scenario.words[scenario.cword] ?? "";
    check(`oracle: ${scenario.name} agrees with the table`,
      norm(oracle(scenario.words, scenario.cword)).filter((value) => value.startsWith(partial)),
      expected(scenario));
  }
}

/** Single-quoted for bash and for PowerShell: the words are command names, action words, option
 *  names and the empty string, and a PowerShell single-quoted string is literal. */
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;
/** `<index>\t<joined replies>`, one line per scenario, from either driver. PowerShell's host
 *  writes `\r\n`, so a trailing carriage return is not part of an answer. */
function replies(stdout: string, separator: string): Map<string, string[]> {
  const parsed = new Map<string, string[]>();
  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    parsed.set(line.slice(0, tab), line.slice(tab + 1).split(separator).filter((word) => word !== ""));
  }
  return parsed;
}

/** ONE bash process for every scenario: the generated script is sourced once, then each scenario
 *  sets COMP_WORDS/COMP_CWORD exactly as an interactive shell would — the program name FIRST,
 *  which is what makes `"${COMP_WORDS[0]}" list --json …` reach the stub on PATH. */
function bashDriver(scriptPath: string): string {
  const runs = scenarios
    .map((scenario, index) => `reply ${index} ${scenario.cword} ${scenario.words.map(quote).join(" ")}`)
    .join("\n");
  return [
    `source ${quote(scriptPath.replaceAll("\\", "/"))}`,
    "reply() {",
    '  local index="$1" cword="$2"; shift 2',
    '  COMP_WORDS=("clawforge" "$@")',
    "  COMP_CWORD=$((cword + 1))",
    "  COMPREPLY=()",
    "  _clawforge_complete",
    '  printf \'%s\\t%s\\n\' "$index" "${COMPREPLY[*]}"',
    "}",
    runs,
    "",
  ].join("\n");
}

/** ONE PowerShell process for every scenario: the generated script is dot-sourced once, then
 *  TabExpansion2 answers each input script. A trailing space is literally the last element "",
 *  so `words` joined by a space is the right input for every scenario — the shell completes a NEW
 *  word, wordToComplete comes out empty and the tokens are the typed words only (verified on
 *  powershell.exe 5.1). The path is written with forward slashes: a backslash is an escape in a
 *  PowerShell double-quoted string, and the path reaches one. */
function pwshDriver(scriptPath: string): string {
  // PowerShell folds case by default (`-eq`, `-contains`, a hashtable): the upper-case scenarios
  // hold the completer to the parser's ordinal comparison. An empty word before the cursor is
  // typed as '' — the only way to write one.
  const runs = scenarios
    .map((scenario, index) => `Reply ${index} 'clawforge ${scenario.words.map((word, at) => (word === "" && at < scenario.cword ? "''''" : word)).join(" ")}'`)
    .join("\n");
  return [
    `. ${quote(scriptPath.replaceAll("\\", "/"))}`,
    "function Reply($n, $inputScript) {",
    "  $expansion = TabExpansion2 -inputScript $inputScript -cursorColumn $inputScript.Length",
    // TabExpansion2 falls back to FILESYSTEM completion when the completer offers nothing (an
    // unknown command), and no candidate this table holds is ever a path — so the fallback is
    // dropped rather than mistaken for an answer.
    "  $names = @($expansion.CompletionMatches | ForEach-Object { $_.CompletionText } | Where-Object { $_ -notmatch '[\\\\/]' })",
    `  Write-Output ("$n" + [char]9 + (($names | Sort-Object -Unique) -join ','))`,
    "}",
    runs,
    // The checkout shim: the completer registers both spellings, and ./clawforge must complete.
    "Reply shim './clawforge sta'",
    "",
  ].join("\n");
}

// --- 3b. the Install: line pasted in ITS shell ----------------------------------------------
//
// The Install: header is spelled for the script's OWN shell, independent of the invocation's
// host (rf6-fix30): under the win32 bin-wrapper program the bash line carries forward slashes
// (bash strips a backslash), the pwsh line names a path PowerShell resolves. The program word
// of each line is pinned LITERALLY below — not by calling installLine, which would make the
// expectation a tautology a spelling regression passes.

const WRAPPER_FRAME: Invocation = { program: "node_modules\\.bin\\clawforge", mode: "local-package", audience: "terminal" };

// the note marker an Install line must not carry inside its executable part ("  (");
// built from code points so the measurement reads it as data, not held prose
const NOTE_MARK = String.fromCharCode(32, 32, 40);

// --- 3c. notes stay OUT of the executable lines (S1.4 item 3) --------------------------------
//
// A note names the shell that can paste a line; it must never land INSIDE an executable
// pipeline. The render API carries notes separately (renderAdviceParts/installLineParts);
// these literals pin the composed surfaces.
{
  // Item 5 (S1.4): these checks run over the CURRENT composer output — never the committed
  // snapshot. Under a checkout frame the pwsh Install line is the sentence form (the bash
  // shim has no pwsh pipeline); every rendered command tokenizes in its own shell
  // (kit/shells.ts) and opens with the frame's program spelling.
  const previous = invocation();
  setInvocation({ program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" });
  try {
    // executable part plus where it ends in the raw line: the note check below runs on the
    // UNTRUNCATED text, so a note before the executable part cannot survive the last "  (" cut
    const commandOf = (line: string): { executable: string; end: number } => {
      const inner = /source <\(([^)]+)\)/.exec(line);
      if (inner !== null) return { executable: inner[1]!, end: inner.index + inner[0].length };
      const sentence = /run (\S+ completion \S+) in Git Bash/.exec(line);
      if (sentence !== null) return { executable: sentence[1]!, end: sentence.index + sentence[1].length };
      const cut = line.lastIndexOf("  (");
      return { executable: (cut === -1 ? line : line.slice(0, cut)).trim(), end: cut === -1 ? line.length : cut };
    };
    for (const shell of ["bash", "zsh", "pwsh"] as const) {
      const script = renderCompletion(shell, data);
      const installMarker = /Install: /;
      const sourceMarker = /^# +source <\(/
      const installLines = script.split("\n").filter((line) => installMarker.test(line) || sourceMarker.test(line.trim())).map((line) => {
        const at = line.search(installMarker);
        const text = at === -1 ? line.trim().replace(/^# +/, "") : line.slice(at + "Install:".length + 1);
        return text;
      });
      const carriesInstall = installLines.length >= (shell === "zsh" ? 2 : 1);
      checkTrue(`the ${shell} script carries Install lines`, carriesInstall);
      const model = shell === "pwsh" ? "pwsh" : "posix";
      for (const install of installLines) {
        const { executable, end } = commandOf(install);
        const head = install.slice(0, end);
        const noteInside = head.includes(NOTE_MARK) || head.includes("(in");
        let words: readonly string[] = [];
        let tokenized = true;
        try { words = tokenizeLine(executable, model); } catch { tokenized = false; }
        const opensWithProgram = tokenized && words.length > 0 && words[0] === SHIM_PROGRAM;
        checkTrue("an Install line's executable part carries no note", noteInside === false);
        checkTrue("an Install line tokenizes in its own shell", tokenized === true && words.length > 0);
        checkTrue("an Install line opens with the frame's program", opensWithProgram);
      }
      // The note rides AFTER the whole composed line: a sentence names the shell it needs
      // ("... in Git Bash"); a pipeline never carries a parenthetical mid-command.
      const first = installLines[0] ?? "";
      const sentenceForm = / in Git Bash/.test(first);
      const markerAt = first.search(/  \(/);
      const ridesWhole = sentenceForm || markerAt === -1 || first.slice(markerAt).endsWith(")");
      checkTrue(`the ${shell} Install header's note rides after the whole line`, ridesWhole === true);
    }
    // Help prose: the rendered sentence keeps every command whole, its note outside.
    const details = makeCompletionGateCommand([], true).details ?? "";
    const prose = renderProse(details);
    const pipeNote = prose.search(/  \(in bash\) \|/) !== -1;
    const redirectNote = prose.search(/  \(in bash\) >/) !== -1;
    checkTrue("the rendered Install sentence keeps the pwsh note out of the pipeline", pipeNote === false && redirectNote === false && /and pipe it through/.test(prose) === true);
    checkHelpInstallFragments(prose, details, SHIM_PROGRAM);
  } finally {
    setInvocation(previous);
  }
}

await requires("bash", "the bash Install: line, pasted in a real bash", async () => {
  const previous = invocation();
  setInvocation(WRAPPER_FRAME);
  try {
    const rendered = renderCompletion("bash", data);
    const install = rendered.split("\n")[1]!.slice("# Install: ".length);
    const installProgram = install.slice("source <(".length, -1).split(" ")[0];
    check("bash: the Install: line's program is the forward-slash wrapper", installProgram, "node_modules/.bin/clawforge");
    const dir = await mkdtemp(join(tmpdir(), "clawforge-install-"));
    try {
      await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
      const scriptPath = join(dir, "completion.sh");
      await writeFile(scriptPath, rendered, "utf8");
      const wrapper = join(dir, "node_modules", ".bin", "clawforge");
      await writeFile(wrapper, `#!/bin/sh\ncat '${scriptPath.replaceAll("\\", "/")}'\n`, "utf8");
      await chmod(wrapper, 0o755);
      const driverPath = join(dir, "driver.sh");
      await writeFile(driverPath, [
        `install=${quote(install)}`,
        'eval "$install"',
        "complete -p clawforge",
        "complete -p ./clawforge",
        "",
      ].join("\n"), "utf8");
      const proc = spawnSync("bash", [driverPath], { timeout: 120_000, encoding: "utf8", cwd: dir });
      check("bash: the pasted Install: line exited 0", [proc.status, (proc.stderr ?? "").trim()], [0, ""]);
      const registered = (proc.stdout ?? "").split("\n").map((row) => row.trim()).filter((row) => row !== "").map((row) => row.split(" ").slice(-2)).sort();
      check("bash: the paste registered both completer names", registered, [["_clawforge_complete", "./clawforge"], ["_clawforge_complete", "clawforge"]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    setInvocation(previous);
  }
});

await requires("pwsh", "the pwsh Install: line, pasted in a real PowerShell", async () => {
  const pwsh = await pwshCommand();
  if (pwsh === undefined) return;
  const previous = invocation();
  setInvocation(WRAPPER_FRAME);
  try {
    const rendered = renderCompletion("pwsh", data);
    const install = rendered.split("\n")[1]!.slice("# Install: ".length);
    const pwshInstallProgram = install.split(" ")[0];
    check("pwsh: the Install: line's program is npm's Windows wrapper", pwshInstallProgram, "node_modules\\.bin\\clawforge");
    const dir = await mkdtemp(join(tmpdir(), "clawforge-install-"));
    try {
      await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
      // The stub serves a SHORT script: Out-String truncates redirected output at the host's
      // 120-column default, so the full script's long table lines would not survive the paste —
      // a pre-existing trait of the pipeline, not of the spelling this pins. Under test is the
      // spelled path resolving to the wrapper and the pipeline registering the completer.
      const scriptPath = join(dir, "completion.ps1");
      await writeFile(scriptPath, `$clawforgeTop = @('completion', 'help')\n`, "utf8");
      await writeFile(join(dir, "node_modules", ".bin", "clawforge.ps1"), `Get-Content '${scriptPath.replaceAll("\\", "/")}'\n`, "utf8");
      const wrapper = join(dir, "node_modules", ".bin", "clawforge");
      await writeFile(wrapper, `#!/bin/sh\ncat '${scriptPath.replaceAll("\\", "/")}'\n`, "utf8");
      await chmod(wrapper, 0o755);
      const driverPath = join(dir, "driver.ps1");
      await writeFile(driverPath, [
        install,
        "if ($clawforgeTop.Count -gt 0) { 'registered' }",
        "",
      ].join("\n"), "utf8");
      const proc = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", driverPath], { timeout: 420_000, encoding: "utf8", cwd: dir });
      check("pwsh: the pasted Install: line exited 0", [proc.status, (proc.stderr ?? "").trim()], [0, ""]);
      check("pwsh: the paste registered the completer", (proc.stdout ?? "").includes("registered"), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    setInvocation(previous);
  }
});

// Whether a usable bash exists is a host fact, not a string to sniff: the `bash` capability
// probe decides (and OC_CHECK_REQUIRE=bash turns the skip into a failure, which is what CI does).
await requires("bash", "the generated bash script, sourced by a real bash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawforge-completion-"));
  try {
    const scriptPath = join(dir, "completion.sh");
    await writeFile(scriptPath, renderCompletion("bash", data), "utf8");
    // A stub `clawforge` on PATH answers --app's lazy `list --json` deterministically — the
    // hidden name included, which the script must filter out.
    const stub = join(dir, "clawforge");
    await writeFile(stub, `#!/bin/sh\necho '${STUB_JSON}'\n`, "utf8");
    await chmod(stub, 0o755);
    const driverPath = join(dir, "driver.sh");
    await writeFile(driverPath, bashDriver(scriptPath), "utf8");
    const proc = spawnSync("bash", [driverPath], {
      timeout: 360_000, encoding: "utf8",
      // The stub has to be found on PATH for `"${COMP_WORDS[0]}" list --json …` to answer.
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` },
    });
    check("bash: the driver exited 0", [proc.status, (proc.stderr ?? "").trim()], [0, ""]);
    const answers = replies(proc.stdout, " ");
    assertShellAnswers("bash", answers, bashDivergent);
    check("bash: the generated script parses (bash -n)", spawnSync("bash", ["-n", scriptPath], { timeout: 15_000 }).status, 0);
    // zsh loads this SAME completer body through bashcompinit, so the two scripts cannot drift:
    // everything from `_clawforge_lookup()` to the end is one text, byte for byte.
    const body = (text: string): string => text.slice(text.indexOf("_clawforge_lookup()"));
    check("zsh's completer body equals bash's byte for byte",
      body(renderCompletion("zsh", data)), body(renderCompletion("bash", data)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await requires("pwsh", "the generated pwsh script, driven by a real PowerShell", async () => {
  // pwshCommand() names the very binary the capability probe accepted — pwsh, or powershell.exe
  // (5.1) on a Windows host without it.
  const pwsh = await pwshCommand();
  if (pwsh === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "clawforge-completion-"));
  try {
    const scriptPath = join(dir, "completion.ps1");
    await writeFile(scriptPath, renderCompletion("pwsh", data), "utf8");
    // A PowerShell resolves a bare command name to the .ps1 whose directory LEADS PATH, and
    // `& $tokens[0] …` cannot reach a .cmd stub on Windows — so the stub is a .ps1 and the
    // directory is first in the child's PATH. Its JSON sits on one line, as the model expects.
    await writeFile(join(dir, "clawforge.ps1"), `Write-Output '${STUB_JSON}'\n`, "utf8");
    const driverPath = join(dir, "driver.ps1");
    await writeFile(driverPath, pwshDriver(scriptPath), "utf8");
    const proc = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", driverPath], {
      timeout: 420_000, encoding: "utf8",
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` },
    });
    check("pwsh: the driver exited 0", [proc.status, (proc.stderr ?? "").trim()], [0, ""]);
    const answers = replies(proc.stdout, ",");
    assertShellAnswers("pwsh", answers, pwshDivergent);
    check("pwsh: the checkout shim ./clawforge completes too",
      norm(answers.get("shim") ?? []).includes("status"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Both differentials record their divergent scenarios independently; where both shells ran,
// the two per-shell divergence sets must name the same scenarios.
check("bash and pwsh record the same divergent scenarios",
  !(shellsRan.includes("bash") && shellsRan.includes("pwsh")) || answerSetsAgree(bashDivergent, pwshDivergent), true);

// --- 4. interpreter invariance: two different tables, one grammar ---------------------------
//
// "Differs only in the data block" means precisely this: the `case` arms bash emits inside
// `_clawforge_lookup` (the "top", "first <command>", "after <command> <word>" and
// "values <command+scope+option>" rows), and what pwsh emits as `$clawforgeApp` plus the four
// tables, are the ONLY things two renders of two different command sets disagree about. Every
// other byte — the interpreter, the headers, the registrations — is a constant of the renderer,
// which is also what lets zsh reuse the bash body verbatim.

/** From the catch-all arm to the end of the script: the fixed interpreter and the registrations. */
const PWSH_FIXED_FROM = "$clawforgeCompleter = {";
const tail = (text: string, from: string): string => text.slice(text.indexOf(from));
const slice = (text: string, from: string, to: string): string => text.slice(text.indexOf(from), text.indexOf(to));

// bash's render is the header, `_clawforge_lookup`'s frame, the data `case` arms, the catch-all,
// `_clawforge_complete` — with the gate's own `--app` snippets inside it where it has a selector
// — and the two registrations. Two tables of two different gates differ in the arms and in those
// snippets and NOWHERE else, which is what the three slices below pin down.
const ARMS_FROM = '    "top")';
const ARMS_TO = "    *) return 1 ;;";
/** What the gate's own `--app` selector adds to the fixed interpreter, and nothing else: the
 *  pair the command-word scan steps over, and the block that answers `--app`'s own value. An
 *  installed single-deployment gate has no selector, so its render carries neither — which is
 *  why these two are removed before two renders are compared, and why the check that they
 *  really are the difference (the third list entry below) has to see them differ. */
const withoutAppSelector = (text: string): string => text.split(APP_SKIP_PAIR).join("").split(APP_VALUES_BLOCK).join("");
/** The script without its generated `case` arms: the header, the lookup's frame and the
 *  interpreter — everything that is a constant of the renderer rather than of the table. */
const withoutArms = (text: string): string => text.slice(0, text.indexOf(ARMS_FROM)) + text.slice(text.indexOf(ARMS_TO));
{
  const bashTrue = renderCompletion("bash", data);
  const bashInstalled = renderCompletion("bash", installed);
  check("bash: two tables differ only in the data arms and the --app selector's own lines",
    [withoutArms(withoutAppSelector(bashTrue)) === withoutArms(withoutAppSelector(bashInstalled)),
     slice(bashTrue, ARMS_FROM, ARMS_TO) !== slice(bashInstalled, ARMS_FROM, ARMS_TO),
     bashTrue.includes(APP_SKIP_PAIR) && !bashInstalled.includes(APP_SKIP_PAIR)
     && bashTrue.includes(APP_VALUES_BLOCK) && !bashInstalled.includes(APP_VALUES_BLOCK)],
    [true, true, true]);
  check("pwsh: two tables differ only in the data block, never in the interpreter",
    [tail(renderCompletion("pwsh", data), PWSH_FIXED_FROM) === tail(renderCompletion("pwsh", installed), PWSH_FIXED_FROM),
     renderCompletion("pwsh", data) !== renderCompletion("pwsh", installed)], [true, true]);
}

finish("completion behaviour");
