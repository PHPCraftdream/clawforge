// `./clawforge upgrade` — resolve the target image to a digest (never moving a shared local
// tag), take a pre-upgrade backup, recreate the gateway, and roll back to the digest it was
// running before on any failure — restoring that backup too when the failure was a migration
// (upstream: exit 78) that may already have changed the data.
//
// Lives here rather than under lifecycle/ or orchestration/: both are already at the
// directory's 7-entry layout cap, and this command's central fact — OPENCLAW_IMAGE — is one
// of the four connection facts this directory otherwise already covers.

import { mkdtemp, writeFile, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgrade } from "#framework/commands/lifecycle/lifecycle.ts";
import { useDeployment, envFile } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { mountPoints } from "#framework/runtime/mounts.ts";
import { toContainerPath, fromContainerPath } from "#framework/core/paths.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { DockerRuntime } from "#framework/runtime/docker/runtime-docker.ts";
import { toSettings, parseEnv } from "#framework/core/env.ts";
import type { Transport, ExecOptions } from "#framework/runtime/transport/transport.ts";

// pinImageReference (lifecycle.ts) writes the deployment's OWN .env on success — a real
// repo-side file, not one ctx.transport can stand in for — so a real temporary deployment
// directory backs this file's checks, cleaned up at the end.
const deploymentDir = await mkdtemp(join(tmpdir(), "clawforge-upgrade-check-"));
useDeployment(deploymentDir);
await writeFile(envFile(), "OC_DATA_DIR=/srv/clawforge/data\nOPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable\n", "utf8");

const DATA_DIR = "/srv/clawforge/data";
const SHARED_TAG = "ghcr.io/openclaw/openclaw:extended-stable";
const TARGET_DIGEST = `${SHARED_TAG.split(":")[0]}@sha256:target00000000000000000000000000000000000000000000000000000000`;
const PREVIOUS_DIGEST = `${SHARED_TAG.split(":")[0]}@sha256:previous0000000000000000000000000000000000000000000000000000`;
// A pin left by a healthy bootstrap/upgrade under the tag-preserving form — the exact digest
// here is never resolved again; only its channel (SHARED_TAG) is.
const PINNED_WITH_TAG = `${SHARED_TAG}@sha256:pinned000000000000000000000000000000000000000000000000000000`;
// A pin with no tag alongside the digest — the channel it came from cannot be recovered
// without guessing.
const PINNED_NO_TAG = `${SHARED_TAG.split(":")[0]}@sha256:pinned000000000000000000000000000000000000000000000000000000`;

type Scenario = "success" | "health-fail" | "exit78" | "doctor-fail";

/** A backup/restore-compatible POSIX stub, permissive by default (matching the proven shape
 *  restore.check.ts's own makeCtx() and backup.check.ts's stubBackupCtx() already use), plus
 *  the runtime primitives ./clawforge upgrade itself asks for. `image` overrides the
 *  deployment's own OPENCLAW_IMAGE, for the pinned-channel scenarios below. */
