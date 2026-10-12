import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { assertResourceBindings, readResourceBindings, normalizeResourceAgentId, parseAgentInventory, selectResourceAgents } from "#framework/commands/management/configuration/memory/resources.ts";
import { MemoryError, type MemoryConfig } from "#framework/commands/management/configuration/memory/declaration.ts";
import { consume, OPERATION_MS, WITNESS_CREATE_SCRIPT, WITNESS_CLEANUP_SCRIPT } from "#framework/commands/management/configuration/memory/consumer.ts";
import { RESOURCE_SNAPSHOT_SCRIPT } from "#framework/commands/management/configuration/memory/resources.ts";
import type { Context } from "#framework/core/context.ts";

const local: MemoryConfig = { enabled: true, provider: "local", model: "/managed/models/a.gguf", fallback: "none",
  local: { modelPath: "/managed/models/a.gguf" }, query: { hybrid: { enabled: true } }, store: { vector: { enabled: true } } };
const remote: MemoryConfig = { ...local, provider: "openai", model: "approved-embedding", local: undefined,
  remote: { apiKey: { source: "env", id: "PRIVATE_KEY" } } };
function assertBindingsFixture(defaults: unknown, overrides: unknown, config: MemoryConfig, selected: readonly string[]) {
  return assertResourceBindings({ defaults: { memorySearch: defaults }, list: overrides }, config, selected, { ids: ["main", "other"] });
}
function code(action: () => unknown): string { try { action(); return "accepted"; } catch (error) { return (error as MemoryError).code; } }
for (const [label, override] of [
  ["selected local B", { local: { modelPath: "/managed/models/b.gguf" } }],
  ["selected remote provider", { provider: "openai", model: "unapproved" }],
  ["selected fallback", { fallback: "openai" }],
  ["selected disabled", { enabled: false }],
  ["selected vector", { store: { vector: { enabled: false } } }],
  ["selected hybrid", { query: { hybrid: { enabled: false } } }],
  ["selected cache", { local: { modelCacheDir: "/tmp/cache" } }],
  ["selected context", { local: { contextSize: 999 } }],
  ["selected vector extension", { store: { vector: { extensionPath: "/tmp/vector.so" } } }],
] as const) {
  check(`${label} rejected`, code(() => assertBindingsFixture(local, [{ id: "main", memorySearch: override }], local, ["main"])), "STALE");
}
{
  const agents = [{ id: "main", memorySearch: { model: "generic-label-ignored-by-local", local: { modelPath: "/managed/models/a.gguf" }, query: { maxResults: 29, hybrid: { vectorWeight: 0.2 } } } },
    { id: "other", memorySearch: { local: { modelPath: "/managed/models/b.gguf" } } }];
  const bindings = assertBindingsFixture(local, agents, local, ["main"]);
  check("effective local model identity is path", bindings.get("main")?.model, "/managed/models/a.gguf");
  check("unselected B ignored", bindings.size, 1);
  check("all-selected B refuses entire binding", code(() => assertBindingsFixture(local, agents, local, ["main", "other"])), "STALE");
}
for (const override of [{ nodeLlamaCppImportUrl: "file:///unapproved.js" }, { local: { nodeLlamaCppImportUrl: "file:///unapproved.js" } },
  { nodeLlamaCppImportUrl: null }, { local: { nodeLlamaCppImportUrl: null } }]) {
  check("selected custom import boundary refuses", code(() => assertBindingsFixture(local, [{ id: "main", memorySearch: override }], local, ["main"])), "UNSUPPORTED");
}
for (const config of [local, { ...local, provider: "none", store: { vector: { enabled: false } } }]) {
  const overrides = { remote: { apiKey: { source: "env", id: "UNUSED_PRIVATE_KEY" }, baseUrl: "https://historical.invalid", headers: { Authorization: "UNUSED_PRIVATE_TOKEN" }, batch: { enabled: true } } };
  const before = JSON.stringify(overrides);
  const bindings = assertBindingsFixture(config, [{ id: "main", memorySearch: overrides }], config, ["main"]);
  check("local/keyword unused remote credentials do not block", bindings.get("main")?.provider, config.provider);
  check("unused credentials never mutated", JSON.stringify(overrides), before);
  checkTrue("unused credentials not exposed", !JSON.stringify([...bindings.values()]).includes("PRIVATE_"));
}
check("defaults B cannot be hidden by selected A", code(() => assertBindingsFixture({ ...local, local: { modelPath: "/managed/models/b.gguf" } },
  [{ id: "main", memorySearch: { local: local.local } }], local, ["main"])), "STALE");
