import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnLocal } from "../runtime/transport.ts";
import { createPathBridge } from "../core/paths.ts";
import { info, warn } from "../core/log.ts";

const PRIVATE_MODE = 0o600;
// A private directory, unlike a file, needs the owner's execute bit to stay enterable.
const DIRECTORY_MODE = 0o700;

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

/** What it takes to run one local support tool and hand the result back as data: every
 *  caller decides for itself what a nonzero exit or a timeout means. `errno` carries the
 *  spawn failure's own cause, so a caller can tell "the tool is not on this machine"
 *  (ENOENT) from any other failure to run it. */
export type ToolRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; errno?: string; output: string }>;

const spawnTool: ToolRunner = async (command, args, timeoutMs) => {
  try {
    const result = await spawnLocal(command, args, { allowFailure: true, timeoutMs });
    return { code: result.code, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    return { code: -1, errno: (error as NodeJS.ErrnoException).code, output: (error as Error).message };
  }
};

// A module-level runner rather than a parameter, like the output sink: the callers that must
// be swappable are arbitrarily deep. Checks script the Windows and WSL support tools through
// this one seam — the probe's argv shape and its verdicts are verified on machines that have
// neither — while production code never enters the swap and always reaches the real tools.
let toolRunner: ToolRunner = spawnTool;

/** Runs `body` with support tools answered by `substitute` instead of executed. */
export async function withToolRunner<T>(substitute: ToolRunner, body: () => Promise<T>): Promise<T> {
  const previous = toolRunner;
  toolRunner = substitute;
  try {
    return await body();
  } finally {
    toolRunner = previous;
  }
}

async function runTool(command: string, args: string[], timeoutMs: number): Promise<{ code: number; errno?: string; output: string }> {
  return toolRunner(command, args, timeoutMs);
}

async function windowsOwnerSid(file: string): Promise<string> {
  const who = await runTool(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], 10_000);
  const sid = /S-1-\d+(?:-\d+)+/.exec(who.output)?.[0];
  if (who.code !== 0 || sid === undefined) {
    throw new Error(`cannot determine the Windows owner for ${file}: ${who.output.trim() || `exit ${who.code}`}`);
  }
  return sid;
}

/** Builds the DACL from nothing rather than patching it, in one icacls invocation: drop
 *  inheritance, remove every foreign trustee the /save readback just named, grant the closed
 *  SID set. No /reset runs in front of it — /reset restored the parent's inheritable access
 *  onto a file that already held its secret, and a failure in the grant that followed left
 *  exactly that widened ACL behind. Every step of this call can only narrow, or grant within
 *  the closed set, so a failure leaves the file no wider than it arrived. Returns the owner
 *  SID so the result can be verified against it. */
