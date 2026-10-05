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

  // A pass-through command's free tail (R4-1): past the declared positionals the words are the
  // child's literal text and nothing more is offered; at the last free slot the flags return.
  for (const [command, positionals] of data.verbatim) {
    const words = [command, ...Array.from({ length: positionals + 2 }, (_, index) => `zz${index}`), ""];
    scenarios.push({ name: `${command}'s verbatim tail offers nothing`, words, cword: words.length - 1 });
    if (positionals > 0) {
      const boundary = [command, ...Array.from({ length: positionals }, (_, index) => `zz${index}`), ""];
      scenarios.push({ name: `${command}'s last free slot still offers flags`, words: boundary, cword: boundary.length - 1 });
    }
    // The bare `--` is the parser's own options-end marker (tokenize's optionsEnded): past it
    // every word is the child's literal tail, even before the positionals run out.
    const bareEnd = [command, "--", ""];
    scenarios.push({ name: `${command}'s bare -- starts the literal tail`, words: bareEnd, cword: bareEnd.length - 1 });
    if (positionals > 0) {
      const pastEnd = [command, ...Array.from({ length: positionals }, (_, index) => `zz${index}`), "--", ""];
      scenarios.push({ name: `${command}'s flags stop after -- past its positionals`, words: pastEnd, cword: pastEnd.length - 1 });
    }
  }

  // The bare `--` is the parser's own options-end marker for ANY command (round 10, class B):
  // everything from it on is refused, so nothing may be offered — and without it the command's
  // own flags still come out (the guard pins the pre-`--` behaviour).
  for (const command of data.first.keys()) {
    if (data.verbatim.has(command)) continue; // the verbatim loop above already covers it
    const bareEnd = [command, "--", ""];
    scenarios.push({ name: `${command}'s bare -- starts the literal tail`, words: bareEnd, cword: bareEnd.length - 1 });
    scenarios.push({ name: `${command}'s flags without --`, words: [command, "--j"], cword: 1 });
  }

  // A `--` a pending value-option swallows is NOT the options-end marker: the parser reads it
  // as the option's value, so the command's own flags still come out behind it — and once that
  // value is filled, a later `--` ends the options for good.
  for (const [command, options] of data.valueOptions) {
    if (data.verbatim.has(command)) continue; // the verbatim loop above covers pass-through
    const option = options[0]!;
    const swallowed = [command, option, "--", ""];
    scenarios.push({ name: `${command} ${option} swallows the bare --`, words: swallowed, cword: swallowed.length - 1 });
    const endedLater = [command, option, "x", "--", ""];
    scenarios.push({ name: `${command} ${option} x -- ends the options`, words: endedLater, cword: endedLater.length - 1 });
  }

  if (first !== "") scenarios.push({ name: "--app before the command", words: ["--app", "x", first, ""], cword: 3 });
  // The `=` form the parser's splitLeadingAppFlag also accepts: one token with its own value.
  if (first !== "") scenarios.push({ name: "--app= before the command", words: [`--app=x`, first, ""], cword: 2 });
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

  // The parser, the model and bash compare case-sensitively: `Backup`, `STATUS` and
  // `--TAIL` are not declared words, so they must not be read as such by any implementation
  // (PowerShell's own operators fold case).
  for (const command of commands) scenarios.push({ name: `upper-case command ${command.toUpperCase()}`, words: [command.toUpperCase(), ""], cword: 1 });
  for (const key of data.after.keys()) {
    const [command, word = "*"] = key.split(" ");
    if (word === "*") continue;
    scenarios.push({ name: `${command} upper-case action ${word.toUpperCase()}`, words: [command, word.toUpperCase(), ""], cword: 2 });
  }
  for (const [command, options] of data.valueOptions) {
    const upper = options[0]!.toUpperCase();
    scenarios.push({ name: `${command} upper-case option ${upper}`, words: [command, upper, ""], cword: 2 });
  }
  // An empty word MID-line is a typed (empty) word, not an option name: nothing it is compared
  // with may match it (bash's `" $opts " == *" $token "*` matched it when no option existed).
  for (const command of commands) scenarios.push({ name: `${command}'s empty mid word`, words: [command, "", ""], cword: 2 });

  scenarios.push(...sweepScenarios(data));
  return scenarios;
}

/** The 2- and 3-word sequences over one command's own vocabulary — taken from its declaration,
 *  never hand-written: its first flag, its first option, a bare `--`, a plain word (its first
 *  action word for a multi-action command, else `zz`), each followed by the word being completed.
 *  Every command gets all 2-word sequences; the 3-word ones (where a `--` behind an option, a
 *  refusal or a verbatim tail interact) are taken once per vocabulary shape — flag/option/
 *  action/verbatim/variadic/choices present or not — because the interpreters branch on shape,
 *  not on a command's name. Exhaustive within that bound, so a rule the three implementations
 *  disagree on shows up as a failing sequence rather than as a case someone thought of. */
function sweepScenarios(data: CompletionData): CompletionScenario[] {
  const scenarios: CompletionScenario[] = [];
  const shapes = new Set<string>();
  for (const [command, declared] of data.declared) {
    if (!data.first.has(command)) continue;
    const flag = declared.find((argument) => argument.kind === "flag");
    const option = declared.find((argument) => argument.kind === "option");
    const action = [...data.after.keys()].map((key) => key.split(" ")).find(([owner, word]) => owner === command && word !== "*")?.[1];
    const alphabet = [
      ...(flag === undefined ? [] : [`--${flag.name}`]),
      ...(option === undefined ? [] : [`--${option.name}`]),
      "--",
      action ?? "zz",
    ];
    const shape = [
      flag !== undefined, option !== undefined, action !== undefined, data.verbatim.has(command),
      declared.some((argument) => argument.kind === "variadic"),
      option !== undefined && data.values.some((row) => row.command === command && row.option === `--${option.name}`),
    ].join();
    const depth = shapes.has(shape) ? 2 : 3;
    shapes.add(shape);
    let sequences: string[][] = [[]];
    for (let length = 1; length <= depth; length += 1) {
      sequences = sequences.flatMap((head) => alphabet.map((word) => [...head, word]));
      if (length === 1) continue;
      for (const sequence of sequences) {
        const words = [command, ...sequence, ""];
        scenarios.push({ name: `sweep: ${words.slice(0, -1).join(" ")} <Tab>`, words, cword: words.length - 1 });
      }
    }
  }
  return scenarios;
}
