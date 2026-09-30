// Checks that profile verification errors leave neither a published backup nor share copy.
//
// No target: a stub transport drives the real pull() end to end, with the grep step inside
// verifySnapshot made to fail outright (exit code 2, "scanning failed"), which is a genuine
// exception rather than a structural rejection. Backup staging must still be cleaned.
// Snapshot naming and listing live here too; pull's lock and publication failures are
// pull-lock.check.ts, loadSecrets is secrets.check.ts.

import { resolve } from "node:path";
import { pull, resolvePushArchive, selectSnapshotPaths } from "#framework/commands/lifecycle/state.ts";
import { InventoryUnreadableError, parseSnapshotArchive } from "#framework/service/archive/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { modelMutationGuard } from "./mutation-guard.ts";
import { check, finish } from "#checks/kit/harness.ts";
useDeployment(resolve(monorepoRoot, "apps", "example app"));

const snapshotName = (name: string, stamp: string): string => `${name}-state-${stamp}.tar.gz`;
const parsedSnapshot = parseSnapshotArchive(snapshotName("example app", "2026-01-12T03-04-05"), "example app");
check("pull snapshot stamp is accepted", parsedSnapshot?.stamp, "2026-01-12T03-04-05");
check("sibling deployment snapshot is rejected", parseSnapshotArchive(snapshotName("example app-state", "2026-01-12T03-04-05"), "example app"), undefined);
check("snapshot with a non-pull suffix is rejected", parseSnapshotArchive("example app-state-2026-01-12T03-04-05-share.tar.gz", "example app"), undefined);
check("snapshot with an impossible timestamp is rejected", parseSnapshotArchive(snapshotName("example app", "2026-02-30T03-04-05"), "example app"), undefined);
check(
  "historical open_claw snapshots remain selectable for openclaw",
  selectSnapshotPaths("/srv/snapshots/open_claw-state-2026-01-12T03-04-05.tar.gz\n", "openclaw")[0],
  "/srv/snapshots/open_claw-state-2026-01-12T03-04-05.tar.gz",
);
check(
  "newest selection preserves listing order and excludes siblings",
  selectSnapshotPaths(
    "/srv/snapshots/example app-state-state-2026-01-12T03-04-06.tar.gz\n/srv/snapshots/example app-state-2026-01-12T03-04-05.tar.gz",
    "example app",
  )[0],
  "/srv/snapshots/example app-state-2026-01-12T03-04-05.tar.gz",
);

