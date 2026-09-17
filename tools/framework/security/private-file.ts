import { chmod, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnLocal } from "../runtime/transport.ts";
import { createPathBridge } from "../core/paths.ts";
import { info, warn } from "../core/log.ts";

const PRIVATE_MODE = 0o600;

// The only trustees a credential file may carry: its owner plus LOCAL SYSTEM and the local
// Administrators group, by SID. icacls's display names are localized, so trustee names must
// never decide access — SIDs read the same on every machine.
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";

// SDDL — what `icacls /save` writes — names well-known trustees with aliases and everything
// else with its full SID; both are locale-independent.
const SDDL_TRUSTEE_SIDS: Record<string, string> = {
  BA: ADMINISTRATORS_SID,
  SY: SYSTEM_SID,
};

/** Windows system tools by absolute path: a Git-Bash-style PATH puts its own whoami ahead
 *  of the Windows one, and its answer means nothing to icacls. */
function systemTool(name: string): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}
function mountedWindowsPath(file: string): boolean {
  return process.platform === "linux" && /^\/mnt\/[a-z](?:\/|$)/i.test(resolve(file));
}

function filesystemAdvice(file: string): string {
  return mountedWindowsPath(file)
    ? "the path is on a mounted Windows/DrvFs filesystem; move the deployment into the Linux filesystem or configure Windows ACLs before retrying"
    : "check the filesystem and its ownership before retrying";
}

/** Runs one local support tool and hands the result back as data: every caller here decides
 *  for itself what a nonzero exit or a timeout means. */
async function runTool(command: string, args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  try {
    const result = await spawnLocal(command, args, { allowFailure: true, timeoutMs });
    return { code: result.code, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    return { code: -1, output: (error as Error).message };
  }
}

async function windowsOwnerSid(file: string): Promise<string> {
  const who = await runTool(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], 10_000);
  const sid = /S-1-\d+(?:-\d+)+/.exec(who.output)?.[0];
  if (who.code !== 0 || sid === undefined) {
    throw new Error(`cannot determine the Windows owner for ${file}: ${who.output.trim() || `exit ${who.code}`}`);
  }
  return sid;
}

/** Builds the DACL from nothing rather than patching it: /reset drops every explicit ACE (a
 *  /grant:r over the old ACL would leave foreign trustees standing), /inheritance:r keeps the
 *  parent's entries from coming back, and the grant names the complete allowed set by SID.
 *  Returns the owner SID so the result can be verified against it. */
async function grantWindowsAcl(file: string): Promise<string> {
  const owner = await windowsOwnerSid(file);
  const reset = await runTool(systemTool("icacls.exe"), [file, "/reset"], 15_000);
  if (reset.code !== 0) {
    throw new Error(`icacls /reset failed for ${file} (exit ${reset.code}): ${reset.output.trim() || "no details"}`);
  }
  const grant = await runTool(
    systemTool("icacls.exe"),
    [file, "/inheritance:r", "/grant:r", `*${owner}:F`, `*${SYSTEM_SID}:F`, `*${ADMINISTRATORS_SID}:F`],
    15_000,
  );
  if (grant.code !== 0) {
    throw new Error(`icacls /grant failed for ${file} (exit ${grant.code}): ${grant.output.trim() || "no details"}`);
  }
  return owner;
}

/** Reads the DACL back through `icacls /save`: the SDDL it writes names every trustee by SID
 *  or SID alias, so verification cannot be fooled by a localized display name. */
async function savedAces(
  file: string,
): Promise<{ daclProtected: boolean; aces: { type: string; flags: string; rights: string; trustee: string }[] }> {
  const saved = join(tmpdir(), `clawforge-dacl-${randomBytes(6).toString("hex")}.txt`);
  try {
    const result = await runTool(systemTool("icacls.exe"), [file, "/save", saved], 15_000);
    if (result.code !== 0) {
      throw new Error(`icacls /save failed for ${file} (exit ${result.code}): ${result.output.trim() || "no details"}`);
    }
    const text = await readFile(saved, "utf16le");
    const line = text.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("D:"));
    if (line === undefined) {
      throw new Error(`could not read back the ACL of ${file}: icacls wrote no DACL line`);
    }
    const aces = [...line.matchAll(/\(([^()]*)\)/g)].map((match) => {
      const [type = "", flags = "", rights = "", , , trustee = ""] = match[1].split(";");
      return { type, flags, rights, trustee };
    });
    return { daclProtected: /^D:([A-Z]*)/.exec(line)?.[1]?.includes("P") === true, aces };
  } finally {
    await rm(saved, { force: true }).catch(() => {});
  }
}

