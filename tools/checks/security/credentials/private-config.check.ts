import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  upsertEnvValue,
  generatePrivateSecret,
  registerPrivateSecret,
  replacePrivateTargetFile,
  ensurePrivateTargetDirectory,
  execWithSecrets,
} from "#framework/security/private-config.ts";
import { clearRecipesDir, recipesDirectory, useRecipesDir } from "#framework/service/recipe.ts";
import { locksDir } from "#framework/core/env.ts";
import { LocalTransport, type ExecResult } from "#framework/runtime/transport.ts";
import type { Context } from "#framework/core/context.ts";

assert.equal(upsertEnvValue("A=1\nB=2\n", "B", "updated"), "A=1\nB=updated\n");
assert.equal(upsertEnvValue("A=1\n", "B", "added"), "A=1\nB=added\n");
assert.throws(() => upsertEnvValue("", "BAD-NAME", "x"), /invalid environment variable name/);
assert.throws(() => upsertEnvValue("", "GOOD", "line\nbreak"), /contains a newline/);
assert.equal(generatePrivateSecret(16).length > 0, true);
registerPrivateSecret("synthetic-private-secret");
assert.throws(() => generatePrivateSecret(8), /at least 16/);

// A private write is only allowed where a recipe's recipe.json declares it (privatePaths):
// that one declaration is what snapshot exclusion and verify derive from, so anything
// written outside it would be invisible to both. The refusals below are that closure.
const previousRecipes = (() => {
  try { return recipesDirectory(); } catch { return undefined; }
})();
const scratch = await mkdtemp(join(tmpdir(), "clawforge-private-config-check-"));
await mkdir(join(scratch, "declared"), { recursive: true });
await writeFile(join(scratch, "declared", "recipe.json"), JSON.stringify({ description: "declared", privatePaths: ["recipe-private"] }), "utf8");

