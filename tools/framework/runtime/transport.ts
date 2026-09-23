// Transport: how the tooling reaches the machine the instance lives on.
//
// This is the abstraction that lets the same code run from Windows, from WSL, or against a
// server. "Where our code executes" and "where the target lives" are different things:
// the Windows Node reaches a WSL target through wsl.exe, and nothing above this layer
// needs to know that.
//
// Rule for everything built on top: never touch target files with node:fs directly. The
// target may not share a filesystem with us. Go through the transport.
//
// All operations are async by design — no *Sync calls anywhere.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdir, rm, rmdir, access, readdir, lstat, open, rename, type FileHandle } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { die, maskSecrets } from "../core/log.ts";
import { outputSink } from "../core/output.ts";

export interface ExecOptions {
  /** Bytes are passed through unchanged; strings retain the existing UTF-8 behavior. */
  input?: string | Uint8Array;
  /** Stream output live; capture it when input or an output sink requires pipes. */
  stream?: boolean;
  env?: Record<string, string>;
  /** Remove these inherited names without putting their values in a command argument. */
  unsetEnv?: string[];
  allowFailure?: boolean;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quotes one value for a POSIX shell command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The two name markers of the tooling's own temp-sibling staging families: a private write
 *  stages `<path>.clawforge-private-<hex>` (private-config.ts, privateWriteCommand below), a
 *  publish stages `<path>.clawforge-publish-<hex>` (publishCommand below, LocalTransport.writeFile).
 *  Both siblings carry the file's real bytes from the first one written, so a process that dies
 *  before the rename — or a cleanup that fails — leaves them beside the target under a name no
 *  declared exact path matches. That is why the snapshot policy recognizes the marker families
 *  themselves (service/archive.ts excludes them, commands/lifecycle/verify.ts refuses them), not
 *  only the declared paths. Defined here, where the names are created, so the policy readers
 *  cannot drift from the writers. */
export const PRIVATE_STAGING_MARKER = ".clawforge-private-";
export const PUBLISH_STAGING_MARKER = ".clawforge-publish-";

/** Builds an exclusive, owner-only remote write with cleanup owned by the writer. */
function privateWriteCommand(path: string): [string, string[]] {
  const temporary = `${path}${PRIVATE_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
  const target = shellQuote(path);
  const staging = shellQuote(temporary);
  const script =
    `umask 077; set -C; temporary=${staging}; ` +
    `if : > "$temporary" 2>/dev/null; then ` +
    `trap 'rm -f -- "$temporary"' EXIT; ` +
    `cat >> "$temporary" && ln -T -- "$temporary" ${target}; status=$?; ` +
    `trap - EXIT; rm -f -- "$temporary"; exit $status; ` +
    `else exit 1; fi`;
  return ["sh", ["-c", script]];
}

/** Builds a publish command for a POSIX target: content lands in a temp sibling that is
 *  renamed over the wanted name. rename(2) swaps the directory entry, so an existing
 *  symlink at the target is replaced rather than written through, and a reader sees either
 *  the old or the new content — never a partial file (P1-02,
 *  docs/review-2026-09-23-xxa-round-6.md). */
function publishCommand(path: string): [string, string[]] {
  const temporary = `${path}${PUBLISH_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
  const script =
    "temporary=$1; target=$2; " +
    "trap 'rm -f -- \"$temporary\"' EXIT; " +
    "cat > \"$temporary\" && mv -f -- \"$temporary\" \"$target\"; status=$?; exit $status";
  return ["sh", ["-c", script, "sh", temporary, path]];
}

function validateEnvNames(names: string[]): void {
  const invalid = names.filter((name) => !ENV_NAME.test(name));
  if (invalid.length > 0) throw new Error(`invalid environment variable name: ${invalid.join(", ")}`);
}

function unsetInheritedEnvironment(environment: Record<string, string | undefined>, names: string[]): void {
  if (process.platform !== "win32") {
    for (const name of names) delete environment[name];
    return;
  }
  const removed = new Set(names.map((name) => name.toLowerCase()));
  for (const name of Object.keys(environment)) {
    if (removed.has(name.toLowerCase())) delete environment[name];
  }
}

export interface Transport {
  /** Human-readable name for diagnostics: "local", "wsl:Ubuntu-24.04", "ssh:user@host". */
  readonly description: string;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  /** Writes text as UTF-8 or byte content without a decoding round trip. */
  writeFile(path: string, content: string | Uint8Array, mode?: string): Promise<void>;
  /** Creates a new owner-only file without exposing its contents during the write. */
  readonly writePrivateFile?: (path: string, content: string | Uint8Array) => Promise<void>;
  /** Creates a new owner-only directory and refuses an existing path. */
  readonly mkdirPrivate?: (path: string) => Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Removes one empty directory, preserving any contents on failure. */
  readonly removeEmptyDir?: (path: string) => Promise<void>;
  /** Removes only empty directories below path; returns whether path itself was removed. */
  readonly removeEmptyTree?: (path: string) => Promise<boolean>;
  /** Every regular file under `dir`, recursively, as POSIX-style paths relative to it.
   *  A directory that does not exist is an empty list, not an error — the caller is usually
   *  asking "what is there now" before putting something there.
   *
   *  Needed by anything that mirrors a directory rather than only writing into it: without
   *  a listing there is no way to see what the target has that the source no longer does,
   *  and a mirror that never deletes is not a mirror. A newline inside a filename is not
   *  supported (the remote implementations parse a line-oriented listing). */
  listFiles(dir: string): Promise<string[]>;
  /** How an external client (an MCP client, a scheduler) should invoke a command of ours
   *  so that it reaches the target. Belongs here because only the transport knows whether
   *  a wrapper such as wsl.exe or ssh is needed. */
  clientInvocation(entryPath: string, args: string[]): { command: string; args: string[] };
}

/** Spawns a process locally. Arguments are passed as an array — never a shell string —
 *  so quoting is impossible to get wrong. */
export function spawnLocal(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    validateEnvNames(Object.keys(options.env ?? {}));
    validateEnvNames(options.unsetEnv ?? []);
    // Streaming means "let the user watch it happen", which is only true on a terminal.
    // When output is being captured, inheriting stdout would put the child's output into
    // the middle of a JSON-RPC message; it is piped and forwarded to the sink instead.
    const sink = outputSink();
    const streamToTerminal = options.stream === true && sink === undefined && options.input === undefined;

    const environment = { ...process.env, ...options.env };
    unsetInheritedEnvironment(environment, options.unsetEnv ?? []);

    const child = spawn(command, args, {
      stdio: streamToTerminal ? ["inherit", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
      env: environment,
    });

    let stdout = "";
    let stderr = "";
    let launchError: Error | undefined;
    let inputError: Error | undefined;
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (options.stream === true) {
        if (sink !== undefined) sink(String(chunk));
        else process.stdout.write(chunk);
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (options.stream === true) {
        if (sink !== undefined) sink(String(chunk));
        else process.stderr.write(chunk);
      }
    });

    // SIGTERM first, SIGKILL after a grace period: a child that ignores SIGTERM would
    // otherwise outwait the very deadline this timer exists to enforce.
    let escalate: ReturnType<typeof setTimeout> | undefined;
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        child.kill("SIGTERM");
        escalate = setTimeout(() => child.kill("SIGKILL"), 5000);
      }, options.timeoutMs);

