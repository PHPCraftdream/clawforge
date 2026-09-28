// Target lives in a WSL distribution while the tooling runs on Windows Node. Split out of
// transport.ts to keep that file a thin facade over the per-transport implementations.
//
// Every call is wrapped in `wsl.exe -d <distro> --exec …`; file access goes through the same
// channel, because the Windows side cannot rely on \\wsl$ paths behaving like POSIX. `--exec`
// is required here: the plain `--` form sends the command line through the distribution's
// default shell, which expands literal `$()` and backticks in otherwise safe argv values.

import { listFilesVia } from "../../security/transport-listing.ts";
import type { ExecOptions, ExecResult, Transport } from "./exec.ts";
import { spawnLocal } from "./exec.ts";
import { existsVia, privateWriteCommand, publishCommand, withEnvPrefix } from "./quoting.ts";

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
