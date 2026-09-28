// `backup` and `pull` must accept the same profile shorthand vocabulary
// (--share/--with-secrets/--migrate, alongside --profile and --hot), only their DEFAULT
// profile differs (backup: full, pull: migrate). Before this fix, `./clawforge backup --share`
// failed with "unknown argument: --share".
//
// Two tiers: an unrecognised flag or an invalid --profile value dies inside the parsing loop
// before either command ever touches its target, so those cases need no transport at all.
// Resolving a shorthand to the right profile is proven by actually running the real
// backup()/pull() CLI entry points to completion against a minimal stub target and reading
// back the profile each command reports having used.

import { resolve } from "node:path";
import { backup } from "#framework/commands/lifecycle/backup.ts";
import { pull } from "#framework/commands/lifecycle/state.ts";
import { PROFILE_SHORTHAND_FLAGS } from "#framework/service/archive/index.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";

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

// --- the shared shorthand vocabulary itself -------------------------------------------------

check("--share is a shorthand for the share profile", PROFILE_SHORTHAND_FLAGS.get("--share"), "share");
check("--with-secrets is a shorthand for the full profile", PROFILE_SHORTHAND_FLAGS.get("--with-secrets"), "full");
check("--migrate is a shorthand for the migrate profile", PROFILE_SHORTHAND_FLAGS.get("--migrate"), "migrate");
check("only those three shorthands exist", PROFILE_SHORTHAND_FLAGS.size, 3);

// --- an unrecognised argument or bad --profile value dies before touching the target --------
//
// die() throws synchronously inside the parsing loop, before either command's first `await`
// — an empty stub proves nothing on it was ever called.

async function rejects(call: () => Promise<unknown>): Promise<string> {
  try {
    await withOutputSink(() => {}, call);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const untouchedCtx = {} as unknown as Context;

check(
  "backup rejects an unknown flag before touching the target",
  await rejects(() => backup(untouchedCtx, ["--bogus"])),
  "unknown argument: --bogus",
);
check(
  "pull rejects an unknown flag before touching the target",
  await rejects(() => pull(untouchedCtx, ["--bogus"])),
  "unknown argument: --bogus",
);
check(
  "backup rejects an invalid --profile value before touching the target",
  await rejects(() => backup(untouchedCtx, ["--profile", "everything"])),
  "--profile needs one of: full, migrate, share",
);
check(
  "pull rejects an invalid --profile value before touching the target",
  await rejects(() => pull(untouchedCtx, ["--profile", "everything"])),
  "--profile needs one of: full, migrate, share",
);

// --- a real run of each shorthand resolves to the right profile ------------------------------
//
// A minimal stub target: no secrets anywhere (so the content scan never has a pattern to
// grep for), a listing that is SHARE_ALLOWED-clean, and every filesystem primitive backup/
// pull actually issues answered generically except where the outcome must reflect real state
// (an archive/snapshot path once published, a symlink check, the crafted tar listings).

function makeCtx(): { ctx: Context; output: string[] } {
  const dataDir = "/srv/openclaw/data";
  const backupDir = "/srv/openclaw/backups";
  const snapshotDir = "/srv/openclaw/snapshots";
  const present = new Set([dataDir, backupDir, snapshotDir]);
  const output: string[] = [];

  const LISTING = "data/\ndata/config/openclaw.json\ndata/workspace/SOUL.md\n";
  const VERBOSE_LISTING =
    "drwxr-xr-x user/user 0 2026-01-01 00:00 data/\n" +
    "-rw-r--r-- user/user 0 2026-01-01 00:00 data/config/openclaw.json\n" +
    "-rw-r--r-- user/user 0 2026-01-01 00:00 data/workspace/SOUL.md\n";

  const ctx = {
    settings: { dataDir, backupDir, snapshotDir, env: {} },
    transport: {
      description: "flag-parsing-stub",
      async exists(path: string): Promise<boolean> {
        return present.has(path);
      },
      async readFile(): Promise<string> {
        return "";
      },
      async writeFile(path: string): Promise<void> {
        present.add(path);
      },
      async remove(path: string): Promise<void> {
        present.delete(path);
      },
      async mkdirp(path: string): Promise<void> {
        present.add(path);
      },
      async exec(command: string, args: string[]): Promise<ExecResult> {
        // Nothing here is a symlink — the ONE case where "generically succeed" would be
        // read backwards (code 0 on `-L` means "is a symlink").
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-e") {
          return { code: present.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "mv") {
          present.delete(args[args.length - 2] ?? "");
          present.add(args[args.length - 1] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "cp") {
          present.add(args[args.length - 1] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rm") {
          const target = args[args.length - 1] ?? "";
          if (args.includes("-rf")) {
            for (const path of present) if (path === target || path.startsWith(`${target}/`)) present.delete(path);
          } else {
            present.delete(target);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mkdir" && args.includes("-p")) {
          present.add(args[args.length - 1] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-czf")) {
          const archive = args[args.indexOf("-czf") + 1];
          if (archive !== undefined) present.add(archive);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) return { code: 0, stdout: LISTING, stderr: "" };
        if (command === "tar" && args.includes("-tvzf")) return { code: 0, stdout: VERBOSE_LISTING, stderr: "" };
        if (command === "du") return { code: 0, stdout: "1K\tarchive\n", stderr: "" };
        if (command === "find") return { code: 0, stdout: "", stderr: "" };
        // Everything else (mkdir/rmdir for the instance lock and its mutation guard, plain
        // "test -w"/"test -d", "tar -xzf", "sh", "id") succeeds generically: none of it is
        // examined by the assertions below, only which profile backup/pull report using.
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: {
      async isRunning(): Promise<boolean> {
        return false;
      },
    },
  } as unknown as Context;

  return { ctx, output };
}

async function backupProfile(args: string[]): Promise<string> {
  const { ctx, output } = makeCtx();
  await withOutputSink((chunk) => output.push(chunk), () => backup(ctx, args));
  const text = output.join("");
  return /profile: (\w+)/.exec(text)?.[1] ?? "";
}

async function pullProfile(args: string[]): Promise<string> {
  const { ctx, output } = makeCtx();
  await withOutputSink((chunk) => output.push(chunk), () => pull(ctx, args));
  const text = output.join("");
  return /profile: (\w+)/.exec(text)?.[1] ?? "";
}

check("backup with no flags defaults to full", await backupProfile([]), "full");
check("backup --share resolves to share", await backupProfile(["--share"]), "share");
check("backup --migrate resolves to migrate", await backupProfile(["--migrate"]), "migrate");
check("backup --with-secrets resolves to full (already the default)", await backupProfile(["--with-secrets"]), "full");
check("backup --profile share resolves to share", await backupProfile(["--profile", "share"]), "share");
check(
  "a shorthand after --profile still wins (last flag decides, same as pull)",
  await backupProfile(["--profile", "full", "--share"]),
  "share",
);

check("pull with no flags defaults to migrate", await pullProfile([]), "migrate");
check("pull --share still resolves to share", await pullProfile(["--share"]), "share");
check("pull --with-secrets still resolves to full", await pullProfile(["--with-secrets"]), "full");
check("pull --migrate is a no-op alongside its own default", await pullProfile(["--migrate"]), "migrate");

process.stderr.write(
  failed === 0 ? "all backup/pull flag checks passed\n" : `${failed} backup/pull flag check(s) failed\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
