// Checks that a rejected share snapshot never leaves both copies behind — including when
// the verifier itself throws instead of returning false.
//
// No target: a stub transport drives the real pull() end to end, with the grep step inside
// verifySnapshot made to fail outright (exit code 2, "scanning failed"), which is a genuine
// exception rather than a structural rejection. The two copies must still be removed.

import { resolve } from "node:path";
import { loadSecrets, pull, rotateSnapshots, selectSnapshotPaths } from "#framework/commands/lifecycle/state.ts";
import { parseSnapshotArchive } from "#framework/service/archive.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { takeLock } from "#framework/runtime/instance-lock.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";
import { pullScenario, type PullFailure } from "../pull-harness.ts";

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

// Cleanup in state.ts runs `rm -f <path>` through exec(), not through the transport's own
// remove() — that method is a different interface entry point verify.ts uses for its own
// temporary files (the pattern file, the unpack directory) and gets called regardless of
// whether the verifier throws, which made an earlier version of this check pass for the
// wrong reason. Only rm commands count as the cleanup under test.
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
  const ownListing = Array.from({ length: 12 }, (_, i) => `${snapshotDir}/${name}-state-2026-01-12T03-04-${String(12 - i).padStart(2, "0")}.tar.gz`);
  const foreign = `${snapshotDir}/${name}-state-state-2026-01-12T03-04-99.tar.gz`;
  const listing = [ownListing[0], foreign, ...ownListing.slice(1)];

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
  const stale = ownListing.slice(3);
  const kept = ownListing.slice(0, 3);

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
  check("foreign deployment snapshot is preserved", removedTargets.includes(foreign), false);

  // The round-trip count that actually matters: this used to be one sudoFor probe per
  // candidate file (up to 3 per stale snapshot), which is what made a large backlog slow
  // enough to blow past a normal command timeout on a real deployment.
  check("the whole rotation costs at most a few round trips, not one per file", execCalls.length <= 5, true);
}

// --- pull holds one lock through the archive and every sidecar ---------------------------

