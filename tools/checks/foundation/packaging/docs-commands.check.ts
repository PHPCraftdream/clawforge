// docs/guide/commands.md must name exactly the commands and flags the declarations declare.
//
// Declared side: every name the one command registry (entry/registry.ts's surfaceRegistry)
// names — the deployment commands, both gates' and the two dispatcher commands. Documented
// side: the first two cells of each table row. Drift is reported as a readable diff, one line
// per finding.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { surfaceRegistry } from "#framework/entry/registry.ts";
import { check, finish } from "#checks/kit/harness.ts";

interface Surface {
  readonly flags: ReadonlySet<string>;
  readonly actions: ReadonlySet<string>;
}

/** Declared but deliberately not a row in the table, with why. */
const UNDOCUMENTED_COMMANDS: Readonly<Record<string, string>> = {
  help: "dispatcher-level; described in the page's opening section",
};

const FLAG = /--[a-z][a-z-]*/g;

function surface(flags: Iterable<string>, actions: Iterable<string> = []): Surface {
  return { flags: new Set([...flags].filter((flag) => flag !== "--help")), actions: new Set(actions) };
}

function declaredFromArguments(args: readonly { name: string; kind: string; choices?: readonly string[] }[]): Surface {
  const action = args.find((argument) => argument.kind === "positional" && argument.name === "action");
  return surface(args.filter((a) => a.kind === "flag" || a.kind === "option").map((a) => `--${a.name}`), action?.choices ?? []);
}

function split(row: string): string[] {
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function documented(markdown: string): Map<string, Surface> {
  const rows = new Map<string, Surface>();
  for (const line of markdown.split(/\r?\n/)) {
    const [, first, second] = split(line);
    const name = /^`([a-z][a-z-]*)[ `]/.exec(first ?? "")?.[1];
    if (!line.startsWith("| `") || name === undefined) continue;
    const cell = (second ?? "").replace(/`/g, "");
    const group = /^\[?<([a-z-]+(?:\\\|[a-z-]+)+)>/.exec(cell)?.[1];
    rows.set(name, surface(cell.match(FLAG) ?? [], group === undefined ? [] : group.split("\\|")));
  }
  return rows;
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((entry) => !right.has(entry)).sort();
}

const declared = new Map<string, Surface>();
for (const entry of surfaceRegistry().entries) declared.set(entry.name, declaredFromArguments(entry.arguments ?? []));
const docs = documented(await readFile(resolve(monorepoRoot, "docs", "guide", "commands.md"), "utf8"));

const problems: string[] = [];
for (const name of [...docs.keys()].sort()) {
  if (!declared.has(name)) problems.push(`${name}: documented, not declared`);
}
for (const [name, real] of [...declared.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const row = docs.get(name);
  if (row === undefined) {
    if (UNDOCUMENTED_COMMANDS[name] === undefined) problems.push(`${name}: declared, no row in the table`);
    continue;
  }
  for (const flag of difference(real.flags, row.flags)) problems.push(`${name}: ${flag} declared, not documented`);
  for (const flag of difference(row.flags, real.flags)) problems.push(`${name}: ${flag} documented, not declared`);
  if (real.actions.size === 0) continue; // positional choices of other names (host, completion) are not actions
  for (const action of difference(real.actions, row.actions)) problems.push(`${name}: action ${action} declared, not documented`);
  for (const action of difference(row.actions, real.actions)) problems.push(`${name}: action ${action} documented, not declared`);
}
check("declared commands and docs/guide/commands.md name the same commands, actions and flags", problems, []);
check("every allowlisted undocumented command is still declared", Object.keys(UNDOCUMENTED_COMMANDS).filter((name) => !declared.has(name)), []);

finish("docs-commands");
