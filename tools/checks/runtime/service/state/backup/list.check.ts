// `./clawforge backup list` — text and --json both report archives and `.replaced-*` copies
// with size and timestamp, and mark which archive restore would pick by default. Hermetic: a
// stub transport models `find`/`du`, no real target and no instance lock (list never takes
// one).

import { backupList } from "#framework/commands/lifecycle/backup/list.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { deploymentName, useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { resolve } from "node:path";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));
const NAME = deploymentName();
const BACKUP_DIR = "/srv/openclaw/backups";
const DATA_DIR = "/srv/openclaw/data";

function listContext(): Context {
  const full = `${BACKUP_DIR}/${NAME}-20260102-000000.tar.gz`;
  const share = `${BACKUP_DIR}/${NAME}-20260101-000000-share.tar.gz`;
  const replaced = `${DATA_DIR}.replaced-2026-01-01T00-00-00-000Z`;
  return {
    settings: { backupDir: BACKUP_DIR, dataDir: DATA_DIR },
    transport: {
      async exists(): Promise<boolean> { return true; },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        if (command === "find" && args[args.indexOf("-type") + 1] === "f") {
          return { code: 0, stdout: `200\t1767312000\t${full}\n50\t1767225600\t${share}\n`, stderr: "" };
        }
        if (command === "find" && args[args.indexOf("-type") + 1] === "d") {
          return { code: 0, stdout: `1767225600\t${replaced}\n`, stderr: "" };
        }
        if (command === "du") return { code: 0, stdout: `999999\t${replaced}\n`, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

function emptyContext(): Context {
  return {
    settings: { backupDir: BACKUP_DIR, dataDir: DATA_DIR },
    transport: {
      async exists(): Promise<boolean> { return true; },
      async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

// --- --json --------------------------------------------------------------------------------

{
  const ctx = listContext();
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, () => backupList(ctx, ["--json"]));
  const parsed = JSON.parse(output) as {
    backupDir: string;
    archives: { name: string; profile: string; default: boolean; sizeBytes: number }[];
    dataDir: string;
    replacedCopies: { name: string; sizeBytes: number | null }[];
  };
  check("backupDir is reported", parsed.backupDir, BACKUP_DIR);
  check("both archives are listed", parsed.archives.length, 2);
  check("newest archive first", parsed.archives[0].name.includes("20260102"), true);
  check("the newest FULL archive is marked default", parsed.archives.find((a) => a.profile === "full")?.default, true);
  check("a profile-limited archive is never marked default", parsed.archives.find((a) => a.profile === "share")?.default, false);
  check("dataDir is reported", parsed.dataDir, DATA_DIR);
  check("the replaced copy is listed with its size", parsed.replacedCopies[0]?.sizeBytes, 999999);
}

// Text rendering (no --json, not captured) is a straightforward map over the same data this
// suite already pins through --json — see watch/status.check.ts's own comment on why its
// hermetic checks go through isCaptured() rather than a real terminal too.

// --- empty -----------------------------------------------------------------------------------

{
  const ctx = emptyContext();
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, () => backupList(ctx, ["--json"]));
  const parsed = JSON.parse(output) as { archives: unknown[]; replacedCopies: unknown[] };
  check("an empty backup directory reports no archives, not an error", parsed.archives, []);
  check("no replaced copies reports an empty list", parsed.replacedCopies, []);
}

finish("backup list");
