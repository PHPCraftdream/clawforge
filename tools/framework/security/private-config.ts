// Generic private target configuration helpers for application-owned recipes.

import { randomBytes } from "node:crypto";
import { checksumOf } from "../service/checksums.ts";
import { installedRecipePrivatePaths } from "../service/recipe.ts";
import { recordPrivateWrite } from "./private-paths-ledger.ts";
import { locksDir, serializeEnvLine } from "../core/env.ts";
import type { Context } from "../core/context.ts";
import { registerSecret } from "../core/log.ts";
import { PRIVATE_STAGING_MARKER, type ExecResult } from "../runtime/transport.ts";

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

// Fed to `sh -s` on stdin with the candidate ancestors as argv — the same channel
// existsVia() uses, because a multi-line argument does not survive wsl.exe's re-parsing.
// Ancestors are reported, not followed: the contract refuses the link, it does not judge
// its target. Explicit `exit 0` keeps the verdict on stdout alone — a for loop's exit
// status is its body's last command, so an all-clear scan would otherwise exit 1.
const SYMLINK_SCAN = `for p in "$@"; do
  [ -h "$p" ] && echo "$p"
done
exit 0
`;

/** A recipe may write private files only where its recipe.json declares them.
 *
 *  The privatePaths declaration is the single source the snapshot rules read: archive.ts
 *  excludes these paths from migrate and share, verify refuses archives that carry them.
 *  A file written anywhere else would be invisible to both — which is exactly how recipe
 *  credentials once travelled inside a migrate archive — so the write itself is refused,
 *  while the recipe is being developed, instead of silently leaking from every snapshot
 *  taken afterwards. Recipes are enumerated from the deployment's own recipe root, so the
 *  declaration a synthetic target is validated against is the deployed one.
 *
 *  The target is normalized by segments and compared against the declarations by segments,
 *  so `<data>/vault/../workspace/private.env` cannot pass as covered by a `vault`
 *  declaration. Symlink contract: a link BETWEEN the data directory and the declared root
 *  is refused, because it moves the write outside the subtree the declaration covers and
 *  the snapshots exclude; the data root itself may be a link (a deployment layout decision
 *  — a private write lands in the tree the link points to; backup is the exception and
 *  refuses a symlinked data root outright, because tar is handed the link's own name and
 *  would store the link instead of its content — audit 2026-09-22 round 2, P2-02), and a
 *  link at the final component of a FILE target is replaced (mv -T), not written through.
 *  This is armor against a recipe author's
 *  path-assembly mistake, not isolation from hostile JavaScript — the hook already holds a
 *  full Context.
 *
 *  The verdict is computed on the string the kernel will actually walk: pathname resolution
 *  follows the RAW path's components, and a link sitting before a `..` vanishes from
 *  textual normalization but is still crossed on disk — so the symlink scan runs over the
 *  raw path's directory prefixes, not the normalized ones. With no link among them,
 *  textual and physical resolution agree, and the single verified path returned here is
 *  what every subsequent mkdir/write/mv uses; the helpers never fall back to the raw
 *  string (audit 2026-09-22 round 2, P2-01). A link at the final component of a DIRECTORY
 *  target is refused too: `mkdir -p` and `chmod` do not replace it the way `mv -T` does,
 *  they act through it.
 *
 *  Returns the target's normalized data-relative path together with the declaration that
 *  covered it — the pair the private-paths ledger records, so a declared directory stays a
 *  declared directory after its declaration is gone while an undeclared ancestor of a file
 *  write never becomes one (audit 2026-09-22, P1-02; round 3, P2-01) — and the target's
 *  absolute form for the write. */
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
  // component; `.` and `..` inside a prefix are resolved as written, so they are scanned
  // exactly where they stand. Directory mode adds the final component itself.
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
  // rather than made and left unprotected once its declaration disappears (P1-02).
  await recordPrivateWrite(ledger, boundary);
  await createPrivateDirectory(ctx, target);
}

/** Atomically replaces a target file with mode 600, preserving the old file on a failed write.
 *
 *  The staging sibling carries the real bytes from the first one written, so a process (or a
 *  cleanup) interrupted before the mv leaves them beside the target under a name the
 *  declaration's exact path never matches. The sibling therefore stays name-adjacent to the
 *  verified target on purpose: the whole `.clawforge-private-` family is what the snapshot
 *  policy excludes and verify refuses (service/archive.ts, commands/lifecycle/verify.ts), and
 *  a successful run removes it here. */
export async function replacePrivateTargetFile(ctx: Context, path: string, content: string): Promise<PrivateFileResult> {
  if (!path.startsWith("/")) throw new Error(`private target file must be absolute: ${path}`);
  const { ledger, boundary, target } = await assertDeclaredPrivatePath(ctx, path, "file");
  // Recorded before anything is written, same contract as ensurePrivateTargetDirectory:
  // a write that cannot be remembered is refused rather than left unprotected (P1-02).
  await recordPrivateWrite(ledger, boundary);
  // Created and validated through the file's own declaration rather than via
  // ensurePrivateTargetDirectory: a declaration may name the exact file, and that entry
  // then covers its parent directory too without the parent being declared a second time.
  await createPrivateDirectory(ctx, parentPath(target));
  // The staging file and the mv both use the verified path: with the symlink contract
  // above enforced, this is the only path any part of the write touches.
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

/** Replaces one KEY=VALUE entry while preserving unrelated target-env lines.
 *
 *  The written line comes from serializeEnvLine — the lossless inverse of parseEnv — so a
 *  value with edge whitespace or embedded quotes survives the next read byte-identically
 *  instead of being rewritten bare and trimmed (P2-13). Name and value are validated by
 *  that call before any line is touched; the refusal messages are the same ones this
 *  function has always thrown. */
export function upsertEnvValue(content: string, name: string, value: string): string {
  const line = serializeEnvLine(name, value);
  const lines = content.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  let replaced = false;
  const next = lines.map((existing) => {
    if (!existing.startsWith(`${name}=`)) return existing;
    replaced = true;
    return line;
  });
  if (!replaced) next.push(line);
  return `${next.join("\n")}\n`;
}