async function grantWindowsAcl(file: string): Promise<string> {
  const owner = await windowsOwnerSid(file);
  const foreign = new Set(
    (await savedAces(file)).aces
      .filter((ace) => !ace.flags.includes("ID"))
      .map((ace) => ace.trustee)
      .filter((trustee) => ![owner, SYSTEM_SID, ADMINISTRATORS_SID].includes(resolvedTrustee(trustee, owner))),
  );
  const grant = await runTool(
    systemTool("icacls.exe"),
    [
      file,
      "/inheritance:r",
      ...[...foreign].flatMap((trustee) => ["/remove", `*${trustee}`]),
      "/grant:r",
      `*${owner}:F`,
      `*${SYSTEM_SID}:F`,
      `*${ADMINISTRATORS_SID}:F`,
    ],
    15_000,
  );
  if (grant.code !== 0) {
    throw new Error(`icacls failed for ${file} (exit ${grant.code}): ${grant.output.trim() || "no details"}`);
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

/** Resolves a trustee against a known owner SID, folding icacls's "LA" alias into the owner
 *  it actually names. LA is the well-known SDDL alias for a machine's built-in Administrator
 *  account (relative ID 500) — not a fixed SID like SYSTEM or the Administrators group, so it
 *  cannot live in SDDL_TRUSTEE_SIDS, but it is still locale-independent and unambiguous: when
 *  the owner IS that RID-500 account (a CI runner routinely runs as it), icacls prints the
 *  owner's own ACE as "LA" instead of the raw SID, and a byte-for-byte comparison against the
 *  owner then reads the owner's own grant as a foreign trustee. Only resolved when the owner
 *  actually is RID 500 — an LA grant on a file some other account owns names a different,
 *  genuinely foreign account and must still be reported. */
function resolvedTrustee(trustee: string, owner: string): string {
  if (trustee.toUpperCase() === "LA" && owner.endsWith("-500")) return owner;
  return trusteeSid(trustee);
}

/** Proves the grant instead of trusting it: only the allowed trustees may appear, the DACL
 *  must be sealed against inheritance, and the owner must hold full access. A leftover
 *  trustee is reported by SID — the one spelling of its name that does not move. */
async function assertDaclOwnerOnly(file: string, owner: string): Promise<void> {
  const { daclProtected, aces } = await savedAces(file);
  const allowed = new Set([owner, SYSTEM_SID, ADMINISTRATORS_SID]);
  const foreign = aces.filter((ace) => !allowed.has(resolvedTrustee(ace.trustee, owner)));
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
  if (!aces.some((ace) => resolvedTrustee(ace.trustee, owner) === owner && /^FA$/i.test(ace.rights))) {
    throw new Error(`the ACL on ${file} does not give the owner full access`);
  }
}

/** What the attempt to list this machine's WSL distributions found. `absent` means there is
 *  genuinely no Linux side that could reach the file; `listed` carries the distributions to
 *  probe; `unlisted` means the enumeration itself failed — the check did not happen, and a
 *  failed enumeration is not evidence that there is no Linux side. */
export type WslListing =
  | { state: "absent" }
  | { state: "listed"; distros: string[] }
  | { state: "unlisted"; reason: string };

/** The WSL distributions this machine can run, as far as they could be listed. Only wsl.exe
 *  missing outright (spawn ENOENT), a clean empty listing, and the "no installed
 *  distributions" answer count as absent; a timeout or any other failed listing is
 *  `unlisted` and must be reported, never read as "no WSL". The listing arrives as UTF-16. */
export async function installedWslDistros(): Promise<WslListing> {
  if (process.platform !== "win32") return { state: "absent" };
  const result = await runTool(systemTool("wsl.exe"), ["-l", "-q"], 15_000);
  const text = result.output.replaceAll("\0", "");
  if (result.code === 0) {
    const distros = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    return distros.length === 0 ? { state: "absent" } : { state: "listed", distros };
  }
  // The "no installed distributions" wording is localized, so matching it is text-sensitive.
  // Accepted here and only here because the miss direction is safe: a localized message that
  // does not match falls into the reported branch, and an honest false alarm beats a silent
  // gap. A spawn failure with ENOENT is wsl.exe itself missing — genuinely no WSL.
  if (result.errno === "ENOENT" || /no installed distributions/i.test(text)) return { state: "absent" };
  return {
    state: "unlisted",
    reason: result.code < 0
      ? `wsl.exe could not be run: ${text.trim() || `code ${result.code}`}`
      : `wsl.exe -l -q exited ${result.code}: ${text.trim() || "no output"}`,
  };
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

/** The verdict the unprivileged side prints. The path arrives as "$1" and is never pasted
 *  into this string: a file name is data, and every shell between here and the open must
 *  keep it that way. A probe that cannot see its argument says NOPROBE rather than guessing. */
const PROBE_SCRIPT =
  'if [ "${1+set}" = set ] && [ -n "$1" ]; then ' +
  'if head -c 0 -- "$1" >/dev/null 2>&1; then echo OPEN; else echo DENIED; fi; ' +
  "else echo NOPROBE; fi";

/** Asks one distribution whether an unprivileged user can open the file. The path travels
 *  as a positional parameter at every shell — wsl.exe hands it to the outer sh as "$1", and
 *  runuser or su passes it on to the inner sh the same way — so no metacharacter in a file
 *  or directory name can become shell code at the root shell this runs under. `head -c 0`
 *  makes the open itself the answer; no content is read or printed. Probed per file, never
 *  cached per drive: reachability depends on the file's own mode, DrvFs metadata and parent
 *  directories, and a stale verdict would silence a warning that still holds. Exported for
 *  the checks, which drive it with a scripted runner. */
export async function probeWslOpen(distro: string, targetPath: string): Promise<string> {
  const script =
    "if command -v runuser >/dev/null 2>&1; then " +
    `runuser -u nobody -- sh -c '${PROBE_SCRIPT}' sh "$1"; ` +
    "elif command -v su >/dev/null 2>&1; then " +
    `su -s /bin/sh -c '${PROBE_SCRIPT}' nobody sh "$1"; ` +
    "else echo NOPROBE; fi";
  const result = await runTool(
    systemTool("wsl.exe"),
    ["-d", distro, "-u", "root", "--exec", "sh", "-c", script, "sh", targetPath],
    15_000,
  );
  const verdict = result.output.replaceAll("\0", "").trim();
  if (verdict === "OPEN" || verdict === "DENIED") return verdict;
  return `no verdict (exit ${result.code})`;
}

/** The Windows half is only half the protection when WSL is installed: every drive is
 *  automounted into every distribution, and across that boundary a Windows ACL carries no
 *  weight between Linux users. Where the deployment sits is the operator's decision, not a
 *  fault of this call, so the boundary is reported rather than enforced: each installed
 *  distribution is probed about the file itself, and whatever it can open — or whatever this probe
 *  could not answer, up to and including a distribution listing that failed outright — is said
 *  out loud instead of silently claimed as owner-only. */
async function reportWslBoundary(file: string): Promise<void> {
  const listing = await installedWslDistros();
  if (listing.state === "absent") return;
  const unverified: string[] = [];
  if (listing.state === "unlisted") {
    unverified.push(`the installed distributions could not be listed (${listing.reason})`);
  }
  let exposed = false;
  for (const distro of listing.state === "listed" ? listing.distros : []) {
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

/** Seals a directory that holds private files: 700 where POSIX modes apply — execute
 *  included, since a directory the owner cannot enter protects nothing — and on Windows
 *  the same closed SID-exact DACL a credential file gets. The directory is sealed, not
 *  just the files inside it, because an editor that saves through atomic replacement
 *  creates its temporary file in this directory and renames it over the store: that
 *  temporary inherits the DIRECTORY's access, so a wide directory hands the file back
 *  wide no matter how carefully the file itself was protected. No WSL boundary probe
 *  here, unlike a file: what that probe decides is whether another system's user can read
 *  a file, and it is reported where files are protected. */
export async function protectPrivateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIRECTORY_MODE });
  if (process.platform === "win32") {
    const owner = await grantWindowsAcl(dir);
    await assertDaclOwnerOnly(dir, owner);
    return;
  }

  let chmodError: unknown;
  try {
    await chmod(dir, DIRECTORY_MODE);
  } catch (error) {
    // Remembered rather than fatal: on a filesystem that refuses mode changes the state
    // decides, exactly as protectPrivateFile's does.
    chmodError = error;
  }

  let mode: number;
  try {
    mode = (await stat(dir)).mode & 0o777;
  } catch (error) {
    throw new Error(`cannot verify private directory ${dir}: ${(error as Error).message}`);
  }

  if ((mode & 0o077) !== 0) {
    const detail = chmodError === undefined
      ? `mode is ${mode.toString(8)}, expected 700`
      : `chmod failed: ${(chmodError as Error).message}; mode is ${mode.toString(8)}`;
    throw new Error(`cannot protect private directory ${dir}: ${detail}; ${filesystemAdvice(dir)}`);
  }
}

/** What is wrong with `file`'s owner-only protection on this machine, or undefined when
 *  it holds as far as this side can see. Read-only on purpose, unlike protectPrivateFile:
 *  the caller that asks (secrets --apply) reads the file without rewriting it, so an
 *  operator's own ACL state is reported rather than silently corrected behind their back.
 *  The WSL boundary is not probed here either — that report belongs to protection, which
 *  is where a file gets (re)sealed, not to every read. */
export async function unprotectedPrivateFile(file: string): Promise<string | undefined> {
  if (process.platform === "win32") {
    try {
      await assertDaclOwnerOnly(file, await windowsOwnerSid(file));
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }
  let mode: number;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch (error) {
    return `its mode could not be read: ${(error as Error).message}`;
  }
  return (mode & 0o077) === 0 ? undefined : `mode is ${mode.toString(8)}, expected 600`;
}

/** Creates a private file without exposing its first byte under the process umask. */
async function createPrivateFileContent(file: string, content: string | Uint8Array): Promise<void> {
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
    if (typeof content === "string") await handle.writeFile(content, "utf8");
    else await handle.writeFile(content);
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

export function createPrivateFile(file: string, content: string): Promise<void> {
  return createPrivateFileContent(file, content);
}

export function createPrivateBinaryFile(file: string, content: Uint8Array): Promise<void> {
  return createPrivateFileContent(file, content);
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
