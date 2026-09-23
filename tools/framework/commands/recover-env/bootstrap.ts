// Recovery's own bootstrap: the running container's connection facts, read with nothing
// but a transport and the project identity.
//
// The normal dispatch builds a full Context before any command runs, and a Context is
// validated from .env — OC_DATA_DIR above all. Recovery exists to repair exactly that
// file, so when a fact is missing the context the dispatcher demands cannot be built and
// the one command that could fill it never runs (P2-10, audit 2026-09-23). This path
// needs none of what failed: the container is found by the compose labels Docker itself
// wrote on it at creation — project and service — so there is no compose invocation, no
// environment file written to the target, no path bridge and no data directory anywhere
// in the read. The transport still comes from .env's location settings: reaching the
// target at all requires them, which is the same limit the command already states for a
// wholly absent .env.

import type { Env } from "#src/core/env.ts";
import { composeProjectName, useComposeProjectOverride } from "#src/runtime/deployment.ts";
import { createTransport, type Transport } from "#src/runtime/transport.ts";
import { connectionFactsFromInspect, type ConnectionFacts } from "./facts.ts";

// The two labels compose writes on every container it creates. `compose ps` filters by
// the same pair; asking Docker directly is what lets the lookup run without compose —
// and without the env file and project directory a compose invocation would demand.
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";

/** The transport recovery reaches its container through, selected from the same .env
 *  settings the context's own transport uses — the location trio needs no OC_DATA_DIR. */
export async function createRecoveryTransport(env: Env): Promise<Transport> {
  return createTransport({
    location: env.OC_TARGET_LOCATION,
    wslDistro: env.OC_WSL_DISTRO,
    sshHost: env.OC_SSH_HOST,
  });
}

/** Reads the running container's connection facts without a Context. Undefined means
 *  what runningConnectionFacts()' undefined means — not running, or the container could
 *  not be inspected — and the caller reports it in the same words. An engine that cannot
 *  be reached at all is a refusal, not a crash: the command's job is to say what cannot
 *  be recovered, and that answer has to survive a missing engine. */
export async function runningConnectionFactsWithoutContext(options: {
  /** The parsed .env — read for the compose project override and nothing else. */
  env: Env;
  transport: Transport;
  /** The compose service the deployment operates (the context defaults an application's
   *  unnamed service to "app"; so does this). */
  service: string;
}): Promise<ConnectionFacts | undefined> {
  // The same override rule the context applies when it is built: an instance managed
  // under a compose project name the deployment directory itself cannot have keeps its
  // real name instead of being forced to rename.
  useComposeProjectOverride(options.env.OC_COMPOSE_PROJECT === "" ? undefined : options.env.OC_COMPOSE_PROJECT);

  let listed: { code: number; stdout: string };
  try {
    listed = await options.transport.exec("docker", [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${PROJECT_LABEL}=${composeProjectName()}`,
      "--filter",
      `label=${SERVICE_LABEL}=${options.service}`,
    ]);
  } catch {
    return undefined;
  }
  if (listed.code !== 0) return undefined;
  const containerIds = listed.stdout.split(/\r?\n/).map((id) => id.trim()).filter((id) => id !== "");

  // `docker ps --all` puts stopped instances in this result too. A stale stopped
  // container can precede the current one, so inspect every match until a running
  // container supplies the facts; an inspect failure for one old ID does not hide it.
  for (const containerId of containerIds) {
    let inspected: { code: number; stdout: string };
    try {
      inspected = await options.transport.exec(
        "docker",
        ["inspect", "--format", "{{json .}}", containerId],
        { allowFailure: true },
      );
    } catch {
      continue;
    }
    if (inspected.code !== 0) continue;
    try {
      const facts = connectionFactsFromInspect(JSON.parse(inspected.stdout));
      if (facts !== undefined) return facts;
    } catch {
      // A malformed or stale match does not prevent trying the remaining containers.
    }
  }
  return undefined;
}