function makeUpgradeCtx(scenario: Scenario, options: { image?: string } = {}): { ctx: Context; calls: string[]; runningDigest: () => string } {
  const calls: string[] = [];
  const files = new Set([DATA_DIR]);
  let runningDigest = PREVIOUS_DIGEST;
  const holder = JSON.stringify({ operationId: "op", what: "x", by: "a@b pid 1", takenAt: new Date().toISOString() });

  const mounts = mountPoints(DATA_DIR);
  const ctx = {
    settings: { dataDir: DATA_DIR, backupDir: "/srv/clawforge/backups", env: {}, image: options.image ?? SHARED_TAG },
    paths: {
      toContainer: (path: string) => toContainerPath(path, mounts),
      fromContainer: (path: string) => fromContainerPath(path, mounts),
    },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> { return files.has(path) || path === DATA_DIR; },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("holder.json")) return holder;
        return "{}";
      },
      async writeFile(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async remove(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        calls.push(`exec ${command} ${args.join(" ")}`);
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: args[1] ?? "", stderr: "" };
        if (command === "stat") return { code: 0, stdout: "1000:1000", stderr: "" };
        if (command === "test") return { code: files.has(args[1] ?? "") || args[0] !== "-e" ? 0 : 1, stdout: "", stderr: "" };
        if (command === "mkdir" && args.length === 1) return { code: 0, stdout: "", stderr: "" };
        if (command === "tar" && args.includes("-tzf")) return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        if (command === "tar" && args.includes("-tvzf")) return { code: 0, stdout: "", stderr: "" };
        if (command === "tar" && args.includes("-czf")) { files.add(args[args.indexOf("-czf") + 1] ?? ""); return { code: 0, stdout: "", stderr: "" }; }
        if (command === "mv") {
          const source = args.at(-2) ?? "";
          const destination = args.at(-1) ?? "";
          if (files.has(source)) { files.delete(source); files.add(destination); }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "find") return { code: 0, stdout: "", stderr: "" };
        if (command === "rm") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: {
      description: "docker",
      async isRunning(): Promise<boolean> { return scenario !== "health-fail" && scenario !== "exit78"; },
      async pause(): Promise<void> {},
      // Migration compensation restores while stopped, then recreates the previous image.
      async start(): Promise<void> { runningDigest = PREVIOUS_DIGEST; },
      async stop(): Promise<void> {},
      async waitForHealth(): Promise<void> {
        if (scenario === "health-fail") throw new Error("the service did not become healthy");
      },
      async probe(): Promise<number> { return scenario === "health-fail" || scenario === "exit78" ? 0 : 200; },
      async lastExitCode(): Promise<number | undefined> {
        if (scenario === "exit78") return 78;
        return scenario === "health-fail" ? 1 : 0;
      },
      async resolveImageDigest(reference: string): Promise<string | undefined> {
        calls.push(`resolveImageDigest ${reference}`);
        return reference === SHARED_TAG ? TARGET_DIGEST : undefined;
      },
      async recreateWithImage(reference: string, onMutationStart?: () => void): Promise<void> {
        calls.push(`recreateWithImage ${reference}`);
        onMutationStart?.();
        runningDigest = reference;
      },
      async runningImageIdentity(): Promise<{ imageId: string; digests: string[]; containerId: string }> {
        return { imageId: "id", digests: [runningDigest], containerId: "c" };
      },
      async runOneOff(_service: string, cliArgs: string[]): Promise<ExecResult> {
        calls.push(`runOneOff ${cliArgs.join(" ")}`);
        if (cliArgs[0] === "backup" && cliArgs[1] === "create") {
          // Simulates an image without native support: createBackup() falls back to its
          // classic stopped path, which this stub's transport already knows how to drive.
          return { code: 1, stdout: "", stderr: "error: unknown command 'backup'" };
        }
        if (cliArgs[0] === "doctor") {
          const findings = scenario === "doctor-fail" ? [{ severity: "error", checkId: "x", message: "broken" }] : [];
          return { code: findings.length > 0 ? 1 : 0, stdout: JSON.stringify({ ok: findings.length === 0, findings }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  return { ctx, calls, runningDigest: () => runningDigest };
}

// --- success path ----------------------------------------------------------------------------

{
  const { ctx, calls, runningDigest } = makeUpgradeCtx("success");
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await upgrade(ctx, []); } catch (error) { failure = error; }
  });
  check("a healthy upgrade completes without throwing", failure, undefined);
  check("it recreates on the resolved target digest", runningDigest(), TARGET_DIGEST);
  check("it takes a pre-upgrade backup before recreating", calls.some((call) => call.startsWith("runOneOff backup create")), true);
  check("it runs openclaw doctor --lint", calls.some((call) => call.startsWith("runOneOff doctor")), true);
}

// --- shared tag is never retagged: resolved by digest, recreated by digest, never `docker pull <tag>`

{
  const { ctx, calls } = makeUpgradeCtx("success");
  await withOutputSink(() => {}, () => upgrade(ctx, []));
  check("the tag is resolved through resolveImageDigest, not a pull", calls.some((call) => call.startsWith(`resolveImageDigest ${SHARED_TAG}`)), true);
  check("recreate always names a digest reference, never the bare tag", calls.some((call) => call === `recreateWithImage ${TARGET_DIGEST}`), true);
  check("the shared tag itself is never handed to recreateWithImage", calls.some((call) => call === `recreateWithImage ${SHARED_TAG}`), false);
}

// --- a generic health failure rolls back to the previous digest, without restoring data ------

{
  const { ctx, calls, runningDigest } = makeUpgradeCtx("health-fail");
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await upgrade(ctx, []); } catch (error) { failure = error; }
  });
  check("a health failure is reported as a failure", failure instanceof Error, true);
  check("it rolls back to the previous digest", runningDigest(), PREVIOUS_DIGEST);
  check("it recreates on the previous digest to roll back", calls.filter((call) => call === `recreateWithImage ${PREVIOUS_DIGEST}`).length, 1);
  check("a non-migration failure never restores the backup", calls.some((call) => call.includes("-xzf")), false);
}

