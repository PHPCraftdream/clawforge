// Real tar profile checks and backup rotation failure semantics.

import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { access, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { rotate, createBackup } from "#framework/commands/lifecycle/backup/index.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { LocalTransport, WslTransport, spawnLocal, type Transport } from "#framework/runtime/transport/transport.ts";
import { parseWslDistroListing } from "#framework/commands/interface/host/contexts.ts";
import { listArchive } from "#framework/service/archive/index.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(`  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`);
}

useDeployment(resolve(monorepoRoot, "apps", "example app"));

for (const failure of ["find", "rm"] as const) {
  const backupDir = "/srv/clawforge/backup-policy-check";
  const own = `${backupDir}/${deploymentName()}-20260101-000000.tar.gz`;
  const calls: string[] = [];
  const ctx = {
    settings: { env: { OC_BACKUP_KEEP: "1" } },
    transport: {
      async exists(): Promise<boolean> { return true; },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        calls.push(command);
        if (failure === "find" && command === "find") return { code: 255, stdout: "", stderr: "private path and secret" };
        if (failure === "rm" && command === "find") {
          return { code: 0, stdout: `2\t${backupDir}/${deploymentName()}-20260102-000000.tar.gz\n1\t${own}\n`, stderr: "" };
        }
        if (failure === "rm" && command === "rm") return { code: 1, stdout: "", stderr: "private path and secret" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  let message = "";
  try { await rotate(ctx, backupDir); } catch (error) { message = (error as Error).message; }
  check(`rotation ${failure} failure is reported`, message.includes(`backup rotation could not ${failure === "find" ? "list archives" : "remove stale archive"}`), true);
  check(`rotation ${failure} failure hides command details`, message.includes("private path"), false);
  if (failure === "find") check("listing failure never attempts deletion", calls.includes("rm"), false);
}

{
  const calls: string[] = [];
  const ctx = {
    settings: { env: { OC_BACKUP_KEEP: "1" } },
    transport: {
      async exists(): Promise<boolean> { return true; },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        calls.push(command);
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  await rotate(ctx, "/srv/clawforge/backup-policy-check");
  check("a successful empty listing is distinct from an enumeration failure", calls.includes("rm"), false);
}

// OC_BACKUP_KEEP parsing must never silently turn rotation off: a typo/empty/negative value
// still rotates (fallback to the default), only "0" is a deliberate no-op, and both are said
// out loud rather than swallowed by a NaN/<=0 check.
for (const testCase of [
  { value: "ten", proceeds: true, invalid: true },
  { value: "", proceeds: true, invalid: true },
  { value: "-3", proceeds: true, invalid: true },
  { value: "10x", proceeds: true, invalid: true },
  { value: "0", proceeds: false, invalid: false },
  { value: "3", proceeds: true, invalid: false },
] as const) {
  const calls: string[] = [];
  const ctx = {
    settings: { env: { OC_BACKUP_KEEP: testCase.value } },
    transport: {
      async exists(): Promise<boolean> { return true; },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        calls.push(command);
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  let output = "";
  await withOutputSink((line) => { output += line; }, () => rotate(ctx, "/srv/clawforge/backup-policy-check"));

  check(`OC_BACKUP_KEEP=${JSON.stringify(testCase.value)} ${testCase.proceeds ? "still lists archives" : "never lists archives"}`, calls.includes("find"), testCase.proceeds);
  if (testCase.invalid) {
    check(`OC_BACKUP_KEEP=${JSON.stringify(testCase.value)} is reported as a warning naming the variable and value`, output.includes(`OC_BACKUP_KEEP=${JSON.stringify(testCase.value)}`), true);
  } else if (testCase.value === "0") {
    check("OC_BACKUP_KEEP=0 is reported as an explicit no-op, not silence", output.includes("OC_BACKUP_KEEP=0"), true);
  }
}

// Passing a path with shell metacharacters as a literal find argument must not execute it.
if (process.platform !== "win32") {
  const root = await mkdtemp(join(tmpdir(), "clawforge-backup-quote-check-"));
  const marker = join(root, "shell-injected");
  const backupDir = join(root, `backup files '$(touch ${marker})' ; echo hacked`);
  try {
    await mkdir(backupDir, { recursive: true });
    const oldArchive = join(backupDir, `${deploymentName()}-20260101-000000.tar.gz`);
    const newArchive = join(backupDir, `${deploymentName()}-20260102-000000.tar.gz`);
    await writeFile(oldArchive, "old");
    await writeFile(newArchive, "new");
    await utimes(oldArchive, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await utimes(newArchive, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    const ctx = {
      settings: { env: { OC_BACKUP_KEEP: "1" } },
      transport: new LocalTransport(),
    } as unknown as Context;
    await withOutputSink(() => {}, () => rotate(ctx, backupDir));
    let newPresent = true;
    try { await access(newArchive); } catch { newPresent = false; }
    let oldPresent = true;
    try { await access(oldArchive); } catch { oldPresent = false; }
    let markerPresent = true;
    try { await access(marker); } catch { markerPresent = false; }
    check("rotation finds archives below a quoted path", oldPresent, false);
    check("rotation keeps the newest archive below that path", newPresent, true);
    check("rotation does not execute path metacharacters", markerPresent, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function posixTransport(): Promise<Transport | undefined> {
  if (process.platform !== "win32") return new LocalTransport();
  try {
    const listing = await spawnLocal("wsl.exe", ["--list", "--quiet"], { allowFailure: true, timeoutMs: 30_000 });
    for (const distro of parseWslDistroListing(listing.stdout).slice(0, 2)) {
      const candidate = new WslTransport(distro);
      const shell = await candidate.exec("sh", ["-c", "true"], { allowFailure: true, timeoutMs: 30_000 })
        .then((result) => result.code === 0, () => false);
      if (shell) return candidate;
    }
  } catch {
    // WSL is optional on Windows development machines.
  }
  return undefined;
}

const transport = await posixTransport();
if (transport === undefined) {
  check("real GNU tar profiles (skipped: no POSIX shell or WSL)", "skip", "skip");
} else {
  const runtime = {
    async isRunning(): Promise<boolean> { return false; },
    async pause(): Promise<void> {},
    async start(): Promise<void> { throw new Error("backup fixture must not start a runtime"); },
    async waitForHealth(): Promise<void> {},
  };
  for (const profile of ["migrate", "share"] as const) {
    const root = `/tmp/clawforge-backup-glob-${randomBytes(4).toString("hex")}`;
    const dataDir = `${root}/data[1]`;
    const backupDir = `${root}/backups`;
    try {
      await transport.mkdirp(`${dataDir}/config/logs`);
      await transport.mkdirp(`${dataDir}/workspace`);
      await transport.writeFile(`${dataDir}/config/openclaw.json`, "{}\n");
      await transport.writeFile(`${dataDir}/config/.env`, "PROVIDER_KEY=synthetic-backup-secret-value\n");
      await transport.writeFile(`${dataDir}/config/logs/fixture.log`, "synthetic log\n");
      await transport.writeFile(`${dataDir}/workspace/SOUL.md`, "fixture\n");
      await transport.writeFile(`${dataDir}/config/openclaw.json.bak-old`, "synthetic backup\n");
      const ctx = {
        settings: { dataDir, backupDir, env: { OC_BACKUP_KEEP: "10" } },
        transport,
        runtime,
      } as unknown as Context;
      const archive = await withOutputSink(() => {}, () => createBackup(ctx, { profile }));
      const entries = await listArchive(ctx, archive);
      check(`real tar ${profile} backup passes policy before publication`, archive.endsWith(`-${profile}.tar.gz`), true);
      check(`real tar ${profile} excludes provider env under data[1]`, entries.some((entry) => entry.includes(".env")), false);
      check(`real tar ${profile} excludes logs under data[1]`, entries.some((entry) => entry.includes("/logs/")), false);
      check(`real tar ${profile} excludes config backups under data[1]`, entries.some((entry) => entry.endsWith("openclaw.json.bak-old")), false);
      check(`real tar ${profile} keeps allowed workspace content`, entries.some((entry) => entry.endsWith("workspace/SOUL.md")), true);
    } catch (error) {
      check(`real tar ${profile} policy-checked backup succeeds`, (error as Error).message, "");
    } finally {
      await transport.remove(root).catch(() => {});
    }
  }
}

process.stderr.write(failed === 0 ? "all backup policy checks passed\n" : `${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
