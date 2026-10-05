// Shell completion BEHAVES, not just renders. Every scenario here states "given the words and
// the cursor state, these candidates come out" — against completionCandidates (the one decision
// both emitted scripts implement), against the bash script ACTUALLY SOURCED by a real bash, and
// against the pwsh script EXECUTED by a real PowerShell through TabExpansion2. All three must
// agree. What this file replaces pinned script substrings (bash's `-W` list, pwsh's
// `"install" = @(` line, the position-past-an-action-word regex) — and those checks PASSED the
// R32-02 regression, a prefix typed at the top level offering nothing; behavioural checks
// cannot (R33-10).

import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { completionCandidates, completionData } from "#framework/integration/completion/table.ts";
import { makeCompletionGateCommand, renderCompletion } from "#framework/integration/completion/index.ts";
import { APP_SKIP_PAIR, APP_VALUES_BLOCK } from "#framework/integration/completion/bash.ts";
import { surfaceRegistry } from "#framework/entry/registry.ts";
import { completionScenarios, type CompletionScenario } from "./scenarios.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";
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
/** The action words a command declares, read off its own `after` rows — so a word that is one
 *  command's action and another command's name (backup's `list` vs the gate's `list`) is never
 *  mistaken for a command name leaking into a command's own candidates. */
const actionWordsOf = (command: string): string[] =>
  [...data.after.keys()]
    .filter((key) => key.startsWith(`${command} `) && key !== `${command} *`)
    .map((key) => key.slice(command.length + 1));

const STUB_JSON = '[{"name":"app-one"},{"name":"app-two"},{"name":".hidden"}]';

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

