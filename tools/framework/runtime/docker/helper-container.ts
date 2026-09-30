// The optional long-lived helper container: startHelper/stopHelper/helperRunning warm it up
// so execInHelper/execCommand can exec into it instead of paying runOneOff's per-call
// create/destroy cost (~5-7s one-off vs ~1-3s exec once warm).

import type { ExecResult, Transport } from "../transport/transport.ts";
import { HelperNotRunning } from "../runtime.ts";

export class HelperContainer {
  #transport: Transport;
  #compose: (args: string[], stream?: boolean, allowFailure?: boolean) => Promise<ExecResult>;
  #containerId: (service?: string, all?: boolean) => Promise<string | undefined>;

  constructor(
    transport: Transport,
    compose: (args: string[], stream?: boolean, allowFailure?: boolean) => Promise<ExecResult>,
    containerId: (service?: string, all?: boolean) => Promise<string | undefined>,
  ) {
    this.#transport = transport;
    this.#compose = compose;
    this.#containerId = containerId;
  }

  async startHelper(service: string, profile: string): Promise<void> {
    await this.#compose(["--profile", profile, "up", "--detach", service], true);
  }

  async stopHelper(service: string, profile: string): Promise<void> {
    await this.#compose(["--profile", profile, "rm", "--force", "--stop", service], true);
  }

  async helperRunning(service: string): Promise<boolean> {
    const result = await this.#compose(["ps", "--quiet", service], false, true);
    return result.stdout.trim() !== "";
  }

  /** `-i` keeps stdin open — required for the MCP stdio bridge, harmless otherwise. `-t` is
   *  added only on a real terminal, mirroring the `-T` compose gets from `runOneOff`: a PTY
   *  does not survive the trip through wsl.exe. */
  async execInContainer(
    service: string,
    command: string,
    args: string[],
    options: { input?: string; stdioProtocol?: boolean; allowFailure?: boolean; timeoutMs?: number },
  ): Promise<ExecResult> {
    // Only a RUNNING container (all=false): about to exec into it.
    const id = await this.#containerId(service, false);
    if (id === undefined) {
      throw new HelperNotRunning(service);
    }

    const execArgs = ["exec", "-i"];
    if (options.stdioProtocol !== true && process.stdout.isTTY === true) execArgs.push("-t");
    return this.#transport.exec("docker", [...execArgs, id, command, ...args], {
      stream: options.input === undefined,
      input: options.input,
      stdioProtocol: options.stdioProtocol,
      allowFailure: options.allowFailure,
      timeoutMs: options.timeoutMs,
    });
  }

  /** "node dist/index.js" is hardcoded: it's the `cli` service's own entrypoint, which
   *  `docker exec` doesn't apply on its own the way `compose run` does. execCommand below is
   *  the same call with the entrypoint left to the caller. */
  async execInHelper(
    service: string,
    args: string[],
    options: { input?: string; stdioProtocol?: boolean; allowFailure?: boolean; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return this.execInContainer(service, "node", ["dist/index.js", ...args], options);
  }

  async execCommand(
    service: string,
    command: string,
    args: string[],
    options: { input?: string; stdioProtocol?: boolean; allowFailure?: boolean; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return this.execInContainer(service, command, args, options);
  }
}
