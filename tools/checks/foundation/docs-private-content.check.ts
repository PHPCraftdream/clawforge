import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const docs = resolve(repository, "docs");

const privatePaths: readonly [string, RegExp][] = [
  ["windows path", /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/],
  ["mounted drive path", /\/mnt\/[a-z]\//i],
  ["user home path", /\/home\/(?!node(?:\/|$))[A-Za-z0-9_.-]+\//],
  ["WSL network path", /\\\\wsl(?:\.localhost|\$)\\/i],
];

const credential = /\b[A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|PASSWORD|SECRET)[A-Z0-9_]*\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([^\s`#;,)\]}]+))/g;

function findings(line: string): string[] {
  const result = privatePaths.filter(([, pattern]) => pattern.test(line)).map(([name]) => name);
  for (const match of line.matchAll(credential)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    const placeholder = /^<[^>]+>$/.test(value) || /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value);
    const verdict = /^(?:true|false|null)$/i.test(value);
    if (value !== "" && !placeholder && !verdict) {
      result.push("credential value");
    }
  }
  return result;
}

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

assert.deepEqual(findings("source: X:/private/example"), ["windows path"]);
assert.deepEqual(findings("source: /mnt/q/private/example"), ["mounted drive path"]);
assert.deepEqual(findings("source: /home/exampleuser/private"), ["user home path"]);
assert.deepEqual(findings("EXAMPLE_TOKEN=nonempty"), ["credential value"]);
assert.deepEqual(findings("EXAMPLE_TOKEN=<synthetic>"), []);
assert.deepEqual(findings("https://example.test and /home/node/.openclaw"), []);

const files = await markdownFiles(docs);
assert.ok(files.length > 0, "documentation inventory is empty");
const problems: string[] = [];
for (const file of files) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const reason of findings(line)) {
      problems.push(`${relative(repository, file).replaceAll("\\", "/")}:${index + 1}: ${reason}`);
    }
  });
}

if (problems.length > 0) {
  throw new Error(`documentation contains private machine data:\n${problems.join("\n")}`);
}
process.stderr.write(`documentation privacy check passed (${files.length} files)\n`);
