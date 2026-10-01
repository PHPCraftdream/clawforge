// check:exclusive — drops a scratch deployment into apps/ for the gate, which other checks that enumerate deployments must not see.
// Golden surface check (plan stage 0, item 1): re-renders every user-visible surface and
// compares it byte for byte with the committed snapshots. A difference is a behaviour
// change and must arrive as a reviewed snapshot diff, not silently — structural
// refactoring later in the plan leans on exactly this.
//
// Never writes: snapshots are updated only by `npm run golden:update`.

import { readdir } from "node:fs/promises";
import { renderGolden, readSnapshot, snapshotsDir } from "./render.ts";

const rendered = await renderGolden();
const committed = (await readdir(snapshotsDir())).filter((name) => name.endsWith(".txt") || name.endsWith(".json"));

let failed = 0;
const expectedNames = Object.keys(rendered).sort();
const missing = committed.filter((name) => !expectedNames.includes(name));
const extra = expectedNames.filter((name) => !committed.includes(name));

for (const name of missing) {
  failed += 1;
  process.stderr.write(`  FAIL golden ${name}: committed but no longer rendered — remove the file\n`);
}
for (const name of extra) {
  failed += 1;
  process.stderr.write(`  FAIL golden ${name}: rendered but not committed — run npm run golden:update\n`);
}

for (const name of expectedNames) {
  if (!committed.includes(name)) continue;
  const actual = rendered[name]!;
  const expected = await readSnapshot(name);
  if (actual === expected) {
    process.stderr.write(`  ok   golden ${name}\n`);
    continue;
  }

  failed += 1;
  process.stderr.write(`  FAIL golden ${name} differs from the committed snapshot\n`);
  // Unified-style excerpt: the equal head, then the first differing lines from both
  // sides, so a reviewed diff starts where the behaviour actually changed.
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  let head = 0;
  while (head < actualLines.length && head < expectedLines.length && actualLines[head] === expectedLines[head]) head += 1;
  let tail = 0;
  while (
    tail < actualLines.length - head && tail < expectedLines.length - head
    && actualLines[actualLines.length - 1 - tail] === expectedLines[expectedLines.length - 1 - tail]
  ) tail += 1;
  const LIMIT = 40;
  const excerpt = (lines: string[], marker: string): string[] =>
    lines.slice(head, Math.min(lines.length - tail, head + LIMIT)).map((line) => `${marker} ${line}`);
  process.stderr.write(
    [`  --- a/expected/${name}`, `  +++ b/expected/${name}`]
      .concat(excerpt(expectedLines, "-"), excerpt(actualLines, "+"))
      .map((line) => `${line}\n`)
      .join(""),
  );
  if (Math.min(actualLines.length, expectedLines.length) - tail - head > LIMIT) {
    process.stderr.write(`  … further differences omitted — run npm run golden:update and read the git diff\n`);
  }
}

process.stderr.write(
  failed === 0 ? "all golden checks passed\n" : `${failed} golden snapshot file(s) differ — inspect the diff, then run npm run golden:update\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
