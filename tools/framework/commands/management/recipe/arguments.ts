// recipe's own argument grammar.
//
// recipe's dispatcher (index.ts) parses action/name/new-name positionally and reads flags
// out of whatever follows with rest.includes()/indexOf() — order-dependent, and not
// rewritten onto parseDeclaredArgs here, which assumes a position-independent grammar this
// one does not have. What this module adds is the missing refusal for a flag or a bare
// positional an action does not use, so it is rejected rather than silently ignored.

import { die } from "#src/core/io/log.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";

/** Every flag/option recipe declares, across every action — spread into recipe's own entry
 *  in openclawCommands.management.ts, so a flag known there and one an action's own grammar
 *  below reads cannot silently drift apart. */
export const RECIPE_FLAG_ARGUMENTS: CommandArgument[] = [
  { name: "json", description: "With list: emit the catalog (recipes, agent/MCP bundles, broken manifests) as JSON", kind: "flag" },
  { name: "volumes", description: "With remove: delete its volumes too", kind: "flag" },
  { name: "tail", description: "With logs/diagnose: lines to return per service", kind: "option", valueName: "n" },
  { name: "force-disabled", description: "With install: build a recipe marked disabled", kind: "flag" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

const RECIPE_OPTION_FLAG_NAMES = new Set(
  RECIPE_FLAG_ARGUMENTS.filter((argument) => argument.kind === "option").map((argument) => argument.name),
);

/** How many bare positionals beyond the action word each action takes (list: none; import:
 *  a source plus an optional new-name; every other action: the recipe name only), and which
 *  of RECIPE_FLAG_ARGUMENTS' names it actually reads. validateRecipeArgs checks every token
 *  in argv against this. */
const RECIPE_ACTION_GRAMMAR: Record<string, { positionals: number; flags: readonly string[] }> = {
  list: { positionals: 0, flags: ["json"] },
  import: { positionals: 2, flags: [] },
  verify: { positionals: 1, flags: ["break-lock", "break-foreign-lock"] },
  onboard: { positionals: 1, flags: ["break-lock", "break-foreign-lock"] },
  diagnose: { positionals: 1, flags: ["tail", "break-lock", "break-foreign-lock"] },
  install: { positionals: 1, flags: ["force-disabled", "break-lock", "break-foreign-lock"] },
  remove: { positionals: 1, flags: ["volumes", "break-lock", "break-foreign-lock"] },
  status: { positionals: 1, flags: [] },
  logs: { positionals: 1, flags: ["tail"] },
};

/** Rejects a token the given action does not use: an undeclared flag (named against what
 *  the action does accept), "=value" on a flag that carries none, or a bare token beyond
 *  the positionals the action takes (list's own "no name at all" included) — over the same
 *  action, then name/new-name, then flags-anywhere-after shape index.ts's dispatch already
 *  assumes; `afterAction` is everything in argv past the action word itself. An
 *  unrecognized action is left alone — index.ts's own check names that, once this returns. */
export function validateRecipeArgs(action: string, afterAction: readonly string[]): void {
  const grammar = RECIPE_ACTION_GRAMMAR[action];
  if (grammar === undefined) return;
  let positionals = 0;
  for (let index = 0; index < afterAction.length; index += 1) {
    const token = afterAction[index];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const bare = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (!grammar.flags.includes(bare)) {
        const allowed = grammar.flags.length === 0 ? "no flags" : grammar.flags.map((name) => `--${name}`).join(", ");
        die(`--${bare} does not apply to recipe ${action} — expected ${allowed}`);
      }
      const isOption = RECIPE_OPTION_FLAG_NAMES.has(bare);
      if (!isOption && eq !== -1) die(`unknown argument: ${token}`);
      if (isOption && eq === -1) index += 1; // its value, read later by whatever consumes this flag
      continue;
    }
    positionals += 1;
    if (positionals > grammar.positionals) die(`unknown argument: ${token}`);
  }
}
