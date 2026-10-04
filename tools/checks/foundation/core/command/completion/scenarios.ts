// Completion scenarios GENERATED from the completion decision table (CompletionData), never
// hand-listed: a command the registry declares is covered here because it is a row there, so
// the differential — the table's reference interpreter against the bash and pwsh scripts the
// table renders into — cannot silently stop covering a command. Every scenario's last word is
// the word being completed, and `cword` is that word's index into `words` — always
// `words.length - 1`, since the last word is the one being completed. A shell driver that
// prepends the program name passes `cword + 1` as its own COMP_CWORD / cursorColumn, which is
// what its scan of the tokens before the cursor starts from.

import type { CompletionData } from "#framework/integration/completion/table.ts";

export interface CompletionScenario {
  /** Stable label used in the check names. */
  readonly name: string;
  /** Every token after the program name, INCLUDING the word being completed at index cword. */
  readonly words: readonly string[];
  /** Index into `words` of the word being completed — always `words.length - 1`, since the last
   *  word is it. A shell driver that prepends the program name passes `cword + 1` as its own
   *  COMP_CWORD / cursorColumn. */
  readonly cword: number;
}

/** An action word no command declares, so its `*` fallback row is the one that answers. */
const UNKNOWN_ACTION = "zz";
/** A name no registry has, so no command's candidates can be mistaken for it. */
const UNKNOWN_COMMAND = "zzz-nope-command";

export function completionScenarios(data: CompletionData): readonly CompletionScenario[] {
  const scenarios: CompletionScenario[] = [];
  const commands = [...data.first.keys()];
  const first = commands[0] ?? "";

  scenarios.push({ name: "top level", words: [""], cword: 0 });
  const name = data.top.find((candidate) => candidate.length >= 4);
  if (name !== undefined) scenarios.push({ name: "typed prefix", words: [name.slice(0, 4)], cword: 0 });

  for (const command of commands) scenarios.push({ name: `${command}'s trailing space`, words: [command, ""], cword: 1 });

  for (const key of data.after.keys()) {
    const space = key.indexOf(" ");
    if (space < 0) continue;
    const [command, word] = [key.slice(0, space), key.slice(space + 1)];
    if (word === "*") continue;
    scenarios.push({ name: `${command} ${word}'s flags`, words: [command, word, ""], cword: 2 });
  }
  // One representative per command for the `*` fallback — an action word no command declares,
  // and skipped where this command would happen to declare one by that name.
  for (const command of commands) {
    if (!data.after.has(`${command} *`) || data.after.has(`${command} ${UNKNOWN_ACTION}`)) continue;
    scenarios.push({ name: `${command}'s unknown action word`, words: [command, UNKNOWN_ACTION, ""], cword: 2 });
  }

  for (const row of data.values) {
    const scope = row.scope === "" ? [] : [row.scope];
    const label = scope.length === 0 ? "" : `${scope[0]} `;
    const words = [row.command, ...scope, row.option, ""];
    scenarios.push({ name: `${row.command} ${label}${row.option}'s value`, words, cword: words.length - 1 });
  }

  if (first !== "") scenarios.push({ name: "--app before the command", words: ["--app", "x", first, ""], cword: 3 });
  scenarios.push({ name: "--app's own value", words: ["--app", ""], cword: 1 });
  // --app is positional: past a command it completes that command's flags instead (R33-10).
  const afterApp = data.first.has("status") ? "status" : first;
  if (afterApp !== "") scenarios.push({ name: "--app after a command", words: [afterApp, "--app", ""], cword: 2 });

  scenarios.push({ name: "an unknown command", words: [UNKNOWN_COMMAND, ""], cword: 1 });

  // A word being completed that is not empty: the shells filter the candidates by it, the
  // reference interpreter must not read it as a typed command (R32-02), so the flags behind
  // the prefix still come out.
  const flagged = commands.map((command) => ({ command, flags: data.after.get(`${command} *`) ?? [] }));
  const found =
    flagged.find((entry) => entry.flags.some((flag) => flag.startsWith("--d"))) ?? flagged.find((entry) => entry.flags.length > 0);
  if (found !== undefined) {
    const flag = found.flags.find((candidate) => candidate.startsWith("--d")) ?? found.flags[0]!;
    const prefix = flag.slice(0, 3);
    scenarios.push({ name: `${prefix} prefix`, words: [found.command, prefix], cword: 1 });
  }

  return scenarios;
}
