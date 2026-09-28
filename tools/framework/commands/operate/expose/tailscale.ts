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
//
// Turning ONE route off (tailscaleGatewayRoutes/tailscaleServeOffCommand, for incident's
// contain phase): per the same CLI reference, "off" is the original serve invocation's own
// flags repeated with `off` appended — `--https=<port> off` for the bare-target form this
// module applies, `--set-path=<mount> off` added only for a mount other than "/". `serve
// status --json` reports the ipn.ServeConfig shape (tailscale/tailscale, ipn/serve.go):
// `Web["<host>:<port>"].Handlers["<mount>"].Proxy` names each route's backend, independent of
// every other host:port entry — so turning one off never touches another service's mapping.

import { log, info, die } from "#src/core/io/log.ts";
import { guarded } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";

/** The slice of `expose`'s declaration this action's own argv actually uses. */
export const EXPOSE_TAILSCALE_ARGUMENTS: CommandArgument[] = [
  { name: "apply", description: "With tailscale: run the printed `tailscale serve` command on the target instead of only printing it", kind: "flag" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

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

/** One `tailscale serve` route that proxies to this gateway's own loopback port. */
export interface TailscaleGatewayRoute {
  /** "$SNI_NAME:$PORT", the Web map's own key. */
  readonly hostPort: string;
  /** The https port `--https=<port> off` needs — the numeric suffix of hostPort. */
  readonly port: string;
  /** The mount this route answers under ("/" for the bare-target form this module applies). */
  readonly mountPoint: string;
}

/** Every route in `tailscale serve status --json` that proxies to 127.0.0.1:<gatewayPort> —
 *  never any other service's mapping. `undefined` means the JSON did not parse as the
 *  documented shape (see header): the caller must not guess at what to turn off from a shape
 *  it does not recognise, and reports the exact manual command instead. */
export async function tailscaleGatewayRoutes(ctx: Context, gatewayPort: string): Promise<TailscaleGatewayRoute[] | undefined> {
  const result = await ctx.transport.exec("tailscale", ["serve", "status", "--json"], { allowFailure: true });
  if (result.code !== 0) return undefined;
  let parsed: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> };
  try {
    parsed = JSON.parse(result.stdout.trim() === "" ? "{}" : result.stdout) as typeof parsed;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const target = `http://127.0.0.1:${gatewayPort}`;
  const routes: TailscaleGatewayRoute[] = [];
  for (const [hostPort, entry] of Object.entries(parsed.Web ?? {})) {
    const port = /^.+:(\d+)$/.exec(hostPort)?.[1];
    if (port === undefined) return undefined; // an unrecognized key shape — refuse to guess at any of it
    for (const [mountPoint, handler] of Object.entries(entry?.Handlers ?? {})) {
      if (handler?.Proxy === target) routes.push({ hostPort, port, mountPoint });
    }
  }
  return routes;
}

/** Turns off exactly one route: the original invocation's own flags repeated with `off`
 *  appended (see header) — never `tailscale serve reset`, which would wipe every other
 *  mapping on the target too. */
export function tailscaleServeOffCommand(route: TailscaleGatewayRoute): string[] {
  const args = ["tailscale", "serve", `--https=${route.port}`];
  if (route.mountPoint !== "/") args.push(`--set-path=${route.mountPoint}`);
  args.push("off");
  return args;
}

function parseArgs(args: string[]): { apply: boolean } {
  // Checked ahead of the generic parser: neither spelling is a declared argument, so it
  // would otherwise just die as unknown — this names the actual reason instead.
  if (args.includes("--funnel") || args.includes("funnel")) {
    die(
      "expose tailscale never runs `tailscale funnel` — funnel shares a service with the " +
        "public internet, and this framework keeps the gateway off public ports on purpose " +
        "(.env.example: 0.0.0.0 only behind a reverse proxy with TLS and auth; OpenClaw's " +
        "own guidance keeps the gateway on loopback, reached through Tailscale or an SSH " +
        "tunnel). `tailscale serve` — tailnet-only, what this command prints and applies — " +
        "is the supported path.",
    );
  }
  const parsed = parseDeclaredArgs(EXPOSE_TAILSCALE_ARGUMENTS, args);
  return { apply: parsed.apply === true };
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

  await requireBootstrapped(ctx);
  return guarded(ctx, "expose tailscale --apply", args, async () => {
    log("applying tailscale serve on the target");
    const result = await ctx.transport.exec(command[0], command.slice(1), { allowFailure: true });
    if (result.code !== 0) {
      die(`tailscale serve failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
    }
    log("applied — check with ./clawforge expose status, or `tailscale serve status` on the target");
  });
}
