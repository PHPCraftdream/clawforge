// Pure decisions run.ts makes once a file's missing capabilities are known: whether to run,
// skip or fail it, and how the skip line and closing summary read. Kept separate from
// capabilities.ts (the probes) and run.ts (the process spawning) so both can be pinned without
// a real docker/wsl.exe/sh and without spawning a single check file.

import { isCapability, type Capability } from "./capabilities.ts";

export type Gate =
  | { readonly kind: "run" }
  | { readonly kind: "skip"; readonly missing: readonly Capability[] }
  | { readonly kind: "fail"; readonly missing: readonly Capability[] };

/** `missing` is this host's shortfall against one file's `requires`; `forced` is the set
 *  (--require / OC_CHECK_REQUIRE) whose absence must fail the run instead of skipping it. */
export function gateFor(missing: readonly Capability[], forced: ReadonlySet<Capability>): Gate {
  if (missing.length === 0) return { kind: "run" };
  const forcedMissing = missing.filter((capability) => forced.has(capability));
  return forcedMissing.length > 0 ? { kind: "fail", missing: forcedMissing } : { kind: "skip", missing };
}

/** The one line a skipped file prints — no header, no output block, same place in the
 *  ordered output a passing/failing file's own block would occupy. */
export function skipLine(label: string, missing: readonly Capability[]): string {
  return `  SKIP ${label} — needs ${missing.join(", ")}\n`;
}

/** Parses `--require`/OC_CHECK_REQUIRE's comma-separated capability list. Throws on an
 *  unrecognized name — a typo here should fail loudly, not silently require nothing. */
export function parseRequireList(raw: string | undefined, isCapability: (value: string) => value is Capability): Capability[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((entry) => {
    const capability = entry.trim();
    if (!isCapability(capability)) throw new Error(`unknown capability in --require/OC_CHECK_REQUIRE: "${capability}"`);
    return capability;
  });
}

/** The closing summary line: unchanged wording when nothing was skipped (other tooling greps
 *  it), a "needs docker: 3, wsl: 2" breakdown appended otherwise. `ran` excludes skipped
 *  files; `failed` counts only files that actually ran (or were forced to fail) and lost. */
export function summaryLine(ran: number, failed: number, skippedByCapability: ReadonlyMap<Capability, number>): string {
  const skippedTotal = [...skippedByCapability.values()].reduce((sum, count) => sum + count, 0);
  const base = failed === 0 ? `${ran} check file(s) passed` : `${failed} of ${ran} check file(s) failed`;
  if (skippedTotal === 0) return `\n${base}\n`;
  const breakdown = [...skippedByCapability.entries()].map(([capability, count]) => `${capability}: ${count}`).join(", ");
  return `\n${base}, ${skippedTotal} skipped (needs ${breakdown})\n`;
}

/** Case-level skips a ran file printed (harness `requires()`): the same `  SKIP … — needs …`
 *  shape as skipLine, with the case name where a file label would be. Folded into the same
 *  breakdown so a skipped case is counted, not just printed. Unrecognizable lines (the
 *  lowercase ad-hoc skips some checks print) are ignored. */
export function parseCaseSkips(output: string): { readonly name: string; readonly capabilities: readonly Capability[] }[] {
  const found: { name: string; capabilities: Capability[] }[] = [];
  for (const match of output.matchAll(/^ {2}SKIP (.+) — needs (.+)$/gm)) {
    const capabilities = match[2].split(",").map((entry) => entry.trim()).filter(isCapability);
    if (capabilities.length > 0) found.push({ name: match[1], capabilities });
  }
  return found;
}