function trusteeSid(trustee: string): string {
  return SDDL_TRUSTEE_SIDS[trustee.toUpperCase()] ?? trustee;
}

/** Proves the grant instead of trusting it: only the allowed trustees may appear, the DACL
 *  must be sealed against inheritance, and the owner must hold full access. A leftover
 *  trustee is reported by SID — the one spelling of its name that does not move. */
async function assertDaclOwnerOnly(file: string, owner: string): Promise<void> {
  const { daclProtected, aces } = await savedAces(file);
  const allowed = new Set([owner, SYSTEM_SID, ADMINISTRATORS_SID]);
  const foreign = aces.filter((ace) => !allowed.has(trusteeSid(ace.trustee)));
  if (foreign.length > 0) {
    throw new Error(
      `the ACL on ${file} still grants access to ${foreign.map((ace) => ace.trustee).join(", ")} — ` +
        "only the owner, SYSTEM and Administrators may hold a credential file",
    );
  }
  if (aces.some((ace) => ace.type !== "A")) {
    throw new Error(`the ACL on ${file} carries an entry that is not an allow ACE`);
  }
  if (!daclProtected || aces.some((ace) => ace.flags.includes("ID"))) {
    throw new Error(`the ACL on ${file} still inherits entries from its parent directory`);
  }
  if (!aces.some((ace) => trusteeSid(ace.trustee) === owner && /^FA$/i.test(ace.rights))) {
    throw new Error(`the ACL on ${file} does not give the owner full access`);
  }
}

/** The WSL distributions this machine can run. Every failure — wsl.exe missing, WSL not
 *  installed, no distribution, unreadable listing — means there is no Linux side that can
 *  reach the file, so there is no boundary to verify. The listing arrives as UTF-16. */
