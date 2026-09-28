// Pure decisions run.ts makes once a file's missing capabilities are known: whether to run,
// skip or fail it, and how the skip line and closing summary read. Kept separate from
// capabilities.ts (the probes) and run.ts (the process spawning) so both can be pinned without
// a real docker/wsl.exe/sh and without spawning a single check file.

import type { Capability } from "./capabilities.ts";

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
