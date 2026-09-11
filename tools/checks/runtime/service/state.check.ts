// Checks that a rejected share snapshot never leaves both copies behind — including when
// the verifier itself throws instead of returning false.
//
// No target: a stub transport drives the real pull() end to end, with the grep step inside
// verifySnapshot made to fail outright (exit code 2, "scanning failed"), which is a genuine
// exception rather than a structural rejection. The two copies must still be removed.

import { resolve } from "node:path";
import { pull, rotateSnapshots } from "../../../framework/commands/lifecycle/state.ts";
import { useDeployment, deploymentName } from "../../../framework/runtime/deployment.ts";
import { monorepoRoot } from "../../../framework/core/env.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import type { Context } from "../../../framework/core/context.ts";
import type { ExecResult } from "../../../framework/runtime/transport.ts";

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

// Cleanup in state.ts runs `rm -f <path>` through exec(), not through the transport's own
// remove() — that method is a different interface entry point verify.ts uses for its own
// temporary files (the pattern file, the unpack directory) and gets called regardless of
// whether the verifier throws, which made an earlier version of this check pass for the
// wrong reason. Only rm commands count as the cleanup under test.
const removed: string[] = [];

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
      return !path.endsWith("openclaw.json");
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
check("both the backup and the share copy were removed", removed.length, 2);

// --- snapshot rotation: bounded, and cheap regardless of backlog size ------------------

{
  const name = deploymentName();
  const snapshotDir = "/srv/openclaw/snapshots";

  // 12 snapshots, newest first — exactly what `ls -1t` returns — with OC_SNAPSHOT_KEEP=3,
  // so 9 are stale. A first-time rotation of a real, long-unrotated deployment looks like
  // this: dozens of snapshots, not one or two.
  const listing = Array.from({ length: 12 }, (_, i) => `${snapshotDir}/${name}-state-2026-01-${String(12 - i).padStart(2, "0")}.tar.gz`);

  const execCalls: { command: string; args: string[] }[] = [];
  const rotationCtx = {
    settings: { env: { OC_SNAPSHOT_KEEP: "3" } },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push({ command, args });
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) {
          return { code: 0, stdout: `${listing.join("\n")}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  await withOutputSink(
    () => {},
    () => rotateSnapshots(rotationCtx, snapshotDir),
  );

  const rmCalls = execCalls.filter((call) => call.command === "rm");
  check("exactly one rm call regardless of how many snapshots are stale", rmCalls.length, 1);

  const removedTargets = rmCalls[0]?.args.filter((arg) => arg !== "-f") ?? [];
  const stale = listing.slice(3);
  const kept = listing.slice(0, 3);

  check("every stale snapshot's base archive is targeted", stale.every((path) => removedTargets.includes(path)), true);
  check(
    "every stale snapshot's sidecar files are targeted too",
    stale.every(
      (path) => removedTargets.includes(`${path}.template.env`) && removedTargets.includes(`${path}.secrets.env`),
    ),
    true,
  );
  check("none of the kept snapshots are targeted", kept.some((path) => removedTargets.includes(path)), false);
  check("removing 9 beyond the last 3 with 12 total", stale.length, 9);

  // The round-trip count that actually matters: this used to be one sudoFor probe per
  // candidate file (up to 3 per stale snapshot), which is what made a large backlog slow
  // enough to blow past a normal command timeout on a real deployment.
  check("the whole rotation costs at most a few round trips, not one per file", execCalls.length <= 5, true);
}

process.stderr.write(failed === 0 ? "all state checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
