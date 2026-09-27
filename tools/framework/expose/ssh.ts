// `./clawforge expose ssh` — the SSH tunnel that reaches a loopback-bound remote gateway, for
// OC_TARGET_LOCATION=ssh deployments (the same shape `deploy` prints once, right after a
// fresh deploy). wsl/local targets need no tunnel at all: Docker Desktop's WSL2 integration
// (or a shared filesystem, for local) already forwards the published port to this machine's
// own loopback.

import { log, info, die } from "#src/core/log.ts";
import { spawnLocal } from "#src/runtime/transport.ts";
import { shouldFollow } from "#src/core/output.ts";
import type { Context } from "#src/core/context.ts";

const PORT = /^[1-9][0-9]*$/;

function parseArgs(args: string[]): { localPort?: string; run: boolean } {
  let localPort: string | undefined;
  let run = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run") { run = true; continue; }
    if (arg === "--local-port") {
      localPort = args[++index] ?? die("--local-port needs a port number");
      if (!PORT.test(localPort)) die(`--local-port must be a plain port number, got: ${localPort}`);
      continue;
    }
    die(`unknown argument: ${arg}`);
  }
  return { localPort, run };
}

/** `ssh -N`: no remote command, only the forward. `-L <local>:127.0.0.1:<gatewayPort>` reaches
 *  the gateway on the REMOTE host's own loopback — the gateway is never asked to bind
 *  anywhere else, only reached through the tunnel. */
export function sshTunnelCommand(host: string, localPort: string, gatewayPort: string): string[] {
  return ["ssh", "-N", "-L", `${localPort}:127.0.0.1:${gatewayPort}`, host];
}

export async function exposeSsh(ctx: Context, args: string[]): Promise<void> {
  const { localPort: requestedPort, run } = parseArgs(args);

  if (ctx.settings.location !== "ssh") {
    log(`no SSH tunnel needed — reach the gateway directly at ${ctx.settings.serviceUrl}`);
    info(`target transport: ${ctx.transport.description} (a local or WSL container's published port is already reachable from this machine)`);
    return;
  }

  const host = ctx.settings.sshHost;
  if (host === "") die("OC_SSH_HOST is not set, but OC_TARGET_LOCATION=ssh — set OC_SSH_HOST to user@host");
  const localPort = requestedPort ?? ctx.settings.gatewayPort;
  const command = sshTunnelCommand(host, localPort, ctx.settings.gatewayPort);

  log("SSH tunnel to the remote gateway");
  info(command.join(" "));
  info(`once open: http://127.0.0.1:${localPort}`);
  info(
    localPort === ctx.settings.gatewayPort
      ? `./clawforge mcp-creds already prints this exact URL (${ctx.settings.serviceUrl}) — it becomes reachable the moment the tunnel is open.`
      : `./clawforge mcp-creds prints ${ctx.settings.serviceUrl} (the remote port) — substitute ${localPort} for ${ctx.settings.gatewayPort} in that URL while this tunnel is open.`,
  );
  info("the gateway token from mcp-creds is unchanged — the tunnel only changes how the URL is reached.");

  if (!run) return;
  if (!shouldFollow()) {
    die("--run opens a blocking tunnel and needs a real terminal — run the printed command yourself, or omit --run to just see it.");
  }
  log("opening the tunnel (Ctrl+C to stop)...");
  await spawnLocal(command[0], command.slice(1), { stream: true, allowFailure: true });
}
