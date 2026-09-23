// `./clawforge host <context> -- <command> [args...]` runs one ad hoc command against the
// operator's own machine layers, not the deployment's containers — that is what exec/cli are
// for. The three contexts: target (the deployment's own transport), engine (wherever the
// container engine actually executes), local (this machine, unwrapped). Root is never
// implicit. Where the context runs as the operator's own user, --root and --confirm-root
// together are what elevate it, each alone doing nothing. Where the context itself has no
// other user — Docker Desktop's engine distro runs everything as root — the same two flags
// are the consent required before the command runs at all: the gate sits where the
// privilege arrives, not where it is named. Arrival as root is not assumed from the backend's
// reputation: docker-desktop declares it, and everywhere else the effective identity is probed
// before the command runs — `id -u` over the transport for target and engine, this process's
// own uid (Windows: the shell's integrity level) for local. A probe that cannot answer does
// not gate, and that gap is named in the code, not papered over.

import { die, info } from "#src/core/log.ts";
import { emit, shouldFollow } from "#src/core/output.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecOptions } from "#src/runtime/transport.ts";
import { probeHostIdentity, realHostEnvironment, resolveHostContext, type HostContextName, type HostEnvironment } from "./contexts.ts";

export interface HostInvocation {
  readonly context: HostContextName;
  readonly root: boolean;
  readonly confirmRoot: boolean;
  readonly command: string[];
}

export function parseHostArgs(args: string[]): HostInvocation {
  const [name, ...rest] = args;
  if (name === undefined) {
    die("usage: ./clawforge host <target|engine|local> [--root --confirm-root] -- <command> [args...], e.g. ./clawforge host engine -- cat /etc/resolv.conf");
  }
  if (name !== "target" && name !== "engine" && name !== "local") {
    die(`unknown context: ${name} (expected target, engine or local)`);
  }

  // Our flags are only recognized before the first command token — exactly so a command's
  // own --root-like flags after that point are passed through untouched.
  let root = false;
  let confirmRoot = false;
  let at = 0;
  for (; at < rest.length; at++) {
    const token = rest[at];
    if (token === "--") {
      at += 1;
      break;
    }
    if (token === "--root") {
      root = true;
    } else if (token === "--confirm-root") {
      confirmRoot = true;
    } else {
      break;
    }
  }

  const command = rest.slice(at);
  if (command.length === 0) {
    die("usage: ./clawforge host <target|engine|local> [--root --confirm-root] -- <command> [args...], e.g. ./clawforge host engine -- cat /etc/resolv.conf");
  }

  // The MCP path never sends `--` (toArgv emits context, then --flags, then the variadic
  // command args), so both shapes must parse identically.
  return { context: name, root, confirmRoot, command };
}

export function rootElevationRequested(root: boolean, confirmRoot: boolean): boolean {
  // Deliberate double friction: one flag alone does nothing, so an accident needs two
  // mistakes instead of one.
  if (root && !confirmRoot) {
    die("--root does not elevate on its own: add --confirm-root to run the command as root");
  }
  if (!root && confirmRoot) {
    die("--confirm-root does not elevate on its own: add --root to ask for elevation at all");
  }
  return root;
}

export async function host(ctx: Context, args: string[], environment: HostEnvironment = realHostEnvironment): Promise<void> {
  const parsed = parseHostArgs(args);
  const elevate = rootElevationRequested(parsed.root, parsed.confirmRoot);
  const execution = await resolveHostContext(ctx, parsed.context, environment);
  if (execution.note !== undefined) info(execution.note);
  // The gate answers "will this command arrive as root", not "do we recognize this backend
  // as root-granting": statically where the place has no other user (docker-desktop),
  // probed before the command runs everywhere else. An unanswered probe runs ungated —
  // an honest unknown, documented here rather than disguised as a pass.
  let arrivesAsRoot = execution.arrivesAsRoot === true;
  let evidence = "the place it runs has no other login user";
  if (execution.arrivesAsRoot !== true) {
    const probe = await probeHostIdentity(execution, environment);
    if (probe.arrivesAsRoot !== undefined) {
      arrivesAsRoot = probe.arrivesAsRoot;
      evidence = probe.evidence;
    }
  }
  if (!elevate && arrivesAsRoot) {
    die(
      `host ${parsed.context} runs as root (uid 0) on this host (${execution.description}) — ` +
      `${evidence}: add --root --confirm-root to consent`,
    );
  }

  // One capability, two shapes, chosen the way lifecycle.ts's and recipe.ts's logs choose it
  // (shouldFollow): a real terminal streams the child's output live; under a sink or a plain
  // pipe the output is captured and handed back, because a tool call owes its caller one result.
  const follow = shouldFollow();
  const options: ExecOptions = follow ? { stream: true } : { input: "", allowFailure: true };

  // Consent where the command is already root wraps nothing: sudo -n or -u root around a
  // command that runs as root anyway adds a failure mode, not a privilege, and the local
  // context on Windows has no elevation to request at all. The flags are honored where
  // elevation is still missing.
  const run = elevate && !arrivesAsRoot ? execution.elevate : execution.exec;
  const result = await run(parsed.command[0], parsed.command.slice(1), options);

  if (!follow) {
    emit(result.stdout);
    if (result.code !== 0) {
      emit(result.stderr);
      die(`host ${parsed.context} ${parsed.command.join(" ")} failed (exit ${result.code})`);
    }
  }
}
