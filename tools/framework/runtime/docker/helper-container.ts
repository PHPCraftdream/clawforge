// The optional long-lived helper container: startHelper/stopHelper/helperRunning warm it up
// so execInHelper/execCommand can exec into an already-running container instead of paying
// runOneOff's per-call create/destroy cost — measured directly: ~5-7s one-off vs ~1-3s exec
// once warm. Split out of runtime-docker.ts to keep that file orchestration-only.

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
    options: { input?: string; allowFailure?: boolean; timeoutMs?: number },
  ): Promise<ExecResult> {
    // Only a RUNNING container (all=false): this is about to exec into it, and the same
    // direct-label lookup containerId() otherwise uses for the main service serves any
    // service name asked of it, helper containers included.
    const id = await this.#containerId(service, false);
    if (id === undefined) {
      throw new HelperNotRunning(service);
    }

    const execArgs = ["exec", "-i"];
    if (process.stdout.isTTY === true) execArgs.push("-t");
    return this.#transport.exec("docker", [...execArgs, id, command, ...args], {
      stream: options.input === undefined,
      input: options.input,
      allowFailure: options.allowFailure,
      timeoutMs: options.timeoutMs,
    });
  }

  /** "node dist/index.js" is hardcoded rather than taken from options: it is the `cli`
   *  service's own entrypoint (see docker-compose.yml), which `docker exec` does not apply
   *  on its own the way `compose run` does. execCommand below is the same call with the
   *  entrypoint left to the caller, for everything that is not the app's own CLI. */
  async execInHelper(
    service: string,
    args: string[],
    options: { input?: string; allowFailure?: boolean; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return this.execInContainer(service, "node", ["dist/index.js", ...args], options);
  }

  async execCommand(
    service: string,
    command: string,
    args: string[],
    options: { input?: string; allowFailure?: boolean; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return this.execInContainer(service, command, args, options);
  }
}
