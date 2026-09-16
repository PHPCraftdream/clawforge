import { chmod, open, rename, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const PRIVATE_MODE = 0o600;

function mountedWindowsPath(file: string): boolean {
  return process.platform === "linux" && /^\/mnt\/[a-z](?:\/|$)/i.test(resolve(file));
}

function filesystemAdvice(file: string): string {
  return mountedWindowsPath(file)
    ? "the path is on a mounted Windows/DrvFs filesystem; move the deployment into the Linux filesystem or configure Windows ACLs before retrying"
    : "check the filesystem and its ownership before retrying";
}

async function windowsCommand(command: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, output }));
  });
}

async function protectWindowsAcl(file: string): Promise<void> {
  let identity: string;
  try {
    const who = await windowsCommand("whoami", []);
    if (who.code !== 0 || who.output.trim() === "") throw new Error(who.output.trim() || `exit ${who.code}`);
    identity = who.output.trim().split(/\r?\n/, 1)[0] ?? "";
  } catch (error) {
    throw new Error(`cannot determine the Windows owner for ${file}: ${(error as Error).message}`);
  }

  const acl = await windowsCommand("icacls", [
    file,
    "/inheritance:r",
    "/grant:r",
    `${identity}:F`,
    "*S-1-5-18:F",
    "*S-1-5-32-544:F",
    "/remove:g",
    "*S-1-1-0",
    "*S-1-5-11",
    "*S-1-5-32-545",
  ]);
  if (acl.code !== 0) {
    throw new Error(`icacls failed (exit ${acl.code}): ${acl.output.trim() || "no details"}`);
  }

  const verification = await windowsCommand("icacls", [file]);
  const output = verification.output.toLowerCase();
  if (verification.code !== 0 || /s-1-1-0|s-1-5-11|s-1-5-32-545|\\everyone|\\users|authenticated users/.test(output)) {
    throw new Error("the resulting ACL still grants access to a broad Windows group");
  }
}

/** Ensures a credential-bearing file is owner-only where POSIX modes apply. */
export async function protectPrivateFile(file: string): Promise<void> {
  if (process.platform === "win32") {
    await protectWindowsAcl(file);
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
  const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await createPrivateFile(temporary, content);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await protectPrivateFile(file);
}
