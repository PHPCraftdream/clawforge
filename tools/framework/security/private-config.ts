// Generic private target configuration helpers for application-owned recipes.

import { randomBytes } from "node:crypto";
import { checksumOf } from "../service/checksums.ts";
import type { Context } from "../core/context.ts";
import { registerSecret } from "../core/log.ts";

export interface PrivateFileResult {
  readonly path: string;
  readonly checksum: string;
  readonly bytes: number;
}

/** Generates a URL-safe secret without printing or registering its value. */
export function generatePrivateSecret(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16) throw new Error("private secret size must be at least 16 bytes");
  return randomBytes(bytes).toString("base64url");
}

/** Adds an app-owned credential to the framework's process-local redaction registry. */
export function registerPrivateSecret(value: string): void {
  registerSecret(value);
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

/** Creates a target directory and narrows it to owner-only access. */
export async function ensurePrivateTargetDirectory(ctx: Context, path: string): Promise<void> {
  if (!path.startsWith("/")) throw new Error(`private target directory must be absolute: ${path}`);
  await ctx.transport.mkdirp(path);
  await ctx.transport.exec("chmod", ["700", path]);
}

/** Atomically replaces a target file with mode 600, preserving the old file on a failed write. */
export async function replacePrivateTargetFile(ctx: Context, path: string, content: string): Promise<PrivateFileResult> {
  if (!path.startsWith("/")) throw new Error(`private target file must be absolute: ${path}`);
  await ensurePrivateTargetDirectory(ctx, parentPath(path));
  const temporary = `${path}.clawforge-private-${randomBytes(8).toString("hex")}`;
  try {
    if (ctx.transport.writePrivateFile !== undefined) await ctx.transport.writePrivateFile(temporary, content);
    else await ctx.transport.writeFile(temporary, content, "600");
    await ctx.transport.exec("chmod", ["600", temporary]);
    await ctx.transport.exec("mv", ["-fT", "--", temporary, path]);
  } catch (error) {
    await ctx.transport.remove(temporary).catch(() => {});
    throw error;
  }
  return { path, checksum: checksumOf(content), bytes: Buffer.byteLength(content, "utf8") };
}

/** Replaces one KEY=VALUE entry while preserving unrelated target-env lines. */
export function upsertEnvValue(content: string, name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid environment variable name: ${name}`);
  if (/[\r\n]/.test(value)) throw new Error(`environment value for ${name} contains a newline`);
  const lines = content.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  let replaced = false;
  const next = lines.map((line) => {
    if (!line.startsWith(`${name}=`)) return line;
    replaced = true;
    return `${name}=${value}`;
  });
  if (!replaced) next.push(`${name}=${value}`);
  return `${next.join("\n")}\n`;
}
