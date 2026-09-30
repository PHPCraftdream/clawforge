// DockerRuntime's upgrade support: digest resolution, a pinned recreate, and the exit code a
// migration failure (upstream: 78) is told apart from one still starting by. Stubbed transport.

import assert from "node:assert/strict";
import { DockerRuntime } from "#framework/runtime/docker/runtime-docker.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import type { Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";
{
  useDeployment("/fixture/deployment");
  const calls: { command: string; args: string[] }[] = [];
  const writes: { path: string; content: string }[] = [];
  let containerIdStdout = "container-x", exitCodeStdout = "78\n";
  const transport = {
    exec: async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === "docker" && args[0] === "buildx") {
        return args.includes("bad-registry-ref")
          ? { code: 1, stdout: "", stderr: "not found" }
          : { code: 0, stdout: "Name:      x\nMediaType: y\nDigest:    sha256:deadbeef\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "ps" && args.includes("--all")) return { code: 0, stdout: containerIdStdout, stderr: "" };
      if (args[0] === "compose" && args.includes("ps")) return { code: 0, stdout: containerIdStdout, stderr: "" };
      if (command === "docker" && args[0] === "inspect" && args.includes("{{.State.ExitCode}}")) return { code: 0, stdout: exitCodeStdout, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    mkdirp: async () => {},
    writeFile: async (path: string, content: string) => { writes.push({ path, content }); },
    remove: async () => {},
  } as unknown as Transport;
  const runtime = new DockerRuntime(
    transport,
    { env: {}, image: "ghcr.io/openclaw/openclaw:extended-stable", dataDir: "/srv/openclaw/data" } as Settings,
    { toTarget: async (path: string) => path } as PathBridge,
    { service: "gateway", reconcileSettings: async () => ({ env: { OPENCLAW_IMAGE: "old-ref" }, image: "old-ref", dataDir: "/srv/openclaw/data" } as unknown as Settings) },
  );

  assert.equal(await runtime.resolveImageDigest!("ghcr.io/openclaw/openclaw:extended-stable"), "ghcr.io/openclaw/openclaw:extended-stable@sha256:deadbeef", "resolves a tag via buildx imagetools, keeping the tag alongside the digest");
  assert.equal(calls.some((call) => call.command === "docker" && call.args.includes("pull")), false, "resolving a digest never pulls");
  assert.equal(await runtime.resolveImageDigest!("myregistry:5000/repo:tag"), "myregistry:5000/repo:tag@sha256:deadbeef", "a registry port is not mistaken for the tag separator, and the tag survives alongside it");
  assert.equal(await runtime.resolveImageDigest!("bad-registry-ref"), undefined, "an unresolvable reference answers undefined, never a guess");

  await runtime.recreateWithImage!("ghcr.io/openclaw/openclaw@sha256:pinned");
  assert.equal(writes.some((write) => write.content.includes("OPENCLAW_IMAGE") && write.content.includes("sha256:pinned")), true, "recreateWithImage pins the compose env file to the given reference");
  assert.equal(calls.some((call) => call.args.includes("up") && call.args.includes("--detach")), true, "recreateWithImage recreates through compose up");

  assert.equal(await runtime.lastExitCode!(), 78, "reads the container's own exit code");
  containerIdStdout = "";
  assert.equal(await runtime.lastExitCode!(), undefined, "no container means no exit code to read");
  process.stderr.write("all upgrade-support runtime checks passed\n");
}
