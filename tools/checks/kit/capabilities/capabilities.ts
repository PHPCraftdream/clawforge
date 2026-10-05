// Host capabilities a check file's `// check:requires <cap>[, <cap>...]` header can name
// (discover.ts parses the marker; run.ts decides whether to start the file). Each capability
// is a real, checkable fact about THIS host, probed lazily — only when some selected check
// actually requires it — and cached for the run: a capability is asked about at most once.
//
// A probe never throws: an absent tool, a timeout, an unexpected error all read as "absent".
// A capability check must never be the reason a run crashes instead of skipping cleanly.

import { readlinkSync, symlinkSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { DEFAULT_WSL_DISTRO } from "#framework/core/env.ts";
import { ENGINE_DISTRO } from "#framework/commands/interface/host/contexts.ts";

export const CAPABILITIES = [
  "docker", "docker-desktop-wsl", "wsl", "posix-sh", "rsync", "symlink", "linux-host", "posix-host", "local-posix", "windows-host", "ssh-loopback", "gnu-userland", "posix-modes", "auto-target",
  "bash", "pwsh",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

const PROBE_TIMEOUT_MS = 5_000;

async function swallow(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

/** A usable local docker daemon: `docker info` succeeds. */
export async function hasDocker(): Promise<boolean> {
  return swallow(async () => (await spawnLocal("docker", ["info"], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS })).code === 0);
}

/** wsl.exe present with at least one usable distro: `wsl.exe -l -q` answers a non-empty
 *  listing. wsl.exe writes UTF-16LE even through a pipe, so a NUL-mangled but non-blank
 *  decode still counts. */
export async function hasWsl(): Promise<boolean> {
  return swallow(async () => {
    const listing = await spawnLocal("wsl.exe", ["-l", "-q"], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS });
    return listing.code === 0 && listing.stdout.replaceAll("\u0000", "").trim() !== "";
  });
}

/** A `sh` that runs a trivial command — never through wsl.exe: Git for Windows' own sh
 *  qualifies here, independently of whether WSL exists at all. */
export async function hasPosixSh(): Promise<boolean> {
  return swallow(async () => (await spawnLocal("sh", ["-c", "exit 0"], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS })).code === 0);
}

/** A `bash` that runs a trivial command — the shell that sources the generated completion
 *  script for real; neither `sh` nor wsl.exe stands in for it. */
export async function hasBash(): Promise<boolean> {
  return swallow(async () => (await spawnLocal("bash", ["-c", "exit 0"], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS })).code === 0);
}

/** A real rsync binary on PATH. */
export async function hasRsync(): Promise<boolean> {
  return swallow(async () => (await spawnLocal("rsync", ["--version"], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS })).code === 0);
}

const PWSH_PROBE_ARGS = ["-NoProfile", "-NonInteractive", "-Command", "exit 0"];

async function pwshAnswers(binary: string): Promise<boolean> {
  return swallow(async () => (await spawnLocal(binary, PWSH_PROBE_ARGS, { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS })).code === 0);
}

/** The PowerShell this host actually runs, undefined when it has none: `pwsh`, or on Windows
 *  without it `powershell.exe` (5.1). Exported so a check can spawn the very binary the probe
 *  accepted instead of assuming one. */
export async function pwshCommand(): Promise<string | undefined> {
  if (await pwshAnswers("pwsh")) return "pwsh";
  if (process.platform === "win32" && await pwshAnswers("powershell.exe")) return "powershell.exe";
  return undefined;
}

/** A PowerShell that runs a trivial command — the other shell the completion differential
 *  really executes. */
export async function hasPwsh(): Promise<boolean> {
  return (await pwshCommand()) !== undefined;
}

/** Docker Desktop's own WSL distro answers `sh -c true` on a Windows host: the engine
 *  context's real half, probed the way provision-agent.check.ts probes a usable distro.
 *  wsl.exe alone is not enough — the cases gated here run commands inside THIS distro,
 *  which a plain `wsl` answer (Git-Bash's sh, another distro) says nothing about. */
export async function hasDockerDesktopWsl(): Promise<boolean> {
  if (process.platform !== "win32" || !(await hasWsl())) return false;
  return swallow(async () =>
    (await spawnLocal("wsl.exe", ["-d", ENGINE_DISTRO, "sh", "-c", "true"], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS })).code === 0,
  );
}

/** This process's own host, not a target: some checks assume GNU/Linux tools with no
 *  fallback (find -printf, /proc, stat -c). No probe needed — the fact is process.platform
 *  itself — but it is still async, so every entry in ProbeMap has the same shape. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function isLinuxHost(): Promise<boolean> {
  return process.platform === "linux";
}

/** This process's own host: some checks (the WSL cell of the transport matrix) need a
 *  Windows host specifically, not merely "wsl.exe answers" — hasWsl() alone would also be
 *  true from a Linux host reaching a WSL machine over ssh, which is not this cell. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function isPosixHost(): Promise<boolean> {
  return process.platform !== "win32";
}

/** This process's own host, a Windows one. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function isWindowsHost(): Promise<boolean> {
  return process.platform === "win32";
}

/** A POSIX filesystem this process drives directly (this Linux host) or through a usable WSL
 *  distribution (Windows) — the target the real-tar archive/verify and symlink-boundary
 *  checks actually need. macOS has neither and answers "absent". */
