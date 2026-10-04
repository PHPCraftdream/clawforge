// Architecture ratchets — refactor plan stage 0, item 2 (docs/internal/refactor-plan-2026-10-01.md).
//
// Each metric counts a "one fact recorded in many places" pattern in the working tree (never
// git) and must EQUAL tools/checks/architecture/baseline.json. Higher means a new occurrence
// slipped in. Lower means real progress — but it must be recorded: lower the baseline in the
// same commit as the change that reduced it, so a decrease is never silently lost.
//
// Per-file counts are stored for the location-based metrics (dotClawforgeLiterals,
// imageStringOps, prosePins) so a failure names the files that grew.

import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { lifecycleCommands } from "#framework/commands/interface/groups/openclawCommands.lifecycle.ts";
import { managementCommands } from "#framework/commands/interface/groups/openclawCommands.management.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import { operateCommands } from "#framework/commands/interface/groups/openclawCommands.operate.ts";
import { setsCommands } from "#framework/commands/interface/groups/openclawCommands.sets.ts";
import { checkoutGateCommands } from "#framework/entry/checkout-gate.ts";
import { surfaceRegistry } from "#framework/entry/registry.ts";
import { versionGateCommand } from "#framework/integration/version.ts";
import { parseProse } from "#framework/core/io/invocation/prose.ts";
import { specOf } from "#framework/core/command/index.ts";
import { checkTrue, finish } from "#checks/kit/harness.ts";

interface PerFileMetric {
  readonly comment: string;
  readonly total: number;
  readonly files: Record<string, number>;
}
/** Lines the literal metric does not count, kept exact so the table cannot rot in either
 *  direction: an entry whose line no longer exists, and an occurrence left over once the
 *  recorded multiplicity ran out, are both failures. */
interface ExemptLines {
  readonly reason: string;
  readonly lines: Record<string, number>;
}
interface Baseline {
  readonly about: string;
  readonly dotClawforgeLiterals: PerFileMetric & { readonly exempt: Record<string, ExemptLines> };
  readonly localizeOptOuts: {
    readonly comment: string;
    readonly infoRaw: number;
    readonly reportErrorVerbatim: number;
    readonly localizeHints: number;
  };
  readonly rawArgvPredicates: {
    readonly comment: string;
    readonly readOnlyWhen: number;
    readonly changedWhen: number;
    readonly requiresConfirmationWhen: number;
  };
  readonly legacyCommands: { readonly comment: string; readonly total: number };
  readonly unsummarizedDescriptions: { readonly comment: string; readonly total: number };
  readonly declaredArguments: { readonly comment: string; readonly total: number };
  readonly imageStringOps: PerFileMetric;
  readonly prosePins: PerFileMetric;
  readonly proseFlags: PerFileMetric;
  readonly retiredSymbols: { readonly comment: string; readonly names: readonly string[]; readonly total: number };
}

