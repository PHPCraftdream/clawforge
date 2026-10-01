// Shell completion behaves, not just renders: every scenario below states "given the words
// and the cursor state, these candidates come out" — against completionCandidates (the one
// decision both emitted scripts implement), against the bash script actually sourced by a
// real bash, and against the pwsh script's own emitted tables (re-parsed and re-walked).
// Substring checks over script text passed the R32-02 regression; these cannot.

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompletionModel, renderCompletion, completionCandidates, makeCompletionGateCommand } from "#framework/integration/completion.ts";
import type { CommandCompletionSpec } from "#framework/integration/completion.ts";
import type { GateCommand } from "#framework/integration/gate.ts";
import { check, finish } from "#checks/kit/harness.ts";

// The completion command itself is in the model, as the gates assemble it — so its own
// positional shell choices are completable too.
const gateCommands: GateCommand[] = [];
gateCommands.push(makeCompletionGateCommand(gateCommands, true));
const model = buildCompletionModel(gateCommands);
const names = model.map((spec) => spec.name);

function candidates(rest: string[], wordToComplete: string, appFlag = true): readonly string[] {
  return completionCandidates(model, rest, wordToComplete, appFlag, ["app-one", "app-two"]);
}

// --- the shared decision, scenario by scenario (R32-02 / R32-09) ------------------------------

{
  check("a typed prefix at the top level still completes commands (R32-02)", candidates(["sta"], "sta").includes("status"), true);
  check("a typed flag prefix completes --app", candidates(["--ap"], "--ap").includes("--app"), true);
  check("a typed prefix after a command completes an action word", candidates(["backup", "l"], "l").includes("list"), true);
  check("a typed prefix after watch completes install", candidates(["watch", "in"], "in").includes("install"), true);

  const trailing = candidates(["backup"], "");
  check("a trailing space after backup offers the implicit action's flags", [trailing.includes("create"), trailing.includes("--hot"), trailing.includes("--dry-run")], [true, true, true]);
  check("a trailing space never offers command names", names.filter((name) => trailing.includes(name)), []);

  const afterApp = candidates(["--app", "app-one", "backup"], "");
  check("after --app X, backup still offers actions and create's flags", [afterApp.includes("create"), afterApp.includes("--hot")], [true, true]);
  check("--app's own value completes from the deployment list", candidates(["--app"], ""), ["app-one", "app-two"]);

  const afterFlag = candidates(["backup", "--hot"], "");
  check("after backup --hot the create flags continue", [afterFlag.includes("--dry-run"), afterFlag.includes("--migrate")], [true, true]);
  check("after backup --hot no action word is offered (backup would reject it)", afterFlag.includes("list"), false);

  check("an option with choices offers its values at the value position", candidates(["mcp-setup", "--client"], ""), ["claude", "codex", "both"]);
  const kindValues = model.find((spec) => spec.name === "set")!.optionValues!["--kind"]!;
  check("an action-scoped option with choices offers its values there too", candidates(["set", "forget", "--kind"], ""), kindValues);
  check("kind's value position does not offer flags", candidates(["set", "forget", "--kind"], "").includes("--kind"), false);
  check("after the value is given, the command's flags return", candidates(["mcp-setup", "--client", "claude"], "").includes("--rewrite-launcher"), true);

  const hostPosition = candidates(["host"], "");
  check("host's positional choices are offered at its position", ["target", "engine", "local"].every((value) => hostPosition.includes(value)), true);
  check("after host's positional is given, flags return", candidates(["host", "target"], "").includes("--confirm-root"), true);

  check("help completes command names", [candidates(["help", "st"], "st").includes("status"), candidates(["help"], "").includes("backup")], [true, true]);
  check("completion completes the shell names", candidates(["completion", "b"], "b").includes("bash"), true);
  check("an installed gate without --app never offers it", candidates(["sta"], "sta", false).includes("--app"), false);
  check("an unknown command completes to nothing", candidates(["zzz"], ""), []);
  check("backup with the action word typed in full offers that action's flags", candidates(["watch", "install", "--int"], "--int").includes("--interval"), true);
}