const files = new Map<string, string>();
const ctx = {
  settings: { dataDir: "/srv/fixture/data", env: {} },
  transport: {
    mkdirp: async (): Promise<void> => {},
    exec: async (command: string, args: string[]) => {
      if (command === "mv") {
        files.set(args.at(-1)!, files.get(args.at(-2)!)!);
        files.delete(args.at(-2)!);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    writePrivateFile: async (path: string, content: string) => { files.set(path, content); },
    writeFile: async (path: string, content: string) => { files.set(path, content); },
    remove: async (path: string) => { files.delete(path); },
  },
} as unknown as Context;

try {
  useRecipesDir(scratch);
  const result = await replacePrivateTargetFile(ctx, "/srv/fixture/data/recipe-private/config.ktav", "secret-free test");
  assert.equal(files.get(result.path), "secret-free test");
  assert.equal(result.checksum.length, 64);
  assert.equal(result.bytes, 16);
  await assert.rejects(replacePrivateTargetFile(ctx, "/srv/fixture/data/undeclared/config.ktav", "x"), /privatePaths/);
  await assert.rejects(ensurePrivateTargetDirectory(ctx, "/srv/fixture/data/undeclared"), /privatePaths/);
  await assert.rejects(replacePrivateTargetFile(ctx, "/elsewhere/config.ktav", "x"), /inside the data directory/);
  // A refused write must leave nothing behind, not even a half-written staging file.
  assert.deepEqual([...files.keys()], ["/srv/fixture/data/recipe-private/config.ktav"]);
} finally {
  if (previousRecipes === undefined) clearRecipesDir();
  else useRecipesDir(previousRecipes);
  await rm(scratch, { recursive: true, force: true });
}
process.stderr.write("all private-config checks passed\n");

// --- execWithSecrets(): running a recipe command with secret values that must never surface
// in an argv. ---------------------------------------------------------------------------
//
// The contract being pinned: the values travel in ONE freshly created owner-only file inside
// a brand-new directory under locksDir(), the command runs as exactly one `sh -c` wrapper
// whose script sources that file (`. "$1"`), the inner result comes back untouched, and the
// private directory is removed again whatever the outcome. Validation of names and values
// happens before the transport is touched at all.
//
// Every group builds its own recording stub transport (the events array is closed over per
// factory call), so nothing leaks between groups; the real-transport group probes for `sh`
// first and skips cleanly where there is none.

let execFailed = 0;

function checkExec(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  execFailed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

async function rejectedExec(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return false;
  } catch {
    return true;
  }
}

const MARKER = "synthetic-secret-not-real-3f9a";
const EXEC_DATA_DIR = "/srv/openclaw/data";
const EXEC_LOCKS = locksDir(EXEC_DATA_DIR);

type ExecEvent =
  | { kind: "mkdirp"; path: string }
  | { kind: "writePrivate"; path: string; content: string }
  | { kind: "writeFile"; path: string; content: string; mode?: string }
  | { kind: "exec"; command: string; args: string[] }
  | { kind: "remove"; path: string };

function secretsContext(
  options: { fallbackWrite?: boolean; innerResult?: ExecResult; failInnerExec?: boolean } = {},
): { ctx: Context; events: ExecEvent[] } {
  const events: ExecEvent[] = [];
  const inner = options.innerResult ?? { code: 0, stdout: "", stderr: "" };
  const transport = {
    description: "secrets-stub",
    async exists(): Promise<boolean> {
      return false;
    },
    async readFile(): Promise<string> {
      return "";
    },
    ...(options.fallbackWrite
      ? {}
      : {
          async writePrivateFile(path: string, content: string): Promise<void> {
            events.push({ kind: "writePrivate", path, content });
          },
        }),
    async writeFile(path: string, content: string, mode?: string): Promise<void> {
      events.push({ kind: "writeFile", path, content, mode });
    },
    async remove(path: string): Promise<void> {
      events.push({ kind: "remove", path });
    },
    async mkdirp(path: string): Promise<void> {
      events.push({ kind: "mkdirp", path });
    },
    async exec(command: string, args: string[]): Promise<ExecResult> {
      events.push({ kind: "exec", command, args });
      if (options.failInnerExec && command === "sh" && args[0] === "-c") throw new Error("inner exec failed");
      return inner;
    },
  };
  return { ctx: { settings: { dataDir: EXEC_DATA_DIR, env: {} }, transport } as unknown as Context, events };
}

const execEvents = (events: ExecEvent[]): { command: string; args: string[] }[] =>
  events.filter((event): event is Extract<ExecEvent, { kind: "exec" }> => event.kind === "exec");

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

const argvLeak = (events: ExecEvent[], needle: string): boolean =>
  events.some(
    (event) =>
      event.kind === "exec" &&
      (event.command.includes(needle) || event.args.some((arg) => arg.includes(needle))),
  );

// --- the happy path: one wrapper, one private file, no secret in any argv -------------------

{
  const { ctx: execCtx, events } = secretsContext({ innerResult: { code: 7, stdout: "inner-stdout", stderr: "inner-stderr" } });
  const result = await execWithSecrets(execCtx, "node", ["run.js", "--flag"], { env: { CF_PROBE: MARKER } });

  const execs = execEvents(events);
  const wrappers = execs.filter((event) => event.command === "sh" && event.args[0] === "-c");
  const wrapperArgs = wrappers[0]?.args ?? [];
  const script = wrapperArgs[1] ?? "";
  const mkdirs = execs.filter((event) => event.command === "mkdir");
  const write = events.find((event): event is Extract<ExecEvent, { kind: "writePrivate" }> => event.kind === "writePrivate");
  const directory = write === undefined ? "" : parentOf(write.path);
  const innerCommand = "node";
  const innerArgs = ["run.js", "--flag"];

  checkExec("exactly one sh -c wrapper reaches the transport", wrappers.length, 1);
  checkExec("the wrapper script sources the env file", script.includes('. "$1"'), true);
  checkExec("the wrapper script never contains the marker", script.includes(MARKER), false);
  checkExec("the env file path reaches the wrapper args", wrapperArgs.includes(write?.path ?? " never"), true);
  checkExec(
    "the wrapper tail carries the inner command unchanged",
    JSON.stringify(wrapperArgs.slice(wrapperArgs.length - (1 + innerArgs.length))) ===
      JSON.stringify([innerCommand, ...innerArgs]),
    true,
  );
  checkExec("no exec argv ever contains the marker", argvLeak(events, MARKER), false);

  checkExec("the locks dir itself is mkdirped", events.some((event) => event.kind === "mkdirp" && event.path === EXEC_LOCKS), true);
  checkExec(
    "exactly one mkdir -m 700 creates the private directory",
    mkdirs.length === 1 && JSON.stringify(mkdirs[0].args) === JSON.stringify(["-m", "700", directory]),
    true,
  );
  checkExec("the private directory is fresh under the locks dir", directory.startsWith(`${EXEC_LOCKS}/recipe-exec-`), true);
  checkExec("the env file is that directory's env entry", write?.path, `${directory}/env`);
  checkExec("the env file content is a shell-sourceable export", write?.content, `export CF_PROBE='${MARKER}'\n`);
  checkExec("writePrivateFile is preferred over the fallback write", events.some((event) => event.kind === "writeFile"), false);

  checkExec(
    "the inner result comes back as-is",
    JSON.stringify(result),
    JSON.stringify({ code: 7, stdout: "inner-stdout", stderr: "inner-stderr" }),
  );
  checkExec(
    "the private directory is removed after the call",
    events.some((event) => event.kind === "remove" && event.path === directory && directory !== ""),
    true,
  );
}

// --- a fresh, never-reused private directory per call ----------------------------------------

{
  const { ctx: execCtx, events } = secretsContext();
  await execWithSecrets(execCtx, "sh", ["-c", "exit 0"], { env: { CF_PROBE: MARKER } });
  await execWithSecrets(execCtx, "sh", ["-c", "exit 0"], { env: { CF_PROBE: MARKER } });
  const directories = execEvents(events)
    .filter((event) => event.command === "mkdir")
    .map((event) => event.args[2]);
  checkExec("two calls create two different private directories", directories.length === 2 && directories[0] !== directories[1], true);
  checkExec(
    "both live under the locks dir as recipe-exec-*",
    directories.every((directory) => directory.startsWith(`${EXEC_LOCKS}/recipe-exec-`)),
    true,
  );
  checkExec(
    "each private directory is removed again",
    events.filter((event) => event.kind === "remove" && directories.includes(event.path)).length,
    2,
  );
}

// --- a single quote inside a value must come through escaped, never raw ----------------------

{
  const { ctx: execCtx, events } = secretsContext();
  const quoted = `${MARKER}'quoted`;
  await execWithSecrets(execCtx, "sh", ["-c", "exit 0"], { env: { QUOTED: quoted } });
  const write = events.find((event): event is Extract<ExecEvent, { kind: "writePrivate" }> => event.kind === "writePrivate");
  checkExec(
    "the quoted value line is a shell-sourceable export",
    write?.content.startsWith("export QUOTED='") === true && write?.content.endsWith("'\n") === true,
    true,
  );
  checkExec("the quote is escaped for the shell", write?.content.includes("'\\''"), true);
  checkExec("the raw quoted value never appears unescaped", write?.content.includes(quoted), false);
  checkExec("no argv carries the quoted value either", argvLeak(events, quoted), false);
}

// --- without writePrivateFile the writeFile(path, content, "600") fallback applies -----------

{
  const { ctx: execCtx, events } = secretsContext({ fallbackWrite: true });
  await execWithSecrets(execCtx, "sh", ["-c", "exit 0"], { env: { CF_PROBE: MARKER } });
  const writes = events.filter((event): event is Extract<ExecEvent, { kind: "writeFile" }> => event.kind === "writeFile");
  checkExec("the fallback writes the env file once", writes.length, 1);
  checkExec("the fallback writes with mode 600", writes[0]?.mode, "600");
  checkExec("the fallback content is the same shell-sourceable export", writes[0]?.content, `export CF_PROBE='${MARKER}'\n`);
  const chmods = execEvents(events).filter((event) => event.command === "chmod");
  checkExec(
    "the fallback chmods the env file to 600",
    chmods.length === 1 && JSON.stringify(chmods[0].args) === JSON.stringify(["600", writes[0]?.path]),
    true,
  );
  checkExec(
    "the fallback still removes the private directory",
    events.some((event) => event.kind === "remove" && writes[0] !== undefined && event.path === parentOf(writes[0].path)),
    true,
  );
}

// --- the inner exec throwing must still clean up ---------------------------------------------

{
  const { ctx: execCtx, events } = secretsContext({ failInnerExec: true });
  let message = "";
  try {
    await execWithSecrets(execCtx, "sh", ["-c", "exit 3"], { env: { CF_PROBE: MARKER } });
  } catch (error) {
    message = (error as Error).message;
  }
  checkExec("an inner exec failure rejects execWithSecrets with that error", message, "inner exec failed");
  const write = events.find((event): event is Extract<ExecEvent, { kind: "writePrivate" }> => event.kind === "writePrivate");
  checkExec(
    "the failed call still removes the private directory",
    events.some((event) => event.kind === "remove" && write !== undefined && event.path === parentOf(write.path)),
    true,
  );
}

// --- an empty env degenerates to a plain exec -------------------------------------------------

{
  const { ctx: execCtx, events } = secretsContext({ innerResult: { code: 3, stdout: "plain", stderr: "" } });
  const result = await execWithSecrets(execCtx, "node", ["run.js"], { env: {} });
  const only = events[0];
  checkExec(
    "an empty env performs exactly one plain exec",
    events.length === 1 &&
      only?.kind === "exec" &&
      only.command === "node" &&
      JSON.stringify(only.args) === JSON.stringify(["run.js"]),
    true,
  );
  checkExec("an empty env touches no private file or directory", events.some((event) => event.kind !== "exec"), false);
  checkExec(
    "the plain result still comes back as-is",
    JSON.stringify(result),
    JSON.stringify({ code: 3, stdout: "plain", stderr: "" }),
  );
}

// --- validation happens before the transport is touched ---------------------------------------

{
  const { ctx: execCtx, events } = secretsContext();
  checkExec(
    "an env name with invalid characters throws",
    await rejectedExec(() => execWithSecrets(execCtx, "sh", ["-c", "exit 0"], { env: { "BAD-NAME": MARKER } })),
    true,
  );
  checkExec(
    "a value containing a newline throws",
    await rejectedExec(() => execWithSecrets(execCtx, "sh", ["-c", "exit 0"], { env: { CF_PROBE: `${MARKER}\nsecond-line` } })),
    true,
  );
  checkExec("validation rejects before any transport call", events.length, 0);
}

// --- the real transport: the marker arrives only through the sourced env file -----------------

{
  const dataDir = resolve(tmpdir(), `clawforge-exec-secrets-${randomBytes(4).toString("hex")}`).replaceAll("\\", "/");
  const locks = `${dataDir}-locks`;
  const execCtx = { settings: { dataDir, env: {} }, transport: new LocalTransport() } as unknown as Context;
  const probe = await execCtx.transport.exec("sh", ["-c", "true"]).then(
    () => true,
    () => false,
  );
  if (!probe) {
    process.stderr.write("  skip real-transport round-trip: no sh on this machine\n");
  } else {
    try {
      const result = await execWithSecrets(execCtx, "sh", ["-c", 'printf %s "$CF_PROBE"'], { env: { CF_PROBE: MARKER } });
      checkExec("the sourced env file delivers the marker", result.stdout, MARKER);
      checkExec("the real inner exec exits cleanly", result.code, 0);
      const plain = await execCtx.transport.exec("sh", ["-c", 'printf %s "$CF_PROBE"']);
      checkExec("the ambient environment never carries the marker", plain.stdout.includes(MARKER), false);
      const leftovers = await execCtx.transport.listFiles(locks);
      checkExec(
        "the private env directory is gone after the call",
        leftovers.filter((entry) => entry.startsWith("recipe-exec-")).length,
        0,
      );
    } finally {
      await rm(locks, { recursive: true, force: true });
    }
  }
}

process.stderr.write(execFailed === 0 ? "all exec-secrets checks passed\n" : `${execFailed} failed\n`);
if (execFailed > 0) process.exitCode = 1;
