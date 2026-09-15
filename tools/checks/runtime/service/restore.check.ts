// Checks that a direct restore never starts the gateway on a config it cannot satisfy.
//
// push() already had this guard — restoreArchive() itself did not, so `./clawforge restore` alone
// (the common path, without going through push) could start straight into a
// SecretRefResolutionError crash-loop. No target: a stub transport drives restoreArchive()
// end to end with a restored config that references a variable nothing supplies.

import { resolve } from "node:path";
import { restoreArchive, newestArchive } from "#framework/commands/lifecycle/restore.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

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

const CONFIG_PATH = "/srv/openclaw/data/config/openclaw.json";
const TARGET_ENV_PATH = "/srv/openclaw/data/config/.env";

let startCalled = false;

function makeCtx(): Context {
  return {
    settings: { dataDir: "/srv/openclaw/data", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        if (path === CONFIG_PATH) return true;
        // Absent on purpose: the restored config references a variable nothing supplies.
        if (path === TARGET_ENV_PATH) return false;
        return true;
      },
      async readFile(path: string): Promise<string> {
        if (path === CONFIG_PATH) {
          return JSON.stringify({ provider: { key: { source: "env", id: "REQUIRED_VAR" } } });
        }
        return "";
      },
      async writeFile(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async remove(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (command === "tar" && args.includes("-tzf")) {
          return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        }
        if (command === "tar" && args.includes("-tvzf")) return { code: 0, stdout: "", stderr: "" };
        if (command === "stat") return { code: 0, stdout: "1000:1000", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: {
      async stop(): Promise<void> {},
      async start(): Promise<void> {
        startCalled = true;
      },
      async waitForHealth(): Promise<void> {},
    },
  } as unknown as Context;
}

let threw = false;
try {
  await withOutputSink(
    () => {},
    () => restoreArchive(makeCtx(), "/srv/openclaw/backups/openclaw-x.tar.gz", { force: true }),
  );
} catch {
  threw = true;
}

check("restoring a config missing its secrets does not throw", threw, false);
check("the gateway is never started when a required secret is missing", startCalled, false);

// A different failure entirely — the restored config itself does not parse — must not be
// read as "just missing secrets" and reported as a successful restore. preflightSecrets()
// throws a plain SyntaxError here (from requirements()'s own JSON.parse), which restore.ts
// used to catch indiscriminately alongside the genuine missing-secrets case.
{
  const ctx = makeCtx();
  (ctx.transport as { readFile: (path: string) => Promise<string> }).readFile = async (path: string) => {
    if (path === CONFIG_PATH) return "{ not valid json";
    return "";
  };

  let corruptThrew = false;
  await withOutputSink(
    () => {},
    async () => {
      try {
        await restoreArchive(ctx, "/srv/openclaw/backups/openclaw-x.tar.gz", { force: true });
      } catch {
        corruptThrew = true;
      }
    },
  );

  check("a corrupted restored config is not reported as a successful restore", corruptThrew, true);
}

// --- which archive `./clawforge restore` picks when given none ------------------------------
//
// `pull` writes migrate and share archives into the same directory `backup` writes full ones
// into, and the rule used to be "the newest file matching <deployment>-*.tar.gz". So the
// documented `./clawforge restore` run right after `pull --share` replaced the data directory
// with an archive carrying neither identity nor credentials: the gateway could not start, and
// the real data survived only as <data>.replaced-<stamp>.

function listingContext(paths: string[]): Context {
  return {
    settings: { backupDir: BACKUP_DIR },
    transport: {
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) {
          return { code: 0, stdout: `${paths.join("\n")}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

const BACKUP_DIR = "/srv/openclaw/backups";
const NAME = deploymentName();

{
  const full = `${BACKUP_DIR}/${NAME}-20260101-000000.tar.gz`;
  const picked = await newestArchive(
    listingContext([
      `${BACKUP_DIR}/${NAME}-20260103-000000-share.tar.gz`,
      `${BACKUP_DIR}/${NAME}-20260102-000000-migrate.tar.gz`,
      full,
    ]),
    BACKUP_DIR,
  );

  check("the newest FULL archive is chosen, not the newest file", picked.archive, full);
  check("and what was passed over is reported, not swallowed", picked.skipped.length, 2);
  check("by name and profile", picked.skipped[0].includes("share"), true);
}

{
  // A sibling deployment sharing the directory matches the glob but is not ours to restore.
  const picked = await newestArchive(listingContext([`${BACKUP_DIR}/${NAME}-staging-20260103-000000.tar.gz`]), BACKUP_DIR);
  check("a sibling deployment's archive is not a candidate", picked.archive, undefined);
  check("and is not reported as a skipped profile either", picked.skipped.length, 0);
}

{
  const picked = await newestArchive(listingContext([`${BACKUP_DIR}/${NAME}-20260103-000000-share.tar.gz`]), BACKUP_DIR);
  check("a directory holding only profile archives offers nothing to restore", picked.archive, undefined);
  check("and says which ones it passed over", picked.skipped.length, 1);
}

process.stderr.write(failed === 0 ? "all restore checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