// eslint-disable-next-line @typescript-eslint/require-await
export async function hasLocalPosix(): Promise<boolean> {
  return (await isLinuxHost()) || (process.platform === "win32" && (await hasWsl()));
}

/** GNU-compatible coreutils (GNU or uutils) and GNU tar as this process's own `mkdir`/`mv`/`tar`: what LocalTransport-backed
 *  checks (useLinuxHost, `mv -T`, `tar --quoting-style`) assume. macOS ships BSD ones and a
 *  stock Windows runner has no mkdir at all. */
export async function hasGnuUserland(): Promise<boolean> {
  return swallow(async () => {
    const versions = await Promise.all(
      ["mkdir", "mv", "tar"].map((tool) => spawnLocal(tool, ["--version"], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS })),
    );
    return versions.every((result, index) => result.code === 0 && (index === 2 ? /GNU tar/ : /(GNU|uutils) coreutils/).test(result.stdout));
  });
}

/** POSIX mode bits are meaningful on this host's own filesystem: chmod 0o600 a temp file and
 *  read the mode back. Windows filesystems have no POSIX permission bits (ACLs are
 *  authoritative — chmod only toggles a read-only flag), so the mode-bit assertions answer
 *  "absent" there instead of asserting a lie. */
export async function hasPosixModes(): Promise<boolean> {
  return swallow(async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawforge-cap-modes-"));
    try {
      const file = join(dir, "probe");
      await writeFile(file, "");
      await chmod(file, 0o600);
      return ((await stat(file)).mode & 0o777) === 0o600;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

/** A file symlink round-trips in a temp dir: what the symlink-boundary checks actually need.
 *  Windows without developer mode or elevation refuses file links (a directory link falls
 *  back to an NTFS junction, which needs neither), so the link-boundary groups answer
 *  "absent" there instead of failing. */
export async function hasSymlink(): Promise<boolean> {
  return swallow(async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawforge-cap-symlink-"));
    try {
      symlinkSync("target", join(dir, "probe"), "file");
      return readlinkSync(join(dir, "probe")) === "target";
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

/** The target OC_TARGET_LOCATION=auto picks on this host answers docker: a local daemon on
 *  Linux, docker inside the WSL distro on Windows. macOS has no auto target at all, and a
 *  WSL distro without docker answers "absent" — wsl.exe alone is not enough for a check that
 *  needs the target to answer. */
export async function hasAutoTarget(): Promise<boolean> {
  if (process.platform === "linux") return hasDocker();
  if (process.platform === "win32") {
    if (!(await hasWsl())) return false;
    const distro = process.env.OC_WSL_DISTRO ?? DEFAULT_WSL_DISTRO;
    return swallow(async () => (await spawnLocal(
      "wsl.exe",
      ["-d", distro, "docker", "info"],
      { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS },
    )).code === 0);
  }
  return false;
}

const SSH_LOOPBACK_TIMEOUT_MS = 8_000;
/** A real, reachable, key-based loopback ssh target at OC_CHECK_SSH_HOST (default localhost):
 *  `ssh -o BatchMode=yes -o ConnectTimeout=5 <host> true` succeeds — the exact command the CI
 *  job that provisions this sshd is contracted to make pass, and the exact one a check gated
 *  on this capability relies on already working. BatchMode refuses rather than prompting, so a
 *  host with no key set up answers "absent" instead of hanging. */
export async function hasSshLoopback(): Promise<boolean> {
  const host = process.env.OC_CHECK_SSH_HOST ?? "localhost";
  return swallow(async () => (await spawnLocal(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "true"],
    { allowFailure: true, timeoutMs: SSH_LOOPBACK_TIMEOUT_MS },
  )).code === 0);
}

export type ProbeMap = Readonly<Record<Capability, () => Promise<boolean>>>;

export const DEFAULT_PROBES: ProbeMap = {
  docker: hasDocker,
  "docker-desktop-wsl": hasDockerDesktopWsl,
  wsl: hasWsl,
  "posix-sh": hasPosixSh,
  rsync: hasRsync,
  symlink: hasSymlink,
  "linux-host": isLinuxHost,
  "posix-host": isPosixHost,
  "local-posix": hasLocalPosix,
  "windows-host": isWindowsHost,
  "ssh-loopback": hasSshLoopback,
  "posix-modes": hasPosixModes,
  "gnu-userland": hasGnuUserland,
  "auto-target": hasAutoTarget,
  bash: hasBash,
  pwsh: hasPwsh,
};

/** Probes each capability at most once per instance, regardless of how many files ask —
 *  probes are injectable so a check file (or this module's own check) never has to spawn a
 *  real docker/wsl.exe/sh to prove the caching and gating logic. */
export class CapabilityProbe {
  readonly #probes: ProbeMap;
  readonly #cache = new Map<Capability, Promise<boolean>>();

  constructor(probes: ProbeMap = DEFAULT_PROBES) {
    this.#probes = probes;
  }

  has(capability: Capability): Promise<boolean> {
    let cached = this.#cache.get(capability);
    if (cached === undefined) {
      cached = this.#probes[capability]();
      this.#cache.set(capability, cached);
    }
    return cached;
  }

  /** The subset of `required` this host lacks, in the given order. */
  async missing(required: readonly Capability[]): Promise<Capability[]> {
    const answers = await Promise.all(required.map((capability) => this.has(capability).then((present) => ({ capability, present }))));
    return answers.filter((entry) => !entry.present).map((entry) => entry.capability);
  }
}