{
  // R32-02: `clawforge sta<Tab>` used to see the command "sta"; only the words BEFORE the cursor
  // pick the command, so a prefix typed anywhere still completes behind it.
  check("a typed prefix at the top level still completes commands (R32-02)", at(data, ["sta"], 0).includes("status"), true);
  check("a typed flag prefix completes --app", at(data, ["--ap"], 0).includes("--app"), true);
  check("a typed prefix after a command completes an action word", at(data, ["backup", "l"], 1).includes("list"), true);
  check("a typed prefix after watch completes install", at(data, ["watch", "in"], 1).includes("install"), true);

  const trailing = at(data, ["backup", ""], 1);
  check("backup's trailing space offers the action words and the create flags",
    ["create", "install", "list", "prune-replaced", "uninstall", "--hot", "--dry-run"].every((word) => trailing.includes(word)), true);
  check("a trailing space never offers command names",
    data.top.filter((name) => trailing.includes(name) && !actionWordsOf("backup").includes(name)), []);

  const afterApp = at(data, ["--app", "app-one", "backup", ""], 3);
  check("after --app X backup still offers actions and create flags",
    [afterApp.includes("create"), afterApp.includes("--hot")], [true, true]);
  check("--app's own value is the deployment list", [...at(data, ["--app", ""], 1)], ["app-one", "app-two"]);

  // The `=` form splitLeadingAppFlag accepts on the command line too: the command after it
  // completes, exactly as after the two-token form.
  const afterAppEq = at(data, ["--app=app-one", "backup", ""], 2);
  check("after --app=x backup still offers actions and create flags",
    [afterAppEq.includes("create"), afterAppEq.includes("--hot")], [true, true]);

  const afterFlag = at(data, ["backup", "--hot", ""], 2);
  check("after backup --hot the create flags continue", [afterFlag.includes("--dry-run"), afterFlag.includes("--migrate")], [true, true]);
  check("after backup --hot no action word is offered (backup would reject it)", afterFlag.includes("list"), false);

  check("mcp-setup --client's value position offers its choices",
    [...at(data, ["mcp-setup", "--client", ""], 2)], ["claude", "codex", "both"]);
  const kind = at(data, ["set", "forget", "--kind", ""], 3);
  check("set forget --kind's value position is the kind values", [...kind].sort(), ["agent", "cron-job", "mcp-server"]);
  check("kind's value position does not offer flags", kind.includes("--kind"), false);
  check("set try --kind's value position offers no kind values (R33-10)",
    ["agent", "cron-job", "mcp-server"].some((value) => at(data, ["set", "try", "--kind", ""], 3).includes(value)), false);
  check("after the value is given the command's flags return",
    at(data, ["mcp-setup", "--client", "claude", ""], 3).includes("--rewrite-launcher"), true);

  const hostPosition = at(data, ["host", ""], 1);
  check("host's positional choices are offered at its position",
    ["target", "engine", "local"].every((value) => hostPosition.includes(value)), true);
  check("after host's positional flags return", at(data, ["host", "target", ""], 2).includes("--confirm-root"), true);
  // R4-1: past a pass-through command's declared positionals the tail is the child's literal
  // text — its own flags must not be offered where the parser would bind them as child text.
  check("host's verbatim tail offers nothing (R4-1)", [...at(data, ["host", "target", "id", "--ro"], 4)], []);
  check("exec's verbatim tail offers nothing (R4-1)", [...at(data, ["exec", "ls", "--raw"], 3)], []);
  check("a declared flag before a verbatim command's positionals keeps offering its flags",
    at(data, ["host", "--root", ""], 2).includes("--confirm-root"), true);
  // An undeclared dash word is where the parser's verbatim mode starts the child's literal tail.
  check("an undeclared dash word starts the verbatim tail (host --bogus)", [...at(data, ["host", "--bogus", ""], 2)], []);
  // R5-B F5-1: a bare `--` starts the verbatim tail — the parser binds everything after it as
  // the child's literal text, so the command's own flags must not be offered there.
  check("a bare -- starts the verbatim tail: host's flags stop (R5-B F5-1)", [...at(data, ["host", "target", "--", ""], 3)], []);
  check("a bare -- starts the verbatim tail: cli's flags stop", [...at(data, ["cli", "--", ""], 2)], []);
  // R9-4: the bare `--` cutoff is not a verbatim privilege — any command's flags stop behind
  // it, and without it they still come out.
  check("a bare -- starts any variadic tail: check's flags stop (R9-4)", [...at(data, ["check", "--", ""], 2)], []);
  check("a bare -- starts any variadic tail: set diff's flags stop", [...at(data, ["set", "diff", "--", ""], 3)], []);
  // One rule after a bare `--` that is no option's value: nothing, refused or not — the word
  // behind it (`status -- x`) and a refusal before it (`check --bogus --`) change nothing.
  check("a bare -- followed by a refused word still offers nothing", [...at(data, ["status", "--", "x", ""], 3)], []);
  check("a bare -- behind a refused flag offers nothing", [...at(data, ["check", "--bogus", "--", ""], 3)], []);
  // An option still waiting for its value completes that value: its choices, or nothing.
  check("an option with no choices offers nothing at its value (logs --grep)", [...at(data, ["logs", "--grep", ""], 2)], []);
  check("the default action's option values are offered (backup --profile)",
    [...at(data, ["backup", "--profile", ""], 2)].sort(), [...at(data, ["backup", "create", "--profile", ""], 3)].sort());
  check("backup --profile's choices are not empty", at(data, ["backup", "--profile", ""], 2).length > 0, true);
  check("an option's value is no marker or flag position (check --jobs -- offers flags)", at(data, ["check", "--jobs", "--", ""], 3).includes("--list"), true);
  check("check's flags without -- still complete", at(data, ["check", "--j"], 1).includes("--jobs"), true);

  check("help completes command names",
    [at(data, ["help", "st"], 1).includes("status"), at(data, ["help", ""], 1).includes("backup")], [true, true]);
  check("completion completes the shell names", at(data, ["completion", "b"], 1).includes("bash"), true);
  check("an installed gate without --app never offers it",
    [[...at(installed, ["--app", ""], 1)], at(installed, ["sta"], 0).includes("--app")], [[], false]);
  check("an unknown command completes to nothing", [...at(data, ["zzz-nope-command", ""], 1)], []);
  // A command's default action is the one its declaration names (recipe: list, backup: create),
  // for flags and for choice-valued options: the bare call's flags complete without an action word.
  check("recipe's bare call completes the default action's --json", [at(data, ["recipe", "--j"], 1).includes("--json"), at(data, ["recipe", "zz", ""], 2).includes("--json")], [true, true]);
  check("recipe's explicit list still offers --json and install does not", [at(data, ["recipe", "list", ""], 2).includes("--json"), at(data, ["recipe", "install", ""], 2).includes("--json")], [true, false]);
  check("backup's bare call still completes create's flags", at(data, ["backup", "--h"], 1).includes("--hot"), true);
  check("upper-case words are not declared words", [at(data, ["Backup", ""], 1).length, at(data, ["backup", "LIST", ""], 2).includes("--keep"), at(data, ["logs", "--TAIL", ""], 2).includes("--help")], [0, false, true]);
  check("watch install --int completes --interval", at(data, ["watch", "install", "--int"], 2).includes("--interval"), true);

  // --app is positional and must lead the command: past a command word the command's own flags
  // come back instead of the deployment list (R33-10).
  const afterAppFlag = at(data, ["status", "--app", ""], 2);
  check("--app after a command offers that command's flags, not deployments",
    [afterAppFlag.includes("--help"), afterAppFlag.includes("app-one")], [true, false]);
}