// A competing operation must not slip in after createBackup() releases its nested lock.
// The fake transport invokes the competitor at the copy boundary, where the old pull
// implementation had already dropped its lock. It also records the archive source and the
// migrate sidecar so the two outputs can be checked as one snapshot.
{
  const dataDir = "/srv/openclaw/data";
  const backupDir = "/srv/openclaw/backups";
  const snapshotDir = "/srv/openclaw/snapshots";
  const files = new Map<string, string>();
  const events: string[] = [];
  let lockExists = false;
  let copySource = "";
  let snapshotPath = "";
  let competitorMessage = "";
  let competitorAttempts = 0;
  files.set(`${dataDir}/config/.env`, "OPENAI_API_KEY=OLD_KEY_VALUE\n");
  const ctx = {
    settings: { dataDir, backupDir, snapshotDir, env: {} },
    transport: {
      description: "pull-lock-stub",
      async exists(path: string): Promise<boolean> {
        return path === dataDir || path === snapshotDir || path.endsWith("openclaw.json") || path.endsWith("config/.env") || files.has(path);
      },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("holder.json")) return files.get(path) ?? "";
        if (path.endsWith("openclaw.json")) {
          return JSON.stringify({ models: { providers: { openai: {} } } });
        }
        if (path.endsWith("config/.env")) return files.get(path) ?? "";
        return files.get(path) ?? "";
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
        events.push(`write:${path}`);
        if (path.endsWith(".tar.gz") && path.includes("-state-")) snapshotPath = path;
      },
      async remove(path: string): Promise<void> {
        if (path.endsWith("operation.lock")) {
          lockExists = false;
          for (const key of files.keys()) if (key.includes("/operation.lock/")) files.delete(key);
        }
        files.delete(path);
      },
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        events.push(`${command}:${args.join(" ")}`);
        if (command === "mkdir" && !args[0]?.startsWith("-")) {
          if (lockExists) return { code: 1, stdout: "", stderr: "File exists" };
          lockExists = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") {
          return { code: lockExists ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
        // The instance lock's release now empties its directory with `rmdir` (round 6,
        // P2-03), not a recursive remove of the whole lock path.
        if (command === "rmdir") {
          if (args[0]?.endsWith("operation.lock")) lockExists = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-e") {
          const path = args[1] ?? "";
          return {
            code: path === dataDir || path === snapshotDir || path.endsWith("openclaw.json") || path.endsWith("config/.env") || files.has(path) ? 0 : 1,
            stdout: "",
            stderr: "",
          };
        }
        if (command === "cp") {
          copySource = args[args.length - 2] ?? "";
          snapshotPath = args[args.length - 1] ?? "";
          if (copySource !== "" && snapshotPath !== "") files.set(snapshotPath, files.get(copySource) ?? "");
          competitorAttempts += 1;
          let competitorLock: Awaited<ReturnType<typeof takeLock>> | undefined;
          try {
            competitorLock = await takeLock(ctx as unknown as Context, "competing-operation", "op-competing");
            files.set(`${dataDir}/config/.env`, "OPENAI_API_KEY=NEW_KEY_VALUE\n");
            await competitorLock.release();
          } catch (error) {
            competitorMessage = (error as Error).message;
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mv") {
          const source = args[args.length - 2] ?? "";
          const destination = args[args.length - 1] ?? "";
          files.set(destination, files.get(source) ?? "");
          files.delete(source);
          if (snapshotPath === source) snapshotPath = destination;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-czf")) {
          const archive = args[args.indexOf("-czf") + 1];
          if (archive !== undefined) files.set(archive, "state=OLD\n");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) {
          return { code: 0, stdout: "data/\ndata/config/openclaw.json\ndata/workspace/SOUL.md\n", stderr: "" };
        }
        if (command === "du") return { code: 0, stdout: "1K\tarchive\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: { async isRunning(): Promise<boolean> { return false; } },
  } as unknown as Context;

  await withOutputSink(() => {}, () => pull(ctx, []));
  const sidecar = files.get(`${snapshotPath}.secrets.env`) ?? "";
  check("pull refuses a competing lock at the copy boundary", competitorMessage.includes("another operation is changing this instance"), true);
  check("the competing operation attempted to take the lock", competitorAttempts, 1);
  check("the snapshot was copied from the backup created by this pull", copySource.endsWith(".tar.gz"), true);
  check("the copied snapshot keeps the pre-copy state", files.get(snapshotPath), "state=OLD\n");
  check("the migrate sidecar belongs to the same pre-copy state", sidecar, "OPENAI_API_KEY=OLD_KEY_VALUE\n");
  check("the published snapshot is selected as newest", selectSnapshotPaths(`${snapshotPath}\n`, deploymentName())[0], snapshotPath);
  check("pull releases its lock after all sidecars are written", lockExists, false);
  check("the lock release leaves no holder file", [...files.keys()].some((path) => path.endsWith("holder.json")), false);
  const archiveMove = events.findIndex((event) => event.startsWith("mv:") && event.endsWith(` ${snapshotPath}`));
  const sidecarWrite = events.findIndex((event) => event.includes(".secrets.env"));
  check("the final archive is published after its sidecar was written", archiveMove > sidecarWrite, true);
}

// A failure after lock acquisition must release it as well. This uses the same atomic
// mkdir state, then proves a fresh operation can claim the instance after pull throws.
{
  const dataDir = "/srv/openclaw/data";
  let lockExists = false;
  const files = new Map<string, string>();
  let failCopy = true;
  const ctx = {
    settings: { dataDir, backupDir: "/srv/openclaw/backups", snapshotDir: "/srv/openclaw/snapshots", env: {} },
    transport: {
      description: "pull-error-lock-stub",
      async exists(path: string): Promise<boolean> { return path === dataDir || path.endsWith("openclaw.json"); },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("holder.json")) return files.get(path) ?? "";
        if (path.endsWith("openclaw.json")) return "{}";
        return "";
      },
      async writeFile(path: string, content: string): Promise<void> { files.set(path, content); },
      async remove(path: string): Promise<void> { if (path.endsWith("operation.lock")) lockExists = false; files.delete(path); },
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (command === "mkdir" && !args[0]?.startsWith("-")) {
          if (lockExists) return { code: 1, stdout: "", stderr: "File exists" };
          lockExists = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") return { code: lockExists ? 0 : 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
        // The instance lock's release now empties its directory with `rmdir` (round 6,
        // P2-03), not a recursive remove of the whole lock path.
        if (command === "rmdir") {
          if (args[0]?.endsWith("operation.lock")) lockExists = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) return { code: 0, stdout: "", stderr: "" };
        if (command === "cp" && failCopy) { failCopy = false; throw new Error("copy failed"); }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: { async isRunning(): Promise<boolean> { return false; } },
  } as unknown as Context;

  let failedPull = false;
  try { await withOutputSink(() => {}, () => pull(ctx, [])); } catch { failedPull = true; }
  const next = await takeLock(ctx, "after-failure", "op-after-failure");
  await next.release();
  check("pull propagates a copy failure", failedPull, true);
  check("pull releases its lock when copy fails", lockExists, false);
}

// Publication failures must leave neither a discoverable partial snapshot nor a held lock.
// The fake is deliberately small but models the target filesystem, mv --no-clobber and the
// commands needed by createBackup/pull so each failure is exercised through the real command.

for (const failure of ["template", "secrets", "verify", "archive", "archive-after-move", "archive-lost-ack", "template-lost-ack", "collision", "dangling", "missing-secrets"] as PullFailure[]) {
  const scenario = pullScenario(failure);
  let threw = false;
  try {
    await withOutputSink(() => {}, () => pull(scenario.ctx, failure === "verify" ? ["--share"] : []));
  } catch {
    threw = true;
  }
  const snapshots = [...scenario.files.keys()].filter((path) => path.includes("-state-") && path.endsWith(".tar.gz"));
  check(`pull ${failure} failure is reported`, threw, true);
  check(`pull ${failure} failure releases its lock`, scenario.lock(), false);
  check(`pull ${failure} failure leaves the previous snapshot intact`, scenario.files.get(`${"/srv/openclaw/snapshots"}/${deploymentName()}-state-2020-01-01T00-00-00.tar.gz`), "previous\n");
  check(
    `pull ${failure} failure leaves no incomplete archive`,
    snapshots.length,
    failure === "archive-after-move" || failure === "archive-lost-ack" ? 2 : 1,
  );
  if (failure === "archive") {
    check("archive publication failure removes its already moved template", [...scenario.files.keys()].some((path) => path.endsWith(".template.env") && path.includes("-state-")), false);
  }
  if (failure === "archive-after-move") {
    const published = snapshots.find((path) => !path.endsWith("2020-01-01T00-00-00.tar.gz"));
    check("uncertain archive publication retains the archive", published !== undefined, true);
    check("uncertain archive publication retains the template", published === undefined ? false : scenario.files.has(`${published}.template.env`), true);
    check("uncertain archive publication retains the secrets", published === undefined ? false : scenario.files.has(`${published}.secrets.env`), true);
  }
  if (failure === "archive-lost-ack") {
    const published = snapshots.find((path) => !path.endsWith("2020-01-01T00-00-00.tar.gz"));
    check("lost archive acknowledgement retains the archive", published !== undefined, true);
    check("lost archive acknowledgement retains the template", published === undefined ? false : scenario.files.has(`${published}.template.env`), true);
    check("lost archive acknowledgement retains the secrets", published === undefined ? false : scenario.files.has(`${published}.secrets.env`), true);
  }
  if (failure === "template-lost-ack") {
    check("lost sidecar acknowledgement removes the uncertain sidecar", [...scenario.files.keys()].some((path) => path.endsWith(".template.env") && path.includes("-state-")), false);
  }
}

// --- loadSecrets: keys private from the first byte, published by one rename ---------------
//
// A model of the target filesystem rather than command echoes: the contract is about what is
// true on the target between two commands — content at the final path under a mode other
// than 600, a staging file left behind — and only a model can observe that.

type SecretFailure = "write" | "chown" | "mv";

const SECRETS_FINAL = "/srv/openclaw/data/config/.env";
const SECRETS_PREVIOUS = "ANTHROPIC_API_KEY=previous-key-value-0123456789\n";
const SECRETS_UPDATED = "ANTHROPIC_API_KEY=updated-key-value-0123456789\nOPENAI_API_KEY=second-key-value-0123456789\n";

function secretsScenario(options: { privateFile?: boolean; fail?: SecretFailure; identity?: string; noSudo?: boolean }): {
  ctx: Context;
  files: Map<string, { content: string; mode: string; owner: string }>;
  events: string[];
  sudoCalls: string[][];
  output: string[];
} {
  const files = new Map<string, { content: string; mode: string; owner: string }>();
  const events: string[] = [];
  const sudoCalls: string[][] = [];
  const output: string[] = [];
  // Who runs the tooling ON THE TARGET. needsOwnerEscalation() reads it through `id -u`/`id -g`
  // before every chown, so the stubbed answer is what decides whether the chown below
  // escalates. The default is the gateway identity, under which nothing about the existing
  // scenarios changes: no force, the `test -w` probe answers writable, no sudo.
  const [uid, gid] = (options.identity ?? "1000:1000").split(":");
  files.set(SECRETS_FINAL, { content: SECRETS_PREVIOUS, mode: "600", owner: "1000:1000" });

  // Both private-write shapes create at 0600 (umask 077, exclusive) — recorded as such, so a
  // later chmod-down from a permissive mode cannot masquerade as created-private.
  const stage = (target: string, content: string): void => {
    events.push(`stage:0600:${target}`);
    if (options.fail === "write") throw new Error("staging write failed");
    files.set(target, { content, mode: "600", owner: "runner" });
  };

  // Hoisted, not a method on the transport literal below: the sudo unwrap inside re-dispatches
  // into these very branches, and an object-literal method has no name to call itself by.
  async function execStub(command: string, args: string[], execOptions?: { input?: string | Uint8Array; allowFailure?: boolean }): Promise<ExecResult> {
    const finish = (result: ExecResult): ExecResult => {
      if (result.code !== 0 && execOptions?.allowFailure !== true) throw new Error(`${command} exited ${result.code}: ${result.stderr.trim()}`);
      return result;
    };

    // An invocation that arrived wrapped in sudo: recorded as made, then run as its inner
    // command so every branch below judges the real chown/mv/rm unchanged. sudoFor's own
    // `sudo -n true` availability probe is answered before the recording — it is a
    // capability check, not a command this scenario ran.
    if (command === "sudo") {
      if (args[0] === "-n" && args[1] === "true") {
        return finish(options.noSudo === true ? { code: 1, stdout: "", stderr: "sudo: a password is required" } : { code: 0, stdout: "", stderr: "" });
      }
      sudoCalls.push(args);
      return execStub(args[1] ?? "", args.slice(2), execOptions);
    }
    // The identity every chown-escalation decision starts from.
    if (command === "id") return { code: 0, stdout: args[0] === "-u" ? (uid ?? "") : (gid ?? ""), stderr: "" };
    if (command === "test") return { code: 0, stdout: "", stderr: "" };
    // sudoFor's availability probe, answered before the fallback-write check: an escalation
    // forced by the identity comparison reaches `command -v sudo` from here.
    if (command === "sh" && args[0] === "-c") {
      if (args[1]?.includes("command -v sudo")) {
        return finish(options.noSudo === true ? { code: 1, stdout: "", stderr: "sudo: not found" } : { code: 0, stdout: "/usr/bin/sudo\n", stderr: "" });
      }
      if (!args[1]?.includes("umask 077") || !args[1]?.includes("set -C")) throw new Error("fallback staging write is not private and exclusive");
      stage(args[1].split("'")[1] ?? "", typeof execOptions?.input === "string" ? execOptions.input : "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "chown") {
      const owner = args[0] ?? "";
      const target = args[1] ?? "";
      events.push(`chown:${owner}:${target}`);
      if (options.fail === "chown") return finish({ code: 1, stdout: "", stderr: "chown: operation not permitted" });
      const entry = files.get(target);
      if (entry !== undefined) entry.owner = owner;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "mv") {
      const source = args[args.length - 2] ?? "";
      const destination = args[args.length - 1] ?? "";
      events.push(`mv:${source}=>${destination}`);
      if (options.fail === "mv") return finish({ code: 1, stdout: "", stderr: "mv: cannot move" });
      const entry = files.get(source);
      if (entry !== undefined) {
        files.set(destination, entry);
        files.delete(source);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "rm") {
      files.delete(args[args.length - 1] ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  const ctx = {
    settings: { dataDir: "/srv/openclaw/data", backupDir: "/srv/openclaw/backups", snapshotDir: "/srv/openclaw/snapshots", env: {} },
    transport: {
      description: "secrets-stub",
      async exists(path: string): Promise<boolean> {
        return files.has(path) || path === "/srv/openclaw/data" || path === "/srv/openclaw/data/config";
      },
      async readFile(path: string): Promise<string> {
        return files.get(path)?.content ?? "";
      },
      // The non-private write, as the real transports behave: content lands at the process
      // umask and the chmod follows. The failure models an interrupted tee — the half file
      // an in-place update leaves behind as the only copy of the keys.
      async writeFile(path: string, content: string, mode?: string): Promise<void> {
        events.push(`write:${path}`);
        files.set(path, {
          content: options.fail === "write" ? content.slice(0, Math.ceil(content.length / 2)) : content,
          mode: "644",
          owner: "runner",
        });
        if (mode !== undefined) {
          events.push(`chmod:${path}:${mode}`);
          const entry = files.get(path);
          if (entry !== undefined) entry.mode = mode;
        }
        if (options.fail === "write") throw new Error("tee interrupted");
      },
      ...(options.privateFile === false
        ? {}
        : {
            async writePrivateFile(path: string, content: string): Promise<void> {
              stage(path, content);
            },
          }),
      async exec(command: string, args: string[], execOptions?: { input?: string | Uint8Array; allowFailure?: boolean }): Promise<ExecResult> {
        return execStub(command, args, execOptions);
      },
    },
    runtime: { async isRunning(): Promise<boolean> { return false; } },
  } as unknown as Context;
  return { ctx, files, events, sudoCalls, output };
}

async function runLoadSecrets(scenario: ReturnType<typeof secretsScenario>): Promise<boolean> {
  let threw = false;
  try {
    await withOutputSink((line) => scenario.output.push(line), () => loadSecrets(scenario.ctx, SECRETS_UPDATED));
  } catch {
    threw = true;
  }
  return threw;
}

for (const privateFile of [true, false]) {
  const label = privateFile ? "capability" : "fallback";
  const scenario = secretsScenario({ privateFile });
  const threw = await runLoadSecrets(scenario);
  const stageEvent = scenario.events.find((event) => event.startsWith("stage:0600:")) ?? "";
  const stagedPath = stageEvent.slice("stage:0600:".length);
  const mvEvents = scenario.events.filter((event) => event.startsWith("mv:"));
  // Exact equality: the staging path has the final path as a prefix, so startsWith
  // would count the staging write itself as a direct write to the final path.
  const directWrites = scenario.events.filter((event) => event === `write:${SECRETS_FINAL}` || event === `stage:0600:${SECRETS_FINAL}`);
  const chownIndex = scenario.events.indexOf(`chown:1000:1000:${stagedPath}`);
  const mvIndex = scenario.events.indexOf(`mv:${stagedPath}=>${SECRETS_FINAL}`);
  check(`secrets (${label}) install without failing`, threw, false);
  check(`secrets (${label}) stage the content once, owner-only from creation`, stageEvent.startsWith("stage:0600:"), true);
  check(`secrets (${label}) reach the final path only by rename, never a direct write`, directWrites.length, 0);
  check(`secrets (${label}) publish with a single rename onto the final path`, mvEvents.length === 1 && mvEvents[0] === `mv:${stagedPath}=>${SECRETS_FINAL}`, true);
  check(`secrets (${label}) never chmod the staging path down from 600`, scenario.events.some((event) => event === `chmod:${stagedPath}:600`), false);
  check(`secrets (${label}) set owner 1000:1000 on the staging file before publication`, chownIndex > -1 && chownIndex < mvIndex, true);
  check(`secrets (${label}) install the updated content at the final path`, scenario.files.get(SECRETS_FINAL)?.content, SECRETS_UPDATED);
  check(`secrets (${label}) publish owner-only and owned by the gateway user`, `${scenario.files.get(SECRETS_FINAL)?.mode} ${scenario.files.get(SECRETS_FINAL)?.owner}`, "600 1000:1000");
  check(`secrets (${label}) leave no staging file behind`, [...scenario.files.keys()].filter((path) => path !== SECRETS_FINAL).length, 0);
  check(`secrets (${label}) still report the variable count`, scenario.output.join("").includes(`installed ${SECRETS_FINAL} (2 variable(s))`), true);
}

for (const fail of ["write", "chown", "mv"] as SecretFailure[]) {
  const scenario = secretsScenario({ fail });
  const threw = await runLoadSecrets(scenario);
  const previous = JSON.stringify({ content: SECRETS_PREVIOUS, mode: "600", owner: "1000:1000" });
  check(`secrets (${fail} failure) propagate the failure`, threw, true);
  check(`secrets (${fail} failure) leave the previous keys byte-for-byte intact`, JSON.stringify(scenario.files.get(SECRETS_FINAL)), previous);
  check(`secrets (${fail} failure) leave no file at the final path that is not the previous one`, [...scenario.files.keys()].filter((path) => path !== SECRETS_FINAL).length, 0);
  check(`secrets (${fail} failure) leave no staging file behind`, [...scenario.files.keys()].length, 1);
}

// --- P2-05: owning the staging file is not the right to hand it to another uid ------------
//
// chown 1000:1000 is a privileged operation whenever the current identity is not 1000:1000,
// no matter who owns the file being handed over — POSIX lets an owner keep or drop their own
// uid, never give the file away. The writability probe answers "can I write the file I just
// created" and always says yes here, so the escalation decision must compare the target
// owner against the current identity instead (the datadir.ts pattern).

{
  const scenario = secretsScenario({});
  const threw = await runLoadSecrets(scenario);
  check("P2-05: a runner whose own identity is the gateway's chowns without escalating", scenario.sudoCalls.length, 0);
  check("P2-05: that install still succeeds", threw, false);
  check("P2-05: the owner still ends 1000:1000", scenario.files.get(SECRETS_FINAL)?.owner, "1000:1000");
}

{
  const scenario = secretsScenario({ identity: "1001:1001" });
  const threw = await runLoadSecrets(scenario);
  const stageEvent = scenario.events.find((event) => event.startsWith("stage:0600:")) ?? "";
  const stagedPath = stageEvent.slice("stage:0600:".length);
  const chownIndex = scenario.events.indexOf(`chown:1000:1000:${stagedPath}`);
  const mvEvents = scenario.events.filter((event) => event.startsWith("mv:"));
  check("P2-05: another identity makes exactly one sudo call", scenario.sudoCalls.length, 1);
  check(
    "P2-05: that sudo call wraps the real chown to the gateway's owner",
    scenario.sudoCalls[0]?.includes("chown") === true && scenario.sudoCalls[0]?.includes("1000:1000") === true,
    true,
  );
  check("P2-05: the escalated install still succeeds", threw, false);
  check("P2-05: the final file is owned by the gateway user", scenario.files.get(SECRETS_FINAL)?.owner, "1000:1000");
  check(
    "P2-05: the chown still precedes the single rename",
    mvEvents.length === 1 && chownIndex > -1 && chownIndex < scenario.events.indexOf(mvEvents[0] ?? ""),
    true,
  );
}

{
  const scenario = secretsScenario({ identity: "1001:1001", noSudo: true });
  const threw = await runLoadSecrets(scenario);
  check("P2-05: the install is refused when sudo is unavailable", threw, true);
  check("P2-05: the refusal leaves the previous keys byte-for-byte intact", JSON.stringify(scenario.files.get(SECRETS_FINAL)), JSON.stringify({ content: SECRETS_PREVIOUS, mode: "600", owner: "1000:1000" }));
  check("P2-05: the refusal leaves no file at the final path that is not the previous one", [...scenario.files.keys()].filter((path) => path !== SECRETS_FINAL).length, 0);
  check("P2-05: the refusal publishes nothing, not even a rename", scenario.events.some((event) => event.startsWith("mv:")), false);
}

process.stderr.write(failed === 0 ? "all state checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
