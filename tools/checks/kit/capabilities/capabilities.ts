// Host capabilities a check file's `// check:requires <cap>[, <cap>...]` header can name
// (discover.ts parses the marker; run.ts decides whether to start the file). Each capability
// is a real, checkable fact about THIS host, probed lazily — only when some selected check
// actually requires it — and cached for the run: a capability is asked about at most once.
//
// A probe never throws: an absent tool, a timeout, an unexpected error all read as "absent".
// A capability check must never be the reason a run crashes instead of skipping cleanly.

import { spawnLocal } from "#framework/runtime/transport/transport.ts";

export const CAPABILITIES = [
  "docker", "wsl", "posix-sh", "rsync", "linux-host", "windows-host", "ssh-loopback", "gnu-userland", "auto-target",
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

/** A real rsync binary on PATH. */
export async function hasRsync(): Promise<boolean> {
  return swallow(async () => (await spawnLocal("rsync", ["--version"], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS })).code === 0);
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
export async function isWindowsHost(): Promise<boolean> {
  return process.platform === "win32";
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

/** The target OC_TARGET_LOCATION=auto picks on this host answers docker: a local daemon on
 *  Linux, docker inside the WSL distro on Windows. macOS has no auto target at all, and a
 *  WSL distro without docker answers "absent" — wsl.exe alone is not enough for a check that
 *  needs the target to answer. */
export async function hasAutoTarget(): Promise<boolean> {
  if (process.platform === "linux") return hasDocker();
  if (process.platform === "win32") {
    if (!(await hasWsl())) return false;
    // The default mirrors core/env.ts's; a later step gives it a single owner.
    const distro = process.env.OC_WSL_DISTRO ?? "Ubuntu-24.04";
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
  wsl: hasWsl,
  "posix-sh": hasPosixSh,
  rsync: hasRsync,
  "linux-host": isLinuxHost,
  "windows-host": isWindowsHost,
  "ssh-loopback": hasSshLoopback,
  "gnu-userland": hasGnuUserland,
  "auto-target": hasAutoTarget,
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
