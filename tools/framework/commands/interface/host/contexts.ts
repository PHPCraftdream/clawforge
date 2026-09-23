// Host contexts: the roles `./clawforge host` can target on the operator's own machine.
//
// A context is a role, resolved per platform — never a hardcoded "on Windows do X". "target"
// is the deployment's own transport; "engine" is wherever the container runtime actually
// executes; "local" is the bare machine, unwrapped. Resolution reports where the command
// actually ended up, and says so when a role collapsed onto another one on this host.

import { die } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { spawnLocal, type ExecOptions, type ExecResult } from "#src/runtime/transport.ts";

export type HostContextName = "target" | "engine" | "local";

export const ENGINE_DISTRO = "docker-desktop";

export interface HostExecution {
  /** Where the command actually runs, in the transport's own naming ("wsl:docker-desktop", "local", "wsl:Ubuntu-24.04"...). */
  readonly description: string;
  /** Set when this context is not actually a distinct machine here — printed by the command so the report is honest. */
  readonly note?: string;
  /** Set when every command this execution runs arrives as root (uid 0) whichever path is
   *  used — not because it asked, but because the place it runs has no other user. Docker
   *  Desktop's docker-desktop distro is the case: its default user is root, and /etc/passwd
   *  offers only nologin service accounts besides. The command layer must demand the
   *  --root --confirm-root consent BEFORE anything runs: gating the flags alone would check
   *  what was requested, never what was obtained. */
  readonly arrivesAsRoot?: boolean;
  exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;
  elevate(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;
}

export interface HostEnvironment {
  readonly platform: NodeJS.Platform;
  readonly listWslDistros: () => Promise<string[]>;
}

/** wsl.exe emits UTF-16LE on the versions in the field, and spawnLocal decodes bytes as
 *  UTF-8, which leaves interleaved NUL characters; stripping them normalizes both encodings. */
export function parseWslDistroListing(stdout: string): string[] {
  return stdout
    .replaceAll("\u0000", "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export const realHostEnvironment: HostEnvironment = {
  platform: process.platform,
  listWslDistros: async () => {
    // A rejection (wsl.exe missing or broken) is "no distros", not an error: the caller only
    // asks whether Docker Desktop's engine distro exists, and a machine without WSL answers no.
    try {
      const result = await spawnLocal("wsl.exe", ["--list", "--quiet"], { allowFailure: true });
      return parseWslDistroListing(result.stdout);
    } catch {
      return [];
    }
  },
};

/** `--exec`, same as WslTransport's: the plain `--` form sends the command line through the
 *  distro's default shell, which re-parses argv; --exec hands it over verbatim. Without `-u`
 *  the distro's default user runs the command — for docker-desktop that is root (uid 0),
 *  which is why the consent gate lives in the command layer, not here: the argv chooses what
 *  to request, never what the default would have run as anyway. */
export function wslEngineCommand(distro: string, command: string, args: string[], root: boolean): { command: string; args: string[] } {
  return {
    command: "wsl.exe",
    args: [...(root ? ["-u", "root"] : []), "-d", distro, "--exec", command, ...args],
  };
}

/** `-n`: non-interactive sudo fails fast when a password would be required, instead of
 *  hanging on a prompt an automated caller can never answer. */
export function sudoCommand(command: string, args: string[]): { command: string; args: string[] } {
  return { command: "sudo", args: ["-n", command, ...args] };
}

function localExecution(platform: NodeJS.Platform, note?: string): HostExecution {
  return {
    description: "local",
    note,
    exec: (command, args, options) => spawnLocal(command, args, options),
    elevate: platform === "win32"
      ? () => die("the local context on windows has no root to elevate to — run the command from an elevated shell yourself")
      : (command, args, options) => {
        const sudo = sudoCommand(command, args);
        return spawnLocal(sudo.command, sudo.args, options);
      },
  };
}

export async function resolveHostContext(ctx: Context, name: HostContextName, environment: HostEnvironment = realHostEnvironment): Promise<HostExecution> {
  switch (name) {
    case "target":
      // The deployment's own transport, verbatim. Elevation is sudo -n THROUGH the same
      // transport, which works uniformly across local, wsl and ssh targets.
      return {
        description: ctx.transport.description,
        exec: (command, args, options) => ctx.transport.exec(command, args, options),
        elevate: (command, args, options) => {
          const sudo = sudoCommand(command, args);
          return ctx.transport.exec(sudo.command, sudo.args, options);
        },
      };
    case "local":
      return localExecution(environment.platform);
    case "engine": {
      if (environment.platform === "win32") {
        const distros = await environment.listWslDistros();
        if (distros.includes(ENGINE_DISTRO)) {
          const viaWsl = (root: boolean) => (command: string, args: string[], options: ExecOptions): Promise<ExecResult> => {
            const wsl = wslEngineCommand(ENGINE_DISTRO, command, args, root);
            return spawnLocal(wsl.command, wsl.args, options);
          };
          return {
            description: `wsl:${ENGINE_DISTRO}`,
            note: `engine runs in Docker Desktop's ${ENGINE_DISTRO} WSL2 distro — not the target's ${ctx.transport.description} — as its default user, root (uid 0): the distro has no other login user`,
            arrivesAsRoot: true,
            exec: viaWsl(false),
            elevate: viaWsl(true),
          };
        }
        return localExecution("win32", `no "${ENGINE_DISTRO}" WSL distro found — engine and local are the same machine on this host`);
      }
      // A future platform branch (macOS / Docker Desktop for Linux bridge their VM differently) is the intended extension point.
      return localExecution(environment.platform, `no separate engine VM is reachable on ${environment.platform} yet — engine and local are the same machine on this host`);
    }
  }
}