// --- the pwsh script: re-parse its own tables and walk the same decision ----------------------

interface PwshTables {
  names: string[];
  flags: Record<string, string[]>;
  actions: Record<string, Record<string, string[]>>;
  choices: Record<string, string[]>;
  positional: Record<string, string[]>;
}

function parsePwshTables(script: string): PwshTables {
  const tables: PwshTables = { names: [], flags: {}, actions: {}, choices: {}, positional: {} };
  const values = (raw: string): string[] => [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  let section = "";
  let actionCommand = "";
  for (const line of script.split("\n")) {
    const commandsMatch = /^\$clawforgeCommands = @\((.*)\)/.exec(line);
    if (commandsMatch !== null) {
      tables.names = values(commandsMatch[1]);
      continue;
    }
    const sectionMatch = /^\$(clawforge\w+) = @\{/.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1];
      continue;
    }
    if (section === "clawforgeActions") {
      const commandMatch = /^  "([^"]+)" = @\{$/.exec(line);
      if (commandMatch !== null) {
        actionCommand = commandMatch[1];
        tables.actions[actionCommand] = {};
      } else if (/^  \}$/.test(line)) {
        actionCommand = "";
      } else {
        const entry = /^    "([^"]+)" = @\(([^)]*)\)/.exec(line);
        if (entry !== null && actionCommand !== "") tables.actions[actionCommand][entry[1]] = values(entry[2]);
      }
      continue;
    }
    const entry = /^  "([^"]+)" = @\(([^)]*)\)/.exec(line);
    if (entry === null) continue;
    if (section === "clawforgeFlags") tables.flags[entry[1]] = values(entry[2]);
    if (section === "clawforgeChoiceValues") tables.choices[entry[1]] = values(entry[2]);
    if (section === "clawforgePositional") tables.positional[entry[1]] = values(entry[2]);
  }
  return tables;
}

function specFromTables(tables: PwshTables): CommandCompletionSpec[] {
  return tables.names.map((name) => {
    const choiceEntries = Object.entries(tables.choices).filter(([key]) => key.startsWith(`${name}--`));
    const optionValues = choiceEntries.length === 0 ? undefined : Object.fromEntries(choiceEntries.map(([key, values]) => [key.slice(name.length), values]));
    const action = tables.actions[name];
    if (action === undefined) {
      return { name, flags: tables.flags[name] ?? [], positionalValues: tables.positional[name], optionValues };
    }
    return {
      name,
      flags: tables.flags[name] ?? [],
      action: { values: Object.keys(action).sort(), flags: action, fallback: tables.flags[name] ?? [] },
      optionValues,
    };
  });
}

{
  for (const appFlag of [true, false]) {
    const script = renderCompletion("pwsh", model, appFlag);
    const tables = parsePwshTables(script);
    const scriptModel = specFromTables(tables);
    const walk = (rest: string[], wordToComplete: string): readonly string[] =>
      completionCandidates(scriptModel, rest, wordToComplete, appFlag, ["app-one", "app-two"]);
    // The tables in the emitted script must reproduce the model's own decision — the same
    // scenarios, fed from the script's data rather than from the declarations.
    check(`pwsh (appFlag ${appFlag}): script tables reproduce prefix completion`, walk(["sta"], "sta").includes("status"), true);
    check(`pwsh (appFlag ${appFlag}): script tables reproduce the trailing-space action offer`, walk(["backup"], "").includes("create"), true);
    check(`pwsh (appFlag ${appFlag}): script tables reproduce --app X backup`, walk(["--app", "app-one", "backup"], "").includes("--hot"), appFlag);
    check(`pwsh (appFlag ${appFlag}): script tables reproduce the value position`, walk(["mcp-setup", "--client"], "").join(" "), "claude codex both");
    check(`pwsh (appFlag ${appFlag}): script tables reproduce host's positional`, walk(["host"], "").includes("target"), true);
    check(`pwsh (appFlag ${appFlag}): script tables reproduce help's command names`, walk(["help", "st"], "st").includes("status"), true);
    check(`pwsh (appFlag ${appFlag}): script tables reproduce after-flag fallback`, [walk(["backup", "--hot"], "").includes("--hot"), walk(["backup", "--hot"], "").includes("list")], [true, false]);
    check(
      `pwsh (appFlag ${appFlag}): the script scans only the words before the partial one`,
      [script.includes("$scan = @($rest[0..($rest.Count - 2)])"), script.includes("ContainsKey(\"$cmd$prev\")")],
      [true, true],
    );
    check(`pwsh (appFlag ${appFlag}): rendering is deterministic`, renderCompletion("pwsh", model, appFlag), script);
  }
  check("pwsh without --app never mentions it", /--app\b/.test(renderCompletion("pwsh", model, false)), false);
}