{
  const directory = "/srv/openclaw/snapshots";
  const newer = `${directory}/${snapshotName("example app", "2026-01-12T03-04-05")}`;
  const older = `${directory}/${snapshotName("example app", "2026-01-11T03-04-05")}`;
  const sibling = `${directory}/${snapshotName("example app-state", "2026-01-13T03-04-05")}`;
  const listingContext = (lines: string[], code = 0, exists = true): Context => ({
    settings: { snapshotDir: directory },
    transport: {
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (command === "test" && args[0] === "-d") return { code: exists ? 0 : 1, stdout: "", stderr: "" };
        if (command === "sh") return { code: 0, stdout: "", stderr: "" };
        if (command === "find") return { code, stdout: lines.join("\n"), stderr: "private detail" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  }) as unknown as Context;

  check("push selects the newest valid snapshot", await resolvePushArchive(listingContext([
    `100\t${older}`, `300\t${sibling}`, `200\t${newer}`,
  ]), undefined), newer);
  check("push preserves an explicit archive without listing", await resolvePushArchive(listingContext([], 1), older), older);
  for (const [label, ctx] of [
    ["empty", listingContext([])],
    ["absent", listingContext([], 0, false)],
  ] as const) {
    let error: unknown;
    try { await resolvePushArchive(ctx, undefined); } catch (caught) { error = caught; }
    check(`${label} snapshot directory reports no snapshots`, String(error).includes("no snapshots"), true);
  }
  let error: unknown;
  try { await resolvePushArchive(listingContext([`200\t${newer}`], 1), undefined); }
  catch (caught) { error = caught; }
  check("failed partial snapshot listing remains unknown", error instanceof InventoryUnreadableError, true);
  check("snapshot listing failure hides target stderr", String(error).includes("private detail"), false);
}

// Backup staging cleanup runs `rm -rf`; verify.ts's scan temp cleanup uses transport.remove().
const removed: string[] = [];
const present = new Set(["/srv/openclaw/data", "/srv/openclaw/snapshots", "/srv/openclaw/data/config/.env"]);

const ctx = {
  settings: {
    dataDir: "/srv/openclaw/data",
    backupDir: "/srv/openclaw/backups",
    snapshotDir: "/srv/openclaw/snapshots",
    // A 12+ character value so collectSecrets() has something to search for — otherwise
    // findSecrets() short-circuits before ever calling grep, and the failure this check
    // exists to reproduce would never happen.
    env: { OPENCLAW_GATEWAY_TOKEN: "not-a-real-token-just-long-enough" },
  },
  transport: {
    description: "stub",
    // Every path "exists" except the config that would otherwise pull requirements() into
    // parsing real JSON — requirements() short-circuits to [] when it is absent, which is
    // fine here since secret requirements are not what this check is about.
    async exists(path: string): Promise<boolean> {
      return present.has(path);
    },
    async readFile(): Promise<string> {
      return "";
    },
    async writeFile(): Promise<void> {},
    async mkdirp(): Promise<void> {},
    async remove(): Promise<void> {
      // verify.ts's own temp-file cleanup (pattern file, unpack directory) — unrelated to
      // the backup/snapshot cleanup under test here, and runs on every path regardless.
    },
    async exec(command: string, args: string[]): Promise<ExecResult> {
      if (command === "rm" && args.includes("-f")) {
        removed.push(args[args.length - 1]);
        present.delete(args[args.length - 1] ?? "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "test" && args[0] === "-e") {
        return { code: present.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
      }
      // createBackup() asks `test -L` before archiving; the modeled data directory is a
      // real one, and the fall-through at the bottom would answer 0 — "is a symlink".
      if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
      if (command === "cp") {
        present.add(args[args.length - 1] ?? "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "mv") {
        present.delete(args[args.length - 2] ?? "");
        present.add(args[args.length - 1] ?? "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "mkdir" && args.includes("-m")) {
        present.add(args.at(-1) ?? "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "tar" && args.includes("-czf")) {
        const archive = args[args.indexOf("-czf") + 1];
        if (archive !== undefined) present.add(archive);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "rm" && args.includes("-rf")) {
        const target = args.at(-1) ?? "";
        for (const path of present) if (path === target || path.startsWith(`${target}/`)) present.delete(path);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "tar" && args.includes("-tzf")) {
        return { code: 0, stdout: "data/\ndata/config/openclaw.json\ndata/workspace/SOUL.md\n", stderr: "" };
      }
      if (command === "tar" && args.includes("-tvzf")) {
        return {
          code: 0,
          stdout:
            "drwxr-xr-x user/user 0 2026-01-01 00:00 data/\n" +
            "-rw-r--r-- user/user 0 2026-01-01 00:00 data/config/openclaw.json\n" +
            "-rw-r--r-- user/user 0 2026-01-01 00:00 data/workspace/SOUL.md\n",
          stderr: "",
        };
      }
      // The failure under test: a scan that cannot run at all, not one that finds nothing.
      if (command === "grep") return { code: 2, stdout: "", stderr: "grep: pattern file: No such file" };
      return { code: 0, stdout: "", stderr: "" };
    },
  },
  runtime: {
    async isRunning(): Promise<boolean> {
      return false;
    },
  },
} as unknown as Context;
modelMutationGuard(ctx);

let threw = false;
try {
  await withOutputSink(
    () => {},
    () => pull(ctx, ["--share"]),
  );
} catch {
  threw = true;
}

check("a verifier that fails outright still propagates as a failure", threw, true);
check("verification fails before pull creates a share copy", removed.length, 0);
check("the failed verification removes the backup staging tree", [...present].some((path) => path.includes(".clawforge-backup-")), false);
check("the failed verification publishes no backup", [...present].some((path) => path.startsWith("/srv/openclaw/backups/") && path.endsWith(".tar.gz")), false);

finish("state");
