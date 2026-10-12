import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { consume } from "#framework/commands/management/configuration/memory/consumer.ts";
import { MemoryError, type MemoryConfig } from "#framework/commands/management/configuration/memory/declaration.ts";
import { RESOURCE_SNAPSHOT_SCRIPT } from "#framework/commands/management/configuration/memory/resources.ts";
import type { Context } from "#framework/core/context.ts";
const approved: MemoryConfig = { enabled: true, provider: "openai", model: "fixed-model", fallback: "none", query: { hybrid: { enabled: true } }, store: { vector: { enabled: true } }, remote: { apiKey: { source: "env", id: "APPROVED_KEY" } } };
const state = { backend: "builtin", provider: "openai", requestedProvider: "openai", model: "fixed-model", fts: { enabled: true, available: true }, vector: { enabled: true, available: true }, custom: { providerState: { mode: "ready" } }, files: 1, chunks: 1, dirty: false };
function fixture(options: { override?: unknown; drift?: boolean; deepFail?: boolean } = {}) {
  const resources: string[][] = []; let snapshotReads = 0;
  const rows = [{ id: "selected", memorySearch: { query: { maxResults: 99 }, remote: { apiKey: { source: "env", id: "APPROVED_KEY" } } } }, { id: "other", memorySearch: options.override ?? { provider: "voyage", model: "unapproved-model" } }];
  const result = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
  const inventory = [{ id: "selected" }, { id: "other" }];
  const ctx = { runtime: { execInHelper: async (_service: string, args: string[]) => {
    if (args[0] === "agents") return result(inventory);
    if (args.includes("--deep")) { resources.push(args); if (options.deepFail) return { code: 1, stdout: "PRIVATE_DIAGNOSTIC", stderr: "missing-provider-auth" }; return result([{ agentId: args[args.indexOf("--agent") + 1], status: state }]); }
    if (args[1] === "status") return result([{ agentId: "selected", status: state }, { agentId: "other", status: state }]);
    resources.push(args); return { code: 0, stdout: "", stderr: "" };
  }, execCommand: async (_service: string, _command: string, args: string[]) => {
    if (args[1] === RESOURCE_SNAPSHOT_SCRIPT) {
      snapshotReads++;
      return result({ backend: "builtin", agents: { defaults: { memorySearch: approved }, list: options.drift && snapshotReads > 1 ? [{ id: "selected", memorySearch: { remote: { baseUrl: "https://unapproved.invalid" } } }, rows[1]] : rows }, inventory });
    }
    resources.push(["node", ...args.slice(2)]);
    throw Error("unexpected model/witness write");
  } } } as unknown as Context;
  return { ctx, resources };
}
{
  const f = fixture(); const result = await consume(f.ctx, approved, "selected", false, false, { spend: true, download: true });
  check("selected equivalent ranking/auth override accepted", result.ok, true);
  check("deep scoped only to selected agent", f.resources, [["memory", "status", "--json", "--deep", "--agent", "selected"], ["memory", "index", "--agent", "selected", "--force"]]);
}
for (const selected of ["other", undefined]) {
  const f = fixture(); let failure: unknown;
  try { await consume(f.ctx, approved, selected, selected === undefined, false, { spend: true, download: true }); } catch (e) { failure = e; }
  check("selected mismatch rejects whole selection", (failure as MemoryError).code, "STALE");
  check("all selected validate before first resource", f.resources, []);
}
{
  const f = fixture({ drift: true }); const result = await consume(f.ctx, approved, "selected", false, false, { spend: true, download: true });
  check("midconfig drift stops probe", result.ok, false); check("drift before deep no resource IO", f.resources, []);
  check("no attempted deep on gate refusal", result.resourcePreflightAttempted, false);
}
{
  const f = fixture({ deepFail: true }); const result = await consume(f.ctx, approved, "selected", false, false, { spend: true, download: true });
  check("failed scoped deep no index", f.resources, [["memory", "status", "--json", "--deep", "--agent", "selected"]]);
  check("failed deep preserves safe normal sibling facts", (result.outcomes[0] as { status: unknown[] }).status.length, 2);
  checkTrue("failed deep safe DTO excludes credential/diagnostic", !JSON.stringify(result).includes("PRIVATE_") && !JSON.stringify(result).includes("APPROVED_KEY"));
}
const localA: MemoryConfig = { enabled: true, provider: "local", model: "/container/models/a.gguf", local: { modelPath: "/container/models/a.gguf" }, fallback: "none", query: { hybrid: { enabled: true } }, store: { vector: { enabled: true } } };
function localFixture(override: unknown) {
  const resources: string[][] = [];
  const result = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
  const ctx = { settings: { dataDir: "/managed" }, paths: { toContainer: (path: string) => path.endsWith("/models") ? "/container/models" : "/container" }, runtime: {
    execCommand: async (_service: string, _command: string, args: string[]) => {
      if (args[1] === RESOURCE_SNAPSHOT_SCRIPT) {
        return result({ backend: "builtin", agents: { defaults: { memorySearch: localA }, list: [{ id: "selected" }, { id: "other", memorySearch: override }] }, inventory: [{ id: "selected" }, { id: "other" }] });
      }
      resources.push(["node", ...args.slice(2)]);
      return args[1].includes("createHash") ? { code: 0, stdout: "", stderr: "" } : result({ platform: "linux", arch: "x64", nodeVersion: "v24.15.0", configRoot: "/container" });
    },
    execInHelper: async (_service: string, args: string[]) => {
      if (args[0] === "agents") return result([{ id: "selected" }, { id: "other" }]);
      if (args[1] === "status" && !args.includes("--deep")) return result([{ agentId: "selected", status: { ...state, provider: "local", requestedProvider: "local", model: "/container/models/a.gguf" } }, { agentId: "other", status: state }]);
      resources.push(args);
      if (args[0] === "--version") return { code: 0, stdout: "OpenClaw 2026.6.34\n", stderr: "" };
      if (args[0] === "plugins" && args.includes("--help")) return { code: 0, stdout: "--all --json", stderr: "" };
      if (args[0] === "config" && args[2] === "plugins") return result({});
      if (args[0] === "plugins") return result([{ plugin: { id: "llama-cpp", name: "llama.cpp Provider", status: "loaded", version: "2026.6.34", source: "/container/npm/provider/index.js" }, install: { source: "npm", resolvedName: "@openclaw/llama-cpp-provider", resolvedVersion: "2026.6.34", version: "2026.6.34", spec: "@openclaw/llama-cpp-provider@2026.6.34", installPath: "/container/npm/provider" } }]);
      if (args.includes("--deep")) return result([{ agentId: args[args.indexOf("--agent") + 1], status: { ...state, provider: "local", requestedProvider: "local", model: "/container/models/a.gguf" } }]);
      if (args[1] === "index") return { code: 0, stdout: "", stderr: "" };
      throw Error("unexpected local scope call");
    },
  } } as unknown as Context;
  return { ctx, resources };
}
const approval = { checksum: "a".repeat(64), source: "approved-model", version: "pinned-model", spend: true, download: true };
for (const override of [{ local: { modelPath: "/container/models/b.gguf" }, model: "/container/models/b.gguf" }, { provider: "openai" }, { fallback: "openai" }, { enabled: false }]) {
  for (const all of [false, true]) {
    const f = localFixture(override); let failure: unknown;
    try { await consume(f.ctx, localA, all ? undefined : "other", all, true, approval); } catch (e) { failure = e; }
    check("selected local resource mismatch rejects", (failure as MemoryError).code, "STALE");
    check("selected/all mismatch before hash/native/plugin/deep/index/witness", f.resources, []);
  }
}
{
  const f = localFixture({ local: { modelPath: "/container/models/b.gguf" }, model: "/container/models/b.gguf" });
  const outcome = await consume(f.ctx, localA, "selected", false, false, approval);
  check("selected local A ignores unselected B initialization", outcome.ok, true);
  check("only A deep resource probe", f.resources.filter((args) => args.includes("--deep")), [["memory", "status", "--json", "--deep", "--agent", "selected"]]);
  check("only A actual index", f.resources.filter((args) => args[1] === "index"), [["memory", "index", "--agent", "selected", "--force"]]);
  checkTrue("unselected B never hashed or initialized", !JSON.stringify(f.resources).includes("/container/models/b.gguf"));
}
for (const explicitList of [false, true]) {
  const keyword: MemoryConfig = { enabled: true, provider: "none", fallback: "none", query: { hybrid: { enabled: true } }, store: { vector: { enabled: false } } }, resources: string[][] = [];
  const result = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
  const ctx = { runtime: { execInHelper: async (_service: string, args: string[]) => {
    if (args[0] === "agents") return result([{ id: "main" }]);
    if (args[1] === "status" && !args.includes("--deep")) return result([{ agentId: "main", status: { ...state, provider: "none", requestedProvider: "none", vector: { enabled: false }, custom: { providerState: { mode: "pending" } } } }]);
    resources.push(args); return { code: 0, stdout: "", stderr: "" };
  }, execCommand: async (_service: string, _command: string, args: string[]) => {
    if (args[1] === RESOURCE_SNAPSHOT_SCRIPT) return result({ backend: "builtin", agents: { defaults: { memorySearch: keyword }, ...(explicitList ? { list: [] } : {}) }, inventory: [{ id: "main" }] });
    resources.push(["node", ...args.slice(2)]);
    throw Error("keyword must not initialize model/witness");
  } } } as unknown as Context;
  const outcome = await consume(ctx, keyword, "Main", false, false);
  check("implicit main absent/empty overrides succeeds", outcome.ok, true);
  check("normalized selector indexes canonical main only", resources, [["memory", "index", "--agent", "main", "--force"]]);
}
for (const inventory of [[{ id: "main" }], [{ id: "Main" }, { id: "main" }]]) {
  const resources: string[][] = [];
  const ctx = { runtime: { execInHelper: async (_service: string, args: string[]) => {
    if (args[0] === "agents") return { code: 0, stdout: JSON.stringify(inventory), stderr: "" };
    resources.push(args); throw Error("selection failure must precede provider/config IO");
  }, execCommand: async () => { throw Error("selection failure must precede hash"); } } } as unknown as Context;
  let error: unknown; try { await consume(ctx, approved, inventory.length === 1 ? "unregistered" : "Main", false, false, { spend: true, download: true }); } catch (failure) { error = failure; }
  check("unregistered/normalized collision typed refusal", (error as MemoryError).code, "UNSUPPORTED");
  check("selection refusal no provider/hash/probe/index resource", resources, []);
}
finish("memory selected consumer resources");
