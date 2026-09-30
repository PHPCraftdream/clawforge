// The live counterpart of compose-env: what restart cannot do and reconcile can, proven against
// a real disposable container with a synthetic value — the value in force is read back from
// docker inspect, not from anything this process mocked. Skipped without Docker Compose and a
// runnable local image.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime } from "#framework/runtime/docker/runtime-docker.ts";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import type { ExecOptions, Transport } from "#framework/runtime/transport/transport.ts";
import { LocalTransport, spawnLocal } from "#framework/runtime/transport/transport.ts";
import { parseEnv, type Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";
const composeLive = await spawnLocal("docker", ["compose", "version"], { allowFailure: true }).catch(() => undefined);
const runnableImage = await (async () => {
  if (composeLive?.code !== 0) return undefined;
  for (const candidate of ["alpine:3.20", "busybox:latest"]) {
    const probeImage = await spawnLocal("docker", ["image", "inspect", candidate], { allowFailure: true }).catch(() => undefined);
    if (probeImage?.code === 0) return candidate;
  }
  return undefined;
})();
if (runnableImage === undefined) {
  process.stderr.write("skip live recreate checks: Docker Compose or a runnable image is unavailable\n");
} else {
  const previousLive = (() => { try { return deploymentDir(); } catch { return undefined; } })();
  const scratch = await mkdtemp(join(tmpdir(), "clawforge-recreate-live-"));
  // The deployment directory's basename becomes the compose project name, and mkdtemp's random
  // suffix may contain uppercase — compose project names must be lowercase — so the deployment
  // is its own subdirectory named from lowercase hex instead.
  const project = `deploy-${randomBytes(6).toString("hex")}`;
  // Forward slashes even on Windows: locksDir() slices the data directory at the last "/", so
  // the runtime's temporary compose.env lands beside it only if the path carries slashes — and
  // the .env content must agree, since reconcile() re-reads that file verbatim.
  const deployDir = join(scratch, project).replaceAll("\\", "/");
  const dataDir = `${deployDir}/data`;
  const definitionPath = join(scratch, "compose.json");
  const envPath = join(deployDir, ".env");
  const NAME = "CLAWFORGE_PROBE_VAR";
  const OLD = "old-synthetic-value";
  const NEW = "new-synthetic-value";
  const envBody = (probeValue: string) =>
    `OC_DATA_DIR=${dataDir}\nOPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:pinned\n${NAME}=${probeValue}\n`;
  await mkdir(deployDir, { recursive: true });
  await writeFile(definitionPath, JSON.stringify({
    services: {
      probe: {
        image: runnableImage,
        command: ["sleep", "300"],
        environment: { [NAME]: `\${${NAME}}` },
      },
    },
  }));
  await writeFile(envPath, envBody(OLD), "utf8");
  useDeployment(deployDir);
  // LocalTransport directly: bypasses ./clawforge's own LOCAL_TARGET_UNSUPPORTED refusal
  // to exec `docker` on whatever host has it on PATH, gated on above.
  const local = new LocalTransport();
  // DockerRuntime composes the framework's own docker-compose.yml (the real gateway
  // definition); the fixture proves the recreate mechanics with a scratch definition instead —
  // everything else (env-file plumbing, project naming, the up verb, real docker) is
  // unmodified, and the real instance's definition stays out of the test. Built on the local
  // transport's prototype rather than a spread: a class instance's methods do not survive one.
  const fixtureTransport: Transport = Object.assign(Object.create(Object.getPrototypeOf(local)), local, {
    exec: (command: string, args: string[], options?: ExecOptions) => {
      if (args.includes("--file")) {
        const at = args.indexOf("--file");
        const redirected = [...args];
        redirected[at + 1] = definitionPath;
        return local.exec(command, redirected, options);
      }
      return local.exec(command, args, options);
    },
  });
  // serviceUrl is never probed here: the fixture has no healthz, and the real gateway listens
  // at that URL on this machine — probing it from a check would touch the real instance.
  const runtime = new DockerRuntime(
    fixtureTransport,
    { env: parseEnv(envBody(OLD)), dataDir, image: "ghcr.io/openclaw/openclaw:pinned", serviceUrl: "http://127.0.0.1:18789" } as unknown as Settings,
    { toTarget: async (path) => path } as PathBridge,
    { service: "probe" },
  );
  try {
    // The daemon's answer, not this process's: the container id compose runs and the
    // environment docker recorded into it at creation.
    const valueInForce = async (): Promise<{ id: string; values: Map<string, string> }> => {
      const listed = await spawnLocal("docker", ["compose", "--project-name", project, "--file", definitionPath, "ps", "--quiet", "probe"]);
      const id = listed.stdout.trim();
      const inspected = await spawnLocal("docker", ["inspect", "--format", "{{json .Config.Env}}", id]);
      const entries = JSON.parse(inspected.stdout.trim()) as string[];
      return {
        id,
        values: new Map(entries.map((entry) => {
          const at = entry.indexOf("=");
          return [entry.slice(0, at), entry.slice(at + 1)] as const;
        })),
      };
    };
    await runtime.start();
    const baseline = await valueInForce();
    assert.ok(baseline.values.get(NAME) === OLD, "the created container runs the initial value");
    await runtime.restart();
    const afterRestart = await valueInForce();
    // The audited bug mechanism, pinned live: compose restart re-runs the command inside the
    // existing container, whose Config.Env was interpolated once at creation — no rotation can
    // cross that boundary, however fresh the .env on disk has become.
    assert.ok(afterRestart.id === baseline.id, "restart keeps the container compose created");
    assert.ok(afterRestart.values.get(NAME) === OLD, "restart leaves the created environment in force");
    // Rotate the deployment .env on disk; the runtime keeps the snapshot it was built with.
    await writeFile(envPath, envBody(NEW), "utf8");
    await runtime.reconcile();
    const afterReconcile = await valueInForce();
    assert.ok(afterReconcile.id !== baseline.id, "reconcile replaces the container when the interpolated environment changed");
    assert.ok(afterReconcile.values.get(NAME) === NEW, "the running container holds the rotated value");
    process.stderr.write("live recreate checks passed\n");
  } finally {
    // stop() takes the fixture project down through the same plumbing the test used; the
    // explicit down is belt and braces for the case where that plumbing itself failed.
    await runtime.stop().catch(() => {});
    await spawnLocal("docker", ["compose", "--project-name", project, "--file", definitionPath, "down", "--volumes"], { allowFailure: true }).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
    if (previousLive !== undefined) useDeployment(previousLive);
  }
}
