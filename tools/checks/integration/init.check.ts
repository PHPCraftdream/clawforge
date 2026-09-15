// `clawforge init` — must not overwrite state a directory already holds.
//
// Only app.ts's existence used to be checked before writing anything: an .env or a
// config/desired-state.json already there (leftover from something else, or a previous init
// that failed partway through) was silently discarded.

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initApp } from "#framework/integration/init.ts";
import { withOutputSink } from "#framework/core/output.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

async function run(root: string): Promise<string | undefined> {
  let message: string | undefined;
  await withOutputSink(
    () => {},
    async () => {
      try {
        await initApp(root);
      } catch (error) {
        message = (error as Error).message;
      }
    },
  );
  return message;
}

// mkdtemp's own random suffix mixes upper and lower case, which safeName (checked before
// anything else in initApp) rejects — a deterministic, compliant subdirectory name is used
// under the temp base instead, so the fixture is testing THIS check, not that one.

// --- an existing .env must refuse init, not be silently overwritten -----------------------

{
  const base = await mkdtemp(join(tmpdir(), "clawforge-init-check-"));
  const root = join(base, "deployment-env");
  await mkdir(root, { recursive: true });
  try {
    const envFile = resolve(root, ".env");
    const original = "MY_OWN_SETTING=do-not-touch-me\n";
    await writeFile(envFile, original, "utf8");

    const message = await run(root);
    check("init refuses when .env already exists", message?.includes(".env") && message.includes("already exists"), true);
    check("the existing .env is left untouched", await readFile(envFile, "utf8"), original);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- an existing config/desired-state.json must refuse init too ---------------------------

{
  const base = await mkdtemp(join(tmpdir(), "clawforge-init-check-"));
  const root = join(base, "deployment-desired");
  await mkdir(root, { recursive: true });
  try {
    await mkdir(resolve(root, "config"), { recursive: true });
    const desiredStateFile = resolve(root, "config", "desired-state.json");
    const original = '[{"path":"custom.setting","value":true}]\n';
    await writeFile(desiredStateFile, original, "utf8");

    const message = await run(root);
    check("init refuses when config/desired-state.json already exists", message?.includes("desired-state.json") && message.includes("already exists"), true);
    check("the existing desired-state.json is left untouched", await readFile(desiredStateFile, "utf8"), original);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- a genuinely fresh directory still initialises normally --------------------------------

{
  const base = await mkdtemp(join(tmpdir(), "clawforge-init-check-"));
  const root = join(base, "deployment-fresh");
  await mkdir(root, { recursive: true });
  try {
    const message = await run(root);
    check("a fresh directory initialises without refusing", message, undefined);
    check("app.ts was written", await readFile(resolve(root, "app.ts"), "utf8").then(() => true, () => false), true);
    check("desired-state.json was written", await readFile(resolve(root, "config", "desired-state.json"), "utf8").then(() => true, () => false), true);
    check(".env was written", await readFile(resolve(root, ".env"), "utf8").then(() => true, () => false), true);

    // The shim invokes node with script_path as an ARGUMENT ("node dist/entry/bin.js"),
    // which bypasses bin.js's own shebang entirely — Node reads a shebang line only when the
    // OS resolves the file as an executable, not when it is handed a path to run. Without
    // the flag repeated here, this package's declared minimum (Node 22.6, where type
    // stripping is not on by default) fails with "Unknown file extension \".ts\"" the moment
    // bin.js dynamically imports this deployment's own, never-compiled app.ts.
    const shim = await readFile(resolve(root, "clawforge"), "utf8");
    check("the shim passes --experimental-strip-types when invoking node directly", shim.includes("--experimental-strip-types"), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// --- the deployment must be loadable as ESM afterwards -------------------------------------
//
// app.ts imports @clawforge/framework, and Node decides how to read a .ts file from the
// nearest package.json's "type". It guesses only when the field is absent; `npm init -y`
// writes an explicit "type": "commonjs", and under that every command — including bootstrap
// and both MCP servers — dies at the first import with "Cannot use import statement outside a
// module". Reproduced against a real packed tarball before this was fixed.

async function freshRoot(name: string): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "clawforge-init-check-"));
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  return { base, root };
}

/** An absent or unreadable package.json is an empty object here rather than a throw: these
 *  cases are about what is IN the file, and a missing one must read as a failed assertion in
 *  this file, not as a crash that takes the rest of the cases with it. */
async function packageJsonOf(root: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

{
  const { base, root } = await freshRoot("deployment-no-package");
  try {
    check("a directory without a package.json initialises", await run(root), undefined);
    const parsed = await packageJsonOf(root);
    check("and gets one that says it is a module", parsed.type, "module");
    check("marked private, because nothing here belongs on a registry", parsed.private, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-typeless");
  try {
    // What `npm install @clawforge/framework` leaves behind in a repository that had a
    // package.json before the framework was added.
    await writeFile(
      resolve(root, "package.json"),
      `${JSON.stringify({ name: "consumer", version: "1.2.3", dependencies: { "@clawforge/framework": "^0.1.0" } }, undefined, 2)}\n`,
      "utf8",
    );

    check("a package.json without a type initialises", await run(root), undefined);
    const parsed = await packageJsonOf(root);
    check("the type is filled in", parsed.type, "module");
    check("and nothing else in the file is lost", JSON.stringify([parsed.name, parsed.version, parsed.dependencies]), JSON.stringify(["consumer", "1.2.3", { "@clawforge/framework": "^0.1.0" }]));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-npm-init");
  try {
    // Exactly what `npm init -y` writes — including the "main" that names a file it did not
    // create. Nothing in the directory is read under that "type", so nobody chose it.
    await writeFile(
      resolve(root, "package.json"),
      `${JSON.stringify({ name: "consumer", version: "1.0.0", main: "index.js", type: "commonjs" }, undefined, 2)}\n`,
      "utf8",
    );

    check("a default `npm init -y` package initialises", await run(root), undefined);
    check("and its commonjs is replaced, because no file here depends on it", (await packageJsonOf(root)).type, "module");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-commonjs-code");
  try {
    // Here the field IS load-bearing: flipping it would change how this file is read.
    const original = `${JSON.stringify({ name: "consumer", version: "1.0.0", main: "index.js", type: "commonjs" }, undefined, 2)}\n`;
    await writeFile(resolve(root, "package.json"), original, "utf8");
    await writeFile(resolve(root, "index.js"), "module.exports = { hello: 1 };\n", "utf8");

    const message = await run(root);
    check("a commonjs package with commonjs code in it is refused", message?.includes('"type": "commonjs"'), true);
    check("the refusal names the files that would change meaning", message?.includes("index.js"), true);
    check("and says what would happen instead", message?.includes("Cannot use import statement outside a module"), true);
    check("the operator's package.json is left exactly as it was", await readFile(resolve(root, "package.json"), "utf8"), original);
    // Refused whole: a directory the deployment cannot run in must not be left half-written.
    check("and nothing was written into the directory", await readFile(resolve(root, "app.ts"), "utf8").then(() => true, () => false), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-broken-package");
  try {
    await writeFile(resolve(root, "package.json"), "{ not json", "utf8");
    const message = await run(root);
    check("a package.json that does not parse is refused rather than guessed at", message?.includes("not valid JSON"), true);
    check("nothing is written in that case either", await readFile(resolve(root, "app.ts"), "utf8").then(() => true, () => false), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const { base, root } = await freshRoot("deployment-already-module");
  try {
    const original = `${JSON.stringify({ name: "consumer", type: "module" }, undefined, 2)}\n`;
    await writeFile(resolve(root, "package.json"), original, "utf8");
    check("a package that already says module initialises", await run(root), undefined);
    check("and its package.json is not rewritten", await readFile(resolve(root, "package.json"), "utf8"), original);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

process.stderr.write(failed === 0 ? "all init checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
