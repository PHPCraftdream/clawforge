// Backup rotation, locking, archive publication and restore checks.

import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { archiveCarriesContent, createArchive, listArchive } from "#framework/service/archive.ts";
import { restoreArchive } from "#framework/commands/lifecycle/restore.ts";
import { rotate, createBackup } from "#framework/commands/lifecycle/backup.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { UserError } from "#framework/core/log.ts";
import type { Context } from "#framework/core/context.ts";
import { LocalTransport, WslTransport, spawnLocal, type Transport, type ExecResult } from "#framework/runtime/transport.ts";
import { DATA_DIR_MARKER, ensureDataDirs } from "#framework/runtime/datadir.ts";
import { parseWslDistroListing } from "#framework/commands/interface/host/contexts.ts";
import { clearRecipesDir, projectName, useRecipesDir } from "#framework/service/recipe.ts";

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

useDeployment(resolve(monorepoRoot, "apps", "example app"));

{
  const name = deploymentName();
  const backupDir = "/srv/openclaw/backups";

  // 12 backups, newest first — as rotation orders `find` output — with OC_BACKUP_KEEP=10, so
  // 2 are stale. Only the oldest of those two should be removed by a single rotate() call.
  // Real stamps: rotation reads the profile out of the name now, and a name that is not one
  // this framework writes is not its archive to delete.
  const listing = Array.from(
    { length: 12 },
    (_, i) => `${backupDir}/${name}-202601${String(12 - i).padStart(2, "0")}-000000.tar.gz`,
  );

  const execCalls: { command: string; args: string[] }[] = [];
  const ctx = {
    settings: { env: { OC_BACKUP_KEEP: "10" } },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push({ command, args });
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        if (command === "find" && args.includes("-printf")) {
          return { code: 0, stdout: listing.map((path, index) => `${listing.length - index}\t${path}`).join("\n") + "\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  await withOutputSink(
    () => {},
    () => rotate(ctx, backupDir),
  );

  const rmCalls = execCalls.filter((call) => call.command === "rm");
  check("exactly one rm call", rmCalls.length, 1);

  const oldest = listing[listing.length - 1];
  const secondOldest = listing[listing.length - 2];
  check("the single oldest archive is targeted", rmCalls[0]?.args.includes(oldest), true);
  check(
    "the second-oldest (also stale, but not the very oldest) is left for next time",
    rmCalls[0]?.args.includes(secondOldest),
    false,
  );
  check("nothing kept within the retention count is targeted", rmCalls[0]?.args.includes(listing[0]), false);
}

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
// reopens the window a paused gateway is meant to close (audit 2026-09-23, P1-02).
{
  const { ctx, calls } = stubBackupCtx(false);
  await withOutputSink(() => {}, () => createBackup(ctx, { leaveStopped: true }));
  check("a leaveStopped backup still pauses the gateway for the snapshot", calls.includes("pause"), true);
  check("a leaveStopped backup does not restart the gateway", calls.includes("start"), false);
  check("a leaveStopped backup does not wait for health either", calls.includes("waitForHealth"), false);
}

// --- retention counts each profile on its own -----------------------------------------------
//
// `pull` writes migrate and share archives into the same directory `backup` writes full ones
// into. Counted together against OC_BACKUP_KEEP, a week of pulls rotated away every full
// backup the instance had — the archives an operator would actually restore from.

function rotationContext(
  listing: string[],
  keep: string,
): { ctx: Context; execCalls: { command: string; args: string[] }[] } {
  const execCalls: { command: string; args: string[] }[] = [];
  const ctx = {
    settings: { env: { OC_BACKUP_KEEP: keep } },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push({ command, args });
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        if (command === "find" && args.includes("-printf")) {
          return { code: 0, stdout: listing.map((path, index) => `${listing.length - index}\t${path}`).join("\n") + "\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  return { ctx, execCalls };
}

{
  const name = deploymentName();
  const backupDir = "/srv/openclaw/backups";
  const full = `${backupDir}/${name}-20260101-000000.tar.gz`;
  // Three share snapshots, all newer than the one full backup, with keep = 2.
  const listing = [
    `${backupDir}/${name}-20260104-000000-share.tar.gz`,
    `${backupDir}/${name}-20260103-000000-share.tar.gz`,
    `${backupDir}/${name}-20260102-000000-share.tar.gz`,
    full,
  ];

  const { ctx, execCalls } = rotationContext(listing, "2");
  await withOutputSink(() => {}, () => rotate(ctx, backupDir));

  const rmCalls = execCalls.filter((call) => call.command === "rm");
  check("share snapshots do not push a full backup out of retention", rmCalls[0]?.args.includes(full), false);
  check("the oldest excess share snapshot goes instead", rmCalls[0]?.args.includes(`${backupDir}/${name}-20260102-000000-share.tar.gz`), true);
}

{
  const name = deploymentName();
  const backupDir = "/srv/openclaw/backups";
  // A sibling deployment sharing the directory: `ls <name>-*.tar.gz` matches its archives
  // too, and rotating them away deletes backups this deployment never made.
  const sibling = `${backupDir}/${name}-staging-20260101-000000.tar.gz`;
  const listing = [
    `${backupDir}/${name}-20260104-000000.tar.gz`,
    `${backupDir}/${name}-20260103-000000.tar.gz`,
    sibling,
  ];

  const { ctx, execCalls } = rotationContext(listing, "1");
  await withOutputSink(() => {}, () => rotate(ctx, backupDir));

  const rmCalls = execCalls.filter((call) => call.command === "rm");
  check("a sibling deployment's archive is never rotated away", rmCalls[0]?.args.includes(sibling), false);
  check("this deployment's own excess archive is", rmCalls[0]?.args.includes(`${backupDir}/${name}-20260103-000000.tar.gz`), true);
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
// archive — the link, none of the data (audit 2026-09-22 round 2, P2-02). The refusal
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

// --- P2-02 (audit 2026-09-22 round 2): a symlinked data root, end to end on a real filesystem.
//
// createBackup() used to hand tar the link's own name and report success: the archive held
// exactly one entry — the link — and none of the data. Every scenario here is the real
// thing: a real GNU tar archive, a real symlink, a real transport (local off Windows, a WSL
// distribution on it). A simulated tar cannot reproduce this class of bug. No instance and
// no gateway: the runtime stub fails loudly if the gateway is ever asked to start.

/** A real POSIX filesystem with real symlinks and real GNU tar: this machine off Windows,
 *  a WSL distribution on it. Where neither exists the group is skipped, loudly. */
async function realPosixTransport(): Promise<Transport | undefined> {
  if (process.platform !== "win32") return new LocalTransport();
  try {
    const listing = await spawnLocal("wsl.exe", ["--list", "--quiet"], { allowFailure: true, timeoutMs: 30_000 });
    for (const distro of parseWslDistroListing(listing.stdout).slice(0, 2)) {
      const candidate = new WslTransport(distro);
      const shell = await candidate
        .exec("sh", ["-c", "true"], { allowFailure: true, timeoutMs: 30_000 })
        .then((result) => result.code === 0, () => false);
      if (shell) return candidate;
    }
  } catch {
    // wsl.exe missing or unlaunchable — reported as the skip below.
  }
  return undefined;
}

const backupRuntime = {
  async isRunning(): Promise<boolean> { return false; },
  async pause(): Promise<void> {},
  async start(): Promise<void> { throw new Error("the gateway must never start from these backups"); },
  async waitForHealth(): Promise<void> {},
};

const restoreRuntime = {
  async isRunning(): Promise<boolean> { return false; },
  async stop(): Promise<void> {},
  async start(): Promise<void> { throw new Error("the gateway must never start from these restores"); },
  async waitForHealth(): Promise<void> {},
};

async function code0(transport: Transport, command: string, args: string[]): Promise<boolean> {
  return (await transport.exec(command, args, { allowFailure: true })).code === 0;
}

async function attemptBackup(
  transport: Transport,
  dataDir: string,
  backupDir: string,
): Promise<{ refused: boolean; user: boolean; message: string; archive: string }> {
  const ctx = { settings: { dataDir, backupDir, env: {} }, transport, runtime: backupRuntime } as unknown as Context;
  try {
    const archive = await withOutputSink(() => {}, () => createBackup(ctx, {}));
    return { refused: false, user: false, message: "", archive };
  } catch (error) {
    return {
      refused: true,
      user: error instanceof UserError,
      message: error instanceof Error ? error.message : String(error),
      archive: "",
    };
  }
}

const p202Transport = await realPosixTransport();

// GNU tar treats brackets in the root basename as glob syntax unless the root part of every
// exclude is escaped. Exercise both public profiles through createBackup, including the
// privacy verifier that must approve the staging archive before it is published.
if (p202Transport !== undefined) {
  for (const profile of ["migrate", "share"] as const) {
    const root = `/tmp/clawforge-backup-glob-${randomBytes(4).toString("hex")}`;
    const dataDir = `${root}/data[1]`;
    const backupDir = `${root}/backups`;
    try {
      await p202Transport.mkdirp(`${dataDir}/config/logs`);
      await p202Transport.mkdirp(`${dataDir}/workspace`);
      await p202Transport.writeFile(`${dataDir}/config/openclaw.json`, "{}\n");
      await p202Transport.writeFile(`${dataDir}/config/.env`, "PROVIDER_KEY=synthetic-backup-secret-value\n");
      await p202Transport.writeFile(`${dataDir}/config/logs/fixture.log`, "synthetic log\n");
      await p202Transport.writeFile(`${dataDir}/workspace/SOUL.md`, "fixture\n");
      await p202Transport.writeFile(`${dataDir}/config/openclaw.json.bak-old`, "synthetic backup\n");
      const ctx = {
        settings: { dataDir, backupDir, env: { OC_BACKUP_KEEP: "10" } },
        transport: p202Transport,
        runtime: backupRuntime,
      } as unknown as Context;
      const archive = await withOutputSink(() => {}, () => createBackup(ctx, { profile }));
      const entries = await listArchive(ctx, archive);
      check(`real tar ${profile} excludes provider env below data[1]`, entries.some((entry) => entry.includes(".env")), false);
      check(`real tar ${profile} excludes log files below data[1]`, entries.some((entry) => entry.includes("/logs/")), false);
      check(`real tar ${profile} excludes backup config below data[1]`, entries.some((entry) => entry.endsWith("openclaw.json.bak-old")), false);
      check(`real tar ${profile} keeps allowed workspace content`, entries.some((entry) => entry.endsWith("workspace/SOUL.md")), true);
    } catch (error) {
      check(`real tar ${profile} policy-checked backup succeeds`, (error as Error).message, "");
    } finally {
      await p202Transport.remove(root).catch(() => {});
    }
  }
}

if (p202Transport === undefined) {
  check("backup symlink-root checks (skipped: no local POSIX filesystem and no WSL distribution with a shell)", "skip", "skip");
} else {
  // The auditor's repro: a non-empty data root that is itself a symlink. Backup must
  // refuse before anything misleading is written, and the data behind the link stays put.
  {
    const root = `/tmp/clawforge-backup-root-link-${randomBytes(4).toString("hex")}`;
    try {
      await p202Transport.mkdirp(`${root}/data2/config`);
      await p202Transport.mkdirp(`${root}/data2/workspace`);
      await p202Transport.writeFile(`${root}/data2/config/openclaw.json`, '{"provider":{}}\n');
      await p202Transport.writeFile(`${root}/data2/workspace/SOUL.md`, "fixture\n");
      await p202Transport.exec("ln", ["-s", "data2", `${root}/datalink`]);

      const outcome = await attemptBackup(p202Transport, `${root}/datalink`, `${root}/backups`);
      check("a backup over a symlinked data root is refused", outcome.refused, true);
      check("the refusal is a deliberate one (a UserError)", outcome.user, true);
      check("the refusal names the target the link points at", outcome.message.includes(`${root}/data2`), true);
      const stray = await p202Transport.exec(
        "sh",
        ["-c", "find \"$1\" -name '*.tar.gz' 2>/dev/null", "sh", root],
        { allowFailure: true },
      );
      check("the refused backup leaves no archive anywhere below the root", stray.stdout.trim(), "");
      check(
        "the data behind the link is untouched",
        await code0(p202Transport, "test", ["-f", `${root}/data2/config/openclaw.json`]),
        true,
      );
    } finally {
      await p202Transport.remove(root).catch(() => {});
    }
  }

  // createArchive() refuses the same layout on its own — the invariant lives at the point
  // of archiving too, for every caller that is not createBackup().
  {
    const root = `/tmp/clawforge-backup-archive-link-${randomBytes(4).toString("hex")}`;
    try {
      await p202Transport.mkdirp(`${root}/data2/config`);
      await p202Transport.writeFile(`${root}/data2/config/openclaw.json`, '{"provider":{}}\n');
      await p202Transport.exec("ln", ["-s", "data2", `${root}/datalink`]);
      const archive = `${root}/direct.tar.gz`;
      const ctx = { settings: { dataDir: `${root}/datalink`, env: {} }, transport: p202Transport } as unknown as Context;
      let message = "";
      await withOutputSink(() => {}, async () => {
        try { await createArchive(ctx, { archive, profile: "full" }); } catch (error) { message = (error as Error).message; }
      });
      check("createArchive refuses a symlinked data root", message.includes("refusing to archive"), true);
      check("createArchive wrote nothing", await code0(p202Transport, "test", ["-e", archive]), false);
    } finally {
      await p202Transport.remove(root).catch(() => {});
    }
  }

  // The shape the content check exists for, from real tar: an archive of an empty data
  // directory holds nothing beneath its root, and archiveCarriesContent() reads it as
  // exactly that — so createBackup refuses the same shape and publishes nothing. The
  // instance lock lives in a <name>-locks sibling, so it cannot seed the tree with content.
  {
    const root = `/tmp/clawforge-backup-empty-${randomBytes(4).toString("hex")}`;
    try {
      await p202Transport.mkdirp(`${root}/empty-data`);
      const emptyArchive = `${root}/empty.tar.gz`;
      const emptyCtx = { settings: { dataDir: `${root}/empty-data`, env: {} }, transport: p202Transport } as unknown as Context;
      await withOutputSink(() => {}, () => createArchive(emptyCtx, { archive: emptyArchive, profile: "full" }));
      const emptyListing = await listArchive(emptyCtx, emptyArchive);
      check("a real bare-root archive holds only the root entry", emptyListing.length, 1);
      check("archiveCarriesContent reads the bare-root shape as content-free", archiveCarriesContent(emptyListing), false);

      const outcome = await attemptBackup(p202Transport, `${root}/empty-data`, `${root}/backups`);
      check("a backup of an empty data root is refused as content-free", outcome.message.includes("carries no data"), true);
      const leftovers = await p202Transport.exec("ls", ["-1", `${root}/backups`], { allowFailure: true });
      check("the content-free backup published no archive", leftovers.stdout.trim(), "");
    } finally {
      await p202Transport.remove(root).catch(() => {});
    }
  }

  // The guard is not a ban on backing up: a real data directory still round-trips —
  // backup produces an archive that carries the data, and restore recovers it.
  {
    const root = `/tmp/clawforge-backup-roundtrip-${randomBytes(4).toString("hex")}`;
    try {
      const dataDir = `${root}/data`;
      await p202Transport.mkdirp(`${dataDir}/config`);
      await p202Transport.mkdirp(`${dataDir}/workspace`);
      await p202Transport.writeFile(`${dataDir}/config/openclaw.json`, '{"provider":{}}\n');
      await p202Transport.writeFile(`${dataDir}/workspace/SOUL.md`, "fixture\n");
      // The provenance marker a clawforge-created tree carries (P1-09): it travels with the
      // archive, so the restore's ensureDataDirs sees a tree of this framework's own making
      // and may narrow its ownership work to the standard paths instead of refusing a tree
      // it cannot vouch for.
      await p202Transport.writeFile(`${dataDir}/${DATA_DIR_MARKER}`, "clawforge data directory\n");

      const outcome = await attemptBackup(p202Transport, dataDir, `${root}/backups`);
      check("a backup over a real data directory still succeeds", outcome.refused, false);
      const ctx = { settings: { dataDir, env: {} }, transport: p202Transport } as unknown as Context;
      const entries = await listArchive(ctx, outcome.archive);
      check("the published archive carries content beneath its root", archiveCarriesContent(entries), true);
      check(
        "the published archive carries the config",
        entries.some((entry) => entry.replace(/^\.\//, "").includes("config/openclaw.json")),
        true,
      );

      const restoredData = `${root}/restored/data`;
      await withOutputSink(() => {}, async () => {
        await restoreArchive(
          { settings: { dataDir: restoredData, env: {} }, transport: p202Transport, runtime: restoreRuntime } as unknown as Context,
          outcome.archive,
          { force: true, noStart: true },
        );
      });
      check("the restored tree holds the config", await code0(p202Transport, "test", ["-f", `${restoredData}/config/openclaw.json`]), true);
      check("the restored tree holds the workspace", await code0(p202Transport, "test", ["-f", `${restoredData}/workspace/SOUL.md`]), true);
    } finally {
      await p202Transport.remove(root).catch(() => {});
    }
  }

  // ensureDataDirs' chown escalation must not be decided from directory writability alone
  // (audit 2026-09-23, XS round 4): a CI runner whose own uid is not 1000 owns its /tmp
  // fixtures outright — `test -w` says yes — but POSIX still refuses an unprivileged
  // `chown 1000:1000` on a file that uid does not already own, exactly the shape that made
  // this round-trip fail for real on GitHub Actions (runner uid 1001, not 1000). P1-09 pins
  // the shape of the escalation too: one chown naming exactly the paths this run created,
  // never -R — the blanket recursive chown of whatever pre-existed is the bug this round
  // removes.
  {
    const dataDir = "/srv/owner-check/data";
    const calls: { command: string; args: string[] }[] = [];
    const ownerStub = {
      description: "stub",
      async exists(): Promise<boolean> { return false; },
      async writeFile(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        calls.push({ command, args });
        if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
        // Not a symlink — ensureDataDirs' root guard (P1-01) checks this before anything
        // else, and the default "everything else succeeds" fallback below would otherwise
        // misread it as one.
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        // The canonical-ancestry check (P1-09) resolves through the ancestors; nothing here
        // is a link, so every path resolves to itself.
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: `${args[1] ?? ""}\n`, stderr: "" };
        if (command === "id" && args[0] === "-u") return { code: 0, stdout: "1001\n", stderr: "" };
        if (command === "id" && args[0] === "-g") return { code: 0, stdout: "1001\n", stderr: "" };
        if (command === "stat" && args[0] === "-c" && args[1] === "%u:%g") return { code: 0, stdout: "1001:1001\n", stderr: "" };
        if (command === "stat" && args[0] === "-c" && args[1] === "%a") return { code: 0, stdout: "755\n", stderr: "" };
        if (command === "sh" && args.some((arg) => arg.includes("command -v sudo"))) return { code: 0, stdout: "/usr/bin/sudo\n", stderr: "" };
        if (command === "sudo" && args[0] === "-n" && args[1] === "true") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    } as unknown as Transport;
    await ensureDataDirs({ settings: { dataDir, env: {} }, transport: ownerStub } as unknown as Context);
    const chownCalls = calls.filter((call) => call.command === "sudo" && call.args.includes("chown"));
    check("a directory-writable-but-wrong-owner target still escalates the chown", chownCalls.length, 1);
    check("the escalated call still carries the real chown", chownCalls[0]?.args.includes("chown"), true);
    check("the fixed owner travels unchanged", chownCalls[0]?.args.includes("1000:1000"), true);
    check("the ownership change is never recursive", calls.some((call) => call.args.includes("-R")), false);
    check(
      "exactly the paths this run created are named, nothing else",
      JSON.stringify(chownCalls[0]?.args.slice(chownCalls[0]!.args.indexOf("1000:1000") + 1)),
      JSON.stringify([dataDir, `${dataDir}/config`, `${dataDir}/workspace`, `${dataDir}/auth-secrets`]),
    );
    check("no unprivileged chown is attempted either", calls.some((call) => call.command === "chown"), false);
  }
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
      // check() compares with ===: two array instances are never equal, so compare the
      // JSON forms — the project names themselves, not the containers holding them.
      check("the probe went to the recipe's own compose project", JSON.stringify(probed), JSON.stringify([projectName(deploymentName(), "vault")]));
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

process.stderr.write(failed === 0 ? "all backup checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