    // Handle early stdin closure and wait for the complete child result.
    child.stdin?.on("error", (error) => {
      inputError ??= error;
    });

    child.on("error", (error) => {
      launchError ??= error;
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (escalate !== undefined) clearTimeout(escalate);
      const result: ExecResult = { code: code ?? -1, stdout, stderr };
      if (launchError !== undefined) {
        rejectPromise(launchError);
        return;
      }
      if (result.code !== 0 && options.allowFailure !== true) {
        const detail = (stderr.trim() || stdout.trim()).split("\n").slice(0, 5).join("\n");
        // Both halves are masked: the arguments may carry a token (onboarding takes one)
        // and the child's own output may echo it back.
        rejectPromise(
          new Error(
            maskSecrets(
              `${command} ${args.join(" ")} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`,
            ),
          ),
        );
        return;
      }
      if (inputError !== undefined && result.code === 0) {
        rejectPromise(new Error(`failed to deliver stdin: ${inputError.message}`));
        return;
      }
      resolvePromise(result);
    });

    try {
      if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    } catch (error) {
      inputError ??= error as Error;
      child.stdin?.destroy();
      if (child.exitCode === null && !child.killed) child.kill();
    }
  });
}

/** Environment variables cross a process boundary only if something carries them. Setting
 *  them on the local `wsl.exe` or `ssh` process does not put them in the target's process:
 *  WSL passes only what WSLENV names, and ssh only what the server's AcceptEnv allows. So
 *  they are prepended to the remote command itself with `env`. */
