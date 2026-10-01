// Backup locking, archive publication and recipe-stack quiesce checks. Rotation is
// rotation.check.ts, retention parsing retention.check.ts, the real-filesystem
// scenarios real-filesystem.check.ts.

import { resolve, join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createBackup } from "#framework/commands/lifecycle/backup/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { parseDeclaredArgs, specOf, specShape, ArgumentError } from "#framework/core/command/index.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { useDeployment, useComposeProjectOverride } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { clearRecipesDir, useRecipesDir } from "#framework/service/recipe.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
useDeployment(resolve(monorepoRoot, "apps", "example app"));
useComposeProjectOverride("example-app");
// --- createBackup must respect the instance lock, not bypass it ---------------------------
//
// Before the fix, createBackup() never called guarded()/takeLock() at all — it paused,
// archived and restarted the gateway regardless of what else was touching the same
// instance. This simulates a lock already held by another operation (the same mkdir-based
// claim takeLock itself uses) and asserts backup refuses before ever touching the gateway.

function stubBackupCtx(
  lockAlreadyHeld: boolean,
  options: { tarFailure?: boolean; publishCollision?: boolean; symlinkedRoot?: boolean; emptyArchive?: boolean } = {},
): { ctx: Context; calls: string[]; files: Set<string>; contents: Map<string, string> } {
  const calls: string[] = [];
  const files = new Set(["/srv/clawforge/data"]);
  const contents = new Map<string, string>();
  const holder = JSON.stringify({
    operationId: "op-holder", what: "apply", by: "someone@host pid 1", takenAt: new Date().toISOString(),
  });
  const ctx = {
    settings: { dataDir: "/srv/clawforge/data", backupDir: "/srv/clawforge/backups", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        return path === "/srv/clawforge/data";
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        calls.push(`exec ${command} ${args.join(" ")}`);
        // symlinkedDataRoot()'s two questions, answered truthfully: the stub's data
        // directory is a real directory, unless this run simulates a symlinked root.
        if (command === "test" && args[0] === "-L") {
          return { code: options.symlinkedRoot === true ? 0 : 1, stdout: "", stderr: "" };
        }
        if (options.symlinkedRoot === true && command === "readlink") {
          return { code: 0, stdout: "/srv/clawforge/real-data", stderr: "" };
        }
        // listArchive() of a staging archive: content beneath the root, except when this
        // run simulates a content-free archive (what a symlinked root used to produce).
        if (command === "tar" && args.includes("-tzf")) {
          return {
            code: 0,
            stdout: options.emptyArchive === true ? "data/\n" : "data/\ndata/config/openclaw.json\n",
            stderr: "",
          };
        }
        // The lock directory itself: a plain `mkdir` (no -p) is the atomic claim takeLock
        // makes; `test -d` is how it tells "someone holds it" from "mkdir just failed".
        if (command === "mkdir" && args.length === 1) {
          const guard = args[0]?.endsWith("/operation.mutation") === true;
          return { code: guard || !lockAlreadyHeld ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") {
          const guard = args[1]?.endsWith("/operation.mutation") === true;
          return { code: !guard && lockAlreadyHeld ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-e") {
          return { code: files.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "mkdir" && args.includes("-m")) {
          files.add(args.at(-1) ?? "");
        }
        if (command === "tar") {
          const index = args.indexOf("-czf");
          const archive = args[index + 1] ?? "";
          if (index !== -1) {
            files.add(archive);
            contents.set(archive, "new archive");
          }
          if (options.tarFailure === true) throw new Error("tar failed after creating its output");
        }
        if (command === "mv") {
          const source = args.at(-2) ?? "";
          const destination = args.at(-1) ?? "";
          if (options.publishCollision === true) {
            files.add(destination);
            contents.set(destination, "old archive");
          }
          if (!files.has(destination)) {
            files.delete(source);
            files.add(destination);
            contents.set(destination, contents.get(source) ?? "");
            contents.delete(source);
          }
        }
        if (command === "rm") {
          const target = args.at(-1) ?? "";
          for (const file of files) {
            if (file === target || (args.includes("-rf") && file.startsWith(`${target}/`))) {
              files.delete(file);
              contents.delete(file);
            }
          }
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("holder.json")) return holder;
        throw new Error(`no such file: ${path}`);
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
    },
    runtime: {
      async isRunning(): Promise<boolean> { calls.push("isRunning"); return true; },
      async pause(): Promise<void> { calls.push("pause"); },
      async start(): Promise<void> { calls.push("start"); },
      async waitForHealth(): Promise<void> { calls.push("waitForHealth"); },
    },
  } as unknown as Context;
  return { ctx, calls, files, contents };
}

{
  const { ctx, calls } = stubBackupCtx(true);
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try { await createBackup(ctx, {}); } catch (error) { message = (error as Error).message; }
    },
  );
  check("backup refuses when another operation already holds the instance lock", message.includes("another operation is changing this instance"), true);
  check("a refused backup never pauses the gateway", calls.includes("pause"), false);
}

{
  const { ctx, calls } = stubBackupCtx(false);
  const archive = await withOutputSink(() => {}, () => createBackup(ctx, {}));
  check("with no competing lock, backup runs and returns the archive path", typeof archive === "string" && archive.length > 0, true);
  check("and it does pause/start the gateway around the archive", calls.includes("pause") && calls.includes("start"), true);
}

// leaveStopped is for a caller (smoke's round-trip check) about to restore right back into
// the same data directory: restarting here just to have restore stop it again a moment later
// reopens the window a paused gateway is meant to close.
{
  const { ctx, calls } = stubBackupCtx(false);
  await withOutputSink(() => {}, () => createBackup(ctx, { leaveStopped: true }));
  check("a leaveStopped backup still pauses the gateway for the snapshot", calls.includes("pause"), true);
  check("a leaveStopped backup does not restart the gateway", calls.includes("start"), false);
  check("a leaveStopped backup does not wait for health either", calls.includes("waitForHealth"), false);
}
// --- the archive a profile produces says which profile it was --------------------------------
{
  const { ctx, files } = stubBackupCtx(false);
  const archive = await withOutputSink(() => {}, () => createBackup(ctx, {}));
  // Unchanged on purpose: a backup directory written before this still reads correctly.
  check("a full backup keeps the plain name", /-\d{8}-\d{6}\.tar\.gz$/.test(archive), true);
  check("a successful backup removes its staging directory", [...files].some((path) => path.includes(".clawforge-backup-")), false);
}

// A failed tar must never expose a partial archive under the name restore/rotation discovers.
{
  const { ctx, calls, files } = stubBackupCtx(false, { tarFailure: true });
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try { await createBackup(ctx, {}); } catch (error) { message = (error as Error).message; }
    },
  );
  check("a failed tar is reported", message.includes("tar failed"), true);
  check("a failed tar leaves no archive", [...files].every((path) => !path.endsWith(".tar.gz")), true);
  check("a failed tar restarts the gateway", calls.includes("start") && calls.includes("waitForHealth"), true);
}

