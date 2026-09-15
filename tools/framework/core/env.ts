// Repository configuration: the .env next to this checkout.
//
// The repository is always on our own filesystem, so it is read with node:fs/promises.
// Anything belonging to the target instance goes through the transport instead.
//
// The shell version used `source .env`, which executes whatever the file contains; here it
// is parsed as data.

import { readFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { die } from "./log.ts";
import { envFile } from "../runtime/deployment.ts";

// Two different roots, kept apart on purpose (npm distribution: tools/framework/ is meant
// to also work installed as a dependency in a separate consumer repo, not only colocated in
// this checkout — see deployment.ts for the matching note on the app side):
//
//   frameworkRoot   where THIS file lives, zero climbing. Once tools/framework/ ships as an
//                   npm package, this file sits at node_modules/<pkg>/env.ts (or one level
//                   deeper for a scoped package) — climbing a fixed number of parents to
//                   guess at anything above that would be exactly the kind of hidden
//                   assumption this framework's own docs warn against elsewhere (paths.ts).
//                   Used only for the framework's own shipped files (docker-compose.yml).
//   monorepoRoot    two levels up from frameworkRoot — the clawforge checkout, valid only
//                   when the framework runs colocated with apps/ the way it does today.
//                   Every other call site below (apps/<name>, deploy's rsync source,
//                   scaffold's templates, the check fixtures) genuinely means this, so it
//                   keeps the old `repoRoot` computation unchanged, just under its real
//                   name — an installed-as-dependency entry point would not use this at
//                   all, it has no apps/ sibling to find.
// This module lives in core/ so the package root is one level above it in source and dist.
export const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const monorepoRoot = resolve(frameworkRoot, "..", "..");

/** Whether `root` is a ClawForge checkout — proven by the gate script every checkout is
 *  built around, tools/clawforge.ts, rather than assumed from this file's own location.
 *
 *  monorepoRoot is a guess, and only a good one in the colocated mode: it climbs two fixed
 *  levels, which lands on the checkout from tools/framework/core/env.ts and on something
 *  arbitrary from anywhere else. Installed as a package the compiled env.js sits at
 *  <pkg>/dist/, so those two levels land on the *parent of the package* — a directory that
 *  has nothing to do with this deployment and, for an npm install, sits inside node_modules.
 *  Any command that derives a path from monorepoRoot has to ask this first: acting on the
 *  guess is how a wrong tree gets mirrored somewhere with --delete. */
export async function isMonorepoCheckout(root: string = monorepoRoot): Promise<boolean> {
  return access(resolve(root, "tools", "clawforge.ts")).then(
    () => true,
    () => false,
  );
}

/** The service definition is shared by every deployment: two deployments run the same
 *  service with different settings, so it stays with the framework rather than being
 *  copied into each one. Ships inside tools/framework/ itself (not at the monorepo root)
 *  so it is part of the npm package once this directory is published. */
export const composeFile = resolve(frameworkRoot, "docker-compose.yml");

export type Env = Record<string, string>;

/** The framework's own scratch directory on the target, beside the data directory.
 *
 *  Beside rather than inside, because `restore` replaces the data directory whole and
 *  anything kept in there leaves with the old tree. The data directory's own name is kept in
 *  it so two deployments sharing a parent cannot collide. Pure and taking the path rather
 *  than a Context: the instance lock lives here (instance-lock.ts) and so does the
 *  environment file compose reads (runtime-docker.ts), and those two must agree on where
 *  "here" is without importing each other. */
export function locksDir(dataDir: string): string {
  const trimmed = dataDir.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  const parent = cut <= 0 ? "" : trimmed.slice(0, cut);
  return `${parent}/${trimmed.slice(cut + 1)}-locks`;
}

/** Parses KEY=VALUE lines; comments, blanks and surrounding quotes handled, anything else
 *  ignored rather than executed. */
export function parseEnv(text: string): Env {
  const env: Env = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export async function loadEnv(): Promise<Env> {
  const file = envFile();
  try {
    await access(file);
  } catch {
    die(`${file} not found. Run ./clawforge bootstrap first.`);
  }
  return parseEnv(await readFile(file, "utf8"));
}

export interface Settings {
  env: Env;
  /** Paths below are paths ON THE TARGET, not necessarily on this machine. */
  dataDir: string;
  backupDir: string;
  snapshotDir: string;
  bindAddress: string;
  gatewayPort: string;
  serviceUrl: string;
  image: string;
  /** Transport selection: auto | local | wsl | ssh. */
  location: string;
  wslDistro: string;
  /** user@host, required when location is ssh. */
  sshHost: string;
  /** Where this repository lives on the remote host. */
  remotePath: string;
}

export function toSettings(env: Env): Settings {
  const dataDir = env.OC_DATA_DIR;
  if (!dataDir) die("OC_DATA_DIR is not set in .env");

  const bindAddress = env.OC_BIND_ADDRESS ?? "127.0.0.1";
  const gatewayPort = env.OPENCLAW_GATEWAY_PORT ?? "18789";
  const parentOfData = dataDir.slice(0, Math.max(dataDir.lastIndexOf("/"), 1));

  return {
    env,
    dataDir,
    backupDir: env.OC_BACKUP_DIR ?? `${parentOfData}/backups`,
    // Snapshots hold secrets, so they default outside the repository and away from Windows
    // mounts, where chmod is accepted and then silently ignored.
    snapshotDir: env.OC_SNAPSHOT_DIR ?? `${parentOfData}/snapshots`,
    bindAddress,
    gatewayPort,
    serviceUrl: `http://${bindAddress}:${gatewayPort}`,
    image: env.OPENCLAW_IMAGE ?? "ghcr.io/openclaw/openclaw:extended-stable",
    location: env.OC_TARGET_LOCATION ?? "auto",
    wslDistro: env.OC_WSL_DISTRO ?? "Ubuntu-24.04",
    sshHost: env.OC_SSH_HOST ?? "",
    remotePath: env.OC_REMOTE_PATH ?? "/opt/openclaw",
  };
}

export async function settings(): Promise<Settings> {
  return toSettings(await loadEnv());
}