/** Builds the target-side `env` wrapper without retaining values that are being cleared. */
export function withEnvPrefix(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  unsetEnv: string[] | undefined,
): [string, string[]] {
  const entries = Object.entries(env ?? {});
  const removals = unsetEnv ?? [];
  const removed = new Set(removals);
  const assignments = entries.filter(([key]) => !removed.has(key));
  if (assignments.length === 0 && removals.length === 0) return [command, args];
  return ["env", [...removals.flatMap((name) => ["-u", name]), ...assignments.map(([key, value]) => `${key}=${value}`), command, ...args]];
}

/** Answers the existence question on the target and says which of the four answers it is:
 *  `exists`, `absent`, `blocked <dir>`, or `loop <path>` — only the second means the path is
 *  not there.
 *
 *  `test -e` alone cannot make that distinction. It exits 1 and prints nothing both for a
 *  path that is genuinely missing and for one the target user was not allowed to stat,
 *  because all it sees is a failed stat with the reason thrown away. So a negative answer is
 *  re-derived by walking the path one component at a time, from the root: each parent is
 *  confirmed to be a directory that can be searched BEFORE the next component is looked at,
 *  which makes every stat along the way one whose failure can only mean ENOENT.
 *
 *  A symlink is resolved and its target walked the same way, because the reason `test -e`
 *  fails may lie entirely outside the path as written: config/openclaw.json pointing at a
 *  file under a directory this user cannot enter is not a missing config, and answering that
 *  it is deletes live credentials one caller later. `readlink` rather than `readlink -f`:
 *  resolving the whole chain in one step would hide which link in it was the problem, and
 *  loses the same invariant this walk exists to keep.
 *
 *  Kept to POSIX sh: it runs on whatever the target has. It is fed to `sh -s` on stdin
 *  rather than passed as an argument, because wsl.exe re-parses the command line it is given
 *  and a multi-line argument does not survive that trip — the shell received a broken `case`
 *  and answered "Syntax error: word unexpected". Over stdin the script is data on a pipe,
 *  which no argument parser between here and the target touches. */
const PRESENCE_PROBE = `
p=$1
if [ -e "$p" ]; then echo exists; exit 0; fi
case $p in
  /*) rest=$p ;;
  *) rest=\${PWD%/}/$p ;;
esac
cur=
hops=0
while :; do
  while [ "\${rest#/}" != "$rest" ]; do rest=\${rest#/}; done
  [ -z "$rest" ] && break
  comp=\${rest%%/*}
  if [ "$comp" = "$rest" ]; then rest=; else rest=\${rest#*/}; fi
  [ "$comp" = "." ] && continue
  parent=\${cur:-/}
  if [ ! -d "$parent" ]; then echo absent; exit 0; fi
  if [ ! -x "$parent" ]; then echo "blocked $parent"; exit 0; fi
  if [ "$comp" = ".." ]; then cur=\${cur%/*}; continue; fi
  cur=$cur/$comp
  # -h is an lstat: it sees the link itself, so it answers even when the target does not.
  if [ -h "$cur" ]; then
    hops=$((hops + 1))
    if [ "$hops" -gt 40 ]; then echo "loop $cur"; exit 0; fi
    target=$(readlink "$cur") || { echo "unreadable $cur"; exit 0; }
    case $target in
      /*) cur=; rest=$target/$rest ;;
      *) cur=\${cur%/*}; rest=$target/$rest ;;
    esac
    continue
  fi
  if [ ! -e "$cur" ]; then echo absent; exit 0; fi
done
# Every component is there while the path as written is not: a trailing slash on a file, or
# something created since the first check. Either way the answer above stands.
echo absent
`;

