// Pure, self-contained environment helpers for `./clawforge set try` — no target I/O, no
// lifecycle: a free port, a throwaway deployment name, its data-directory sibling path, the
// .env content it starts with, and whether this run's target location even supports it.
// Split out of set-try.ts, which keeps TryReport/TryTeardownResult/teardownTry/setTry — the
// actual throwaway-instance lifecycle these are inputs to.
//
// Deliberately NOT split further: setTry() itself is one long orchestration sequence
// (bootstrap → accept → teardown) with its own error-handling and cleanup guarantees, and
// breaking up its body is a materially riskier refactor than relocating these helpers —
// left as a separate, later task if wanted.

import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { die } from "#src/core/log.ts";
import { unpackArtifactVerified } from "#src/set/artifacts/install.ts";
import type { SetManifest } from "#src/set/artifacts/model.ts";

export interface VerifiedArtifact {
  readonly staging: string;
  readonly verified: { readonly manifest: SetManifest; readonly id: string };
}

/** Set try must use the verified installer: accepting a merely parseable set.json would make
 * the reported id unrelated to the artifact's actual file bytes. */
export async function unpackForTry(artifact: string): Promise<VerifiedArtifact> {
  return unpackArtifactVerified(artifact);
}

/** A port nothing on this host is listening on yet. Docker still might refuse it for a
 *  reason this cannot see (another compose project mid-teardown, a reserved range) — this
 *  narrows the search, it does not replace the runtime's own preflight, which still runs
 *  right before the gateway starts. */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.once("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveFree(true)));
  });
}

export async function findFreePort(startAt = 20000, tries = 500): Promise<number> {
  for (let port = startAt; port < startAt + tries; port += 1) {
    if (await isPortFree(port)) return port;
  }
  die(`no free port found between ${startAt} and ${startAt + tries}`);
}

/** A deployment name for the throwaway instance — safeName-valid by construction, and
 *  distinct from anything a coder would choose by hand, so it reads as what it is. */
export function tryDeploymentName(): string {
  return `clawforge-try-${randomBytes(4).toString("hex")}`;
}

/** Where the throwaway instance's data lives on the target: a sibling of the real
 *  deployment's own data directory, named after this run rather than after it — two levels
 *  up from .../<deployment>/data lands on the directory deployments share, the same
 *  assumption init.ts's own template makes (/srv/<name>/data next to /srv/<other>/data). */
export function targetSiblingRoot(realDataDir: string, tryName: string): string {
  const normalised = realDataDir.replaceAll("\\", "/").replace(/\/+$/, "");
  const windows = /^([A-Za-z]):\/(.*)$/.exec(normalised);
  const prefix = windows === null ? "/" : `${windows[1].toUpperCase()}:/`;
  const body = windows === null ? normalised : windows[2];
  const parts = body.split("/").filter((part) => part !== "");
  if (parts.length < 2) return `${prefix}tmp/${tryName}`;
  const parent = parts.slice(0, -2).join("/");
  return parent === "" ? `${prefix}${tryName}` : `${prefix}${parent}/${tryName}`;
}

export function buildEnv(opts: {
  port: number;
  token: string;
  image: string;
  dataRoot: string;
  copiedFrom: Record<string, string>;
}): string {
  const c = opts.copiedFrom;
  return [
    `OPENCLAW_IMAGE=${opts.image}`,
    `OC_TARGET_LOCATION=${c.OC_TARGET_LOCATION ?? "auto"}`,
    `OC_WSL_DISTRO=${c.OC_WSL_DISTRO ?? "Ubuntu-24.04"}`,
    `OC_SSH_HOST=${c.OC_SSH_HOST ?? ""}`,
    `OC_REMOTE_PATH=${c.OC_REMOTE_PATH ?? "/opt/openclaw"}`,
    `OC_DATA_DIR=${opts.dataRoot}/data`,
    "OC_BIND_ADDRESS=127.0.0.1",
    `OPENCLAW_GATEWAY_PORT=${opts.port}`,
    `OPENCLAW_GATEWAY_TOKEN=${opts.token}`,
    `OPENCLAW_TZ=${c.OPENCLAW_TZ ?? "UTC"}`,
    `OC_BACKUP_DIR=${opts.dataRoot}/backups`,
    `OC_SNAPSHOT_DIR=${opts.dataRoot}/snapshots`,
    `OC_BACKUP_KEEP=${c.OC_BACKUP_KEEP ?? "10"}`,
    `OC_SNAPSHOT_KEEP=${c.OC_SNAPSHOT_KEEP ?? "10"}`,
    "",
  ].join("\n");
}

/** Returns a refusal before artifact unpacking or target mutation when this mode cannot map
 * the throwaway deployment safely. */
export function tryTargetProblem(location: string, platform = process.platform): string | undefined {
  const targetLocation = location.toLowerCase();
  if (targetLocation === "ssh") return "set try currently supports local and WSL targets; SSH requires remote staging and is not supported yet";
  if (targetLocation !== "auto" && targetLocation !== "local" && targetLocation !== "wsl") {
    return `set try cannot use target location "${targetLocation}" (expected local, wsl or auto)`;
  }
  if (targetLocation === "wsl" && platform !== "win32") {
    return "set try's WSL target mode requires the tooling to run on Windows; use local mode from Linux";
  }
  return undefined;
}