const root = monorepoRoot;
const baselinePath = resolve(root, "tools", "checks", "architecture", "baseline.json");
const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Baseline;

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      found.push(...(await walk(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

const rel = (full: string): string => relative(root, full).split("\\").join("/");

const frameworkFiles = await walk(resolve(root, "tools", "framework"));
const checkFiles = (await walk(resolve(root, "tools", "checks")))
  .map(rel)
  .filter((file) => !file.startsWith("tools/checks/architecture/") && !file.startsWith("tools/checks/golden/"));

interface Ratchet {
  readonly name: string;
  readonly expected: number;
  readonly actual: number;
  /** What changed the count: files that grew, or the decrease to record. */
  readonly details: readonly string[];
}

function ratchet(name: string, expected: number, actual: number, grew: readonly string[], shrank: readonly string[]): Ratchet {
  const details: string[] = grew.map((file) => `a new occurrence was added: ${file}`);
  if (actual < expected) {
    details.push(`lower the baseline to ${actual} in the same commit`);
    details.push(...shrank.map((file) => `  decreased: ${file}`));
  }
  return { name, expected, actual, details };
}

function perFileRatchet(name: string, before: Record<string, number>, after: Map<string, number>): Ratchet {
  const grew: string[] = [];
  const shrank: string[] = [];
  const files = new Set([...Object.keys(before), ...after.keys()]);
  let expectedTotal = 0;
  let actualTotal = 0;
  for (const file of files) {
    const was = before[file] ?? 0;
    const now = after.get(file) ?? 0;
    expectedTotal += was;
    actualTotal += now;
    if (now > was) grew.push(`${file} (${was} → ${now})`);
    if (now < was) shrank.push(`${file} (${was} → ${now})`);
  }
  return ratchet(name, expectedTotal, actualTotal, grew, shrank);
}

function report(result: Ratchet): void {
  checkTrue(
    `${result.name} equals the baseline (${result.actual} measured, ${result.expected} recorded)`,
    result.actual === result.expected,
  );
  for (const line of result.details) process.stderr.write(`    ${line}\n`);
}

// 1. `./clawforge` literals in tools/framework and in the checkout entry — stage 4
// (Advice): the command name must reach output only through one renderer, so this goes to 0
// outside it. An occurrence on an `exempt` line (the shim naming itself, the completion
// registration) is left out of the per-file counts but still counted in the total, and the
// table fails in both directions: a line it names that no longer exists, and an occurrence
// left once the recorded multiplicity ran out.
const LITERAL = "./clawforge";
const exemptLeft = new Map<string, Map<string, number>>(
  Object.entries(baseline.dotClawforgeLiterals.exempt).map(([file, entry]) => [file, new Map(Object.entries(entry.lines))]),
);
const literalAfter = new Map<string, number>();
let literalTotal = 0;
for (const full of [...frameworkFiles, resolve(root, "tools", "clawforge.ts")]) {
  const content = await readFile(full, "utf8");
  const left = exemptLeft.get(rel(full));
  let counted = 0;
  for (const line of content.split("\n")) {
    const occurrences = line.split(LITERAL).length - 1;
    if (occurrences === 0) continue;
    literalTotal += occurrences;
    const remaining = left?.get(line.trim()) ?? 0;
    const exempt = Math.min(remaining, occurrences);
    if (exempt > 0 && left !== undefined) left.set(line.trim(), remaining - exempt);
    counted += occurrences - exempt;
  }
  if (counted > 0) literalAfter.set(rel(full), counted);
}
for (const [file, lines] of exemptLeft) {
  for (const [line, unmatched] of lines) {
    if (unmatched === 0) continue;
    checkTrue(`dotClawforgeLiterals.exempt names a line ${file} no longer has (${unmatched} left): ${line}`, false);
  }
}
report(perFileRatchet("dotClawforgeLiterals", baseline.dotClawforgeLiterals.files, literalAfter));
report(ratchet("dotClawforgeLiterals.total", baseline.dotClawforgeLiterals.total, literalTotal, [], []));

// 2. Raw-output opt-outs — stage 4: `infoRaw`/`reportErrorVerbatim`/`localizeHints` call
// sites. Imports carry no parentheses; each function's own definition is the one site to
// subtract, so the count is occurrences minus definitions.
const OPT_OUTS = ["infoRaw", "reportErrorVerbatim", "localizeHints"] as const;
for (const name of OPT_OUTS) {
  let count = 0;
  for (const full of frameworkFiles) {
    const content = await readFile(full, "utf8");
    for (const line of content.split("\n")) {
      if (!line.includes(`${name}(`)) continue;
      if (line.startsWith(`export function ${name}(`)) continue;
      count += 1;
    }
  }
  const expected = baseline.localizeOptOuts[name];
  const result = ratchet(`localizeOptOuts.${name}`, expected, count, [], []);
  report(result);
}

// 3. Flag spellings in help prose — stage 4 (design 2.3): a `--name` the declaration itself
// declares, spelled in its own `details` outside a token and outside a code span quoting
// another tool. Each one is prose that belongs in a `{--name}` token, so the ratchet counts
// down to 0 as the groups are migrated.
interface ProseSource {
  readonly details?: string;
  readonly arguments?: readonly { readonly name: string }[];
}
/** The files that own a proseFlags count: the five command groups plus the two gate
 *  declarations whose details are read from a module rather than a group file. */
const PROSE_SOURCES: Record<string, readonly ProseSource[]> = {
  "tools/framework/commands/interface/groups/openclawCommands.lifecycle.ts": Object.values(lifecycleCommands),
  "tools/framework/commands/interface/groups/openclawCommands.management.ts": Object.values(managementCommands),
  "tools/framework/commands/interface/groups/openclawCommands.orchestration.ts": Object.values(orchestrationCommands),
  "tools/framework/commands/interface/groups/openclawCommands.operate.ts": Object.values(operateCommands),
  "tools/framework/commands/interface/groups/openclawCommands.sets.ts": Object.values(setsCommands),
  "tools/framework/entry/checkout-gate.ts": checkoutGateCommands,
  "tools/framework/integration/version.ts": [versionGateCommand],
};
/** Every name the dispatcher can resolve: a code span quoting one of them is our own prose,
 *  anything else (`openclaw channels status --json`, `tailscale status --json`) belongs to
 *  another tool and its flags are not ours to count. Read from the one registry
 *  (entry/registry.ts), the list every surface reconciles against. */
const commandNames = new Set(surfaceRegistry().names);
const TOKEN_SPAN = /\{[^{}]*\}/g;
const CODE_SPAN = /`[^`]*`/g;
const FLAG_MENTION = /(?<![\w-])--([A-Za-z][A-Za-z0-9-]*)/g;
/** A leading program word is not the command: `./clawforge apply-config --dry-run` reads as
 *  apply-config's own --dry-run, not as another tool's line. */
const PROGRAM_WORD = /^\.?\/?clawforge$/;

function proseFlagCount(details: string, declared: ReadonlySet<string>): number {
  // Tokens first: a recognized span becomes one space, so the words around it stay apart.
  const text = details.replace(TOKEN_SPAN, (span) => (parseProse(span).length === 1 ? " " : span));
  const foreign = new Set<number>();
  for (const span of text.matchAll(CODE_SPAN)) {
    const words = span[0].slice(1, -1).trim().split(/\s+/);
    const first = words.find((word) => !PROGRAM_WORD.test(word)) ?? "";
    if (commandNames.has(first) || first.startsWith("--") || first.startsWith("{")) continue;
    const start = span.index ?? 0;
    for (let at = start; at < start + span[0].length; at += 1) foreign.add(at);
  }
  let count = 0;
  for (const mention of text.matchAll(FLAG_MENTION)) {
    const name = mention[1];
    if (name === undefined || !declared.has(name)) continue;
    if (foreign.has(mention.index ?? 0)) continue;
    count += 1;
  }
  return count;
}

const proseFlagsAfter = new Map<string, number>();
for (const [file, sources] of Object.entries(PROSE_SOURCES)) {
  let count = 0;
  for (const source of sources) {
    if (source.details === undefined) continue;
    count += proseFlagCount(source.details, new Set((source.arguments ?? []).map((argument) => argument.name)));
  }
  if (count > 0) proseFlagsAfter.set(file, count);
}
report(perFileRatchet("proseFlags", baseline.proseFlags.files, proseFlagsAfter));

// 3. Raw-argv predicates — stage 3 (CommandSpec effect): MCP confirmation must come from the
// declared effect, not from 28 predicates re-parsing argv beside the real parser.
let readOnlyWhen = 0;
let changedWhen = 0;
let requiresConfirmationWhen = 0;
let legacyCount = 0;
let unsummarized = 0;
let argumentCount = 0;
for (const command of Object.values(openclawCommands)) {
  if (command.readOnlyWhen !== undefined) readOnlyWhen += 1;
  if (command.changedWhen !== undefined) changedWhen += 1;
  if (command.requiresConfirmationWhen !== undefined) requiresConfirmationWhen += 1;
  // 4. Stage-3 (CommandSpec) counts, measured through the materialized declarations:
  // legacyCommands — entries not yet carrying a spec body.
  if (specOf(command) === undefined) legacyCount += 1;
  argumentCount += (command.arguments ?? []).length;
}

// unsummarizedDescriptions — stage 5 (rf5-mcp) widened the scope from openclawCommands to
// surfaceRegistry(): the schema is built for the gate commands and the help command too, so
// an argument over 60 characters without a `summary` would need a heuristic back anywhere on
// the surface, not only among the deployment's own commands.
for (const entry of surfaceRegistry().entries) {
  for (const argument of entry.arguments ?? []) {
    if (argument.description.length > 60 && argument.summary === undefined) unsummarized += 1;
  }
}
report(ratchet("rawArgvPredicates.readOnlyWhen", baseline.rawArgvPredicates.readOnlyWhen, readOnlyWhen, [], []));
report(ratchet("rawArgvPredicates.changedWhen", baseline.rawArgvPredicates.changedWhen, changedWhen, [], []));
report(ratchet("rawArgvPredicates.requiresConfirmationWhen", baseline.rawArgvPredicates.requiresConfirmationWhen, requiresConfirmationWhen, [], []));
report(ratchet("legacyCommands", baseline.legacyCommands.total, legacyCount, [], []));
report(ratchet("unsummarizedDescriptions", baseline.unsummarizedDescriptions.total, unsummarized, [], []));
report(ratchet("declaredArguments", baseline.declaredArguments.total, argumentCount, [], []));

// 5. String operations on image references outside runtime/docker/image-ref.ts — stage 1
// (ImageRef): one module owns the grammar, call sites get values.
const IMAGE_OPS = /@sha256|split\("@"\)|indexOf\("@"\)|lastIndexOf\(":"\)/;
const imageAfter = new Map<string, number>();
for (const full of frameworkFiles) {
  if (rel(full) === "tools/framework/runtime/docker/image-ref.ts") continue;
  const content = await readFile(full, "utf8");
  let count = 0;
  for (const line of content.split("\n")) if (IMAGE_OPS.test(line)) count += 1;
  if (count > 0) imageAfter.set(rel(full), count);
}
report(perFileRatchet("imageStringOps", baseline.imageStringOps.files, imageAfter));

// 6. Prose pins in checks — stage 5 and the cross-cutting I9: checks assert structure
// (codes, argv, JSON fields); prose belongs in goldens and renderer checks. The generated
// golden surfaces and this ratchet's own directory are excluded.
const PROSE_PIN = /includes\((`|")[^`"]* [^`"]*(`|")\)/;
const proseAfter = new Map<string, number>();
for (const file of checkFiles) {
  const content = await readFile(resolve(root, file), "utf8");
  let count = 0;
  for (const line of content.split("\n")) if (PROSE_PIN.test(line)) count += 1;
  if (count > 0) proseAfter.set(file, count);
}
report(perFileRatchet("prosePins", baseline.prosePins.files, proseAfter));

// 7. Retired symbols — stage 5 (rf5-completion C1): names the command registry made
// structural that must not reappear anywhere under tools/ outside this check's own directory
// (excluded so the guard can name them here). A new occurrence fails the build.
const RETIRED_EXCLUDED = "tools/checks/architecture/";
const toolsFiles = (await walk(resolve(root, "tools"))).filter((full) => !rel(full).startsWith(RETIRED_EXCLUDED));
let retiredCount = 0;
for (const full of toolsFiles) {
  const content = await readFile(full, "utf8");
  for (const name of baseline.retiredSymbols.names) {
    const matches = content.match(new RegExp(`\\b${name}\\b`, "g"));
    if (matches !== null) retiredCount += matches.length;
  }
}
report(ratchet("retiredSymbols", baseline.retiredSymbols.total, retiredCount, [], []));

finish("architecture ratchet");
