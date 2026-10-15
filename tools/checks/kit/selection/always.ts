// The fast tier: checks that are cheap, foundational, or assert over repo structure rather than
// any one changed file, so they run on every `check --related` invocation regardless of the diff.

/** One always-run entry: a label substring filter plus why it cannot be related-selected. */
export interface AlwaysEntry {
  /** Substring of check labels (paths relative to tools/checks), matched like --filters. */
  readonly filter: string;
  /** Why the check runs on every selection. */
  readonly reason: string;
}

const ALWAYS: readonly AlwaysEntry[] = [
  { filter: "foundation/layout.check.ts", reason: "the repo's own file layout is touched by practically every change" },
  { filter: "architecture/", reason: "architecture rules span the whole tree, so any change can violate one" },
  { filter: "foundation/hygiene/static/", reason: "static hygiene scans the entire source tree and is cheap to re-run" },
  { filter: "foundation/core/command/needs.check.ts", reason: "the command requirements contract is global, not per changed file" },
];

/** The always entries as data (consumed by the meta-check and the selection command). */
export function alwaysFilters(): readonly AlwaysEntry[] {
  return ALWAYS;
}

/** Check labels matched by at least one always filter, in input order. */
export function alwaysChecks(labels: readonly string[]): string[] {
  const filters = ALWAYS.map((entry) => entry.filter);
  return labels.filter((label) => filters.some((filter) => label.includes(filter)));
}
