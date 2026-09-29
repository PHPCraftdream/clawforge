// A side stack: a recipe's own compose project, deployed next to the managed instance but
// isolated from it — separate lifecycle, separate project name — sharing only the env-file
// plumbing ComposeOperations.withEnvFile already owns. Split out of runtime-docker.ts to keep
// that file orchestration-only.

import type { Settings } from "../../core/env.ts";
import type { PathBridge } from "../../core/paths.ts";
import type { ExecResult, Transport } from "../transport/transport.ts";
import type { Stack, StackServiceState } from "../runtime.ts";

/** Parses `compose ps --format json`: one JSON object per line for multiple containers, a
 *  single bare object for one, and empty for none. A line that fails to parse is dropped
 *  rather than failing the whole read — readiness treats an unparsable/missing entry for a
 *  required service the same as one compose never reported at all. */
function parseComposePs(stdout: string): Array<{ Service?: unknown; State?: unknown; Health?: unknown }> {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as Array<{ Service?: unknown; State?: unknown; Health?: unknown }>;
    if (parsed !== null && typeof parsed === "object") return [parsed as { Service?: unknown; State?: unknown; Health?: unknown }];
  } catch {
    // Not one JSON value — try newline-delimited below.
  }
  const entries: Array<{ Service?: unknown; State?: unknown; Health?: unknown }> = [];
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      entries.push(JSON.parse(text) as { Service?: unknown; State?: unknown; Health?: unknown });
    } catch {
      // Skipped: a single malformed line must not hide the services compose did report.
    }
  }
  return entries;
}

/** The replica-aggregated health for one service: a defined non-healthy verdict from any
 *  replica fails the service, a healthy one only holds when no replica reports otherwise,
 *  and a replica with no health opinion at all neither passes nor fails the aggregate. */
function worstHealth(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (left === "healthy") return right;
  if (right === "healthy") return left;
  return left;
}

/** Builds one side stack: separate compose project, separate lifecycle, driven through the
 *  same env-file plumbing (`withEnvFile`) the main service's compose operations already own —
 *  a recipe's variables are declared in recipe.json and supplied from the deployment's .env,
 *  and none of it belongs on the target's command line. */
export function buildStack(
  transport: Transport,
  paths: PathBridge,
  getSettings: () => Settings,
  withEnvFile: <T>(action: (path: string) => Promise<T>, settings?: Settings) => Promise<T>,
  project: string,
  definitionPath: string,
): Stack {
  const compose = async (args: string[], stream = true): Promise<ExecResult> => {
    // The definition lives in our checkout; compose runs on the target.
    return withEnvFile(async (envFile) => {
      const file = await paths.toTarget(definitionPath);
      const directory = file.slice(0, file.lastIndexOf("/"));
      return transport.exec(
        "docker",
        ["compose", "--env-file", envFile, "--project-name", project, "--file", file, "--project-directory", directory, ...args],
        { stream, unsetEnv: Object.keys(getSettings().env) },
      );
    });
  };

  const voidly = async (args: string[]): Promise<void> => {
    await compose(args);
  };

  return {
    build: () => voidly(["build"]),
    up: (options) =>
      voidly([
        "up",
        "--detach",
        ...(options?.wait === true
          ? ["--wait", ...(options.timeoutSeconds !== undefined ? ["--wait-timeout", String(options.timeoutSeconds)] : [])]
          : []),
      ]),
    down: (removeVolumes = false) => voidly(["down", ...(removeVolumes ? ["--volumes"] : [])]),
    status: () => voidly(["ps"]),
    followLogs: () => voidly(["logs", "--follow", "--tail", "100"]),
    readLogs: async (tail: string) => (await compose(["logs", "--tail", tail], false)).stdout,
    isRunning: async () => {
      const result = await transport.exec(
        "docker",
        ["ps", "--quiet", "--filter", `label=com.docker.compose.project=${project}`],
        { allowFailure: true },
      );
      if (result.code !== 0) {
        throw new Error(`could not determine whether recipe stack "${project}" is running: ${result.stderr.trim() || `docker ps exited ${result.code}`}`);
      }
      return result.stdout.trim() !== "";
    },
    serviceStates: async () => {
      // --all: without it compose lists only running containers, and the recipe installer
      // derives the required set from this very response when a recipe declares none — a
      // crashed service absent from the listing would shrink the requirement set to
      // whichever sidecars happened to survive.
      const result = await compose(["ps", "--all", "--format", "json"], false).catch(() => undefined);
      if (result === undefined) return {};
      const states: Record<string, StackServiceState> = {};
      for (const entry of parseComposePs(result.stdout)) {
        if (typeof entry.Service !== "string" || entry.Service === "") continue;
        const running = entry.State === "running";
        const health = typeof entry.Health === "string" && entry.Health !== "" ? entry.Health : undefined;
        // Replicas of one service arrive as separate entries under the same name. Requiring
        // every replica running (and healthy) keeps the last-enumerated replica from
        // answering for its dead siblings.
        const existing = states[entry.Service];
        states[entry.Service] = existing === undefined
          ? { running, health }
          : { running: existing.running && running, health: worstHealth(existing.health, health) };
      }
      return states;
    },
  };
}
