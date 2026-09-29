// recipe's own argument grammar.
//
// recipe's dispatcher (index.ts) parses action/name/new-name positionally and reads flags
// with rest.includes()/indexOf(), order-dependent and not rewritten onto
// parseDeclaredArgs's position-independent grammar. This module adds the missing refusal
// for a flag or bare positional an action doesn't use, instead of silently ignoring it.

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
  { name: "with-hooks", description: "With new: add commented prepare.ts/verify.ts stubs", kind: "flag" },
  { name: "dry-run", description: "With install/remove: show what would happen", kind: "flag", actions: ["install", "remove"] },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

const RECIPE_OPTION_FLAG_NAMES = new Set(
  RECIPE_FLAG_ARGUMENTS.filter((argument) => argument.kind === "option").map((argument) => argument.name),
);

/** How many bare positionals beyond the action word each action takes, and which of
 *  RECIPE_FLAG_ARGUMENTS' names it reads. validateRecipeArgs checks every argv token against this. */
const RECIPE_ACTION_GRAMMAR: Record<string, { positionals: number; flags: readonly string[] }> = {
  list: { positionals: 0, flags: ["json"] },
  import: { positionals: 2, flags: [] },
  new: { positionals: 1, flags: ["with-hooks"] },
  verify: { positionals: 1, flags: ["break-lock", "break-foreign-lock"] },
  onboard: { positionals: 1, flags: ["break-lock", "break-foreign-lock"] },
  diagnose: { positionals: 1, flags: ["tail", "break-lock", "break-foreign-lock"] },
  install: { positionals: 1, flags: ["force-disabled", "dry-run", "break-lock", "break-foreign-lock"] },
  remove: { positionals: 1, flags: ["volumes", "dry-run", "break-lock", "break-foreign-lock"] },
  status: { positionals: 1, flags: [] },
  logs: { positionals: 1, flags: ["tail"] },
};

/** Rejects a token the given action does not use: an undeclared flag, "=value" on a flag
 *  that carries none, or a bare token beyond the positionals the action takes. An
 *  unrecognized action is left alone — index.ts's own check names that. */
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
