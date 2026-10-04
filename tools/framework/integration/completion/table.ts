// The completion decision table, and the reference interpreter for it: each generated script
// (bash, zsh sharing its body verbatim, and pwsh) is this data plus the algorithm below — one
// decision implemented more than once, with no branch on a command name in either one. The
// table is built from the one command registry help, the MCP tool list and the docs table
// read, so a command completes because it is declared, not because a case arm named it.

import { NO_ACTION } from "../../core/command/index.ts";
import type { CommandArgument } from "../../core/app.ts";
import type { CommandRegistry } from "../gate.ts";

/** One option's `choices`, offered at the position where its own value is typed. The scripts
 *  look this up by `command + scope + option` — the three fields, in that order. */
export interface OptionValues {
  readonly command: string;
  /** The action word the value sits under: "" for a single-action command, and either the
   *  option's own `actions` or every action for a multi-action one. */
  readonly scope: string;
  readonly option: string;
  readonly values: readonly string[];
}

/** The whole completion surface as data: what to offer before a command name, at the word
 *  right after it, past its action word, and at a choice-valued option's own value. */
export interface CompletionData {
  readonly appFlag: boolean;
  /** The registry's names alphabetically, and `--app` appended at the end when the gate has
   *  one — not sorted in, so the emitted text stays `… watch --app` as it has always been. */
  readonly top: readonly string[];
  /** Command → the candidates offered at the word immediately after it. */
  readonly first: ReadonlyMap<string, readonly string[]>;
  /** `"<command> <action>"` and `"<command> *"` → candidates; `*` is the fallback for an
   *  action word that is absent or unknown, where the shell cannot tell which was meant. */
  readonly after: ReadonlyMap<string, readonly string[]>;
  readonly values: readonly OptionValues[];
}

function flagName(argument: CommandArgument): string {
  return `--${argument.name}`;
}

/** Every entry of the registry as completion rows. `name`/`arguments` come from the same
 *  declaration --help, the MCP schema and the parser read, so nothing here is restated. */
export function completionData(registry: CommandRegistry, appFlag: boolean): CompletionData {
  const top = [...registry.names].sort();
  // --app is the gate's own selector, not a registry name; appended after them (the bash
  // script has always listed it last), and only where the gate actually has one.
  if (appFlag) top.push("--app");
  const first = new Map<string, readonly string[]>();
  const after = new Map<string, readonly string[]>();
  const values: OptionValues[] = [];

  for (const entry of registry.entries) {
    const name = entry.name;
    const args = entry.arguments ?? [];
    const actionArgument = args.find(
      (argument): argument is CommandArgument & { choices: readonly string[] } =>
        argument.kind === "positional" && argument.name === "action" && argument.choices !== undefined,
    );
    const flagArgs = args.filter((argument) => argument.kind === "flag" || argument.kind === "option");
    // A shared flag — core/app.ts documents an absent `actions` as belonging to the whole
    // command — plus --help, which every command answers.
    const globalFlags = [...new Set([...flagArgs.filter((argument) => argument.actions === undefined).map(flagName), "--help"])].sort();
    // Choice values are keyed command + action + option once the command declares an action
    // positional: the action word already typed scopes the lookup, so `set try` (no --kind)
    // never sees forget's values while `set forget --kind` does (R33-10).
    for (const argument of flagArgs) {
      if (!(argument.kind === "option" && argument.choices !== undefined)) continue;
      const option = flagName(argument);
      if (actionArgument === undefined) {
        values.push({ command: name, scope: "", option, values: argument.choices });
        continue;
      }
      if (argument.actions === undefined) values.push({ command: name, scope: "", option, values: argument.choices });
      for (const action of argument.actions ?? actionArgument.choices) {
        values.push({ command: name, scope: action, option, values: argument.choices });
      }
    }
    if (actionArgument === undefined) {
      const positional = args.find(
        (argument): argument is CommandArgument & { choices: readonly string[] } =>
          argument.kind === "positional" && argument.choices !== undefined,
      );
      // A non-action positional's choices (completion's shell, host's context, help's command)
      // belong at the word right after the command, before any flag is typed.
      first.set(name, positional === undefined ? globalFlags : [...new Set([...positional.choices, ...globalFlags])].sort());
      after.set(`${name} *`, globalFlags);
      continue;
    }
    const actionWords = [...actionArgument.choices].map(String).sort();
    const perAction = new Map<string, readonly string[]>();
    for (const value of actionArgument.choices) {
      const scoped = flagArgs.filter((argument) => argument.actions?.includes(value) === true).map(flagName);
      perAction.set(value, [...new Set([...globalFlags, ...scoped])].sort());
    }
    // An OPTIONAL action positional means the command has an implicit default action —
    // backup's bare create (NO_ACTION). Its flags are the fallback for the no-action and
    // unknown-action cases, where the shell cannot know which action is meant.
    const fallback = actionArgument.required === true
      ? globalFlags
      : [...new Set([...globalFlags, ...(perAction.get(NO_ACTION) ?? globalFlags)])].sort();
    first.set(name, [...new Set([...actionWords, ...fallback])].sort());
    for (const [value, flags] of perAction) after.set(`${name} ${value}`, flags);
    after.set(`${name} *`, fallback);
  }

  return { appFlag, top, first, after, values };
}

/** The candidates for one completion request — the one decision both emitted scripts
 *  implement, so a script and the table it was rendered from cannot quietly diverge. `words`
 *  is every token after the program name and `cword` the index of the word being completed.
 *  The partial word itself is deliberately not consulted: the shells filter the list
 *  (compgen -W … -- "$cur"), the reference answers with the table as it stands.
 *  `appNames` stands in for the lazy `list --json` call the scripts make for --app's value. */
export function completionCandidates(
  data: CompletionData,
  words: readonly string[],
  cword: number,
  appNames: () => readonly string[],
): readonly string[] {
  // Only the words BEFORE the cursor pick the command — the partial word itself is not a
  // typed command (R32-02: `clawforge sta<Tab>` used to see the command "sta").
  const scan = words.slice(0, cword);
  const prev = scan.at(-1);
  // --app leads the command line and takes the next word as its own value: step over both.
  let i = 0;
  while (data.appFlag && scan[i] === "--app") i += 2;
  if (i >= scan.length) {
    // --app's own value, offered only while no command word has been typed yet: past one it
    // is positional and must come before the command, so the command's flags return (R33-10).
    if (prev === "--app") return appNames();
    return data.top;
  }
  const cmd = scan[i];
  const candidates = data.first.get(cmd);
  if (candidates === undefined) return [];
  const between = scan.slice(i + 1);
  // The word after the command scopes option-value lookups; when the option itself is the
  // last scanned word it sits in `between` too and is not a scope.
  const scope = between.length > 0 && between[0] !== prev ? between[0] : "";
  if (prev !== undefined && prev.startsWith("--")) {
    const row = data.values.find((option) => option.command === cmd && option.scope === scope && option.option === prev);
    if (row !== undefined) return row.values;
  }
  // Nothing after the command means the word being completed IS its own first positional —
  // an action word, typed in full or in part.
  if (between.length === 0) return candidates;
  return data.after.get(`${cmd} ${between[0]}`) ?? data.after.get(`${cmd} *`) ?? [];
}
