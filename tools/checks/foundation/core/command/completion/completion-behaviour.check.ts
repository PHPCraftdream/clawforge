// Shell completion behaves, not just renders: every scenario below states "given the words
// and the cursor state, these candidates come out" — against completionCandidates (the one
// decision both emitted scripts implement), against the bash script actually sourced by a
// real bash, and against the pwsh script's own body EXECUTED by a PowerShell-subset
// evaluator (tools/checks .../pwsh-completer.ts). All three must agree on every scenario —
// substring checks over script text passed the R32-02 regression; these cannot (R33-10).

import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildCompletionModel, renderCompletion, completionCandidates, makeCompletionGateCommand } from "#framework/integration/completion.ts";
import type { GateCommand } from "#framework/integration/gate.ts";
import { runPwshCompleter } from "./pwsh-completer.ts";
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
  const kindValues = model.find((spec) => spec.name === "set")!.optionValues!["setforget--kind"]!;
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

// --- the pwsh script: EXECUTED by a PowerShell-subset evaluator, differentially ---------------

const scenarios: Array<{ name: string; rest: string[]; word: string }> = [
  { name: "a typed prefix at the top level", rest: ["sta"], word: "sta" },
  { name: "a typed flag prefix", rest: ["--ap"], word: "--ap" },
  { name: "--app's own value position", rest: ["--app"], word: "" },
  { name: "backup's trailing space", rest: ["backup"], word: "" },
  { name: "backup's action word typed in part", rest: ["backup", "l"], word: "l" },
  { name: "past a typed action word", rest: ["watch", "install", "--int"], word: "--int" },
  { name: "after a flag the command's flags continue", rest: ["backup", "--hot"], word: "" },
  { name: "--app before the command", rest: ["--app", "app-one", "backup"], word: "" },
  { name: "--app after a command (R33-10: flags, not deployments)", rest: ["status", "--app"], word: "" },
  { name: "mcp-setup's --client value", rest: ["mcp-setup", "--client"], word: "" },
  { name: "set forget's --kind value", rest: ["set", "forget", "--kind"], word: "" },
  { name: "set try has no --kind values (R33-10)", rest: ["set", "try", "--kind"], word: "" },
  { name: "set's action word typed in part", rest: ["set", "f"], word: "f" },
  { name: "host's positional", rest: ["host"], word: "" },
  { name: "past host's positional", rest: ["host", "target"], word: "" },
  { name: "help's command names", rest: ["help", "st"], word: "st" },
  { name: "completion's shell names", rest: ["completion", "b"], word: "b" },
  { name: "an unknown command", rest: ["zzz"], word: "" },
];

const norm = (values: readonly string[]): string[] => [...new Set(values)].sort();

// Shells filter the candidate list by the word being typed (compgen/-like); the model does
// not — the differential compares after that filter.
const decision = (rest: string[], word: string, appFlag: boolean): string[] =>
  norm(completionCandidates(model, rest, word, appFlag, ["app-one", "app-two"])).filter((value) => value.startsWith(word));

{
  for (const appFlag of [true, false]) {
    const script = renderCompletion("pwsh", model, appFlag);
    const walk = (rest: string[], word: string): string[] =>
      norm(runPwshCompleter(script, rest, word, ["app-one", "app-two"]));
    for (const scenario of scenarios) {
      check(`pwsh (appFlag ${appFlag}): ${scenario.name} matches the model's decision`, walk(scenario.rest, scenario.word), decision(scenario.rest, scenario.word, appFlag));
    }
    // The R33-10 facts the differential must hold, stated on their own too.
    check(`pwsh (appFlag ${appFlag}): --app after a command offers the command's flags, not deployments`,
      [walk(["status", "--app"], "").includes("--help"), walk(["status", "--app"], "").includes("app-one")], [true, false]);
    check(`pwsh (appFlag ${appFlag}): set try's --kind value position offers no kind values`,
      walk(["set", "try", "--kind"], "").includes("agent"), false);
    check(`pwsh (appFlag ${appFlag}): set forget's --kind value position offers the kind values`,
      walk(["set", "forget", "--kind"], "").join(" "), "agent cron-job mcp-server");
    check(`pwsh (appFlag ${appFlag}): --app's own value offers the deployments`,
      walk(["--app"], "").sort().join(" "), appFlag ? "app-one app-two" : "");
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
      // A stub `clawforge` on PATH answers --app's lazy `list --json` deterministically.
      const stub = join(dir, "clawforge");
      await writeFile(stub, "#!/bin/sh\necho '[{\"name\":\"app-one\"},{\"name\":\"app-two\"}]'\n", "utf8");
      await chmod(stub, 0o755);
      // Words + cursor -> COMPREPLY, exactly as an interactive shell would call it.
      const scenario = (words: string[], cword: number): Promise<string[]> =>
        new Promise((resolveScenario) => {
          const wordsLit = `(${["clawforge", ...words].map((word) => JSON.stringify(word)).join(" ")})`;
          const proc = spawnSync(
            "bash",
            ["-c", `source "${scriptPath}"\nCOMP_WORDS=${wordsLit}\nCOMP_CWORD=${cword}\n_clawforge_complete\nprintf '%s\n' "\${COMPREPLY[@]}"`],
            { timeout: 30_000, env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` } },
          );
          resolveScenario(proc.stdout.toString().split("\n").filter((line) => line !== ""));
        });
      // Differential: every scenario through the REAL bash completer must equal the model.
      const bashScenario = (scenarioSpec: { rest: string[]; word: string }): Promise<string[]> => {
        const words = scenarioSpec.word === "" ? [...scenarioSpec.rest, ""] : scenarioSpec.rest;
        return scenario(words, words.length);
      };
      for (const scenarioSpec of scenarios) {
        const expected = decision(scenarioSpec.rest, scenarioSpec.word, true);
        check(`bash: ${scenarioSpec.name} matches the model's decision`, norm(await bashScenario(scenarioSpec)), expected);
      }
      check("bash: --app after a command offers flags, not deployments",
        [(await bashScenario(scenarios[8]!)).includes("--help"), (await bashScenario(scenarios[8]!)).includes("app-one")], [true, false]);

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
