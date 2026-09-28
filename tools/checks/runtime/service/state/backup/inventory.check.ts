// service/archive/inventory.ts: listBackupArchives/listReplacedCopies parse what `find`
// reports (name, size, timestamp, profile), exclude what is not this deployment's own, sort
// newest first; defaultRestoreArchive picks the same archive restore's own newestArchive()
// would; replacedCopyName/parseReplacedCopyName round-trip and reject anything else. All
// hermetic — a stub transport models `find`/`du`, no real target.

import { resolve } from "node:path";
import {
  listBackupArchives, listReplacedCopies, defaultRestoreArchive,
  replacedCopyName, parseReplacedCopyName, type BackupArchiveInfo,
} from "#framework/service/archive/index.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(`  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`);
}

useDeployment(resolve(monorepoRoot, "apps", "example app"));
const NAME = deploymentName();
const BACKUP_DIR = "/srv/openclaw/backups";
const DATA_DIR = "/srv/openclaw/data";

function stubContext(execImpl: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>): Context {
  return {
    settings: { backupDir: BACKUP_DIR, dataDir: DATA_DIR },
    transport: {
      async exists(): Promise<boolean> { return true; },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        return execImpl(command, args);
      },
    },
  } as unknown as Context;
}

// --- listBackupArchives ------------------------------------------------------------------

{
  const full = `${BACKUP_DIR}/${NAME}-20260103-000000.tar.gz`;
  const migrate = `${BACKUP_DIR}/${NAME}-20260102-000000-migrate.tar.gz`;
  const share = `${BACKUP_DIR}/${NAME}-20260101-000000-share.tar.gz`;
  const sibling = `${BACKUP_DIR}/${NAME}-staging-20260104-000000.tar.gz`;
  const ctx = stubContext(async (command) => {
    if (command !== "find") return { code: 0, stdout: "", stderr: "" };
    return {
      code: 0,
      stdout: [
        `100\t1767398400\t${full}`, // 2026-01-03T00:00:00Z
        `50\t1767312000\t${migrate}`, // 2026-01-02T00:00:00Z
        `10\t1767225600\t${share}`, // 2026-01-01T00:00:00Z
        `999\t1767484800\t${sibling}`, // 2026-01-04T00:00:00Z, newer than all — but not ours
      ].join("\n"),
      stderr: "",
    };
  });
  const archives = await listBackupArchives(ctx, BACKUP_DIR);
  check("a sibling deployment's archive is excluded despite matching the glob", archives.some((entry) => entry.path === sibling), false);
  check("every one of this deployment's own archives is included", archives.length, 3);
  check("sorted newest first", archives.map((entry) => entry.name), [full, migrate, share].map((path) => path.slice(path.lastIndexOf("/") + 1)));
  check("size parsed as bytes", archives[0].sizeBytes, 100);
  check("modifiedAt parsed from the epoch field", archives[0].modifiedAt, new Date(1767398400 * 1000).toISOString());
  check("profile parsed from the name", archives.map((entry) => entry.profile), ["full", "migrate", "share"]);
}

{
  const ctx = stubContext(async () => ({ code: 1, stdout: "", stderr: "no such directory" }));
  const archives = await listBackupArchives(ctx, BACKUP_DIR);
  check("an unreadable/missing backup directory reports no archives, not a thrown error", archives, []);
}

// --- listReplacedCopies --------------------------------------------------------------------

{
  const newer = `${DATA_DIR}.replaced-2026-01-03T00-00-00-000Z`;
  const older = `${DATA_DIR}.replaced-2026-01-01T00-00-00-000Z`;
  const malformed = `${DATA_DIR}.replaced-not-a-stamp`; // matches the find glob, not the strict parse
  const ctx = stubContext(async (command, args) => {
    if (command === "find") {
      return {
        code: 0,
        stdout: [`1767225600\t${older}`, `1767398400\t${newer}`, `1767312000\t${malformed}`].join("\n"),
        stderr: "",
      };
    }
    if (command === "du") {
      check("du is asked for exactly the strictly-parsed candidates, malformed name excluded", args.includes(malformed), false);
      return { code: 0, stdout: [`4096\t${older}`, `123456789\t${newer}`].join("\n"), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const copies = await listReplacedCopies(ctx, DATA_DIR);
  check("a name that only glob-matches but fails the strict stamp shape is excluded", copies.some((entry) => entry.path === malformed), false);
  check("both well-formed copies are listed", copies.length, 2);
  check("sorted newest first", copies.map((entry) => entry.path), [newer, older]);
  check("size comes from the batched du pass", copies[0].sizeBytes, 123456789);
}

{
  const ctx = stubContext(async () => ({ code: 0, stdout: "", stderr: "" }));
  const copies = await listReplacedCopies(ctx, DATA_DIR);
  check("no replaced copies is an empty list, and du is never called for zero candidates", copies, []);
}

// --- defaultRestoreArchive -------------------------------------------------------------------

{
  const entries = (specs: { profile: BackupArchiveInfo["profile"]; modifiedAt: string }[]): BackupArchiveInfo[] =>
    specs.map((spec, index) => ({ name: `a${index}`, path: `/p/a${index}`, sizeBytes: 1, stamp: "20260101-000000", ...spec }));

  const withFull = entries([
    { profile: "share", modifiedAt: "2026-01-03T00:00:00.000Z" },
    { profile: "full", modifiedAt: "2026-01-02T00:00:00.000Z" },
    { profile: "migrate", modifiedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  check("picks the newest FULL archive, not the newest file", defaultRestoreArchive(withFull)?.path, "/p/a1");

  const noFull = entries([{ profile: "share", modifiedAt: "2026-01-01T00:00:00.000Z" }]);
  check("no full archive means no default", defaultRestoreArchive(noFull), undefined);
}

// --- replacedCopyName / parseReplacedCopyName --------------------------------------------

{
  const name = replacedCopyName(DATA_DIR);
  const base = name.slice(name.lastIndexOf("/") + 1);
  const parsed = parseReplacedCopyName(base, "data");
  check("what replacedCopyName writes, parseReplacedCopyName reads back", parsed !== undefined, true);

  check("a name with the wrong stamp shape is refused", parseReplacedCopyName("data.replaced-not-a-stamp", "data"), undefined);
  check("a name for a different data directory is refused", parseReplacedCopyName(base, "other"), undefined);
  check("a bare data directory name (no .replaced- suffix) is refused", parseReplacedCopyName("data", "data"), undefined);
  check("a sibling name that merely starts with the prefix is refused", parseReplacedCopyName("data-old.replaced-2026-01-01T00-00-00-000Z", "data"), undefined);
}

// --- a listing is a read: a missing or unreadable directory never demands sudo -------------

{
  const calls: string[] = [];
  const ctx = {
    settings: { backupDir: BACKUP_DIR, dataDir: DATA_DIR },
    transport: {
      async exists(): Promise<boolean> { return false; },
      async exec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
        calls.push(command);
        return { code: 1, stdout: "", stderr: "" }; // nothing exists; sudo would ask for a password
      },
    },
  } as unknown as Context;
  check("a missing backup directory lists no archives", await listBackupArchives(ctx, BACKUP_DIR), []);
  check("a missing data parent lists no replaced copies", await listReplacedCopies(ctx, DATA_DIR), []);
  check("and neither probed sudo", calls.includes("sudo"), false);
}

process.stderr.write(failed === 0 ? "all backup inventory checks passed\n" : `${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