// A data directory that is itself a symlink used to produce a "successful" one-entry
// archive — the link, none of the data. The refusal
// must come before the gateway is ever touched.
{
  const { ctx, calls, files } = stubBackupCtx(false, { symlinkedRoot: true });
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try { await createBackup(ctx, {}); } catch (error) { message = (error as Error).message; }
    },
  );
  check("a symlinked data root is refused", message.includes("is a symlink to"), true);
  check("the refusal names the real directory the link points to", message.includes("/srv/clawforge/real-data"), true);
  check("a refused symlink-root backup never pauses the gateway", calls.includes("pause"), false);
  check("a refused symlink-root backup writes no archive", [...files].some((path) => path.endsWith(".tar.gz")), false);
}

// Defense in depth behind that refusal: tar exiting 0 and the file landing are not
// evidence the data is inside. A staging archive that holds nothing beneath its root is
// never published, and the gateway still comes back up.
{
  const { ctx, calls, files } = stubBackupCtx(false, { emptyArchive: true });
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try { await createBackup(ctx, {}); } catch (error) { message = (error as Error).message; }
    },
  );
  check("an archive with no data beneath its root is refused", message.includes("carries no data"), true);
  check("an empty-content refusal leaves no archive", [...files].every((path) => !path.endsWith(".tar.gz")), true);
  check("an empty-content refusal restarts the gateway", calls.includes("start") && calls.includes("waitForHealth"), true);
}

