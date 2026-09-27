// Registry digest resolution and exit-code readback for ./clawforge upgrade, split out of
// runtime/runtime-docker.ts to keep it under the line cap — same reasoning as
// spawn-failure.ts beside this file.

import type { Transport } from "../runtime/transport.ts";

/** Registry digest for `reference` via `docker buildx imagetools inspect` — never pulls a
 *  layer or moves a local tag, unlike `docker pull`/`docker image inspect`, which only ever
 *  answer for what is already local. Undefined on any failure (offline registry, buildx
 *  missing, unparseable output): "could not ask" must never read as "asked and got nothing". */
export async function resolveImageDigest(transport: Transport, reference: string): Promise<string | undefined> {
  const result = await transport.exec("docker", ["buildx", "imagetools", "inspect", reference], { allowFailure: true });
  const digest = result.code === 0 ? /^Digest:\s+(\S+)/m.exec(result.stdout)?.[1] : undefined;
  if (digest === undefined) return undefined;
  // The trailing :tag is stripped before rejoining with the fresh digest — never a registry
  // port, which always has a slash after it.
  return `${reference.split("@")[0].replace(/:[^/]*$/, "")}@${digest}`;
}

/** The container's own exit code, or undefined when there is no container or the inspect
 *  failed — how a migration failure (upstream docs: exit code 78) is told apart from one
 *  still starting up. */
export async function lastExitCode(transport: Transport, containerId: string | undefined): Promise<number | undefined> {
  if (containerId === undefined) return undefined;
  const result = await transport.exec("docker", ["inspect", "--format", "{{.State.ExitCode}}", containerId], { allowFailure: true });
  return result.code === 0 ? Number.parseInt(result.stdout.trim(), 10) : undefined;
}