check("remote generic model override refused", code(() => assertBindingsFixture(remote,
  [{ id: "main", memorySearch: { model: "other-embedding" } }], remote, ["main"])), "STALE");
for (const override of [{ remote: { baseUrl: "https://unapproved.invalid" } }, { remote: { headers: { Authorization: "PRIVATE_TOKEN" } } },
  { remote: { apiKey: { source: "env", id: "OTHER_KEY" } } }, { remote: { batch: { enabled: true } } }]) {
  check("remote resource override refused", code(() => assertBindingsFixture(remote, [{ id: "main", memorySearch: override }], remote, ["main"])), "STALE");
}
{
  const bindings = assertBindingsFixture(remote, [{ id: "main", memorySearch: { remote: remote.remote, query: { maxResults: 99 } } }], remote, ["main"]);
  check("equivalent remote with ranking differences passes", bindings.get("main")?.model, "approved-embedding");
  checkTrue("returned binding excludes credential refs", !JSON.stringify([...bindings.values()]).includes("PRIVATE_"));
}
for (const agents of [null, {}, [null], [{ id: "main" }, { id: "main" }], [{ id: "Main" }, { id: "main" }],
  [{ id: "main", memorySearch: [] }], [{ id: "main", memorySearch: { local: "bad" } }]]) {
  check("malformed/ambiguous authored inventory refused", code(() => assertBindingsFixture(local, agents, local, ["main"])), "UNSUPPORTED");
}
check("duplicate selection refused", code(() => assertBindingsFixture(local, [{ id: "main" }], local, ["main", "main"])), "UNSUPPORTED");
check("absent selection refused", code(() => assertBindingsFixture(local, [{ id: "main" }], local, ["missing"])), "UNSUPPORTED");
for (const backend of ["qmd", "auto", null, { backend: "builtin" }]) {
  let failure: unknown;
  try { await readResourceBindings({ snapshot: async () => ({
    code: 0, stdout: JSON.stringify({ backend, agents: { defaults: { memorySearch: local } }, inventory: [{ id: "main" }] }), stderr: ""
  }) }, local, ["main"]); } catch (error) { failure = error; }
  check("backend mismatch unsupported", (failure as MemoryError).code, "UNSUPPORTED");
}
{
  let failure: unknown;
  try { await readResourceBindings({ snapshot: async () => ({
    code: 0, stdout: JSON.stringify({ private: "é".repeat(2 * 1024 ** 2) }), stderr: ""
  }) }, local, ["main"]); } catch (error) { failure = error; }
  check("UTF8 oversized JSON unsupported", (failure as MemoryError).code, "UNSUPPORTED");
  checkTrue("oversized raw DTO not exposed", !String(failure).includes("é"));
}
for (const root of [{ defaults: { memorySearch: local } }, { defaults: { memorySearch: local }, list: [] }]) {
  const inventory = parseAgentInventory([{ id: "main" }]);
  check("implicit authored main verified by native inventory", assertResourceBindings(root, local, ["Main"], inventory).get("main")?.provider, "local");
  check("implicit main never fabricated for missing inventory", code(() => assertResourceBindings(root, local, ["main"], { ids: ["other"] })), "UNSUPPORTED");
}
for (const [raw, expected] of [["Main", "main"], [" Agent B ", "agent-b"], ["Ab.C", "ab-c"], ["---", "main"], ["", "main"], ["A".repeat(65), "a".repeat(64)]]) {
  check("evidenced native normalization", normalizeResourceAgentId(raw), expected);
}
check("normalized selected existing ID", selectResourceAgents([{ id: "agent-b" }], "Agent B", false), ["agent-b"]);
check("authoritative all IDs normalized once", selectResourceAgents([{ id: "Main" }, { id: "Agent B" }], undefined, true), ["main", "agent-b"]);
for (const raw of [[{ id: "Main" }, { id: "main" }], [{ id: "Ab.C" }, { id: "ab-c" }], [{ id: 7 }], []]) {
  check("authoritative malformed/normalized collision refuses", code(() => parseAgentInventory(raw)), "UNSUPPORTED");
}
check("unselected malformed memory override ignored", assertBindingsFixture(local, [{ id: "other", memorySearch: "bad" }], local, ["main"]).size, 1);
{
  let failure: unknown;
  try { await readResourceBindings({ snapshot: async () => ({
    code: 1, stdout: "PRIVATE_ROOT", stderr: "missing config"
  }) }, local, ["main"]); } catch (error) { failure = error; }
  check("resource snapshot failure never swallowed", (failure as MemoryError).code, "UNSUPPORTED");
  checkTrue("snapshot failure DTO safe", !String(failure).includes("PRIVATE_ROOT"));
}
{
  const clock = Date.now;
  let now = 100, owned = false, indexes = 0;
  const keyword: MemoryConfig = { enabled: true, provider: "none", fallback: "none", query: { hybrid: { enabled: true } }, store: { vector: { enabled: false } } };
  const snapshot = { backend: "builtin", agents: { defaults: { memorySearch: keyword } }, inventory: [{ id: "main" }] };
  const ctx = {
    settings: { dataDir: "/managed" }, paths: { fromContainer: (p: string) => p.replace("/container", "/managed") },
    runtime: {
      execCommand: async (_service: string, _command: string, args: string[]) => {
        if (args[1] === RESOURCE_SNAPSHOT_SCRIPT) return { code: 0, stdout: JSON.stringify(snapshot), stderr: "" };
        if (args[1] === WITNESS_CREATE_SCRIPT) { owned = true; return { code: 0, stdout: '{"dev":1,"ino":23}', stderr: "" }; }
        if (args[1] === WITNESS_CLEANUP_SCRIPT) { owned = false; return { code: 0, stdout: '{"fileRemoved":true}', stderr: "" }; }
        throw Error("unexpected helper operation");
      },
      execInHelper: async (_service: string, args: string[]) => {
        if (args[0] === "agents") return { code: 0, stdout: '[{"id":"main"}]', stderr: "" };
        if (args[1] === "status") return { code: 0, stdout: JSON.stringify([{ agentId: "main", status: {
          backend: "builtin", provider: "none", requestedProvider: "none", fts: { enabled: true, available: true },
          vector: { enabled: false }, workspaceDir: "/container/workspace"
        } }]), stderr: "" };
        if (args[1] === "index") {
          indexes++;
          if (indexes === 1) { now += OPERATION_MS + 1; return { code: 124, timedOut: true, stdout: "", stderr: "" }; }
          return { code: 0, stdout: "", stderr: "" };
        }
        throw Error("unexpected native operation");
      }
    }
  } as unknown as Context;
  try {
    Date.now = () => now;
    const result = await consume(ctx, keyword, "main", false, true);
    check("expired primary verification remains a deadline failure", result.outcomes.map(value => {
      const outcome = value as Record<string, unknown>;
      return { agentId: outcome.agentId, ok: outcome.ok, code: outcome.code, exitCode: outcome.exitCode, timedOut: outcome.timedOut };
    }), [{ agentId: "main", ok: false, code: "DEADLINE", exitCode: 124, timedOut: true }]);
    check("expired primary removes only its owned witness", owned, false);
    check("independent cleanup budget completes reindex", indexes, 2);
  } finally { Date.now = clock; }
}
finish("memory-resource");
