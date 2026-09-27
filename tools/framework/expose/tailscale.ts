// `./clawforge expose tailscale` — tailnet-only access to the loopback-bound gateway through
// `tailscale serve`. `tailscale funnel` (the public-internet sibling) is refused outright,
// here and nowhere else in this command: the framework's whole security posture keeps the
// gateway off public ports (.env.example: 0.0.0.0 only behind a reverse proxy with TLS and
// auth; OpenClaw's own gateway guidance keeps it on loopback, reached over Tailscale or SSH).
//
// The probe below runs on the TARGET, through the transport, not on the operator's own
// machine — a tailnet identity here says nothing about whether the target can serve anything.
//
// `tailscale serve` syntax verified against the official CLI reference (checked 2026-09-27):
//   https://tailscale.com/docs/reference/tailscale-cli/serve — `tailscale serve [flags] <target>`;
//   `--bg` backgrounds it so it survives this process exiting; a bare `http://127.0.0.1:<port>`
//   target proxies HTTPS (the default mode, on the tailnet's own cert, default port 443) to
//   that plain-HTTP backend. The older `tailscale serve https / http://...` mount-path form
//   is legacy syntax the current CLI translates or rejects — not used here.
//   https://tailscale.com/docs/reference/tailscale-cli/funnel confirms the split: `serve` stays
//   inside the tailnet, `funnel` "shares a local service over the internet" — never run here.

import { log, info, die } from "#src/core/log.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport.ts";

export interface TailscaleProbe {
  readonly present: boolean;
  readonly loggedIn: boolean;
  readonly detail: string;
}

function backendState(result: ExecResult): string | undefined {
  try {
    const parsed = JSON.parse(result.stdout) as { BackendState?: unknown };
    return typeof parsed.BackendState === "string" ? parsed.BackendState : undefined;
  } catch {
    return undefined;
  }
}

/** Read-only: existence and login state, both asked on the target through the transport.
 *  `BackendState: "Running"` is tailscaled's own spelling for "logged in and connected" —
 *  anything else (NeedsLogin, Stopped, Starting, NoState, an unreadable answer) is not. */
export async function probeTailscale(ctx: Context): Promise<TailscaleProbe> {
  const found = await ctx.transport.exec("sh", ["-c", "command -v tailscale"], { allowFailure: true });
  if (found.code !== 0 || found.stdout.trim() === "") {
    return { present: false, loggedIn: false, detail: "tailscale is not installed on the target" };
  }
  const status = await ctx.transport.exec("tailscale", ["status", "--json"], { allowFailure: true });
  if (status.code !== 0) {
    return {
      present: true,
      loggedIn: false,
      detail: `tailscale is installed but \`tailscale status\` failed (exit ${status.code})`,
    };
  }
  const state = backendState(status);
  const loggedIn = state === "Running";
  return {
    present: true,
    loggedIn,
    detail: loggedIn
      ? "tailscale is installed and logged in"
      : `tailscale is installed but not logged in (state: ${state ?? "unknown"}) — run \`tailscale up\` on the target`,
  };
}

/** Tailnet-only HTTPS proxy to the gateway's own loopback. Never funnel — see the header. */
export function tailscaleServeCommand(gatewayPort: string): string[] {
  return ["tailscale", "serve", "--bg", `http://127.0.0.1:${gatewayPort}`];
}

function parseArgs(args: string[]): { apply: boolean } {
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") { apply = true; continue; }
    // Both read directly by guarded() below, from this same array — nothing to do with
    // either here. --break-foreign-lock takes its host id as the next token (bootstrap.ts's
    // own parser skips it the same way).
    if (arg === "--break-lock") continue;
    if (arg === "--break-foreign-lock") { index += 1; continue; }
    if (arg === "--funnel" || arg === "funnel") {
      die(
        "expose tailscale never runs `tailscale funnel` — funnel shares a service with the " +
          "public internet, and this framework keeps the gateway off public ports on purpose " +
          "(.env.example: 0.0.0.0 only behind a reverse proxy with TLS and auth; OpenClaw's " +
          "own guidance keeps the gateway on loopback, reached through Tailscale or an SSH " +
          "tunnel). `tailscale serve` — tailnet-only, what this command prints and applies — " +
          "is the supported path.",
      );
    }
    die(`unknown argument: ${arg}`);
  }
  return { apply };
}

export async function exposeTailscale(ctx: Context, args: string[]): Promise<void> {
  const { apply } = parseArgs(args);
  const probe = await probeTailscale(ctx);
  const command = tailscaleServeCommand(ctx.settings.gatewayPort);

  log("tailscale serve (tailnet-only)");
  info(probe.detail);
  info(command.join(" "));
  info("reachable to tailnet members only — the exact https URL depends on this machine's");
  info("tailnet name; see `tailscale serve status` (or ./clawforge expose status) once applied.");
  info("undo with: tailscale serve reset (run on the target)");

  if (!apply) {
    if (!probe.present) info("install tailscale on the target, then `tailscale up`, before --apply");
    else if (!probe.loggedIn) info("run `tailscale up` on the target before --apply");
    return;
  }

  if (!probe.present) die("cannot --apply: tailscale is not installed on the target");
  if (!probe.loggedIn) die(`cannot --apply: ${probe.detail}`);

  return guarded(ctx, "expose tailscale --apply", args, async () => {
    log("applying tailscale serve on the target");
    const result = await ctx.transport.exec(command[0], command.slice(1), { allowFailure: true });
    if (result.code !== 0) {
      die(`tailscale serve failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
    }
    log("applied — check with ./clawforge expose status, or `tailscale serve status` on the target");
  });
}