// --- exit 78 (migration failure) rolls back AND restores the pre-upgrade backup --------------

{
  const { ctx, calls, runningDigest } = makeUpgradeCtx("exit78");
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await upgrade(ctx, []); } catch (error) { failure = error; }
  });
  check("an exit-78 failure is reported as a failure", failure instanceof Error, true);
  check("the reported reason names the migration exit", failure instanceof Error && failure.message.includes("78"), true);
  // Compensation restores while stopped before recreating the exact previous digest.
  check("data is restored rather than merely recreated back", calls.some((call) => call.includes("-xzf")), true);
  check("the running digest is not left on the failed target", runningDigest() !== TARGET_DIGEST, true);
}

// --- a blocking doctor --lint finding rolls back like any other health failure ---------------

{
  const { ctx, runningDigest } = makeUpgradeCtx("doctor-fail");
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await upgrade(ctx, []); } catch (error) { failure = error; }
  });
  check("a blocking doctor finding fails the upgrade", failure instanceof Error, true);
  check("and rolls back to the previous digest", runningDigest(), PREVIOUS_DIGEST);
}

// --- --dry-run changes nothing, and takes no lock --------------------------------------------

{
  const { ctx, calls } = makeUpgradeCtx("success");
  await withOutputSink(() => {}, () => upgrade(ctx, ["--dry-run"]));
  check("--dry-run never recreates the gateway", calls.some((call) => call.startsWith("recreateWithImage")), false);
  check("--dry-run never takes a backup", calls.some((call) => call.startsWith("runOneOff backup create")), false);
  check("--dry-run never runs doctor --lint", calls.some((call) => call.startsWith("runOneOff doctor")), false);
  check("--dry-run still resolves the digest to report the real plan", calls.some((call) => call.startsWith("resolveImageDigest")), true);
}

// --- already on the target digest is a no-op, not a needless recreate ------------------------

{
  const { ctx, calls } = makeUpgradeCtx("success");
  (ctx.runtime as unknown as { resolveImageDigest: (reference: string) => Promise<string> }).resolveImageDigest = async () => PREVIOUS_DIGEST;
  await withOutputSink(() => {}, () => upgrade(ctx, []));
  check("nothing recreates when already on the resolved digest", calls.some((call) => call.startsWith("recreateWithImage")), false);
}

// --- upgrade with no --image, after a tag-preserving pin, re-resolves the CHANNEL (`repo:tag`),
// never the stale digest already sitting in the pin — a moved tag must still be caught, or
// `upgrade` silently stops doing anything the moment bootstrap/a prior upgrade pins.

{
  const { ctx, calls, runningDigest } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await upgrade(ctx, []); } catch (error) { failure = error; }
  });
  check("upgrading off a tag-preserving pin succeeds", failure, undefined);
  check("the channel alone is resolved", calls.some((call) => call === `resolveImageDigest ${SHARED_TAG}`), true);
  check("the stale pinned reference itself is never asked about", calls.some((call) => call === `resolveImageDigest ${PINNED_WITH_TAG}`), false);
  check("it recreates on the newly resolved digest, not the old pin", runningDigest(), TARGET_DIGEST);
}

// --- the same check, but the channel's registry digest has not moved — a no-op, not a
// recreate onto the very reference already running -------------------------------------------

{
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  (ctx.runtime as unknown as { resolveImageDigest: (reference: string) => Promise<string> }).resolveImageDigest = async () => PREVIOUS_DIGEST;
  await withOutputSink(() => {}, () => upgrade(ctx, []));
  check("nothing recreates when the channel still resolves to what is running", calls.some((call) => call.startsWith("recreateWithImage")), false);
}

