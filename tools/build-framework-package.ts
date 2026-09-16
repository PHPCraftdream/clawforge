// Builds tools/framework/ into a publishable npm package.
//
// This repo's own ./clawforge runs the framework's TypeScript directly — no build step, by
// design. That stops working once the framework is installed as a dependency: Node
// refuses to type-strip anything it loads from inside node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), confirmed by actually packing and
// installing the raw .ts sources and watching that error come back. There is no flag to
// turn it off.
//
// Node strips types for the JavaScript build; tsgo emits the declaration graph.
// Both outputs use published .js import paths.
//
// Output goes to tools/framework/dist/ — git-ignored, regenerated on demand by this
// script, never hand-edited, never the source of truth.

import { readdir, readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const frameworkDir = resolve(toolsDir, "framework");
const distDir = resolve(frameworkDir, "dist");
const declarationConfig = resolve(frameworkDir, "tsconfig.declaration.json");
const tsgo = resolve(frameworkDir, "../../node_modules/@typescript/native-preview/bin/tsgo");

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
 *  ".ts" -> ".js" replace across the whole file.
 *
 *  Also resolves "#src/..." subpath imports (tools/framework/package.json's own "imports"
 *  map, used in the source tree for readability) down to a plain relative path. dist/ ships
 *  with no package.json of its own, so nothing in it can rely on "#src/" resolving at
 *  runtime — the published package must be as self-contained as the pre-alias source was. */
function rewriteSpecifiers(code: string, fileDir: string, sourceRoot = frameworkDir): string {
  return code.replace(
    /((?:from|import)\s*\(?\s*["'])(\.[^"']+|#src\/[^"']+)\.ts(["'])/g,
    (_match, prefix: string, path: string, suffix: string) => {
      if (path.startsWith("#src/")) {
        const target = resolve(sourceRoot, path.slice("#src/".length));
        const rel = relative(fileDir, target).replaceAll("\\", "/");
        return `${prefix}${rel.startsWith(".") ? rel : `./${rel}`}.js${suffix}`;
      }
      return `${prefix}${path}.js${suffix}`;
    },
  );
}

/** Rewrites generated declaration imports to published JavaScript paths. */
function rewriteDeclarationSpecifiers(code: string, fileDir: string): string {
  return rewriteSpecifiers(code, fileDir, distDir);
}

/** Runs the repository's existing tsgo to emit the declaration graph. */
function emitDeclarations(): void {
  const result = spawnSync(process.execPath, [tsgo, "--project", declarationConfig], {
    cwd: resolve(frameworkDir, "../.."),
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";
    if (stdout !== "") process.stderr.write(stdout);
    if (stderr !== "") process.stderr.write(stderr);
    const detail = result.error?.message ??
      (result.status === null ? "the process did not exit normally" : `exit code ${result.status}`);
    throw new Error(`tsgo declaration build failed: ${detail}`);
  }
}

/** Applies publication path rewrites to every emitted declaration. */
async function rewriteDeclarations(): Promise<void> {
  const files = await collectFiles(distDir, ".d.ts");
  for (const file of files) {
    const source = await readFile(file, "utf8");
    await writeFile(file, rewriteDeclarationSpecifiers(source, dirname(file)), "utf8");
  }
}

/** Collects files ending in `suffix` below `dir`. */
async function collectFiles(dir: string, suffix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full, suffix)));
    } else if (entry.name.endsWith(suffix)) {
      files.push(full);
    }
  }
  return files;
}

async function build(): Promise<void> {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  emitDeclarations();
  await rewriteDeclarations();

  const files = await collectTsFiles(frameworkDir);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const stripped = stripTypeScriptTypes(source, { mode: "strip" });
    const rewritten = rewriteSpecifiers(stripped, dirname(file));
    const rel = relative(frameworkDir, file).replace(/\.ts$/, ".js");
    const outFile = resolve(distDir, rel);
    await mkdir(dirname(outFile), { recursive: true });

    // The shebang travels unchanged. bin.ts's own comment says why: this compiled bin.js
    // dynamically imports the CONSUMER's own app.ts at runtime (never compiled by this
    // build — it is not this package's file), and Node still needs type-stripping active
    // in the process to load it on this package's declared minimum, Node 22.6, where
    // stripping is behind --experimental-strip-types rather than on by default. Stripping
    // the flag here (as this used to) left a published, installed package unable to load a
    // consumer's app.ts on exactly the oldest Node version it claims to support, with
    // "Unknown file extension \".ts\"" — invisible on any newer Node, where stripping is
    // already on by default regardless of the flag.
    await writeFile(outFile, rewritten, "utf8");
  }

  await copyFile(resolve(frameworkDir, "docker-compose.yml"), resolve(distDir, "docker-compose.yml"));
  await copyFile(resolve(frameworkDir, ".env.example"), resolve(distDir, ".env.example"));

  process.stderr.write(`built ${files.length} file(s) into ${distDir}\n`);
}

await build();
