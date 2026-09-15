// The compiled dist/entry/bin.js must keep the --experimental-strip-types flag its own
// shebang carries in source.
//
// bin.ts's own comment explains why: the compiled bin.js dynamically imports the
// CONSUMER's own app.ts at runtime — a real, uncompiled TypeScript file this build never
// touches, since it belongs to a different project entirely. This package's declared
// minimum, Node 22.6, requires the flag to load that file at all (type stripping is not
// on by default until later versions). Stripping the flag from the COMPILED shebang (as
// an earlier version of this build did, reasoning that "the compiled output is plain JS
// and needs none of that") is true for bin.js's own module tree but false for the
// consumer's app.ts it dynamically imports — and left a published, installed package
// failing with `Unknown file extension ".ts"` on exactly the oldest Node version it
// claims to support, invisible on any newer one where stripping is already unconditional.

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

if (!firstLine.includes("--experimental-strip-types")) {
  throw new Error(
    `dist/entry/bin.js's shebang lost --experimental-strip-types (got: ${JSON.stringify(firstLine)}) — ` +
      "this package's declared minimum, Node 22.6, needs it to load the consumer's own app.ts, which this build never compiles",
  );
}

process.stderr.write("build output keeps the type-stripping flag bin.js needs on Node 22.6\n");

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
