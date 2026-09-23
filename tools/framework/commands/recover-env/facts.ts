// The four .env values that are plumbing, not secrets, and which of them the running
// container still carries. Shared by recover-env (which repairs a stale .env from it) and
// inspect's ENV_STALE finding (which reports one), so there is one answer to "is the .env
// stale", never two that can disagree.
//
// Compose resolved all four from that same .env at container-creation time, so the running
// container holds the answers (Runtime.runningConnectionFacts()); the file mixes them with
// a real secret (OPENCLAW_GATEWAY_TOKEN), so everything these functions return is variable
// NAMES — a value from the parsed file never crosses this module's boundary.
//
// A disagreement between the two sides has two readings these functions deliberately keep
// apart, because they demand opposite remedies: a name the .env does not carry at all is
// unambiguous (the file is half-filled; filling it cannot overwrite any decision), while
// different values for a name both sides carry is equally consistent with a rotted file and
// with an edit the operator just made that the container has not caught up with. Collapsing
// both into "stale" is how a deliberate port change got rewritten back to the container's
// old value (P2-03, round 3).

export interface ConnectionFacts {
  dataDir?: string;
  port?: string;
  composeProject?: string;
  image?: string;
}

export const CONNECTION_FACTS: { field: keyof ConnectionFacts; name: string }[] = [
  { field: "dataDir", name: "OC_DATA_DIR" },
  { field: "port", name: "OPENCLAW_GATEWAY_PORT" },
  { field: "composeProject", name: "OC_COMPOSE_PROJECT" },
  { field: "image", name: "OPENCLAW_IMAGE" },
];

export interface ConnectionFactDiff {
  name: string;
  /** The value the running container carries — the only side this module reads values from. */
  value: string;
  /** "missing" — .env does not carry the name at all; the one case a plain recover-env
   *  writes. "diverged" — both sides carry the name with different values; written only
   *  when the direction is chosen explicitly (--adopt-runtime). */
  kind: "missing" | "diverged";
}

/** The facts the container's answer carries that .env does not agree with, classified by how
 *  much the disagreement means. A fact the answer does not carry at all is not here: there
 *  is nothing to compare it against, and calling it stale would be a guess. */
export function connectionFactDiffs(
  facts: ConnectionFacts,
  current: Record<string, string>,
): ConnectionFactDiff[] {
  return CONNECTION_FACTS.flatMap((fact): ConnectionFactDiff[] => {
    const value = facts[fact.field];
    if (value === undefined) return [];
    const local = current[fact.name];
    if (local === undefined) return [{ name: fact.name, value, kind: "missing" as const }];
    return local !== value ? [{ name: fact.name, value, kind: "diverged" as const }] : [];
  });
}

/** Every fact the container's answer disagrees with, either kind — the observation-level
 *  diff inspect's ENV_STALE reports and recover-env --adopt-runtime writes. */
export function staleConnectionFacts(
  facts: ConnectionFacts,
  current: Record<string, string>,
): { name: string; value: string }[] {
  return connectionFactDiffs(facts, current).map(({ name, value }) => ({ name, value }));
}

/** The facts Docker's own answer did not carry — reported as-is, never guessed. */
export function unrecoverableConnectionFacts(facts: ConnectionFacts): { name: string }[] {
  return CONNECTION_FACTS.filter((fact) => facts[fact.field] === undefined).map((fact) => ({ name: fact.name }));
}

/** The connection facts one whole-object `docker inspect` document carries, and those it
 *  refuses to guess: the data dir only from the config bind mount whose Source ends in
 *  "/config", the port only from a published 18789/tcp with a host port, the project from
 *  Docker's own compose label, and the image from .Config.Image — never the top-level
 *  .Image, which is a resolved ID no .env ever wrote. Undefined when the container is not
 *  running.
 *
 *  This is the recovery bootstrap's parser (bootstrap.ts, which reaches the container by
 *  Docker's own compose labels because the full Context may be exactly what cannot be
 *  built); the runtime's own runningConnectionFacts() reads the same four fields from the
 *  same document, reached through compose ps. One document, two ways in — the fields and
 *  their refusals-to-guess are pinned by checks on both sides. */
export function connectionFactsFromInspect(parsed: unknown): ConnectionFacts | undefined {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const container = parsed as {
    State?: { Running?: boolean };
    Mounts?: unknown;
    NetworkSettings?: { Ports?: Record<string, unknown> };
    Config?: { Labels?: Record<string, string>; Image?: unknown };
  };
  if (container.State?.Running !== true) return undefined;
  const facts: ConnectionFacts = {};
  if (Array.isArray(container.Mounts)) {
    const mount = container.Mounts.find(
      (entry) =>
        typeof entry === "object" && entry !== null &&
        (entry as { Destination?: unknown }).Destination === "/home/node/.openclaw",
    );
    const source = typeof mount === "object" && mount !== null ? (mount as { Source?: unknown }).Source : undefined;
    // The config bind mount is "<dataDir>/config"; only a Source carrying that exact suffix
    // yields the data dir — any other shape stays absent rather than guessed.
    if (typeof source === "string" && source.endsWith("/config") && source.length > "/config".length) {
      facts.dataDir = source.slice(0, -"/config".length);
    }
  }
  const ports = container.NetworkSettings?.Ports?.["18789/tcp"];
  if (Array.isArray(ports)) {
    const hostPort = (ports[0] as { HostPort?: unknown } | undefined)?.HostPort;
    if (typeof hostPort === "string" && hostPort !== "") facts.port = hostPort;
  }
  const project = container.Config?.Labels?.["com.docker.compose.project"];
  if (typeof project === "string" && project !== "") facts.composeProject = project;
  const image = container.Config?.Image;
  if (typeof image === "string" && image !== "") facts.image = image;
  return facts;
}