export async function installedWslDistros(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const result = await runTool(systemTool("wsl.exe"), ["-l", "-q"], 15_000);
  if (result.code !== 0) return [];
  return result.output
    .replaceAll("\0", "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The file's path inside a distribution, via the same bridge the transports use — the
 *  automount root is the distribution's own, not an assumed /mnt. Undefined when the file is
 *  not on a Windows drive, which no automount can address. */
async function automountedPath(distro: string, file: string): Promise<string | undefined> {
  const bridge = await createPathBridge({
    kind: "wsl",
    distro,
    mounts: [],
    readFile: async (path) => {
      const result = await runTool(systemTool("wsl.exe"), ["-d", distro, "-u", "root", "--exec", "cat", path], 10_000);
      if (result.code !== 0) throw new Error(result.output.trim() || `exit ${result.code}`);
      return result.output;
    },
  });
  try {
    return await bridge.toTarget(file);
  } catch {
    return undefined;
  }
}

/** Asks one distribution whether an unprivileged user can open the file — runuser to nobody,
 *  `head -c 0` so the open itself is the answer and no content is read or printed. OPEN and
 *  DENIED are verdicts; anything else means the probe itself did not work. */
async function probeWslOpenUncached(distro: string, targetPath: string): Promise<string> {
  const quoted = `'${targetPath.replaceAll("'", `'\\''`)}'`;
  const script =
    "if command -v runuser >/dev/null 2>&1; then " +
    `runuser -u nobody -- sh -c 'head -c 0 ${quoted} >/dev/null 2>&1 && echo OPEN || echo DENIED'; ` +
    "elif command -v su >/dev/null 2>&1; then " +
    `su -s /bin/sh -c "head -c 0 ${quoted} >/dev/null 2>&1 && echo OPEN || echo DENIED" nobody; ` +
    "else echo NOPROBE; fi";
  const result = await runTool(systemTool("wsl.exe"), ["-d", distro, "-u", "root", "--exec", "sh", "-c", script], 15_000);
  const verdict = result.output.replaceAll("\0", "").trim();
  if (verdict === "OPEN" || verdict === "DENIED") return verdict;
  return `no verdict (exit ${result.code})`;
}

// One probe per distribution and drive per process: the verdict is a property of the mount,
// not of the individual file, and this sits on a path every command walks.
const wslProbeVerdicts = new Map<string, string>();

async function probeWslOpen(distro: string, targetPath: string): Promise<string> {
  const mount = `${distro}|${targetPath.split("/").slice(0, 3).join("/")}`;
  const cached = wslProbeVerdicts.get(mount);
  if (cached !== undefined) return cached;
  const verdict = await probeWslOpenUncached(distro, targetPath);
  wslProbeVerdicts.set(mount, verdict);
  return verdict;
}

/** The Windows half is only half the protection when WSL is installed: every drive is
 *  automounted into every distribution, and across that boundary a Windows ACL carries no
 *  weight between Linux users. Where the deployment sits is the operator's decision, not a
 *  fault of this call, so the boundary is reported rather than enforced: each installed
 *  distribution is probed once per drive, and whatever it can open — or whatever this probe
 *  could not answer — is said out loud instead of silently claimed as owner-only. */
async function reportWslBoundary(file: string): Promise<void> {
  const distros = await installedWslDistros();
  if (distros.length === 0) return;
  const unverified: string[] = [];
  let exposed = false;
  for (const distro of distros) {
    const targetPath = await automountedPath(distro, file);
    if (targetPath === undefined) {
      unverified.push(`"${distro}" has no path for it (the file is not on a Windows drive)`);
      continue;
    }
    const verdict = await probeWslOpen(distro, targetPath);
    if (verdict === "DENIED") continue;
    if (verdict === "OPEN") {
      exposed = true;
      warn(
        `${file} is owner-only on the Windows side only: distribution "${distro}" opens it as an unprivileged ` +
          `Linux user via ${targetPath} — a Windows ACL does not separate Linux users on a mounted drive`,
      );
      continue;
    }
    unverified.push(`"${distro}" at ${targetPath}: ${verdict}`);
  }
  if (exposed) {
    info(
      "move the deployment into the distribution's own filesystem (and run the framework from there), " +
        "or give the drive restrictive DrvFs permissions in that distribution's /etc/wsl.conf",
    );
  }
  if (unverified.length > 0) {
    warn(`could not verify ${file} as owner-only across the Windows/WSL boundary — ${unverified.join("; ")}`);
    info(
      "check by hand with: wsl.exe -d <distro> -u root --exec runuser -u nobody -- head -c 0 <path in the distribution>; " +
        "a file this opens is readable by every Linux user of this machine",
    );
  }
}

/** Ensures a credential-bearing file is owner-only, and can prove it: POSIX modes where they
 *  apply; on Windows a rebuilt SID-exact ACL plus an honest report of what the WSL boundary
 *  can and cannot verify. */
export async function protectPrivateFile(file: string): Promise<void> {
  if (process.platform === "win32") {
    const owner = await grantWindowsAcl(file);
    await assertDaclOwnerOnly(file, owner);
    await reportWslBoundary(file);
    return;
  }

  let chmodError: unknown;
  try {
    await chmod(file, PRIVATE_MODE);
  } catch (error) {
    chmodError = error;
  }

  let mode: number;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch (error) {
    throw new Error(`cannot verify private file ${file}: ${(error as Error).message}`);
  }

  if ((mode & 0o077) !== 0) {
    const detail = chmodError === undefined
      ? `mode is ${mode.toString(8)}, expected 600`
      : `chmod failed: ${(chmodError as Error).message}; mode is ${mode.toString(8)}`;
    throw new Error(`cannot protect private file ${file}: ${detail}; ${filesystemAdvice(file)}`);
  }
}

/** Creates a private file without exposing its first byte under the process umask. */
export async function createPrivateFile(file: string, content: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(file, "wx", PRIVATE_MODE);
    created = true;
    if (process.platform === "win32") {
      await handle.close();
      handle = undefined;
      await protectPrivateFile(file);
      handle = await open(file, "r+");
    }
    await handle.writeFile(content, "utf8");
  } catch (error) {
    if (created) await unlink(file).catch(() => {});
    throw error;
  } finally {
    await handle?.close();
  }
  try {
    if (process.platform !== "win32") await protectPrivateFile(file);
  } catch (error) {
    await unlink(file).catch(() => {});
    throw error;
  }
}

/** Replaces a private file atomically on the same filesystem. */
export async function replacePrivateFile(file: string, content: string): Promise<void> {
  // Random per call: PID plus a millisecond timestamp collided when two replacements shared
  // a millisecond, and the old catch-all cleanup then deleted a temporary file this call
  // never created. `created` keeps the cleanup to files this call brought into being —
  // createPrivateFile removes its own on failure and refuses an existing path untouched.
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let created = false;
  try {
    await createPrivateFile(temporary, content);
    created = true;
    await rename(temporary, file);
  } catch (error) {
    if (created) await unlink(temporary).catch(() => {});
    throw error;
  }
  await protectPrivateFile(file);
}