// --- a pin from before this fix (digest with no tag) cannot be re-resolved — refused with
// the one remedy that applies, never guessed -----------------------------------------------

{
  const { ctx, calls } = makeUpgradeCtx("success", { image: PINNED_NO_TAG });
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await upgrade(ctx, []); } catch (error) { failure = error; }
  });
  check("an untagged pin refuses rather than guessing a channel", failure instanceof Error, true);
  check("the refusal names the remedy", failure instanceof Error && failure.message.includes("--image"), true);
  check("nothing was asked of the registry — there is no channel to resolve", calls.some((call) => call.startsWith("resolveImageDigest")), false);
  check("and nothing recreates", calls.some((call) => call.startsWith("recreateWithImage")), false);
}

// --- --dry-run reports the current digest, the channel, and the registry's answer for it ------

{
  const { ctx } = makeUpgradeCtx("success", { image: PINNED_WITH_TAG });
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, () => upgrade(ctx, ["--dry-run"]));
  check("--dry-run shows the currently running digest", output.includes(PREVIOUS_DIGEST), true);
  check("--dry-run names the channel it will re-resolve", output.includes(SHARED_TAG), true);
  check("--dry-run shows what the channel resolves to at the registry", output.includes(TARGET_DIGEST), true);
}

// Exercise the real DockerRuntime and Compose environment selection, with only the
// transport standing in for Docker/the target filesystem. Backup uses the same POSIX
// fixture as above; neither runOneOff nor recreateWithImage is independently mocked.
type DockerScenario = "success" | "reject-b" | "cleanup" | "validator" | "pin" | "rollback" | "backup" | "prepare" | "migration-exception" | "identity";

