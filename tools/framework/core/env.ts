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
import { randomInt } from "node:crypto";
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
  const separator = pathSeparator(dataDir);
  const cut = lastSeparator(dataDir);
  const parent = cut < 0 ? "" : dataDir.slice(0, cut) || separator;
  const name = dataDir.slice(cut + 1);
  return `${parent}${parent === separator ? "" : separator}${name}-locks`;
}

function pathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") ? "\\" : "/";
}

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
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

/** Selects a deployment port candidate outside the usual ephemeral range. */
export function projectPort(taken: ReadonlySet<number> = new Set(), start = randomInt(12768)): number {
  const portCount = 12768;
  const first = 20000 + (start % portCount);
  for (let offset = 0; offset < portCount; offset += 1) {
    const port = 20000 + ((first - 20000 + offset) % portCount);
    if (!taken.has(port)) return port;
  }
  throw new Error("no deployment port is available in the configured range (20000–32767)");
}

/** The write side of the grammar above — the exact inverse of parseEnv's per-line read:
 *  parseEnv(serializeEnvLine(name, value))[name] is byte-identical to value for every
 *  value without a line terminator.
 *
 *  parseEnv trims each line, splits on the first `=` and strips ONE matched outer quote
 *  pair (`"` or `'`, `length > 1`) with no escape processing. The bare form therefore
 *  survives a round trip only when the value has no edge whitespace and no quote
 *  character anywhere; everything else is written single-quoted, and what sits between
 *  the quotes is read back as literal bytes — exactly one matched pair is stripped,
 *  whatever the value contains, so even `'it's'` parses back to it's. A value holding a
 *  newline or carriage return cannot live on one line at all (a `\n` splits into two
 *  lines; a trailing `\r` is eaten by the reader's line trim as a CRLF terminator) and
 *  is refused with the key named rather than written lossily — P2-13: the store writers
 *  used to emit bare NAME=value text, so every apply cycle silently ate the padding of a
 *  value like ` sample ` and re-wrapped quote-shaped values. */
export function serializeEnvLine(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid environment variable name: ${name}`);
  if (/[\r\n]/.test(value)) throw new Error(`environment value for ${name} contains a newline or carriage return`);
  if (value === value.trim() && !value.includes(`"`) && !value.includes(`'`)) return `${name}=${value}`;
  return `${name}='${value}'`;
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

const DATA_DIR_HINT =
  "OC_DATA_DIR must be an absolute, already-normalized path with at least two segments below " +
  'its root (e.g. "/srv/openclaw/data"), never "/" or a bare top-level directory.';

// A Windows drive prefix ("C:\" or "C:/") counts as a root the same way a leading "/" does:
// OC_TARGET_LOCATION=local on a Windows host can hand toSettings a native Windows path.
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]/;

/** Guards the one string that later reaches a recursive `chown -R 1000:1000` in
 *  ensureDataDirs() (runtime/datadir.ts). Run here, before a Context or transport exists,
 *  because that chown is destructive and this string — straight out of .env — is the only
 *  thing standing between it and the whole target filesystem (audit 2026-09-23, XS round 4,
 *  P1-01: an unvalidated OC_DATA_DIR=/ turns bootstrap into `chown -R 1000:1000 /`).
 *
 *  Rejects rather than silently repairs: a trailing slash or a stray ".." the operator did
 *  not intend to write is exactly the kind of mistake this exists to surface, not to correct
 *  out from under them. Validated with plain string/regex checks rather than node:path's
 *  normalize — that would canonicalize every separator to the host's own style, which is
 *  exactly wrong for a path that may describe a different target than the one running this
 *  process (wsl/ssh are always POSIX regardless of this host) and for the one case that IS
 *  this host (OC_TARGET_LOCATION=local), which can use native Windows paths.
 *
 *  The depth-2 floor is deliberate rather than an explicit deny-list — every system top-level
 *  directory ("/", "/etc", "/home", "/root", "/usr", "/var", "C:\", …) has exactly one segment
 *  below its root, so requiring two rejects all of them at once without needing to name each
 *  one and keep the list current.
 *
 *  Depth is a backstop, not the primary control (P1-09): standard directories deeper than
 *  one segment ("/var/lib") pass here on purpose — a string in .env cannot prove what a
 *  path resolves to on the target. The primary check is filesystem-level, in ensureDataDirs
 *  (runtime/datadir.ts): canonical-ancestor resolution before any mkdir/chown/chmod, and
 *  ownership changed only for what that run created or a provenance marker vouches for —
 *  never a blanket recursive chown. */
function assertSafeDataDir(dataDir: string): void {
  const isPosixRoot = dataDir.startsWith("/");
  const isWindowsRoot = WINDOWS_ROOT.test(dataDir);
  if (!isPosixRoot && !isWindowsRoot) {
    die(`OC_DATA_DIR "${dataDir}" is not an absolute path. ${DATA_DIR_HINT}`);
  }
  if (/[\\/]{2,}/.test(dataDir) || /[\\/]$/.test(dataDir)) {
    die(`OC_DATA_DIR "${dataDir}" is not a normalized path (repeated or trailing separators). ${DATA_DIR_HINT}`);
  }
  if (dataDir.includes("/") && dataDir.includes("\\")) {
    die(`OC_DATA_DIR "${dataDir}" mixes path separators. ${DATA_DIR_HINT}`);
  }
  // The first split segment is "" for a POSIX root or the drive letter ("C:") for a Windows
  // one — both mark the root itself, never a directory name, so neither counts toward depth.
  const segments = dataDir.split(/[\\/]+/).slice(1);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    die(`OC_DATA_DIR "${dataDir}" contains a "." or ".." segment. ${DATA_DIR_HINT}`);
  }
  if (segments.length < 2) {
    die(`OC_DATA_DIR "${dataDir}" is a top-level directory. ${DATA_DIR_HINT}`);
  }
}

export function toSettings(env: Env): Settings {
  const dataDir = env.OC_DATA_DIR;
  if (!dataDir) die("OC_DATA_DIR is not set in .env");
  assertSafeDataDir(dataDir);

  const bindAddress = env.OC_BIND_ADDRESS ?? "127.0.0.1";
  const gatewayPort = env.OPENCLAW_GATEWAY_PORT ?? "18789";
  const separator = pathSeparator(dataDir);
  const cut = lastSeparator(dataDir);
  const parentOfData = cut < 0 ? "" : dataDir.slice(0, cut) || separator;
  const siblingSeparator = parentOfData === separator ? "" : separator;

  return {
    env,
    dataDir,
    backupDir: env.OC_BACKUP_DIR ?? `${parentOfData}${siblingSeparator}backups`,
    // Snapshots hold secrets, so they default outside the repository and away from Windows
    // mounts, where chmod is accepted and then silently ignored.
    snapshotDir: env.OC_SNAPSHOT_DIR ?? `${parentOfData}${siblingSeparator}snapshots`,
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