// --- 3. the differential: the same scenarios through a real bash and a real PowerShell -------
//
// The scenarios are GENERATED from the table (scenarios.ts), never hand-listed, so a command the
// registry declares is covered because it is a row there. The expected answer is always the
// model's; where a shell disagrees the check fails — that is the whole point of running two
// real interpreters against one reference.

const scenarios = completionScenarios(data);
const norm = (values: readonly string[]): string[] => [...new Set(values)].sort();
/** The model's answer for one scenario, after the filter the shells apply themselves (compgen
 *  -W … -- "$cur", `-like "$wordToComplete*"`). Both sides are normalised, because bash's compgen
 *  keeps the table's own order and pwsh's Sort-Object orders by culture: what is compared is the
 *  SET of answers, never an ordering rule the model does not own. */
function expected(scenario: CompletionScenario): string[] {
  const partial = scenario.words[scenario.cword] ?? "";
  return norm(completionCandidates(data, scenario.words, scenario.cword, appNames)).filter((value) => value.startsWith(partial));
}

// scenarios.ts names the cursor by the word being completed's index in `words`; every driver
// below prepends the program name, so its own cursor index is one further along.
check("every scenario's cword is the index of its last word, the one being completed",
  scenarios.every((scenario) => scenario.cword === scenario.words.length - 1), true);

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
      timeout: 120_000, encoding: "utf8",
      // The stub has to be found on PATH for `"${COMP_WORDS[0]}" list --json …` to answer.
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` },
    });
    check("bash: the driver exited 0", [proc.status, (proc.stderr ?? "").trim()], [0, ""]);
    const answers = replies(proc.stdout, " ");
    for (const [index, scenario] of scenarios.entries()) {
      check(`bash: ${scenario.name} matches the model's decision`, norm(answers.get(String(index)) ?? []), expected(scenario));
    }
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
      timeout: 180_000, encoding: "utf8",
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` },
    });
    check("pwsh: the driver exited 0", [proc.status, (proc.stderr ?? "").trim()], [0, ""]);
    const answers = replies(proc.stdout, ",");
    for (const [index, scenario] of scenarios.entries()) {
      check(`pwsh: ${scenario.name} matches the model's decision`, norm(answers.get(String(index)) ?? []), expected(scenario));
    }
    check("pwsh: the checkout shim ./clawforge completes too",
      norm(answers.get("shim") ?? []).includes("status"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
