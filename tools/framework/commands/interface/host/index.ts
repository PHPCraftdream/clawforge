// `clawforge host <context> -- <command> [args...]` runs one ad hoc command against the
// operator's own machine layers, not the deployment's containers (exec/cli are for that).
// Three contexts: target (the deployment's transport), engine (where the container engine
// executes), local (this machine, unwrapped). Root is never implicit — --root and
// --confirm-root together elevate it where the context runs as the operator's own user, or
// are the required consent where the context has no other user (Docker Desktop's engine
// distro runs everything as root): the gate sits where the privilege arrives, not where it
// is named. Arrival as root is probed, never assumed from reputation — `id -u` over the
// transport for target/engine, this process's own uid (Windows: shell integrity level) for
// local. A probe that cannot answer refuses the command until explicit consent is given.

import { die, dieWithExitCode, info } from "#src/core/io/log.ts";
import { emitRaw, shouldFollow } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecOptions } from "#src/runtime/transport/transport.ts";
import { commandBody, parseCall, runOnContext, specShape } from "#src/core/command/index.ts";
import type { ArgumentSpec, Values } from "#src/core/command/index.ts";
import { ArgumentError } from "#src/core/command/index.ts";
import { probeHostIdentity, realHostEnvironment, resolveHostContext, type HostContextName, type HostEnvironment } from "./contexts.ts";

export const HOST_ARGUMENTS = [
  {
    name: "context",
    summary: "Where to run: target, engine, local",
    description: "Where to run: target (the deployment's transport), engine (the container engine's machine), local (this machine)",
    kind: "positional",
    required: true,
    choices: ["target", "engine", "local"],
  },
  {
    name: "root",
    summary: "Request root; one half of the elevation consent",
    description: "Request root. On target/local: half of the elevation consent, dead without --confirm-root. On engine: half of the consent every command needs to run at all — the distro's only user is root (uid 0)",
    kind: "flag",
  },
  {
    name: "confirm-root",
    summary: "Second consent; both flags together are required",
    description: "Second consent; both flags together are required — to elevate on target/local, and for an engine command to run at all",
    kind: "flag",
  },
  {
    name: "args",
    description: "Command and arguments to run, e.g. [\"resolvectl\", \"status\"]",
    kind: "variadic",
    verbatim: true,
    required: true,
  },
] as const satisfies readonly ArgumentSpec[];

interface HostInvocation {
  readonly context: HostContextName;
  readonly root: boolean;
  readonly confirmRoot: boolean;
  readonly command: string[];
}

/** The invocation the bound values describe. Our flags are only recognized before the first
 *  command token — exactly so a command's own --root-like flags after that point are passed
 *  through untouched; that order is the parser's (tokenize's verbatim tail), not re-derived
 *  here. */
function invocationOf(values: Values<typeof HOST_ARGUMENTS>): HostInvocation {
  return { context: values.context, root: values.root, confirmRoot: values["confirm-root"], command: [...values.args] };
}

export function rootElevationRequested(root: boolean, confirmRoot: boolean): boolean {
  // Deliberate double friction: one flag alone does nothing, so an accident needs two
  // mistakes instead of one.
  if (root && !confirmRoot) {
    throw new ArgumentError("--root does not elevate on its own: add --confirm-root to run the command as root", "root");
  }
  if (!root && confirmRoot) {
    throw new ArgumentError("--confirm-root does not elevate on its own: add --root to ask for elevation at all", "confirm-root");
  }
  return root;
}

/** The command body; host(ctx, args) stays for callers that already hold a Context (and the
 *  checks' injected HostEnvironment). */
export const HOST = commandBody({
  effect: "destroy",
  arguments: HOST_ARGUMENTS,
  prepare(call) {
    const parsed = invocationOf(call.values as Values<typeof HOST_ARGUMENTS>);
    rootElevationRequested(parsed.root, parsed.confirmRoot);
    return parsed;
  },
  async run(ctx, plan) {
    await runInvocation(ctx, plan as HostInvocation, realHostEnvironment);
  },
});

export async function host(ctx: Context, args: string[], environment: HostEnvironment = realHostEnvironment): Promise<void> {
  if (environment === realHostEnvironment) return runOnContext(HOST, ctx, args, "host");
  // An injected environment (the checks): parse and run directly, as runOnContext would.
  const call = parseCall(specShape(HOST), args, "host");
  await runInvocation(ctx, invocationOf(call.values as Values<typeof HOST_ARGUMENTS>), environment);
}

async function runInvocation(ctx: Context, parsed: HostInvocation, environment: HostEnvironment): Promise<void> {
  const elevate = rootElevationRequested(parsed.root, parsed.confirmRoot);
  const execution = await resolveHostContext(ctx, parsed.context, environment);
  if (execution.note !== undefined) info(execution.note);
  // The gate answers "will this command arrive as root", not "do we recognize this backend
  // as root-granting": statically where the place has no other user (docker-desktop),
  // probed before the command runs everywhere else. An unanswered probe requires consent
  // because the command's identity cannot be assumed unprivileged.
  let arrivesAsRoot = execution.arrivesAsRoot === true;
  let identityKnown = execution.arrivesAsRoot === true;
  let evidence = "the place it runs has no other login user";
  if (execution.arrivesAsRoot !== true) {
    const probe = await probeHostIdentity(execution, environment);
    identityKnown = probe.arrivesAsRoot !== undefined;
    if (probe.arrivesAsRoot !== undefined) {
      arrivesAsRoot = probe.arrivesAsRoot;
      evidence = probe.evidence;
    } else {
      evidence = probe.evidence;
    }
  }
  if (!elevate && (!identityKnown || arrivesAsRoot)) {
    die(
      `host ${parsed.context} ${arrivesAsRoot ? "runs as root (uid 0)" : "identity is unknown"} on this host (${execution.description}) — ` +
      `${evidence}: add --root --confirm-root to consent`,
    );
  }

  // One capability, two shapes, chosen the way instance/logs.ts's and recipe.ts's logs choose it
  // (shouldFollow): a real terminal streams the child's output live; under a sink or a plain
  // pipe the output is captured and handed back, because a tool call owes its caller one result.
  // allowFailure either way: a non-zero exit is reported below with the command's own code
  // (dieWithExitCode), never surfaced as the transport's own generic rejection.
  const follow = shouldFollow();
  const options: ExecOptions = follow ? { stream: true, allowFailure: true } : { input: "", allowFailure: true };

  // Consent where the command is already root wraps nothing: sudo -n or -u root around a
  // command that runs as root anyway adds a failure mode, not a privilege, and the local
  // context on Windows has no elevation to request at all. The flags are honored where
  // elevation is still missing.
  const run = elevate && !arrivesAsRoot ? execution.elevate : execution.exec;
  const result = await run(parsed.command[0], parsed.command.slice(1), options);

  if (!follow) {
    emitRaw(result.stdout);
    if (result.code !== 0) emitRaw(result.stderr);
  }
  if (result.code !== 0) {
    dieWithExitCode(`host ${parsed.context} ${parsed.command.join(" ")} failed (exit ${result.code})`, result.code);
  }
}
