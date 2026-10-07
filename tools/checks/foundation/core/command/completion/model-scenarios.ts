// Section 2 of completion-behaviour.check.ts (moved at the S2.8 rebase for the 700-line
// layout limit): the reference-model scenarios — given the words and the cursor, these
// candidates come out of completionCandidates. `installed` is the same registry's table
// without --app, so its assertions double as the installed-gate coverage.

import { completionCandidates, type CompletionData } from "#framework/integration/completion/table.ts";
import { check } from "#checks/kit/harness.ts";

export function modelScenarios(
  data: CompletionData,
  installed: CompletionData,
  appNames: () => readonly string[],
): void {
  const at = (shape: CompletionData, words: readonly string[], cword: number): readonly string[] =>
    completionCandidates(shape, words, cword, appNames);
  const actionWordsOf = (command: string): string[] =>
    [...data.after.keys()]
      .filter((key) => key.startsWith(command + " ") && key !== [command, "*"].join(" "))
      .map((key) => key.slice(command.length + 1));
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
  const bareProfile = [...at(data, ["backup", "--profile", ""], 2)].sort();
  const createProfile = [...at(data, ["backup", "create", "--profile", ""], 3)].sort();
  check("the default action's option values are offered (backup --profile)",
    JSON.stringify(bareProfile) === JSON.stringify(createProfile) && bareProfile.length > 0, true);
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

}
