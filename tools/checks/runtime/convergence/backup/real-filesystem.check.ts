// Backup against a real POSIX filesystem: bracketed data roots under real GNU tar, a symlinked
// data root refused end to end, the content-free-archive guard, a backup/restore round trip, and
// ensureDataDirs' chown escalation. Skipped, loudly, where neither Linux nor a WSL distribution
// with a shell exists.

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { archiveCarriesContent, createArchive, listArchive } from "#framework/service/archive/index.ts";
import { restoreArchive } from "#framework/commands/lifecycle/restore/index.ts";
import { createBackup } from "#framework/commands/lifecycle/backup/index.ts";
import { useDeployment, useComposeProjectOverride } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { UserError } from "#framework/core/io/log.ts";
import type { Context } from "#framework/core/context.ts";
import { LocalTransport, WslTransport, spawnLocal, type Transport, type ExecResult } from "#framework/runtime/transport/transport.ts";
import { DATA_DIR_MARKER, ensureDataDirs } from "#framework/runtime/datadir.ts";
import { parseWslDistroListing } from "#framework/commands/interface/host/contexts.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";
useDeployment(resolve(monorepoRoot, "apps", "example app"));
useComposeProjectOverride("example-app");
// --- a symlinked data root, end to end on a real filesystem. -----------------------------------
//
// createBackup() used to hand tar the link's own name and report success: the archive held
// exactly one entry — the link — and none of the data. Every scenario here is the real
// thing: a real GNU tar archive, a real symlink, a real transport (local on Linux, a WSL
// distribution on it). A simulated tar cannot reproduce this class of bug. No instance and
// no gateway: the runtime stub fails loudly if the gateway is ever asked to start.

/** A real POSIX filesystem with real symlinks and real GNU tar: this machine on Linux,
 *  a WSL distribution on it. Where neither exists the group is skipped, loudly. */
async function realPosixTransport(): Promise<Transport | undefined> {
  if (process.platform === "linux") return new LocalTransport();
  if (process.platform !== "win32") return undefined;
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

// exclude is escaped. Exercise both public profiles through createBackup, including the
// privacy verifier that must approve the staging archive before it is published.
await requires("local-posix", "real tar excludes provider env, logs and backup config below a bracketed data root", async () => {
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
});

await requires("local-posix", "backup symlink-root checks over a real POSIX filesystem", async () => {
if (p202Transport === undefined) {
  // requires() already held local-posix: a probe that disagrees is a failure, never a skip.
  check("backup symlink-root checks: local-posix holds, so a POSIX transport must answer", "none", "a POSIX transport");
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
      // The provenance marker a clawforge-created tree carries: it travels with the
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

  // ensureDataDirs' chown escalation must not be decided from directory writability alone:
  // a CI runner whose own uid is not 1000 owns its /tmp fixtures outright — `test -w` says
  // yes — but POSIX still refuses an unprivileged `chown 1000:1000` on a file that uid does
  // not already own, exactly the shape that made this round-trip fail for real on GitHub
  // Actions (runner uid 1001, not 1000). The escalation's shape matters too: one chown naming
  // exactly the paths this run created, never -R — a blanket recursive chown of whatever
  // pre-existed would be a bug.
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
        // Not a symlink — ensureDataDirs' root guard checks this before anything
        // else, and the default "everything else succeeds" fallback below would otherwise
        // misread it as one.
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        // The canonical-ancestry check resolves through the ancestors; nothing here
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
      chownCalls[0]?.args.slice(chownCalls[0]!.args.indexOf("1000:1000") + 1),
      [dataDir, `${dataDir}/config`, `${dataDir}/workspace`, `${dataDir}/auth-secrets`],
    );
    check("no unprivileged chown is attempted either", calls.some((call) => call.command === "chown"), false);
  }
}
});

finish("backup real filesystem");
