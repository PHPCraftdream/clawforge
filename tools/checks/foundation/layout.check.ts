import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { monorepoRoot } from "../../framework/core/env.ts";

async function inspect(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const source = entries.some((entry) => entry.isFile() && /\.(?:ts|tsx|js|jsx)$/.test(entry.name));
  if (source) assert.ok(entries.length <= 7, `${dir} has ${entries.length} direct entries`);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== "dist" && entry.name !== "node_modules") await inspect(resolve(dir, entry.name));
  }
}

await inspect(resolve(monorepoRoot, "tools", "framework"));
await inspect(resolve(monorepoRoot, "tools", "checks"));
process.stderr.write("source layout limits passed\n");