// --- the bash script, actually sourced by a real bash -----------------------------------------

{
  const probe = spawnSync("bash", ["--version"], { timeout: 15_000 });
  if (probe.error !== undefined || probe.status !== 0) {
    process.stderr.write("  skip bash sourcing scenarios (no usable bash)\n");
  } else {
    const dir = await mkdtemp(join(tmpdir(), "clawforge-completion-"));
    try {
      const scriptPath = join(dir, "completion.sh");
      await writeFile(scriptPath, renderCompletion("bash", model, true), "utf8");
      // Words + cursor -> COMPREPLY, exactly as an interactive shell would call it.
      const scenario = (words: string[], cword: number): Promise<string[]> =>
        new Promise((resolveScenario) => {
          const wordsLit = `(${["clawforge", ...words].map((word) => JSON.stringify(word)).join(" ")})`;
          const proc = spawnSync(
            "bash",
            ["-c", `source "${scriptPath}"\nCOMP_WORDS=${wordsLit}\nCOMP_CWORD=${cword}\n_clawforge_complete\nprintf '%s\n' "\${COMPREPLY[@]}"`],
            { timeout: 30_000 },
          );
          resolveScenario(proc.stdout.toString().split("\n").filter((line) => line !== ""));
        });

      check("bash: typed prefix completes status", (await scenario(["sta"], 1)).includes("status"), true);
      check("bash: typed flag prefix completes --app", (await scenario(["--ap"], 1)).includes("--app"), true);
      check("bash: typed prefix completes the list action word", (await scenario(["backup", "l"], 2)).includes("list"), true);
      const trailing = await scenario(["backup"], 2);
      check("bash: trailing space offers create and its flags", [trailing.includes("create"), trailing.includes("--hot")], [true, true]);
      const afterApp = await scenario(["--app", "x", "backup"], 4);
      check("bash: after --app x backup offers actions and create's flags", [afterApp.includes("create"), afterApp.includes("--hot")], [true, true]);
      const afterFlag = await scenario(["backup", "--hot"], 3);
      check("bash: after backup --hot no action word is offered", [afterFlag.includes("--migrate"), afterFlag.includes("list")], [true, false]);
      check("bash: --client's value position offers its choices", (await scenario(["mcp-setup", "--client"], 3)).sort().join(" "), "both claude codex");
      check("bash: help completes command names", (await scenario(["help", "st"], 2)).includes("status"), true);
      check("bash: completion completes the shell names", (await scenario(["completion", "b"], 2)).includes("bash"), true);
      const hostValues = (await scenario(["host"], 2)).filter((word) => ["engine", "local", "target"].includes(word));
      check("bash: host's positional choices are offered", hostValues.sort().join(" "), "engine local target");
      check("bash: watch install's flags complete past the action", (await scenario(["watch", "install", "--int"], 3)).includes("--interval"), true);
      check("bash: the generated script parses (bash -n)", spawnSync("bash", ["-n", scriptPath], { timeout: 15_000 }).status, 0);
      const body = (text: string): string => text.slice(text.indexOf("_clawforge_complete()"), text.indexOf("complete -F"));
      check("bash: zsh shares the completer body verbatim", body(renderCompletion("zsh", model, true)), body(renderCompletion("bash", model, true)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

finish("completion behaviour");
