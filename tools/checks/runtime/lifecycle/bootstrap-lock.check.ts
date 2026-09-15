// `./clawforge bootstrap` must hold the instance lock across its ENTIRE mutating sequence,
// not rely on the sub-commands it calls (applyConfig, configureProvider) to each take their
// own separately.
//
// Before the fix, ensureDataDirs/ensureSecretsFile ran with no lock check of their own at
// all — bootstrap only ever found out another operation was contending for the instance
// once applyConfig's own internal guarded() call finally refused, by which point
// ensureSecretsFile had already written config/.env. This proves the refusal now happens
// before anything is written at all: with another operation already holding the lock,
// bootstrap must refuse immediately, and nothing downstream of that refusal — not
// ensureDataDirs, not ensureSecretsFile, not the image pull, not a single write — may run.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrap } from "#framework/commands/lifecycle/bootstrap.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";

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

const DATA_DIR = "/srv/openclaw/data";

const deployment = await mkdtemp(join(tmpdir(), "clawforge-bootstrap-lock-check-"));
try {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  await writeFile(resolve(deployment, "config", "desired-state.json"), "[]");
  useDeployment(deployment);

  const holder = JSON.stringify({
    operationId: "op-holder",
    what: "apply",
    by: "someone@host pid 1",
    takenAt: new Date().toISOString(),
  });
  const writes: string[] = [];
  const runtimeCalls: string[] = [];
  const execCalls: string[][] = [];

  const ctx = {
    settings: {
      dataDir: DATA_DIR,
      env: { OPENCLAW_GATEWAY_TOKEN: "test-token" },
      image: "ghcr.io/openclaw/openclaw:extended-stable",
      gatewayPort: "18789",
      serviceUrl: "http://127.0.0.1:18789",
    },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        // The secrets file must look ABSENT, or ensureSecretsFile's own "already there,
        // nothing to do" early return means it never even attempts the write this test
        // exists to catch — everything else can report present, since creating data
        // directories that already exist is not what this test is about.
        return !path.endsWith("config/.env");
      },
      async readFile(path: string): Promise<string> {
        return path.endsWith("holder.json") ? holder : "";
      },
      async writeFile(path: string): Promise<void> {
        writes.push(path);
      },
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
        execCalls.push([command, ...args]);
        // The lock claim itself: mkdir (not -p) is refused, and the directory is reported
        // as existing — the exact shape takeLock() reads as "held by someone else".
        if (command === "mkdir" && args[0] !== "-p") return { code: 1, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-d") return { code: 0, stdout: "", stderr: "" };
        const code = 0;
        if (code !== 0 && options.allowFailure !== true) throw new Error(`${command} failed`);
        return { code, stdout: "", stderr: "" };
      },
    },
    paths: { toContainer: (path: string) => path },
    runtime: {
      async pullImage(): Promise<void> {
        runtimeCalls.push("pullImage");
      },
      async runOneOff(): Promise<{ code: number; stdout: string; stderr: string }> {
        runtimeCalls.push("runOneOff");
        return { code: 0, stdout: "", stderr: "" };
      },
      async start(): Promise<void> {
        runtimeCalls.push("start");
      },
      async waitForHealth(): Promise<void> {
        runtimeCalls.push("waitForHealth");
      },
      async imageReference(): Promise<string | undefined> {
        return undefined;
      },
    },
  } as unknown as Context;

  let refused = "";
  try {
    await withOutputSink(() => {}, () => bootstrap(ctx, ["--no-pull"]));
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }

  check(
    "bootstrap refuses when another operation already holds the instance lock",
    refused.includes("another operation is changing this instance"),
    true,
  );
  check("nothing is ever written — not even config/.env (ensureSecretsFile)", writes.length, 0);
  check("the runtime is never touched — no pull, no config apply, no start", runtimeCalls.length, 0);

  {
    // A truly fresh host: the lock's own home directory does not exist yet, and its parent
    // is root:root — writable only via passwordless sudo. Before the fix, guarded()'s own
    // unprivileged claim ran BEFORE ensureDataDirs (and the ensureLockHome escalation inside
    // it) ever got a chance to run, so the first bootstrap ever attempted on such a host
    // died inside claimDirectory() itself, telling the reader to run the very command that
    // was failing. This proves the escalation now happens, and happens BEFORE the lock is
    // claimed.
    const home = "/srv/openclaw/data-locks";
    const lockPath = `${home}/operation.lock`;
    let lockHomeCreated = false;
    let lockHomeWritable = false;
    const freshExecCalls: string[][] = [];

    const freshCtx = {
      settings: {
        dataDir: DATA_DIR,
        env: { OPENCLAW_GATEWAY_TOKEN: "test-token" },
        image: "ghcr.io/openclaw/openclaw:extended-stable",
        gatewayPort: "18789",
        serviceUrl: "http://127.0.0.1:18789",
      },
      transport: {
        description: "stub",
        async exists(path: string): Promise<boolean> {
          if (path === home) return lockHomeCreated;
          if (path.endsWith("config/.env")) return false;
          return true;
        },
        async readFile(path: string): Promise<string> {
          if (path.endsWith("holder.json")) throw new Error("no holder recorded");
          return "";
        },
        async writeFile(): Promise<void> {},
        async remove(): Promise<void> {},
        async mkdirp(): Promise<void> {},
        async exec(command: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
          freshExecCalls.push([command, ...args]);

          if (command === "mkdir" && args[0] === "-p" && args[1] === home) {
            return { code: lockHomeCreated ? 0 : 1, stdout: "", stderr: "" };
          }
          if (command === "mkdir" && args[0] !== "-p") {
            // The lock claim itself: succeeds once the home exists and is owned.
            return { code: lockHomeCreated && lockHomeWritable ? 0 : 1, stdout: "", stderr: "" };
          }
          if (command === "test" && args[0] === "-d") {
            return { code: 1, stdout: "", stderr: "" };
          }
          if (command === "test" && args[0] === "-w") {
            const target = args[1];
            return { code: target === home && lockHomeWritable ? 0 : 1, stdout: "", stderr: "" };
          }
          if (command === "sh" && args.join(" ").includes("command -v sudo")) {
            return { code: 0, stdout: "/usr/bin/sudo\n", stderr: "" };
          }
          if (command === "sudo" && args[0] === "-n") {
            if (args[1] === "true") return { code: 0, stdout: "", stderr: "" };
            if (args.includes("mkdir")) {
              lockHomeCreated = true;
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args.includes("chown")) {
              lockHomeWritable = true;
              return { code: 0, stdout: "", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "id") return { code: 0, stdout: "1000\n", stderr: "" };
          const code = 0;
          if (code !== 0 && options.allowFailure !== true) throw new Error(`${command} failed`);
          return { code, stdout: "", stderr: "" };
        },
      },
      paths: { toContainer: (path: string) => path },
      runtime: {
        async pullImage(): Promise<void> {},
        async runOneOff(): Promise<{ code: number; stdout: string; stderr: string }> {
          return { code: 0, stdout: "", stderr: "" };
        },
        async start(): Promise<void> {},
        async waitForHealth(): Promise<void> {},
        async imageReference(): Promise<string | undefined> {
          return undefined;
        },
      },
    } as unknown as Context;

    let freshError = "";
    try {
      await withOutputSink(() => {}, () => bootstrap(freshCtx, ["--no-pull"]));
    } catch (error) {
      freshError = error instanceof Error ? error.message : String(error);
    }

    check(
      "a fresh host does not die inside the lock claim telling the reader to run bootstrap",
      freshError.includes("./clawforge bootstrap prepares it"),
      false,
    );
    const homeMkdirIndex = freshExecCalls.findIndex((call) => call[0] === "sudo" && call.includes("mkdir") && call.includes(home));
    const homeChownIndex = freshExecCalls.findIndex((call) => call[0] === "sudo" && call.includes("chown") && call.includes(home));
    const lockClaimIndex = freshExecCalls.findIndex((call) => call[0] === "mkdir" && call[1] === lockPath);
    check("the lock home is created via sudo before the lock is claimed", homeMkdirIndex !== -1 && lockClaimIndex !== -1 && homeMkdirIndex < lockClaimIndex, true);
    check("and made writable via sudo before the lock is claimed", homeChownIndex !== -1 && lockClaimIndex !== -1 && homeChownIndex < lockClaimIndex, true);
  }
} finally {
  await rm(deployment, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all bootstrap lock checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