/** Present, absent, or "the check itself could not run" — and the third must never be
 *  answered as the second.
 *
 *  `result.code === 0` was once the whole test, so ssh exiting 255 because it never reached
 *  the host, or wsl.exe failing because the distro would not start, both read as "that path
 *  is not there" about a machine this process never spoke to. Reading exit 1 with an empty
 *  stderr as "absent" was the same mistake one level down: that is exactly what `test -e`
 *  reports for an existing file under a directory the current user cannot enter.
 *
 *  Callers act on the answer: `secrets --apply` rebuilt config/.env from the empty
 *  requirement list that follows and deleted the keys it no longer believed were needed, and
 *  `restore` skips moving live data aside — then unpacks the archive over it, with sudo —
 *  when it believes the data directory is absent. Anything short of a definite "not there"
 *  therefore throws.
 *
 *  Exported for testing, like listFilesVia: the case worth pinning — an existing file under a
 *  directory the user may not enter — needs a real shell and a real directory tree, and
 *  neither needs a WSL distribution or a server to stage. */
export async function existsVia(
  exec: (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>,
  path: string,
): Promise<boolean> {
  // `sh -s -- <path>`: the script arrives on stdin and the path is its $1, so neither is ever
  // part of a command line — a space or a quote in the path is data, never syntax.
  const result = await exec("sh", ["-s", "--", path], { allowFailure: true, input: PRESENCE_PROBE });
  const verdict = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";

  if (result.code === 0) {
    if (verdict === "exists") return true;
    if (verdict === "absent") return false;
    if (verdict.startsWith("blocked ")) {
      throw new Error(
        `could not check whether ${path} exists: ${verdict.slice("blocked ".length)} cannot be searched by the target user`,
      );
    }
    if (verdict.startsWith("loop ")) {
      throw new Error(`could not check whether ${path} exists: ${verdict.slice("loop ".length)} is a symlink loop`);
    }
    if (verdict.startsWith("unreadable ")) {
      throw new Error(
        `could not check whether ${path} exists: ${verdict.slice("unreadable ".length)} is a symlink whose target could not be read`,
      );
    }
  }

  const detail = result.stderr.trim() === "" ? verdict : result.stderr.trim();
  throw new Error(`could not check whether ${path} exists (exit ${result.code})${detail === "" ? "" : `: ${detail}`}`);
}

/** Target and tooling share a filesystem: the fast path. */
export class LocalTransport implements Transport {
  readonly description = "local";

  exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return spawnLocal(command, args, options);
  }

  readFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async writeFile(path: string, content: string | Uint8Array, mode?: string): Promise<void> {
    // Same publish contract as publishCommand() on the remote transports: a temp sibling
    // renamed over the name. rename(2) replaces a symlink at path instead of following it,
    // and the exclusive temp create refuses to sneak through a link that appears between
    // the caller's containment check and this write.
    const temporary = `${path}${PUBLISH_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", mode === undefined ? 0o666 : Number.parseInt(mode, 8));
      await handle.writeFile(content);
      await handle.close();
      await rename(temporary, path);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
    const { createPrivateBinaryFile, createPrivateFile } = await import("../security/private-file.ts");
    if (typeof content === "string") await createPrivateFile(path, content);
    else await createPrivateBinaryFile(path, content);
  }

  async mkdirPrivate(path: string): Promise<void> {
    await mkdir(path, { mode: 0o700 });
    try {
      const { protectPrivateDirectory } = await import("../security/private-file.ts");
      await protectPrivateDirectory(path);
    } catch (error) {
      await rmdir(path).catch(() => {});
      throw error;
    }
  }

  /** Same distinction existsVia() makes for the exec-based transports: ENOENT (and ENOTDIR,
   *  which also means the path genuinely is not there) is an answer; any other errno —
   *  EACCES on a parent, an I/O error — is the check failing, not "absent". */
  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw new Error(`could not check whether ${path} exists: ${(error as Error).message}`);
    }
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async removeEmptyDir(path: string): Promise<void> {
    await rmdir(path);
  }

  async removeEmptyTree(path: string): Promise<boolean> {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw error;
    }
    if (!info.isDirectory()) return false;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await this.removeEmptyTree(join(path, entry.name));
    }
    try {
      await rmdir(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return false;
      throw error;
    }
  }

  async listFiles(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, recursive: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"));
  }

  clientInvocation(entryPath: string, args: string[]): { command: string; args: string[] } {
    return { command: entryPath, args };
  }
}

/** Shared by the two remote transports: `find` prints absolute paths, the contract is
 *  relative ones, and a missing directory is an empty listing rather than a failure.
 *
 *  Exported for testing: reaching it through a real WslTransport or SshTransport would mean
 *  a WSL distribution or a server, and the part worth checking — what is made of find's
 *  output — needs neither. */
export async function listFilesVia(
  exec: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>,
  dir: string,
): Promise<string[]> {
  const result = await exec("find", [dir, "-type", "f"], { allowFailure: true });
  if (result.code !== 0) return [];
  const prefix = `${dir.replace(/\/+$/, "")}/`;
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/** Target lives in a WSL distribution while the tooling runs on Windows Node.
 *  Every call is wrapped in `wsl.exe -d <distro> --exec …`; file access goes through the same
 *  channel, because the Windows side cannot rely on \\wsl$ paths behaving like POSIX. `--exec`
 *  is required here: the plain `--` form sends the command line through the distribution's
 *  default shell, which expands literal `$()` and backticks in otherwise safe argv values. */
export class WslTransport implements Transport {
  readonly description: string;
  // Native private field, not a TypeScript `private` parameter property: Node executes
  // TypeScript by erasing types only, so anything that would need code generation
  // (parameter properties, enum, namespace, decorators) is unavailable project-wide.
  #distro: string;

  constructor(distro: string) {
    this.#distro = distro;
    this.description = `wsl:${distro}`;
  }

  exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const [head, rest] = withEnvPrefix(command, args, options.env, options.unsetEnv);
    return spawnLocal("wsl.exe", ["-d", this.#distro, "--exec", head, ...rest], options);
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec("cat", [path]);
    return result.stdout;
  }

  async writeFile(path: string, content: string | Uint8Array, mode?: string): Promise<void> {
    // Publish via publishCommand(): temp sibling renamed over the name, never a write
    // through a symlink that is already there.
    const [command, args] = publishCommand(path);
    await this.exec(command, args, { input: content });
    if (mode !== undefined) await this.exec("chmod", [mode, path]);
  }

  writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
    const [command, args] = privateWriteCommand(path);
    return this.exec(command, args, { input: content }).then(() => undefined);
  }

  mkdirPrivate(path: string): Promise<void> {
    return this.exec("mkdir", ["-m", "700", path]).then(() => undefined);
  }

  exists(path: string): Promise<boolean> {
    return existsVia((command, args, options) => this.exec(command, args, options), path);
  }

  async mkdirp(path: string): Promise<void> {
    await this.exec("mkdir", ["-p", path]);
  }

  async remove(path: string): Promise<void> {
    await this.exec("rm", ["-rf", path]);
  }

  async removeEmptyDir(path: string): Promise<void> {
    await this.exec("rmdir", ["--", path]);
  }

  async removeEmptyTree(path: string): Promise<boolean> {
    if (!(await this.exists(path))) return false;
    const result = await this.exec("find", [path, "-depth", "-type", "d", "-empty", "-delete"]);
    if (result.code !== 0) throw new Error(`could not remove empty directories under ${path}: ${result.stderr.trim()}`);
    return !(await this.exists(path));
  }

  listFiles(dir: string): Promise<string[]> {
    return listFilesVia((command, args, options) => this.exec(command, args, options), dir);
  }

  /** Which distribution this transport talks to — the path bridge needs it for UNC paths. */
  get distro(): string {
    return this.#distro;
  }

  clientInvocation(entryPath: string, args: string[]): { command: string; args: string[] } {
    // Wrapped in bash -lc on purpose: MSYS rewrites a bare /mnt/... argument into
    // C:/Program Files/Git/mnt/... on its way through wsl.exe.
    const cut = entryPath.lastIndexOf("/");
    const directory = entryPath.slice(0, cut);
    const entry = entryPath.slice(cut + 1);
    const inner = `cd '${directory}' && ./${entry} ${args.join(" ")}`.trim();
    return { command: "wsl.exe", args: ["-d", this.#distro, "--", "bash", "-lc", inner] };
  }
}

/** Target is a remote host reached over SSH.
 *
 *  Commands are passed as an argument array all the way through: ssh joins them into a
 *  single remote command line, so anything containing spaces is quoted here rather than
 *  hoping the remote shell agrees with us. */
export class SshTransport implements Transport {
  readonly description: string;
  #host: string;

  constructor(host: string) {
    this.#host = host;
    this.description = `ssh:${host}`;
  }

  /** Minimal single-quote quoting for the remote shell. */
  static quote(argument: string): string {
    return `'${argument.replaceAll("'", `'\\''`)}'`;
  }

  exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const [head, rest] = withEnvPrefix(command, args, options.env, options.unsetEnv);
    const remote = [head, ...rest].map(SshTransport.quote).join(" ");
    return spawnLocal("ssh", [this.#host, remote], options);
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec("cat", [path]);
    return result.stdout;
  }

  async writeFile(path: string, content: string | Uint8Array, mode?: string): Promise<void> {
    const [command, args] = publishCommand(path);
    await this.exec(command, args, { input: content });
    if (mode !== undefined) await this.exec("chmod", [mode, path]);
  }

  writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
    const [command, args] = privateWriteCommand(path);
    return this.exec(command, args, { input: content }).then(() => undefined);
  }

  mkdirPrivate(path: string): Promise<void> {
    return this.exec("mkdir", ["-m", "700", path]).then(() => undefined);
  }

  exists(path: string): Promise<boolean> {
    return existsVia((command, args, options) => this.exec(command, args, options), path);
  }

  async mkdirp(path: string): Promise<void> {
    await this.exec("mkdir", ["-p", path]);
  }

  async remove(path: string): Promise<void> {
    await this.exec("rm", ["-rf", path]);
  }

  async removeEmptyDir(path: string): Promise<void> {
    await this.exec("rmdir", ["--", path]);
  }

  async removeEmptyTree(path: string): Promise<boolean> {
    if (!(await this.exists(path))) return false;
    const result = await this.exec("find", [path, "-depth", "-type", "d", "-empty", "-delete"]);
    if (result.code !== 0) throw new Error(`could not remove empty directories under ${path}: ${result.stderr.trim()}`);
    return !(await this.exists(path));
  }

  listFiles(dir: string): Promise<string[]> {
    return listFilesVia((command, args, options) => this.exec(command, args, options), dir);
  }

  get host(): string {
    return this.#host;
  }

  clientInvocation(entryPath: string, args: string[]): { command: string; args: string[] } {
    return { command: "ssh", args: [this.#host, entryPath, ...args] };
  }
}

export interface TransportConfig {
  location?: string;
  wslDistro?: string;
  sshHost?: string;
}

/** Picks the transport. "auto" means: Windows tooling reaches a WSL target, everything
 *  else is local. An explicit setting always wins. */
export async function createTransport(config: TransportConfig = {}): Promise<Transport> {
  const location = (config.location ?? "auto").toLowerCase();
  const distro = config.wslDistro ?? "Ubuntu-24.04";

  switch (location) {
    case "local":
      return new LocalTransport();
    case "wsl":
      return new WslTransport(distro);
    case "ssh": {
      const host = config.sshHost;
      if (host === undefined || host === "") {
        die("OC_TARGET_LOCATION=ssh requires OC_SSH_HOST (user@host)");
      }
      return new SshTransport(host);
    }
    case "auto":
      return process.platform === "win32" ? new WslTransport(distro) : new LocalTransport();
    default:
      return die(`unknown target location: ${location} (expected local, wsl, ssh or auto)`);
  }
}
