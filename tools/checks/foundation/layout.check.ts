import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";

const MAX_LINES = 700;

async function inspect(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const source = entries.some((entry) => entry.isFile() && /\.(?:ts|tsx|js|jsx)$/.test(entry.name));
  if (source) assert.ok(entries.length <= 7, `${dir} has ${entries.length} direct entries`);
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isFile() && /\.(?:ts|js)$/.test(entry.name)) {
      const content = await readFile(full, "utf8");
      const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      assert.ok(lines <= MAX_LINES, `${full} is ${lines} lines (limit ${MAX_LINES})`);
    }
    if (entry.isDirectory() && entry.name !== "dist" && entry.name !== "node_modules") await inspect(full);
  }
}

await inspect(resolve(monorepoRoot, "tools", "framework"));
await inspect(resolve(monorepoRoot, "tools", "checks"));
process.stderr.write("source layout limits passed\n");