async function dockerUpgradeScenario(scenario: DockerScenario): Promise<void> {
  await writeFile(envFile(), `OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${PREVIOUS_DIGEST}\n`);
  const { ctx } = makeUpgradeCtx("success");
  const delegate = ctx.transport;
  const envFiles = new Map<string, string>();
  const recreations: string[] = [];
  const doctors: string[] = [];
  let running = PREVIOUS_DIGEST;
  let cleanupFailure = false;
  let pinFileHidden = false;
  let doctorDone = false;
  let restored = false;
  const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const settings = toSettings(parseEnv(await readFile(envFile(), "utf8")));
  const transport = {
    ...delegate,
    async listFiles(): Promise<string[]> { return []; },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      envFiles.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8"));
      if (scenario === "prepare" && path.endsWith("compose.env") && envFiles.get(path)?.includes(TARGET_DIGEST)) {
        throw new Error("target environment write denied");
      }
    },
    async remove(path: string): Promise<void> {
      if (path.includes("/compose-") && cleanupFailure) {
        cleanupFailure = false;
        throw new Error("target env cleanup denied");
      }
    },
    async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
      if (command === "curl") {
        if (running === TARGET_DIGEST && scenario === "migration-exception") throw new Error("probe transport lost");
        return ok("200");
      }
      if (command === "docker") {
        if (args[0] === "ps") return ok("gateway-container");
        if (args[0] === "inspect") {
          if (args.includes("{{.State.ExitCode}}")) return ok(running === TARGET_DIGEST && scenario === "migration-exception" ? "78" : "0");
          return ok(JSON.stringify({ Image: running, State: { Running: true } }));
        }
        if (args[0] === "image") {
          if (doctorDone && running === TARGET_DIGEST && scenario === "pin" && !pinFileHidden) {
            await rename(envFile(), `${envFile()}.saved`);
            pinFileHidden = true;
          }
          return ok(JSON.stringify({ RepoDigests: [doctorDone && scenario === "identity" ? PREVIOUS_DIGEST : running] }));
        }
        if (args[0] === "compose") {
          const envPath = args[args.indexOf("--env-file") + 1] ?? "";
          const image = parseEnv(envFiles.get(envPath) ?? "").OPENCLAW_IMAGE;
          if (args.includes("up")) {
            recreations.push(image);
            if (image === PREVIOUS_DIGEST && recreations.includes(TARGET_DIGEST)) {
              if (scenario === "rollback") throw new Error("previous image recreation denied");
              if (pinFileHidden) {
                await rename(`${envFile()}.saved`, envFile());
                pinFileHidden = false;
              }
            }
            running = image;
            if (image === TARGET_DIGEST && scenario === "cleanup") cleanupFailure = true;
            return ok();
          }
          if (args.includes("run")) {
            if (args.includes("backup")) return { code: 1, stdout: "", stderr: "error: unknown command 'backup'" };
            if (args.includes("doctor")) {
              doctors.push(image);
              check(`${scenario}: durable pin stays A throughout doctor`, parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE, PREVIOUS_DIGEST);
              doctorDone = true;
              if (scenario === "validator" || scenario === "rollback") throw new Error("validator transport lost");
              const findings = scenario === "reject-b" && image === TARGET_DIGEST ? [{ severity: "error", checkId: "schema", message: "B rejects configuration" }] : [];
              return ok(JSON.stringify({ findings }));
            }
          }
          if (args.includes("ps")) return ok("gateway-container");
          return ok();
        }
      }
      if (command === "tar" && args.includes("-czf") && scenario === "backup") throw new Error("backup archive failed");
      if (command === "tar" && args.includes("-xzf")) restored = true;
      return delegate.exec(command, args, options);
    },
  } as Transport;
  const paths = { ...ctx.paths, async toTarget(path: string): Promise<string> { return path; } };
  const dockerCtx: Context = {
    ...ctx, transport, paths,
    runtime: new DockerRuntime(transport, settings, paths, { service: "gateway", reconcileSettings: async () => settings }),
  };
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await upgrade(dockerCtx, ["--image", TARGET_DIGEST]); } catch (error) { failure = error; }
  });
  if (scenario === "success") {
    check("Docker success returns without failure", failure, undefined);
    check("Docker success running identity is B", running, TARGET_DIGEST);
    check("Docker success publishes B after validation", parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE, TARGET_DIGEST);
  } else {
    check(`${scenario}: upgrade reports failure`, failure instanceof Error, true);
    check(`${scenario}: B is not durably pinned`, parseEnv(await readFile(envFile(), "utf8")).OPENCLAW_IMAGE, PREVIOUS_DIGEST);
    const expectedReason: Partial<Record<DockerScenario, string>> = {
      "reject-b": "B rejects configuration",
      cleanup: "target env cleanup denied",
      validator: "validator transport lost",
      rollback: "validator transport lost",
      backup: "backup archive failed",
      prepare: "target environment write denied",
      "migration-exception": "probe transport lost",
      identity: "could not confirm the validated gateway",
      pin: "ENOENT",
    };
    check(`${scenario}: original failure is preserved`, failure instanceof Error && failure.message.includes(expectedReason[scenario] ?? ""), true);
    if (scenario === "backup" || scenario === "prepare") {
      check(`${scenario}: no target-image mutation begins before backup/preparation succeeds`, recreations.includes(TARGET_DIGEST), false);
    } else if (scenario === "rollback") {
      check("failed compensation retains both causes", failure instanceof AggregateError && failure.errors.length === 2 && failure.message.includes("validator transport lost") && failure.message.includes("previous image recreation denied"), true);
      check("failed compensation never claims rollback succeeded", failure instanceof Error && failure.message.includes("was rolled back"), false);
    } else {
      check(`${scenario}: exact previous digest is recreated`, recreations.includes(PREVIOUS_DIGEST), true);
      check(`${scenario}: running identity is restored to A`, running, PREVIOUS_DIGEST);
      check(`${scenario}: compensation outcome is reported`, failure instanceof Error && failure.message.includes("was rolled back") && failure.message.includes("pre-upgrade backup:"), true);
    }
  }
  if (doctors.length > 0) check(`${scenario}: actual Compose doctor image is B`, doctors, [TARGET_DIGEST]);
  check(`${scenario}: backup restoration is restricted to migration failure`, restored, scenario === "migration-exception");
}

for (const scenario of ["success", "reject-b", "cleanup", "validator", "pin", "rollback", "backup", "prepare", "migration-exception", "identity"] as const) {
  await dockerUpgradeScenario(scenario);
}

await rm(deploymentDir, { recursive: true, force: true });

finish("upgrade");