// Publication refuses a same-name collision and leaves the existing archive untouched.
{
  const { ctx, calls, files, contents } = stubBackupCtx(false, { publishCollision: true });
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try { await createBackup(ctx, {}); } catch (error) { message = (error as Error).message; }
    },
  );
  check("a backup filename collision is reported", message.includes("backup path already exists"), true);
  check("a collision leaves one existing archive", [...files].filter((path) => path.endsWith(".tar.gz")).length, 1);
  check("a collision preserves the existing archive", [...contents.values()].filter((value) => value === "old archive").length, 1);
  check("a publication failure restarts the gateway", calls.includes("start") && calls.includes("waitForHealth"), true);
}
// --- Recipe stacks without quiesce support block a consistent backup. ------------------
//
// A running stack without quiesce/resume blocks backup; a stopped stack stays quiet.

{
  const recipes = await mkdtemp(join(tmpdir(), "clawforge-backup-recipe-check-"));
  try {
    await mkdir(resolve(recipes, "vault"), { recursive: true });
    await writeFile(resolve(recipes, "vault", "recipe.json"), JSON.stringify({ description: "sidecar under the data directory" }), "utf8");
    const probed: string[] = [];
    const ctxWithStack = (running: boolean): Context => {
      const { ctx } = stubBackupCtx(false);
      (ctx as unknown as { runtime: { stack: unknown } }).runtime.stack = (project: string) => {
        probed.push(project);
        return { async isRunning(): Promise<boolean> { return running; } };
      };
      return ctx;
    };

    let output = "";
    let refusal = "";
    useRecipesDir(recipes);
    try {
      await withOutputSink((line) => { output += line; }, async () => {
        try { await createBackup(ctxWithStack(true), {}); }
        catch (error) { refusal = (error as Error).message; }
      });
      check("a running recipe without quiesce hooks blocks backup", refusal.includes("could not be quiesced"), true);
      check("the refusal names the uncovered stack", refusal.includes("vault"), true);
    } finally {
      clearRecipesDir();
    }

    output = "";
    probed.length = 0;
    useRecipesDir(recipes);
    try {
      await withOutputSink((line) => { output += line; }, () => createBackup(ctxWithStack(false), {}));
    } finally {
      clearRecipesDir();
    }
    check("a stopped recipe stack draws no warning", output.includes("recipe stack"), false);
    check("a stopped stack is still probed, not skipped", probed.length, 1);
  } finally {
    await rm(recipes, { recursive: true, force: true });
  }
}


// --- declared = accepted (moved from the shared parse registry once backup became a body) ---
// R29-04: every action's derived slice is exactly what its own parser accepts. The parser IS
// the declaration now, so this is a syntactic re-proof over the body's own arguments.

{
  const shape = specShape(specOf(openclawCommands.backup)!);
  for (const [action, data] of Object.entries(shape.actions!)) {
    const slice = data.arguments ?? [];
    for (const argument of slice) {
      if (argument.kind !== "flag" && argument.kind !== "option") continue;
      const tokens = argument.kind === "option" ? [`--${argument.name}`, "x"] : [`--${argument.name}`];
      let error: unknown;
      try { parseDeclaredArgs(slice, tokens); } catch (caught) { error = caught; }
      check(`backup ${action} accepts its declared --${argument.name}`, error, undefined);
    }
  }
}


// --- --native with a non-full profile is a prepare refusal ---------------------------------
// The refusal needs only the arguments, so the pipeline lands it at prepare — before
// requireBootstrapped and the instance lock (which the create path takes inside
// createBackup). A recording transport proves nothing was contacted.

{
  const app: AppDefinition = { name: "backup-fixture", description: "fixture", commands: { backup: openclawCommands.backup } };
  const contacts: string[] = [];
  const transport = {
    description: "stub",
    exec(...rest: unknown[]): never { contacts.push(String(rest[0])); throw new Error("unreachable"); },
    exists(): never { contacts.push("exists"); throw new Error("unreachable"); },
    readFile(): never { contacts.push("readFile"); throw new Error("unreachable"); },
  } as unknown as Transport;

  for (const argv of [["--native", "--profile", "share"], ["--native", "--migrate"], ["create", "--native", "--share"]]) {
    const execution = await executeCommand(app, "backup", [...argv], { surface: "terminal", transport });
    check(`backup ${argv.join(" ")} stops at the prepare stage`, execution.stage, "prepare");
    checkTrue(`backup ${argv.join(" ")} is an ArgumentError naming --native`, execution.error instanceof ArgumentError
      && (execution.error as ArgumentError).argument === "native");
    check(`backup ${argv.join(" ")} never contacts the target`, contacts, []);
    contacts.length = 0;
  }
}


finish("backup");
