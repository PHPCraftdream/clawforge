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
import { checkTrue, finish } from "#checks/kit/harness.ts";

interface PerFileMetric {
  readonly comment: string;
  readonly total: number;
  readonly files: Record<string, number>;
}
interface Baseline {
  readonly about: string;
  readonly dotClawforgeLiterals: PerFileMetric;
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
  readonly longArgumentDescriptions: { readonly comment: string; readonly total: number; readonly arguments: number };
  readonly imageStringOps: PerFileMetric;
  readonly prosePins: PerFileMetric;
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

// 1. `./clawforge` literals in tools/framework — stage 4 (Advice): the command name must
// reach output only through one renderer, so this goes to 0 outside it.
const literalAfter = new Map<string, number>();
for (const full of frameworkFiles) {
  const content = await readFile(full, "utf8");
  const count = content.split("./clawforge").length - 1;
  if (count > 0) literalAfter.set(rel(full), count);
}
report(perFileRatchet("dotClawforgeLiterals", baseline.dotClawforgeLiterals.files, literalAfter));

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

// 3. Raw-argv predicates — stage 3 (CommandSpec effect): MCP confirmation must come from the
// declared effect, not from 28 predicates re-parsing argv beside the real parser.
let readOnlyWhen = 0;
let changedWhen = 0;
let requiresConfirmationWhen = 0;
let argumentCount = 0;
let longDescriptions = 0;
for (const command of Object.values(openclawCommands)) {
  if (command.readOnlyWhen !== undefined) readOnlyWhen += 1;
  if (command.changedWhen !== undefined) changedWhen += 1;
  if (command.requiresConfirmationWhen !== undefined) requiresConfirmationWhen += 1;
  for (const argument of command.arguments ?? []) {
    argumentCount += 1;
    // 4. Long argument descriptions — stage 3: declared `summary` fields replace the MCP
    // schema's 60-character heuristic shortening.
    if (argument.description.length > 60) longDescriptions += 1;
  }
}
report(ratchet("rawArgvPredicates.readOnlyWhen", baseline.rawArgvPredicates.readOnlyWhen, readOnlyWhen, [], []));
report(ratchet("rawArgvPredicates.changedWhen", baseline.rawArgvPredicates.changedWhen, changedWhen, [], []));
report(ratchet("rawArgvPredicates.requiresConfirmationWhen", baseline.rawArgvPredicates.requiresConfirmationWhen, requiresConfirmationWhen, [], []));
report(ratchet("longArgumentDescriptions", baseline.longArgumentDescriptions.total, longDescriptions, [], []));
report(ratchet("declaredArguments", baseline.longArgumentDescriptions.arguments, argumentCount, [], []));

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

finish("architecture ratchet");
