// Generic private target configuration helpers for application-owned recipes.

import { randomBytes } from "node:crypto";
import { checksumOf } from "../service/checksums.ts";
import { installedRecipePrivatePaths } from "../service/recipe.ts";
import { locksDir } from "../core/env.ts";
import type { Context } from "../core/context.ts";
import { registerSecret } from "../core/log.ts";
import type { ExecResult } from "../runtime/transport.ts";

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

/** A recipe may write private files only where its recipe.json declares them.
 *
 *  The privatePaths declaration is the single source the snapshot rules read: archive.ts
 *  excludes these paths from migrate and share, verify refuses archives that carry them.
 *  A file written anywhere else would be invisible to both — which is exactly how recipe
 *  credentials once travelled inside a migrate archive — so the write itself is refused,
 *  while the recipe is being developed, instead of silently leaking from every snapshot
 *  taken afterwards. Recipes are enumerated from the deployment's own recipe root, so the
 *  declaration a synthetic target is validated against is the deployed one. */
async function assertDeclaredPrivatePath(ctx: Context, path: string): Promise<void> {
  const dataDir = ctx.settings?.dataDir ?? "";
  if (dataDir === "" || !path.startsWith(`${dataDir}/`)) {
    throw new Error(`private target path must be inside the data directory (${dataDir === "" ? "context has no dataDir" : dataDir}): ${path}`);
  }
  const relative = path.slice(dataDir.length + 1);
  const declared = await installedRecipePrivatePaths();
  if (!declared.some((candidate) => relative === candidate || relative.startsWith(`${candidate}/`))) {
    throw new Error(
      `private target path is not covered by any recipe's privatePaths — declare it (or a parent directory of it) in recipes/<name>/recipe.json: ${path}`,
    );
  }
}

/** Creates a target directory and narrows it to owner-only access. */
async function createPrivateDirectory(ctx: Context, path: string): Promise<void> {
  await ctx.transport.mkdirp(path);
  await ctx.transport.exec("chmod", ["700", path]);
}

/** Creates one of the recipe's declared private directories, owner-only. */
export async function ensurePrivateTargetDirectory(ctx: Context, path: string): Promise<void> {
  if (!path.startsWith("/")) throw new Error(`private target directory must be absolute: ${path}`);
  await assertDeclaredPrivatePath(ctx, path);
  await createPrivateDirectory(ctx, path);
}

/** Atomically replaces a target file with mode 600, preserving the old file on a failed write. */
export async function replacePrivateTargetFile(ctx: Context, path: string, content: string): Promise<PrivateFileResult> {
  if (!path.startsWith("/")) throw new Error(`private target file must be absolute: ${path}`);
  await assertDeclaredPrivatePath(ctx, path);
  // Created and validated through the file's own declaration rather than via
  // ensurePrivateTargetDirectory: a declaration may name the exact file, and that entry
  // then covers its parent directory too without the parent being declared a second time.
  await createPrivateDirectory(ctx, parentPath(path));
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

/** Renders entries as shell-sourceable `export` lines, single-quoted per POSIX. */
function serializeShellEnv(entries: [string, string][]): string {
  return entries.map(([name, value]) => `export ${name}='${value.replaceAll("'", `'\\''`)}'`).join("\n") + "\n";
}

/** Runs a target command with secret values that never appear in any process's argv.
 *
 * Everything else here keeps secrets out of this process's own logs; handing one to
 * `ctx.transport.exec` still leaks it on the target — as an argument it sits in the target
 * command's `/proc/<pid>/cmdline` for the whole run, and the transport's own `env` option
 * parks values in the wrapping `env` process's argv for the window before it execs. So the
 * values travel once, through the transport's private write, into an owner-only file under
 * locksDir (the runtime's own env-file pattern), and a shell sources that file and replaces
 * itself with the command. Nothing here can see the values again once the file is written —
 * which is also why they are registered for redaction first: a failing child is reported
 * with its whole command line, and the command's own output may echo them. */
export async function execWithSecrets(
  ctx: Context,
  command: string,
  args: string[],
  options: { env: Record<string, string> },
): Promise<ExecResult> {
  const entries = Object.entries(options.env);
  if (entries.length === 0) return ctx.transport.exec(command, args);
  const invalid = entries.filter(([name]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).map(([name]) => name);
  if (invalid.length > 0) throw new Error(`invalid environment variable name: ${invalid.join(", ")}`);
  const multiline = entries.filter(([, value]) => /[\r\n]/.test(value)).map(([name]) => name);
  if (multiline.length > 0) throw new Error(`environment value for ${multiline.join(", ")} contains a newline`);
  for (const [, value] of entries) registerSecret(value);

  const locks = locksDir(ctx.settings.dataDir);
  const directory = `${locks}/recipe-exec-${randomBytes(8).toString("hex")}`;
  const file = `${directory}/env`;
  const body = serializeShellEnv(entries);
  let result!: ExecResult;
  let operationError: unknown;
  let cleanupError: unknown;
  try {
    await ctx.transport.mkdirp(locks);
    await ctx.transport.exec("mkdir", ["-m", "700", directory]);
    if (ctx.transport.writePrivateFile !== undefined) await ctx.transport.writePrivateFile(file, body);
    else {
      await ctx.transport.writeFile(file, body, "600");
      await ctx.transport.exec("chmod", ["600", file]);
    }
    result = await ctx.transport.exec("sh", ["-c", '. "$1" && shift && exec "$@"', "sh", file, command, ...args]);
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await ctx.transport.remove(directory);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) {
    throw new Error(`could not remove the temporary environment file: ${(cleanupError as Error).message}`);
  }
  return result;
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
