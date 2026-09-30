// Private target configuration and operator-file helpers for application-owned hooks.

import { randomBytes } from "node:crypto";
import { checksumOf } from "../../service/checksums.ts";
import { installedRecipePrivatePaths } from "../../service/recipe.ts";
import { recordPrivateWrite } from "./private-paths-ledger.ts";
import { locksDir, upsertEnvLine } from "../../core/env.ts";
import type { Context } from "../../core/context.ts";
import { registerSecret } from "../../core/io/log.ts";
import { shellQuote } from "../../core/io/shell.ts";
import { PRIVATE_STAGING_MARKER, type ExecResult } from "../../runtime/transport/transport.ts";

export { protectPrivateDirectory, createPrivateBinaryFile } from "./private-file.ts";

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

/** Normalizes a data-relative POSIX path by segments: collapses "//" and ".", resolves ".."
 *  textually. Returns null when the path climbs above its root. */
function normalizeRelativeSegments(path: string): string[] | null {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

// Fed to `sh -s` on stdin with the candidate ancestors as argv, since a multi-line argument
// doesn't survive wsl.exe's re-parsing. Explicit `exit 0` keeps the verdict on stdout alone —
// a for loop's exit status is its body's last command, so an all-clear scan would exit 1.
const SYMLINK_SCAN = `for p in "$@"; do
  [ -h "$p" ] && echo "$p"
done
exit 0
`;

/** A recipe may write private files only where its recipe.json declares them. privatePaths
 *  is the single source the snapshot rules read (archive.ts excludes, verify refuses), so a
 *  file written anywhere else is refused up front. Target is normalized and compared by
 *  segments, so `<data>/vault/../workspace/x` can't pass as covered by `vault`. Symlink
 *  contract: a link between the data directory and the declared root is refused; a link at
 *  the final component is replaced (file: `mv -T`) or refused (directory). Armor against
 *  path-assembly mistakes, not isolation from hostile code. The symlink scan runs over the
 *  RAW path's prefixes, not normalized, since a link before a `..` would otherwise vanish
 *  from textual normalization while still crossed on disk. */
async function assertDeclaredPrivatePath(
  ctx: Context,
  path: string,
  mode: "file" | "directory",
): Promise<{ ledger: string; boundary: string; target: string }> {
  const dataDir = ctx.settings?.dataDir ?? "";
  if (dataDir === "" || !path.startsWith(`${dataDir}/`)) {
    throw new Error(`private target path must be inside the data directory (${dataDir === "" ? "context has no dataDir" : dataDir}): ${path}`);
  }
  const rawRelative = path.slice(dataDir.length + 1);
  const relative = normalizeRelativeSegments(rawRelative);
  if (relative === null || relative.length === 0) {
    throw new Error(`private target path must stay inside the data directory: ${path}`);
  }
  const declared = await installedRecipePrivatePaths();
  const boundary = declared.find((candidate) => {
    const declaredSegments = candidate.split("/");
    return declaredSegments.length > 0 && relative.length >= declaredSegments.length
      && declaredSegments.every((segment, index) => relative[index] === segment);
  });
  if (boundary === undefined) {
    throw new Error(
      `private target path is not covered by any recipe's privatePaths — declare it (or a parent directory of it) in recipes/<name>/recipe.json: ${path}`,
    );
  }
  // Every proper prefix of the raw path is a directory the kernel crosses before the final
  // component. Directory mode adds the final component itself.
  const rawSegments = rawRelative.split("/");
  const checked = Array.from(
    { length: rawSegments.length - 1 },
    (_, depth) => `${dataDir}/${rawSegments.slice(0, depth + 1).join("/")}`,
  );
  if (mode === "directory") checked.push(`${dataDir}/${relative.join("/")}`);
  if (checked.length > 0) {
    let result: ExecResult;
    try {
      result = await ctx.transport.exec("sh", ["-s", "--", ...checked], { input: SYMLINK_SCAN, allowFailure: true });
    } catch (error) {
      throw new Error(`could not check the private target path for symlinks: ${(error as Error).message}`);
    }
    if (result.code !== 0) {
      throw new Error(`could not check the private target path for symlinks (exit ${result.code}): ${result.stderr.trim()}`);
    }
    const lines = result.stdout.split("\n").filter((line) => line !== "");
    if (lines.length > 0) {
      throw new Error(`private target path crosses a symlinked directory (${lines[0]}): ${path}`);
    }
  }
  return { ledger: relative.join("/"), boundary, target: `${dataDir}/${relative.join("/")}` };
}

/** Creates a target directory and narrows it to owner-only access. */
async function createPrivateDirectory(ctx: Context, path: string): Promise<void> {
  await ctx.transport.mkdirp(path);
  await ctx.transport.exec("chmod", ["700", path]);
}

/** Creates one of the recipe's declared private directories, owner-only. */
export async function ensurePrivateTargetDirectory(ctx: Context, path: string): Promise<void> {
  if (!path.startsWith("/")) throw new Error(`private target directory must be absolute: ${path}`);
  const { ledger, boundary, target } = await assertDeclaredPrivatePath(ctx, path, "directory");
  // Recorded before anything is created: a write that cannot be remembered is refused
  // rather than made and left unprotected once its declaration disappears.
  await recordPrivateWrite(ledger, boundary);
  await createPrivateDirectory(ctx, target);
}

/** Atomically replaces a target file with mode 600, preserving the old file on a failed write.
 *  The staging sibling stays name-adjacent to the verified target: the whole
 *  `.clawforge-private-` family is excluded by the snapshot policy and refused by verify, so
 *  an interrupted mv still leaves protected bytes behind. */
export async function replacePrivateTargetFile(ctx: Context, path: string, content: string): Promise<PrivateFileResult> {
  if (!path.startsWith("/")) throw new Error(`private target file must be absolute: ${path}`);
  const { ledger, boundary, target } = await assertDeclaredPrivatePath(ctx, path, "file");
  // Same contract as ensurePrivateTargetDirectory: recorded before anything is written.
  await recordPrivateWrite(ledger, boundary);
  // Created via the file's own declaration rather than ensurePrivateTargetDirectory: an
  // entry naming the exact file also covers its parent, without declaring it separately.
  await createPrivateDirectory(ctx, parentPath(target));
  const temporary = `${target}${PRIVATE_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
  try {
    if (ctx.transport.writePrivateFile !== undefined) await ctx.transport.writePrivateFile(temporary, content);
    else await ctx.transport.writeFile(temporary, content, "600");
    await ctx.transport.exec("chmod", ["600", temporary]);
    await ctx.transport.exec("mv", ["-fT", "--", temporary, target]);
  } catch (error) {
    await ctx.transport.remove(temporary).catch(() => {});
    throw error;
  }
  return { path: target, checksum: checksumOf(content), bytes: Buffer.byteLength(content, "utf8") };
}

/** Renders entries as shell-sourceable `export` lines, single-quoted per POSIX. */
function serializeShellEnv(entries: [string, string][]): string {
  return entries.map(([name, value]) => `export ${name}=${shellQuote(value)}`).join("\n") + "\n";
}

/** Runs a target command with secret values that never appear in any process's argv. Passing
 *  one to `ctx.transport.exec` directly would still leak it (an argument sits in
 *  `/proc/<pid>/cmdline`, `env` parks values in the wrapping process's argv). Values travel
 *  once, through a private write, into an owner-only file, and a shell sources it then
 *  replaces itself with the command. Registered for redaction first. */
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
    if (ctx.transport.mkdirPrivate !== undefined) await ctx.transport.mkdirPrivate(directory);
    else await ctx.transport.exec("mkdir", ["-m", "700", directory]);
    if (ctx.transport.writePrivateFile !== undefined) await ctx.transport.writePrivateFile(file, body);
    else {
      await ctx.transport.writeFile(file, body, "600");
      await ctx.transport.exec("chmod", ["600", file]);
    }
    const sourceAndExec =
      'file=$1; case "$file" in [A-Za-z]:*) ' +
      'command -v cygpath >/dev/null 2>&1 || { echo PRIVATE_ENV_PATH_UNSUPPORTED >&2; exit 65; }; ' +
      'file=$(cygpath -u -- "$file") || exit 65 ;; esac; ' +
      '. "$file" && shift && exec "$@"';
    result = await ctx.transport.exec("sh", ["-c", sourceAndExec, "sh", file, command, ...args]);
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

/** Replaces one KEY=VALUE entry while preserving unrelated target-env lines — core/env.ts's
 *  upsertEnvLine, which recognizes `export NAME=` and spacing round `=` like parseEnv does. */
export function upsertEnvValue(content: string, name: string, value: string): string {
  return upsertEnvLine(content, name, value);
}
