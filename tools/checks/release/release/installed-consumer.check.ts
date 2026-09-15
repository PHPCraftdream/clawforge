// The published package, installed the way an operator installs it, running a command.
//
// Everything else in this suite tests the sources. This packs the real tarball, puts it in a
// directory that looks exactly like what `npm init -y` leaves behind, runs `clawforge init`
// there and then runs a command through the installed entry point. That path had never been
// covered, and it is where a release-blocking defect lived: `npm init -y` writes an explicit
// "type": "commonjs", under which Node refuses the ESM app.ts that init writes, so every
// command — bootstrap and both MCP servers included — died at the first import with "Cannot
// use import statement outside a module". Sources, typecheck, lint and pack:check were all
// green while the thing being shipped did not start.
//
// Dependencies are copied from this repository's own node_modules rather than installed:
// the point here is the packed tarball and the consumer's package.json, not npm's resolver,
// and a check that needs the registry cannot run on a machine without one.

import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, cp, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

interface Run {
  code: number;
  output: string;
}

/** spawnLocal has no cwd, and every step here is about which directory it runs in. */
function run(command: string, args: string[], cwd: string): Promise<Run> {
  return new Promise((resolvePromise) => {
    // npm is a .cmd on Windows, and Node refuses to spawn one without a shell. The command
    // itself must stay unquoted — npm.cmd locates its own installation from %~dp0, and a
    // quoted invocation sends it looking for npm-prefix.js beside the working directory.
    const useShell = process.platform === "win32" && command.endsWith(".cmd");
    const quoted = args.map((arg) => (useShell && arg.includes(" ") ? `"${arg}"` : arg));
    const child = spawn(command, quoted, {
      cwd,
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", (error) => resolvePromise({ code: -1, output: `${output}${(error as Error).message}` }));
    child.on("close", (code) => resolvePromise({ code: code ?? -1, output }));
  });
}

// What `npm init -y` writes, verbatim in shape — including the "main" naming a file it does
// not create, and the "type" that used to make the deployment unloadable.
const DEFAULT_CONSUMER_PACKAGE = {
  name: "cf-consumer",
  version: "1.0.0",
  main: "index.js",
  scripts: { test: 'echo "Error: no test specified" && exit 1' },
  keywords: [] as string[],
  author: "",
  license: "ISC",
  type: "commonjs",
};

const packageRoot = resolve(monorepoRoot, "tools", "framework");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const base = await mkdtemp(join(tmpdir(), "clawforge-installed-check-"));

try {
  // --- pack the real thing (prepack builds dist) ------------------------------------------
  const packed = await run(npm, ["pack", "--pack-destination", base], packageRoot);
  const tarballs = packed.code === 0 ? (await readdir(base)).filter((entry) => entry.endsWith(".tgz")) : [];

  if (tarballs.length === 0) {
    // npm missing, or a pack failure this check cannot attribute: say so rather than pass.
    process.stderr.write(`  skip installed-consumer check (npm pack did not produce a tarball)\n    ${packed.output.trim().split("\n").slice(-3).join("\n    ")}\n`);
  } else {
    const extracted = join(base, "extracted");
    await mkdir(extracted, { recursive: true });
    // Relative paths, with the working directory doing the work: GNU tar reads `D:\x` as a
    // remote host spec ("Cannot connect to D") and bsdtar has no --force-local to turn that
    // off, so no absolute Windows path is handed to it at all.
    const untarred = await run("tar", ["-xzf", tarballs[0], "-C", "extracted"], base);
    check("the tarball unpacks", untarred.code === 0 ? 0 : untarred.output.trim(), 0);

    // --- a consumer directory exactly as npm leaves it --------------------------------------
    const consumer = join(base, "consumer");
    await mkdir(join(consumer, "node_modules", "@clawforge"), { recursive: true });
    await writeFile(resolve(consumer, "package.json"), `${JSON.stringify(DEFAULT_CONSUMER_PACKAGE, undefined, 2)}\n`, "utf8");
    await cp(join(extracted, "package"), join(consumer, "node_modules", "@clawforge", "framework"), { recursive: true });
    await cp(resolve(monorepoRoot, "node_modules", "json5"), join(consumer, "node_modules", "json5"), { recursive: true });

    const entry = join(consumer, "node_modules", "@clawforge", "framework", "dist", "entry", "bin.js");
    check("the packed entry point is where the bin field says it is", await access(entry).then(() => true, () => false), true);

    // --- init, then a command, both through the installed entry point -----------------------
    const initialised = await run(process.execPath, ["--experimental-strip-types", entry, "init"], consumer);
    check("init succeeds in a default consumer directory", initialised.code, 0);

    const consumerPackage = JSON.parse(await readFile(resolve(consumer, "package.json"), "utf8")) as { type?: string };
    check("and leaves the directory loadable as ESM", consumerPackage.type, "module");
    check("app.ts is written", await access(resolve(consumer, "app.ts")).then(() => true, () => false), true);
    check("and so is the ./clawforge shim", await access(resolve(consumer, "clawforge")).then(() => true, () => false), true);

    // The decisive one: bin.js dynamically imports the deployment's own app.ts, which is what
    // the consumer's package.json decides how to read.
    const helped = await run(process.execPath, ["--experimental-strip-types", entry, "help"], consumer);
    check("a command runs against the installed package", helped.code, 0);
    check("and the deployment's own commands are what it lists", helped.output.includes("bootstrap"), true);
    if (helped.code !== 0) process.stderr.write(`    ${helped.output.trim().split("\n").slice(0, 5).join("\n    ")}\n`);

    // What the npm-linked bin actually gets: a plain `#!/usr/bin/env node`, because busybox
    // `env` has no -S to carry a flag. On Node 22.6-22.17 that Node cannot read app.ts at
    // all, and bin.js has to notice and re-execute itself with --experimental-strip-types.
    // --no-experimental-strip-types reproduces that here on any Node.
    const stripless = await run(process.execPath, ["--no-experimental-strip-types", entry, "help"], consumer);
    check("and runs on a Node that does not strip types until asked", stripless.code, 0);
    check("listing the same commands after re-executing itself", stripless.output.includes("bootstrap"), true);
    if (stripless.code !== 0) process.stderr.write(`    ${stripless.output.trim().split("\n").slice(0, 5).join("\n    ")}\n`);
  }
} finally {
  await rm(base, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all installed consumer checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
