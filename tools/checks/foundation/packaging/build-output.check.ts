// The compiled dist/entry/bin.js must start with a shebang every POSIX system can execute.
//
// Two ways to get this wrong, and this package has had both. Dropping the type-stripping
// concern entirely leaves the installed package failing with `Unknown file extension ".ts"`
// because bin.js dynamically imports the CONSUMER's own app.ts — a real,
// uncompiled TypeScript file this build never touches. Carrying the flag in the shebang
// instead (`#!/usr/bin/env -S node --experimental-strip-types`) fixes that on GNU coreutils
// and breaks the package outright on busybox, whose `env` has no -S — Alpine is the most
// common Node base image there is. So the shebang stays plain and bin.js re-executes itself
// with the flag when, and only when, loading app.ts turns out to need it; what is asserted
// here is that the shebang is plain, and installed-consumer.check.ts proves the recovery
// works by running the entry point with stripping explicitly disabled.

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";

// Imported for its side effect: build-framework-package.ts runs its build unconditionally
// at module load, the same way `npm run build` invokes it — regenerating dist/ fresh
// rather than trusting whatever a previous build happened to leave there.
await import("#tools/build-framework-package.ts");

const distDir = resolve(monorepoRoot, "tools", "framework", "dist");
const binPath = resolve(distDir, "entry", "bin.js");
const firstLine = (await readFile(binPath, "utf8")).split("\n")[0];

if (firstLine.trim() !== "#!/usr/bin/env node") {
  throw new Error(
    `dist/entry/bin.js must start with "#!/usr/bin/env node" (got: ${JSON.stringify(firstLine)}) — ` +
      "anything else, `env -S` above all, is not executable on a busybox system such as Alpine",
  );
}

process.stderr.write("build output starts with a shebang every POSIX system can execute\n");

// The source tree uses "#src/..." subpath imports (tools/framework/package.json's own
// "imports" map) for readability. dist/ ships with no package.json of its own, so a
// literal "#src/" specifier surviving into a built file would fail at runtime with
// ERR_INVALID_MODULE_SPECIFIER / ERR_MODULE_NOT_FOUND — build-framework-package.ts's
// rewriteSpecifiers must resolve every one of these down to a plain relative path first.
const distEntries = await readdir(distDir, { recursive: true });
for (const relPath of distEntries) {
  if (!relPath.endsWith(".js")) continue;
  const content = await readFile(resolve(distDir, relPath), "utf8");
  if (content.includes('"#src/') || content.includes("'#src/")) {
    throw new Error(`dist/${relPath} still contains a "#src/" subpath-import specifier — it must be rewritten to a plain relative path before shipping`);
  }
}

process.stderr.write("build output carries no unresolved \"#src/\" subpath-import specifiers\n");
