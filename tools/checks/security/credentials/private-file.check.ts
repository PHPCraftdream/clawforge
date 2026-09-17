// Private environment files are protected before a credential can be written — and the
// protection is proven rather than assumed: the Windows ACL is read back as SDDL (trustee
// SIDs, never localized display names), and when this machine's WSL distributions can reach
// the file through a drive mount, the refusal IS the success case. Platform-specific
// assertions print a skip line elsewhere rather than failing.

import { access, chmod, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateFile, installedWslDistros, protectPrivateFile, replacePrivateFile } from "#framework/security/private-file.ts";
import { spawnLocal } from "#framework/runtime/transport.ts";
import { withOutputSink } from "#framework/core/output.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(`  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`);
}

function skip(reason: string): void {
  process.stderr.write(`  skip ${reason}\n`);
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

const systemTool = (name: string): string => join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

const icacls = (args: string[]): Promise<{ code: number; stdout: string }> =>
  spawnLocal(systemTool("icacls.exe"), args, { allowFailure: true, timeoutMs: 60_000 });

async function windowsOwnerSid(): Promise<string> {
  const result = await spawnLocal(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { allowFailure: true });
  return /S-1-\d+(?:-\d+)+/.exec(result.stdout)?.[0] ?? "";
}

/** The DACL as saved SDDL — the same locale-free form the product verifies with, read here
 *  independently so the check does not trust the code under test to grade itself. */
async function savedAces(file: string): Promise<{ daclProtected: boolean; aces: { type: string; flags: string; rights: string; trustee: string }[] }> {
  const saved = join(tmpdir(), `clawforge-check-dacl-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const result = await icacls([file, "/save", saved]);
  if (result.code !== 0) throw new Error(`icacls /save failed: ${result.stdout.trim()}`);
  try {
    const text = await readFile(saved, "utf16le");
    const line = text.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("D:"));
    const aces = [...(line ?? "").matchAll(/\(([^()]*)\)/g)].map((match) => {
      const [type = "", flags = "", rights = "", , , trustee = ""] = match[1].split(";");
      return { type, flags, rights, trustee };
    });
    return { daclProtected: /^D:([A-Z]*)/.exec(line ?? "")?.[1]?.includes("P") === true, aces };
  } finally {
    await rm(saved, { force: true }).catch(() => {});
  }
}

/** The review's own probe, independent of the product: can an unprivileged Linux user of an
 *  installed distribution open the file through the drive mount? Uses the default /mnt root;
 *  a distribution with a custom root merely fails to open, which cannot fake an OPEN. */
async function wslOpensAsNobody(file: string, distros: string[]): Promise<string> {
  const windows = /^([A-Za-z]):[\\/](.*)$/.exec(file);
  if (windows === null) return "UNPROBED";
  const drive = windows[1] ?? "c";
  const rest = (windows[2] ?? "").replaceAll("\\", "/");
  const quoted = `'${`/mnt/${drive.toLowerCase()}/${rest}`.replaceAll("'", `'\\''`)}'`;
  for (const distro of distros) {
    const script = `runuser -u nobody -- sh -c 'head -c 0 ${quoted} >/dev/null 2>&1 && echo OPEN || echo DENIED'`;
    const result = await spawnLocal(
      systemTool("wsl.exe"),
      ["-d", distro, "-u", "root", "--exec", "sh", "-c", script],
      { allowFailure: true, timeoutMs: 90_000 },
    );
    if (result.stdout.replaceAll("\0", "").trim() === "OPEN") return "OPEN";
  }
  return "DENIED";
}

/** A pre-existing file at the temporary path a legacy build would compute must survive: the
 *  cleanup may only ever remove a file this call created. Freezing Date.now pins the legacy
 *  PID+timestamp name; the random name never lands on it. */
async function plantedTemporarySurvives(root: string): Promise<void> {
  const target = join(root, "replace.env");
  await writeFile(target, "OPENCLAW_GATEWAY_TOKEN=old-token\n");
  const frozen = 1_700_000_000_000;
  const planted = `${target}.${process.pid}.${frozen.toString(36)}.tmp`;
  await writeFile(planted, "planted-by-the-check\n");
  const realNow = Date.now;
  let error: unknown;
  try {
    Date.now = () => frozen;
    try {
      await replacePrivateFile(target, "OPENCLAW_GATEWAY_TOKEN=new-token\n");
    } catch (caught) {
      error = caught;
    }
  } finally {
    Date.now = realNow;
  }
  check("a foreign file at a colliding temporary path is never removed", await exists(planted), true);
  check("the planted temporary keeps its content", await readFile(planted, "utf8"), "planted-by-the-check\n");
  check("the replacement no longer fails on the planted name", (error as NodeJS.ErrnoException | undefined)?.code, undefined);
  const plantedName = planted.split(/[\\/]/).pop() ?? planted;
  const litter = (await readdir(root)).filter((name) => name.endsWith(".tmp") && name !== plantedName);
  check("no temporary litter remains afterwards", litter, []);
  await rm(planted, { force: true });
}

async function posixChecks(root: string): Promise<void> {
  const file = join(root, "deployment.env");
  await createPrivateFile(file, "OPENCLAW_GATEWAY_TOKEN=synthetic-token\n");
  check("a newly created environment file contains the complete value", await readFile(file, "utf8"), "OPENCLAW_GATEWAY_TOKEN=synthetic-token\n");
  check("a newly created environment file is owner-only", (await stat(file)).mode & 0o777, 0o600);

  await chmod(file, 0o644);
  await protectPrivateFile(file);
  check("an existing permissive environment file is tightened", (await stat(file)).mode & 0o777, 0o600);

  let collision = false;
  try {
    await createPrivateFile(file, "replacement\n");
  } catch (error) {
    collision = (error as NodeJS.ErrnoException).code === "EEXIST";
  }
  check("creation refuses to overwrite an existing environment file", collision, true);
  check("a refused creation leaves the original value", await readFile(file, "utf8"), "OPENCLAW_GATEWAY_TOKEN=synthetic-token\n");

  await replacePrivateFile(file, "OPENCLAW_GATEWAY_TOKEN=replaced-token\n");
  check("atomic replacement publishes the complete new value", await readFile(file, "utf8"), "OPENCLAW_GATEWAY_TOKEN=replaced-token\n");

  const missingParent = join(root, "missing", "deployment.env");
  let failedWrite = false;
  try {
    await createPrivateFile(missingParent, "must-not-survive\n");
  } catch {
    failedWrite = true;
  }
  check("a failed private-file write reports its error", failedWrite, true);
}

async function windowsChecks(root: string, distros: string[]): Promise<void> {
  skip("POSIX mode assertions on Windows (ACLs are authoritative)");
  const secret = "OPENCLAW_GATEWAY_TOKEN=tok-check-synthetic-1\n";

  // --- the DACL is rebuilt from an allowed SID set, not patched -----------------------------
  const file = join(root, "acl.env");
  await writeFile(file, secret);
  const owner = await windowsOwnerSid();
  const planted = await icacls([file, "/grant", "*S-1-5-32-546:R"]);
  check("a Guests ACE can be planted by SID for this test", planted.code, 0);
  let refusal: string | null = null;
  let captured = "";
  try {
    await withOutputSink((chunk) => {
      captured += chunk;
    }, () => protectPrivateFile(file));
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  const dacl = await savedAces(file);
  const allowed = new Set([owner, "S-1-5-18", "S-1-5-32-544", "BA", "SY"]);
  const foreign = dacl.aces.map((ace) => ace.trustee).filter((trustee) => !allowed.has(trustee));
  check("no trustee beyond owner, SYSTEM and Administrators survives", foreign, []);
  check("the DACL is sealed against inheritance", dacl.daclProtected && dacl.aces.every((ace) => !ace.flags.includes("ID")), true);
  check("the owner keeps full access", dacl.aces.some((ace) => ace.trustee === owner && /^FA$/i.test(ace.rights)), true);
  let ownerCanWrite = true;
  try {
    const handle = await open(file, "r+");
    await handle.close();
  } catch {
    ownerCanWrite = false;
  }
  check("the owner can still open the file for writing", ownerCanWrite, true);

  // --- the WSL boundary is reported, never silently assumed -----------------------------------
  if (distros.length === 0) {
    skip("WSL boundary assertions (no WSL distribution installed)");
    check("with no WSL installed, protection succeeds without a boundary warning", refusal === null && !captured.includes("Windows/WSL boundary"), true);
  } else {
    const probe = await wslOpensAsNobody(file, distros);
    if (probe === "OPEN") {
      check("a file another Linux user can open through WSL is still protected", refusal, null);
      check("the boundary gap is warned about, naming the distribution", distros.some((distro) => captured.includes(`"${distro}"`)), true);
      check("the warning names the distribution-side path", captured.includes("/mnt/"), true);
      check("the warning never carries the file's content", captured.includes(secret.trim()), false);
      check("the warning says what to do about it", captured.includes("wsl.conf"), true);
    } else {
      check("protection succeeds when no distribution can open the file", refusal, null);
      check("no boundary gap is reported when every distribution is shut out", captured.includes("Windows/WSL boundary"), false);
      if (probe !== "DENIED") skip(`the independent probe could not answer (${probe}); the product's own verdict governed`);
    }
  }

  {
    // Creation goes through the same protection: it must succeed and report the same gap.
    let created = false;
    let freshCaptured = "";
    try {
      await withOutputSink((chunk) => {
        freshCaptured += chunk;
      }, () => createPrivateFile(join(root, "fresh.env"), secret));
      created = true;
    } catch {
      created = false;
    }
    check("creation succeeds on a Windows drive", created, true);
    check("creation writes the complete value", created ? await readFile(join(root, "fresh.env"), "utf8") : "", secret);
    if (distros.length === 0) {
      check("creation warns nothing when there is no WSL to reach the file", freshCaptured.includes("Windows/WSL boundary"), false);
    } else {
      check("creation reports the same boundary gap", distros.some((distro) => freshCaptured.includes(`"${distro}"`)), true);
    }
  }
}

const root = await mkdtemp(join(tmpdir(), "clawforge-private-file-check-"));
try {
  const distros = process.platform === "win32" ? await installedWslDistros() : [];
  if (process.platform === "win32") await windowsChecks(root, distros);
  else await posixChecks(root);
  await plantedTemporarySurvives(root);
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all private-file checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
