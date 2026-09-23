// The harness the apply checks drive the REAL apply()/runSteps with: a real createContext(),
// with the transport and docker answers stubbed — the seam a hand-built Context cannot reach.
// Shared by convergence/apply.check.ts and connection-facts/operator-edit.check.ts.
//
// Everything here is check-side scaffolding, not framework code: it lives under tools/checks/
// because both of its consumers do. The stubbed `config set --batch-file` payload goes out
// through the transport's writeFile under the staged declaration name apply-config uses, which
// is what lets a check apply it to the live config the way the real CLI would.

import { json, matchingJob, CONFIG_FILE, MIRROR, DATA } from "../convergence/inspect/fixture.ts";
import { mcpServerSpec } from "#framework/commands/management/provision-agent/index.ts";
import type { ExecResult, Transport } from "#framework/runtime/transport.ts";

/** The live config as the fixture's stub presents it, so the plan is quiet except for the
 *  finding each scenario is about. */
export function refreshLiveConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gateway: { mode: "local", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
    agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
    models: { providers: { zai: {} } },
    ...overrides,
  };
}

export interface RefreshSpec {
  liveConfig: Record<string, unknown>;
  mirrorChecksums: Record<string, string>;
  prompts: Record<string, string>;
  agents?: string[];
  mcpServers?: string[];
  mcpServerEntries?: Record<string, { command?: unknown; args?: unknown; enabled?: unknown }>;
  cronJobs?: Record<string, unknown>[];
}

export interface RefreshState {
  files: Map<string, string>;
  composeEnvWrites: string[];
  dockerCalls: string[][];
  running: boolean;
  facts?: Record<string, unknown>;
}

/** A transport whose "target" is an in-memory file map, answering for one DockerRuntime: the
 *  compose argv, the container inspects (state.facts overrides the default answer), the one-off
 *  CLI lists and the checksums the inspection asks for. sudo is unwrapped so loadSecrets'
 *  staged mv lands in the map like the real rename would. */
export function refreshCheckTransport(spec: RefreshSpec, state: RefreshState, driver?: { onStagedConfig?: (payload: string) => void }): Transport {
  const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const containerFacts = (): Record<string, unknown> => state.facts ?? {
    Image: "sha256:fixture-image",
    State: { Running: state.running },
    Mounts: [{ Destination: "/home/node/.openclaw", Source: "/srv/clawforge/data/config" }],
    NetworkSettings: { Ports: { "18789/tcp": [{ HostPort: "18789" }] } },
    Config: { Labels: { "com.docker.compose.project": "refresh-check", Image: "ghcr.io/openclaw/openclaw:extended-stable" } },
  };
  const docker = (args: string[]): ExecResult => {
    state.dockerCalls.push([...args]);
    const format = args[args.indexOf("--format") + 1] ?? "";
    // Two image-inspect formats: the digest line imageReference() reads — the value the
    // fixture's lock pins — and the whole-object inspect runningImageIdentity() parses.
    // Answering both with one payload would corrupt one of them.
    if (args[0] === "image") {
      return ok(format.includes("json")
        ? JSON.stringify({ RepoDigests: ["ghcr.io/openclaw/openclaw@sha256:abc"], Config: { Labels: {} } })
        : "ghcr.io/openclaw/openclaw@sha256:abc");
    }
    if (format.includes("State.Health")) return ok("healthy");
    // Recent, so no RESTART_REQUIRED against the fixture's epoch-1000s config mtime.
    if (format.includes("StartedAt")) return ok("2026-09-22T00:00:00.000000000Z");
    if (format.includes("json")) return ok(JSON.stringify(containerFacts()));
    if (args.includes("ps")) return ok(state.running ? "container-one" : "");
    if (args.includes("run")) {
      const rest = args.slice(args.indexOf("run") + 1);
      const tail = rest.slice(rest.indexOf("cli") + 1);
      if (tail[0] === "agents" && tail[1] === "list") return json((spec.agents ?? ["main", "onboarding"]).map((id) => ({ id })));
      if (tail[0] === "mcp" && tail[1] === "list") {
        return json(Object.fromEntries((spec.mcpServers ?? ["demo-mcp"]).map((name) => [name, spec.mcpServerEntries ?? mcpServerSpec("demo")])));
      }
      if (tail[0] === "cron" && tail[1] === "list") return json({ jobs: spec.cronJobs ?? [matchingJob()] });
      if (tail.includes("--version")) return ok("OpenClaw 2026.6.34\n");
      return ok("{}");
    }
    if (args.includes("up")) {
      state.running = true;
      return ok("container-one");
    }
    return ok();
  };
  const dispatch = async (command: string, args: string[]): Promise<ExecResult> => {
    if (command === "sudo" && args[0] === "-n") return dispatch(args[1], args.slice(2));
    if (command === "docker") return docker(args);
    if (command === "mkdir" || command === "chown" || command === "rmdir") return ok();
    if (command === "test") return { code: 1, stdout: "", stderr: "" };
    if (command === "stat") return ok(`${new Date(1_000_000).toISOString().replace("T", " ").replace("Z", " +0000")}\n`);
    if (command === "sh" && args[1]?.includes("sha256sum")) {
      // The tree arrives as the positional parameter (args[3]); the program text is a constant.
      const wanted = args[3] === MIRROR ? spec.mirrorChecksums : spec.prompts;
      return ok(`${Object.entries(wanted).map(([rel, sum]) => `${sum}  ./${rel}`).join("\n")}\n`);
    }
    if (command === "mv") {
      state.files.set(args[3], state.files.get(args[2]) ?? "");
      state.files.delete(args[2]);
      return ok();
    }
    if (command === "rm") return ok();
    if (command === "curl") return ok("200");
    return ok();
  };
  return {
    description: "refresh-check",
    exec: dispatch,
    async readFile(path) {
      if (path === CONFIG_FILE) return JSON.stringify(spec.liveConfig);
      if (path === `${DATA}/config/.env`) return state.files.get(path) ?? "";
      if (state.files.has(path)) return state.files.get(path)!;
      throw new Error(`unexpected read: ${path}`);
    },
    async writeFile(path, content) {
      const text = typeof content === "string" ? content : "";
      if (path.endsWith("/compose.env")) state.composeEnvWrites.push(text);
      // The non-dry-run staged declaration apply-config writes before invoking the CLI with
      // it: handed to the driver so a check can make the stubbed batch apply really happen.
      if (path.endsWith("/clawforge-desired.json")) driver?.onStagedConfig?.(text);
      state.files.set(path, text);
    },
    async writePrivateFile(path, content) { state.files.set(path, typeof content === "string" ? content : ""); },
    async exists(path) {
      if (path === CONFIG_FILE) return true;
      if (path === `${DATA}/config/.env`) return state.files.has(path);
      return false;
    },
    async mkdirp() {},
    async remove(path) { state.files.delete(path); },
    async removeEmptyDir() {},
    async listFiles(dir) { return dir === MIRROR ? Object.keys(spec.mirrorChecksums) : Object.keys(spec.prompts); },
    clientInvocation(entryPath, args) { return { command: entryPath, args }; },
  };
}
