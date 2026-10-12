import assert from "node:assert/strict";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { setupLocalMemory, type SetupRequest, type SetupPorts } from "#framework/commands/management/configuration/memory/setup/operation.ts";
import { MODEL_SETUP_SCRIPT } from "#framework/commands/management/configuration/memory/setup/model.ts";
import { MODEL_ROOT_SCRIPT } from "#framework/commands/management/configuration/memory/setup/root.ts";
import { NATIVE_PATH_CHECK_SCRIPT, NATIVE_ABSENCE_CHECK_SCRIPT } from "#framework/commands/management/configuration/memory/native.ts";
import { RESOURCE_SNAPSHOT_SCRIPT } from "#framework/commands/management/configuration/memory/resources.ts";
import { typeAssert, finish } from "#checks/kit/harness.ts";

const root = "/home/node/.openclaw", model = root + "/models/model.gguf", version = "2026.6.34";
const approval = { source: `https://huggingface.co/owner/repo/resolve/${"a".repeat(40)}/model.gguf`, modelVersion: "a".repeat(40), checksum: "b".repeat(64), pluginVersion: version, maxBytes: 4096 };
const request: SetupRequest = { approval, allowInstall: true, allowDownload: true, agent: "selected" };
const config = { enabled: true, provider: "local", model, fallback: "none", local: { modelPath: model }, query: { hybrid: { enabled: true } }, store: { vector: { enabled: true } }, remote: { apiKey: { source: "env", id: "PRIVATE_AUTH" } }, unknown: { preserved: true } };
const result = (value: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
interface FixtureOptions { missingPlugin?: boolean; mismatchPlugin?: boolean; wrongLive?: boolean; mountShadow?: boolean; wrongModel?: boolean; failInstall?: boolean; failDeep?: boolean; quiescence?: boolean; expire?: boolean; noAgentFlag?: boolean; failAbsence?: boolean; missingRoot?: boolean; missingModel?: boolean; driftAfterProbe?: boolean; overrides?: Record<string, unknown>; rankingOverride?: boolean; driftAfterInstall?: boolean; driftAfterHash?: boolean; driftBeforeDownload?: boolean; nativeIds?: string[]; overrideList?: "absent" | "empty" | "collision" | "unknown"; inspectWritesStore?: boolean }
function fixture(options: FixtureOptions = {}) {
  const calls: string[][] = [];
  let plugin = !options.missingPlugin, present = !(options.quiescence || options.missingModel || options.missingRoot), rootExists = !options.missingRoot, clockOffset = 0, probes = 0;
  const declaration = [{ path: "memory.backend", value: "builtin" }, { path: "agents.defaults.memorySearch", value: structuredClone(config) }];
  const beforeDeclaration = JSON.stringify(declaration);
  const liveDefaults = structuredClone(config);
  const authoredAgents = [{ id: "selected", memorySearch: options.rankingOverride ? { model: "ignored-generic-label", query: { maxResults: 9 }, remote: { apiKey: { source: "env", id: "PRIVATE_AUTH" } } } : {} }, { id: "unrelated", memorySearch: options.overrides ?? {} }];
  let installed = false, hashed = false, hashReads = 0, beforeDownload = false;
  let nativeStoreRevision = 0;
  const entry = () => ({ plugin: { id: "llama-cpp", status: "loaded", version: options.mismatchPlugin ? "2026.6.33" : version, source: root + "/npm/provider/index.js" }, install: { source: "npm", resolvedName: "@openclaw/llama-cpp-provider", resolvedVersion: version, version, installPath: root + "/npm/provider" } });
  const cli = async (_service: string, args: string[]): Promise<ExecResult> => {
    calls.push(args);
    if (args[0] === "--version") return { code: 0, stdout: "OpenClaw 2026.6.34\n", stderr: "" };
    if (args.includes("--help")) return { code: 0, stdout: options.noAgentFlag ? "--all --json --pin --deep" : "--agent <id> --all --json --pin --deep", stderr: "" };
    if (args[0] === "config") {
      if (args[2] === "memory.backend") return result("builtin");
      return result({});
    }
    if (args[0] === "agents") return result((options.nativeIds ?? ["selected", "unrelated"]).map((id) => ({ id })));
    if (args[1] === "inspect") {
      assert.ok(!args.includes("--runtime"));
      if (options.inspectWritesStore) nativeStoreRevision++;
      return result(plugin ? [entry()] : []);
    }
    if (args[1] === "install") {
      if (options.failInstall) return { code: 1, stdout: "", stderr: "PRIVATE https://secret.invalid/npm" };
      plugin = true; installed = true; return result({});
    }
    if (args[0] === "memory" && args.includes("--deep")) {
      const agent = args[args.indexOf("--agent") + 1];
      assert.ok(["selected", "unrelated", "main"].includes(agent));
      assert.deepEqual(args, ["memory", "status", "--agent", agent, "--json", "--deep"]);
      probes++;
      if (options.failDeep) return result({ unsupported: "PRIVATE" });
      return result([{ agentId: args[args.indexOf("--agent") + 1], status: { backend: "builtin", provider: "local", requestedProvider: "local", model, fts: { enabled: true, available: true }, vector: { enabled: true, available: true }, custom: { providerState: "ready" } } }]);
    }
    throw Error("unexpected CLI fixture call");
  };
  const node = async (_service: string, _command: string, argv: string[]): Promise<ExecResult> => {
    const script = argv[1];
    if (script === RESOURCE_SNAPSHOT_SCRIPT) {
      const list = options.overrideList === "collision" ? [{ id: "Main" }, { id: "main" }] : options.overrideList === "unknown" ? [{ id: "ghost", memorySearch: { provider: "openai" } }] : options.overrideList === "empty" ? [] : authoredAgents.map((row) => row.id === "unrelated" && (options.driftAfterProbe && probes > 0 || options.driftAfterInstall && installed || options.driftAfterHash && hashed || options.driftBeforeDownload && beforeDownload) ? { ...row, memorySearch: { local: { modelPath: "/PRIVATE/drift.gguf" } } } : row);
      return result({ backend: "builtin", agents: { defaults: { memorySearch: options.wrongLive ? { ...liveDefaults, local: { modelPath: "/PRIVATE/wrong.gguf" } } : liveDefaults }, ...(options.overrideList === "absent" ? {} : { list }) }, inventory: (options.nativeIds ?? ["selected", "unrelated"]).map(id => ({ id })) });
    }
    if (script === NATIVE_PATH_CHECK_SCRIPT) { calls.push(["native-path-read"]); return result({ platform: "linux", arch: "x64", nodeVersion: "v24.15.0", configRoot: root }); }
    if (script === NATIVE_ABSENCE_CHECK_SCRIPT) {
      calls.push(["native-record-read"]);
      return options.failAbsence ? { code: 1, stdout: "", stderr: "PRIVATE migration error" } : result({ absent: true });
    }
    const input = JSON.parse(argv[2]) as { operation: string; expectedModels?: object; expectedRoot?: object };
    calls.push([script === MODEL_ROOT_SCRIPT ? "root" : "model", input.operation]);
    if (script === MODEL_ROOT_SCRIPT) {
      if (options.driftBeforeDownload && hashReads >= 2) beforeDownload = true;
      if (options.expire) clockOffset = 240001;
      if (input.operation === "create") rootExists = true;
      return result({ ok: true, code: input.operation === "create" ? "ROOT_CREATED" : rootExists ? "ROOT_PRESENT" : "ROOT_MISSING", changed: input.operation === "create", created: input.operation === "create", exists: rootExists, config: { dev: "1", ino: "2" }, ...(rootExists ? { models: { dev: "1", ino: "3" } } : {}) });
    }
    assert.equal(script, MODEL_SETUP_SCRIPT);
    assert.deepEqual(input.expectedRoot, { dev: "1", ino: "3" });
    if (input.operation === "inspect") {
      hashReads++; hashed = true;
      return { code: present && !options.wrongModel ? 0 : 1, stdout: JSON.stringify({ kind: "model-result", ok: present && !options.wrongModel, code: options.wrongModel ? "MODEL_CONTENT" : present ? "MODEL_PRESENT" : "MODEL_MISSING", changed: false }), stderr: "" };
    }
    if (input.operation === "download") {
      if (options.quiescence) throw Object.assign(Error("PRIVATE"), { code: "HELPER_QUIESCENCE" });
      present = true; return result({ kind: "model-result", ok: true, code: "MODEL_DOWNLOADED", changed: true });
    }
    throw Error("unexpected cleanup/mutation fixture call");
  };
  const ctx = { settings: { dataDir: "/target/data" }, paths: { toContainer: () => root }, runtime: { execInHelper: cli, execCommand: node } } as unknown as Context;
  const ports: SetupPorts = { readDeclaration: async () => declaration, readMounts: async () => {
    calls.push(["mounts"]); const mounts = [{ source: "/target/data/config", destination: root, type: "bind", writable: true }]; return { gateway: mounts, helper: options.mountShadow ? [...mounts, { source: "/foreign", destination: root + "/models", type: "bind", writable: true }] : mounts };
  } };
  return { ctx, ports, calls, offset: () => clockOffset, preserved: () => JSON.stringify(declaration) === beforeDeclaration, nativeStoreRevision: () => nativeStoreRevision };
}
const mutation = (calls: string[][]) => calls.filter((args) => args[0] === "plugins" && args[1] === "install" && !args.includes("--help") || args[0] === "root" && args[1] === "create" || args[0] === "model" && args[1] !== "inspect" || args.includes("--deep") && !args.includes("--help"));
for (const flag of ["allowInstall", "allowDownload"] as const) {
  const f = fixture(), outcome = await setupLocalMemory(f.ctx, { ...request, [flag]: false }, f.ports);
  assert.equal(outcome.code, "CONSENT"); assert.equal(outcome.changed, false); assert.deepEqual(f.calls, []);
}
for (const options of [{ mismatchPlugin: true }, { wrongModel: true }, { noAgentFlag: true }]) {
  const f = fixture(options), outcome = await setupLocalMemory(f.ctx, request, f.ports);
  assert.equal(outcome.ok, false); assert.equal(outcome.changed, !options.noAgentFlag); assert.deepEqual(mutation(f.calls), []);
  assert.ok(!JSON.stringify(outcome).includes("PRIVATE")); assert.ok(!JSON.stringify(outcome).includes(approval.source));
}
{
  const f = fixture({ mismatchPlugin: true, inspectWritesStore: true });
  const outcome = await setupLocalMemory(f.ctx, request, f.ports);
  assert.equal(f.nativeStoreRevision(), 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.changed, true);
  assert.equal(outcome.activity.nativeRecordReadAttempted, true);
  assert.equal(outcome.activity.retainedMaterial, "unknown");
  assert.deepEqual(mutation(f.calls), []);
}
{
  const f = fixture({ wrongLive: true }), outcome = await setupLocalMemory(f.ctx, request, f.ports);
  assert.equal(outcome.code, "STALE", "MODEL_LIVE_MATCH");
  assert.equal(outcome.changed, false, "MODEL_LIVE_MATCH_UNCHANGED");
  assert.deepEqual(mutation(f.calls), [], "MODEL_LIVE_MATCH_NO_MUTATION");
  assert.ok(f.preserved()); assert.ok(!JSON.stringify(outcome).includes("PRIVATE"));
}
{
  const f = fixture({ mountShadow: true }), outcome = await setupLocalMemory(f.ctx, request, f.ports);
  assert.equal(outcome.code, "MOUNT", "MOUNT_MATCH");
  assert.equal(outcome.changed, false, "MOUNT_MATCH_UNCHANGED");
  assert.deepEqual(mutation(f.calls), [], "MOUNT_MATCH_NO_MUTATION");
}
{
  const f = fixture({ missingPlugin: true, failInstall: true }), outcome = await setupLocalMemory(f.ctx, request, f.ports);
  assert.equal(outcome.changed, true, "PARTIAL_ATTEMPT"); assert.equal(outcome.activity.pluginInstallAttempted, true); assert.equal(outcome.activity.modelDownloadAttempted, false);
  assert.ok(!JSON.stringify(outcome).includes("PRIVATE"));
}
{
  const f = fixture({ failDeep: true }), outcome = await setupLocalMemory(f.ctx, request, f.ports);
  assert.equal(outcome.ok, false); assert.equal(outcome.changed, true); assert.equal(outcome.activity.deepProbeAttempted, true); assert.notEqual(outcome.activity.retainedMaterial, "none");
}
{
  const f = fixture({ quiescence: true }), outcome = await setupLocalMemory(f.ctx, request, f.ports);
  assert.equal(outcome.code, "QUIESCENCE", "QUIESCENCE_NO_CLEANUP_CODE"); assert.equal(outcome.changed, true); assert.equal(outcome.activity.staging, "unknown");
  assert.ok(!f.calls.some((args) => args.includes("cleanup")), "QUIESCENCE_NO_CLEANUP"); assert.equal(outcome.activity.deepProbeAttempted, false);
}
{
  const f = fixture(), outcome = await setupLocalMemory(f.ctx, request, f.ports);
  assert.equal(outcome.ok, true); assert.equal(outcome.code, "READY"); assert.equal(outcome.activity.modelDownloadAttempted, false);
}
{
  const f = fixture({ expire: true }), original = Date.now, start = original();
  Date.now = () => start + f.offset();
  try { const outcome = await setupLocalMemory(f.ctx, request, f.ports); assert.equal(outcome.code, "DEADLINE"); assert.deepEqual(mutation(f.calls), []); }
  finally { Date.now = original; }
}
{
  const f = fixture({ missingPlugin: true, failAbsence: true }), outcome = await setupLocalMemory(f.ctx, request, f.ports);
  assert.equal(outcome.changed, true); assert.equal(outcome.activity.nativeRecordReadAttempted, true);
  assert.equal(outcome.activity.pluginInstallAttempted, false); assert.equal(outcome.activity.retainedMaterial, "unknown");
  assert.deepEqual(mutation(f.calls), []); assert.ok(f.preserved()); assert.ok(!JSON.stringify(outcome).includes("PRIVATE"));
}
{
  const f = fixture({ missingPlugin: true, missingRoot: true }), outcome = await setupLocalMemory(f.ctx, request, f.ports);
  assert.equal(outcome.ok, true); assert.equal(outcome.activity.nativeRecordReadAttempted, true);
  assert.equal(outcome.activity.pluginInstallAttempted, true); assert.equal(outcome.activity.rootCreationAttempted, true);
  assert.equal(outcome.activity.modelDownloadAttempted, true); assert.equal(outcome.activity.retainedMaterial, "confirmed");
  const work = mutation(f.calls);
  assert.ok(work.findIndex((args) => args[1] === "install") < work.findIndex((args) => args[1] === "download"));
  assert.ok(f.preserved()); assert.ok(!JSON.stringify(outcome).includes("PRIVATE_AUTH"));
}
{
  const f = fixture({ driftAfterProbe: true }), outcome = await setupLocalMemory(f.ctx, { ...request, agent: undefined, allAgents: true }, f.ports);
  assert.equal(outcome.code, "STALE"); assert.equal(outcome.changed, true);
  assert.equal(f.calls.filter((args) => args.includes("--deep") && !args.includes("--help")).length, 1);
  assert.ok(f.preserved());
}
const resourceCalls = (calls: string[][]) => calls.filter((args) => ["root", "model", "native-record-read", "native-path-read"].includes(args[0]) || args[0] === "plugins" && args[1] === "inspect" && !args.includes("--help") || args.includes("--deep") && !args.includes("--help"));
for (const overrides of [{ local: { modelPath: "/PRIVATE/other.gguf" } }, { provider: "openai" }, { fallback: "openai" }, { enabled: false }]) {
  const selectedOnly = fixture({ overrides });
  const selectedOutcome = await setupLocalMemory(selectedOnly.ctx, request, selectedOnly.ports);
  assert.equal(selectedOutcome.ok, true, "UNSELECTED_OVERRIDE_NOT_PROBED");
  assert.equal(selectedOnly.calls.filter((args) => args.includes("--deep") && !args.includes("--help")).length, 1);
  const all = fixture({ overrides });
  const rejected = await setupLocalMemory(all.ctx, { ...request, agent: undefined, allAgents: true }, all.ports);
  assert.equal(rejected.code, "STALE", "ALL_SELECTED_RESOURCES_BEFORE_FIRST");
  assert.equal(rejected.changed, false); assert.deepEqual(resourceCalls(all.calls), []);
  assert.ok(!JSON.stringify(rejected).includes("PRIVATE")); assert.ok(all.preserved());
}
{
  const f = fixture({ rankingOverride: true }), outcome = await setupLocalMemory(f.ctx, request, f.ports);
  assert.equal(outcome.ok, true, "RANKING_AND_GENERIC_LOCAL_MODEL_ALLOWED"); assert.ok(f.preserved());
  assert.ok(!JSON.stringify(outcome).includes("PRIVATE_AUTH"));
}
{
  const f = fixture({ missingPlugin: true, driftAfterInstall: true });
  const outcome = await setupLocalMemory(f.ctx, { ...request, agent: undefined, allAgents: true }, f.ports);
  assert.equal(outcome.code, "STALE", "MID_PIPELINE_RESOURCE_DRIFT"); assert.equal(outcome.changed, true);
  const installation = f.calls.findIndex((args) => args[0] === "plugins" && args[1] === "install" && !args.includes("--help"));
  assert.ok(installation >= 0); assert.deepEqual(resourceCalls(f.calls.slice(installation + 1)), []);
  assert.equal(outcome.activity.modelDownloadAttempted, false); assert.equal(outcome.activity.deepProbeAttempted, false);
}
{
  const b = fixture({ overrides: { provider: "openai" } });
  const refused = await setupLocalMemory(b.ctx, { ...request, agent: "unrelated" }, b.ports);
  assert.equal(refused.code, "STALE", "SELECTED_B_BEFORE_ANY_RESOURCE");
  assert.equal(refused.changed, false); assert.deepEqual(resourceCalls(b.calls), []);
}
for (const drift of ["driftAfterHash", "driftBeforeDownload"] as const) {
  const f = fixture({ missingModel: true, [drift]: true });
  const outcome = await setupLocalMemory(f.ctx, { ...request, agent: undefined, allAgents: true }, f.ports);
  assert.equal(outcome.code, "STALE", "MODEL_HASH_DRIFT_BLOCKS_DOWNLOAD");
  assert.equal(outcome.activity.modelDownloadAttempted, false); assert.equal(outcome.activity.nativeRecordReadAttempted, true);
  assert.equal(outcome.changed, true);
  assert.equal(outcome.activity.deepProbeAttempted, false); assert.deepEqual(mutation(f.calls), []);
  let lastHelper: number = -1;
  for (let index: number = f.calls.length - 1; index >= 0; index--) {
    if (["root", "model"].includes(f.calls[index][0])) { lastHelper = index; break; }
  }
  assert.ok(lastHelper >= 0); assert.deepEqual(resourceCalls(f.calls.slice(lastHelper + 1)), []);
}
for (const overrideList of ["absent", "empty", "unknown"] as const) {
  const f = fixture({ nativeIds: ["main"], overrideList });
  const outcome = await setupLocalMemory(f.ctx, { ...request, agent: "Main" }, f.ports);
  assert.equal(outcome.ok, true, "AUTHORITATIVE_MAIN_WITH_OPTIONAL_OVERRIDES");
  assert.deepEqual(outcome.agents, [{ agentId: "main", state: "ready" }]);
  assert.deepEqual(f.calls.filter((args) => args.includes("--deep") && !args.includes("--help")), [["memory", "status", "--agent", "main", "--json", "--deep"]]);
}
for (const options of [{ nativeIds: ["Main", "main"] }, { nativeIds: ["main"], overrideList: "collision" as const }]) {
  const f = fixture(options), outcome = await setupLocalMemory(f.ctx, { ...request, agent: "main" }, f.ports);
  assert.equal(outcome.code, "UNSUPPORTED", "NORMALIZED_INVENTORY_COLLISION_BEFORE_RESOURCES");
  assert.equal(outcome.changed, false); assert.deepEqual(resourceCalls(f.calls), []);
}
{
  const f = fixture({ nativeIds: ["main"], overrideList: "unknown" });
  const outcome = await setupLocalMemory(f.ctx, { ...request, agent: "ghost" }, f.ports);
  assert.equal(outcome.code, "UNSUPPORTED", "OVERRIDE_CANNOT_REGISTER_AGENT");
  assert.equal(outcome.changed, false); assert.deepEqual(resourceCalls(f.calls), []);
}
typeAssert("setup preflights, selected deep probes, conservative failures and shared deadlines");
finish("memory setup operation");
