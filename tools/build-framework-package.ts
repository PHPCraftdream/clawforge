// Builds tools/framework/ into a publishable npm package.
//
// This repo's own ./clawforge runs the framework's TypeScript directly — no build step, by
// design. That stops working once the framework is installed as a dependency: Node
// refuses to type-strip anything it loads from inside node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), confirmed by actually packing and
// installing the raw .ts sources and watching that error come back. There is no flag to
// turn it off.
//
// So packaging needs an actual build, but not a real compiler: `node:module`'s own
// `stripTypeScriptTypes` is the exact same mechanism Node already applies at runtime
// everywhere else in this project, run here instead at pack time, outside node_modules,
// where it is still allowed. The only manual step beyond that is rewriting the `.ts`
// extensions this codebase's imports use explicitly (e.g. `from "./env.ts"`) to `.js`,
// since the emitted files are `.js` and nothing here uses bundler-style extensionless
// resolution.
//
// Output goes to tools/framework/dist/ — git-ignored, regenerated on demand by this
// script, never hand-edited, never the source of truth.

import { readdir, readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const frameworkDir = resolve(toolsDir, "framework");
const distDir = resolve(frameworkDir, "dist");

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
      continue;
    }
    if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

/** Only rewrites the extension inside a quoted static or dynamic import/export specifier —
 *  never touches comments or unrelated string literals, which is why this is not a blanket
 *  ".ts" -> ".js" replace across the whole file. */
function rewriteSpecifiers(code: string): string {
  return code.replace(
    /((?:from|import)\s*\(?\s*["'])(\.[^"']+)\.ts(["'])/g,
    (_match, prefix: string, path: string, suffix: string) => `${prefix}${path}.js${suffix}`,
  );
}

async function build(): Promise<void> {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const files = await collectTsFiles(frameworkDir);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const stripped = stripTypeScriptTypes(source, { mode: "strip" });
    const rewritten = rewriteSpecifiers(stripped);
    const rel = relative(frameworkDir, file).replace(/\.ts$/, ".js");
    const outFile = resolve(distDir, rel);
    await mkdir(dirname(outFile), { recursive: true });

    // The source shebang picks --experimental-strip-types for the raw-.ts case; the
    // compiled output is plain JS and needs none of that.
    const finalContent = rel === "entry/bin.js"
      ? rewritten.replace(/^#!.*\n/, "#!/usr/bin/env node\n")
      : rewritten;

    await writeFile(outFile, finalContent, "utf8");
  }

  await copyFile(resolve(frameworkDir, "docker-compose.yml"), resolve(distDir, "docker-compose.yml"));
  await copyFile(resolve(frameworkDir, ".env.example"), resolve(distDir, ".env.example"));

  process.stderr.write(`built ${files.length} file(s) into ${distDir}\n`);
}

await build();
