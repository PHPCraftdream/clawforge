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

import { spawn } from "node:child_process";
import { readFile, writeFile, chmod, mkdir, rm, access, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { die, maskSecrets } from "./log.ts";
import { outputSink } from "./output.ts";

export interface ExecOptions {
  input?: string;
  /** Inherit stdio so the user watches long output live; stdout/stderr come back empty. */
  stream?: boolean;
  env?: Record<string, string>;
  allowFailure?: boolean;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Transport {
  /** Human-readable name for diagnostics: "local", "wsl:Ubuntu-24.04", "ssh:user@host". */
  readonly description: string;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, mode?: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
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
    // Streaming means "let the user watch it happen", which is only true on a terminal.
    // When output is being captured, inheriting stdout would put the child's output into
    // the middle of a JSON-RPC message; it is piped and forwarded to the sink instead.
    const sink = outputSink();
    const streamToTerminal = options.stream === true && sink === undefined;

    const child = spawn(command, args, {
      stdio: streamToTerminal ? ["inherit", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (options.stream === true && sink !== undefined) sink(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (options.stream === true && sink !== undefined) sink(String(chunk));
    });

    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      rejectPromise(error);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result: ExecResult = { code: code ?? -1, stdout, stderr };
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
      resolvePromise(result);
    });

    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

/** Environment variables cross a process boundary only if something carries them. Setting
 *  them on the local `wsl.exe` or `ssh` process does not put them in the target's process:
 *  WSL passes only what WSLENV names, and ssh only what the server's AcceptEnv allows. So
 *  they are prepended to the remote command itself with `env`. */
function withEnvPrefix(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
): [string, string[]] {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return [command, args];
  return ["env", [...entries.map(([key, value]) => `${key}=${value}`), command, ...args]];
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

  async writeFile(path: string, content: string, mode?: string): Promise<void> {
    await writeFile(path, content, "utf8");
    if (mode !== undefined) await chmod(path, Number.parseInt(mode, 8));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
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
 *  Every call is wrapped in `wsl.exe -d <distro> -- …`; file access goes through the same
 *  channel, because the Windows side cannot rely on \\wsl$ paths behaving like POSIX. */
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
    const [head, rest] = withEnvPrefix(command, args, options.env);
    return spawnLocal("wsl.exe", ["-d", this.#distro, "--", head, ...rest], options);
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec("cat", [path]);
    return result.stdout;
  }

  async writeFile(path: string, content: string, mode?: string): Promise<void> {
    // `tee` rather than a redirect: no shell means no quoting hazards.
    await this.exec("tee", [path], { input: content });
    if (mode !== undefined) await this.exec("chmod", [mode, path]);
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.exec("test", ["-e", path], { allowFailure: true });
    return result.code === 0;
  }

  async mkdirp(path: string): Promise<void> {
    await this.exec("mkdir", ["-p", path]);
  }

  async remove(path: string): Promise<void> {
    await this.exec("rm", ["-rf", path]);
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
    const [head, rest] = withEnvPrefix(command, args, options.env);
    const remote = [head, ...rest].map(SshTransport.quote).join(" ");
    return spawnLocal("ssh", [this.#host, remote], options);
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec("cat", [path]);
    return result.stdout;
  }

  async writeFile(path: string, content: string, mode?: string): Promise<void> {
    await this.exec("tee", [path], { input: content });
    if (mode !== undefined) await this.exec("chmod", [mode, path]);
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.exec("test", ["-e", path], { allowFailure: true });
    return result.code === 0;
  }

  async mkdirp(path: string): Promise<void> {
    await this.exec("mkdir", ["-p", path]);
  }

  async remove(path: string): Promise<void> {
    await this.exec("rm", ["-rf", path]);
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
