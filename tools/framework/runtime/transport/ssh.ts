// Target is a remote host reached over SSH. Split out of transport.ts to keep that file a
// thin facade over the per-transport implementations.
//
// Commands are passed as an argument array all the way through: ssh joins them into a
// single remote command line, so anything containing spaces is quoted here rather than
// hoping the remote shell agrees with us.

import { listFilesVia } from "../../security/transport-listing.ts";
import type { ExecOptions, ExecResult, Transport } from "./exec.ts";
import { spawnLocal } from "./exec.ts";
import { existsVia, privateWriteCommand, publishCommand, withEnvPrefix } from "./quoting.ts";

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
