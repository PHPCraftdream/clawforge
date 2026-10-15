import { registerSecret } from "#framework/core/io/log.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { configure, declaredMemory, MemoryError, ownedPatch, type MemoryConfig } from "#framework/commands/management/configuration/memory/declaration.ts";
import { consume, ready, safeStatus, witnessMatch, witness, cli, budget, failureFacts } from "#framework/commands/management/configuration/memory/consumer.ts";
import { managementCommands } from "#framework/commands/interface/groups/openclawCommands.management.ts";
import { envReads, resetEnvReads } from "#framework/core/env.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { ConfirmationRequiredError } from "#framework/core/command/index.ts";
import { HelperContainer, HELPER_TIMEOUT_SUPERVISOR } from "#framework/runtime/docker/helper-container.ts";
import { ContainerIntrospection } from "#framework/runtime/docker/container-introspection.ts";
import type { Context } from "#framework/core/context.ts";
import type { Settings } from "#framework/core/env.ts";
import type { Transport, ExecOptions } from "#framework/runtime/transport/transport.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, mkdir, rm, symlink, lstat } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import * as nativeFs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { WITNESS_CREATE_SCRIPT, MODEL_CHECK_SCRIPT } from "#framework/commands/management/configuration/memory/consumer.ts";
import { localPrerequisites } from "#framework/commands/management/configuration/memory/consumer.ts";
import { NATIVE_PATH_CHECK_SCRIPT } from "#framework/commands/management/configuration/memory/native.ts";
import { RESOURCE_SNAPSHOT_SCRIPT } from "#framework/commands/management/configuration/memory/resources.ts";
function resourceSnapshotFixture(config: MemoryConfig, ids: readonly string[] = ["main"]) {
  return async (_service: string, _command: string, args: string[]) => {
    if (args[1] !== RESOURCE_SNAPSHOT_SCRIPT) throw Error("unexpected resource helper operation");
    return { code: 0, stdout: JSON.stringify({ backend: "builtin", agents: { defaults: { memorySearch: config } }, inventory: ids.map(id => ({ id })) }), stderr: "" };
  };
}
const nativePluginFixture = [{ plugin: { id: "llama-cpp", name: "llama.cpp Provider", status: "loaded", version: "2026.6.34", source: "/container/npm/provider/index.js" }, install: { source: "npm", resolvedName: "@openclaw/llama-cpp-provider", resolvedVersion: "2026.6.34", version: "2026.6.34", spec: "@openclaw/llama-cpp-provider@2026.6.34", installPath: "/container/npm/provider" } }];
function nativeReadFixture(args: string[]) {
  if (args[0] === "--version") return { code: 0, stdout: "OpenClaw 2026.6.34\n", stderr: "" };
  if (args[0] === "plugins" && args.includes("--help")) return { code: 0, stdout: "--all --json", stderr: "" };
  if (args[0] === "plugins") return { code: 0, stdout: JSON.stringify(nativePluginFixture), stderr: "" };
  if (args[0] === "config" && args[2] === "plugins") return { code: 0, stdout: "{}", stderr: "" };
  throw Error("unexpected native read fixture call");
}
const nativeHelperFixture = { code: 0, stdout: JSON.stringify({ platform: "linux", arch: "x64", nodeVersion: "v24.15.0", configRoot: "/container" }), stderr: "" };
import { join } from "node:path";
function code(fn: () => unknown) { try { fn(); return "accepted"; } catch (e) { return (e as MemoryError).code; } }
const base = [{ path: "gateway.mode", value: "local" }, { path: "agents.defaults.memorySearch", value: { remote: { apiKey: { source: "env", id: "PRIVATE_AUTH" }, baseUrl: "https://preserve.invalid" }, extraPaths: ["retained"], query: { maxResults: 17 } } }];
const next = configure(base, "keyword"), keyword = declaredMemory(next);
check("keyword owned leaves exact", ownedPatch("keyword"), [{ path: "memory.backend", value: "builtin" }, { path: "agents.defaults.memorySearch.enabled", value: true }, { path: "agents.defaults.memorySearch.provider", value: "none" }, { path: "agents.defaults.memorySearch.fallback", value: "none" }, { path: "agents.defaults.memorySearch.query.hybrid.enabled", value: true }, { path: "agents.defaults.memorySearch.store.vector.enabled", value: false }]);
check("existing memory credential preserved", keyword.remote?.apiKey, { source: "env", id: "PRIVATE_AUTH" });
checkTrue("no whole memory object replacement", next.every((op) => op.path !== "agents.defaults.memorySearch"));
const live: Record<string, unknown> = { agents: { defaults: { memorySearch: { remote: { apiKey: { source: "env", id: "LIVE_AUTH" } }, unknown: 29 } } } };
for (const op of configure([{ path: "gateway.mode", value: "local" }, { path: "agents.defaults.memorySearch", value: { query: { maxResults: 17 } } }], "keyword")) {
  const keys = op.path.split("."); let at = live;
  for (const key of keys.slice(0, -1)) { at[key] ??= {}; at = at[key] as Record<string, unknown>; }
  at[keys.at(-1)!] = op.value;
}
check("independent leaf consumer preserves live auth/unknown", ((live.agents as { defaults: { memorySearch: { remote: unknown; unknown: number } } }).defaults.memorySearch), { remote: { apiKey: { source: "env", id: "LIVE_AUTH" } }, unknown: 29, enabled: true, provider: "none", fallback: "none", query: { maxResults: 17, hybrid: { enabled: true } }, store: { vector: { enabled: false } } });
const status = { backend: "builtin", provider: "none", requestedProvider: "none", custom: { providerState: { mode: "pending", requestedProvider: "none" }, indexIdentity: { status: "valid" }, searchMode: "hybrid" }, fts: { enabled: true, available: true }, vector: { enabled: false }, files: 1, chunks: 1, dirty: false, workspaceDir: "PRIVATE_WORKSPACE", dbPath: "PRIVATE_DB", snippet: "PRIVATE_SNIPPET", apiKey: "PRIVATE_AUTH" };
check("actual none nested pending keyword accepted", ready([{ agentId: "main", status }], "main", keyword).provider, "none");
check("manager null representation accepted", ready([{ agentId: "main", status: { ...status, provider: null } }], "main", keyword).provider, null);
check("arbitrary provider rejected", code(() => ready([{ agentId: "main", status: { ...status, provider: "openai" } }], "main", keyword)), "STALE");
checkTrue("nested metadata retained", JSON.stringify(safeStatus([{ agentId: "main", status }])).includes('"indexIdentity":"valid"'));
checkTrue("private status excluded", !JSON.stringify(safeStatus([{ agentId: "main", status }])).includes("PRIVATE_"));
check("builtin row error stops readiness", code(() => ready([{ agentId: "main", status, error: { code: "missing-provider-auth", message: "PRIVATE_SECRET" } }], "main", keyword)), "AUTH");
checkTrue("builtin row error projected safely", JSON.stringify(safeStatus([{ agentId: "main", status, error: { code: "missing-provider-auth", message: "PRIVATE_SECRET" } }])).includes('"ok":false'));
check("partial status retained", safeStatus([{ agentId: "bad", status: { backend: "unknown" } }, { agentId: "main", status }]).length, 2);
for (const [startLine, endLine, expected] of [[1, 4, true], [2, 4, false], [0, 4, false], [1, 0, false], [1, Infinity, false]] as const) check(`witness ${startLine}..${endLine}`, witnessMatch({ results: [{ source: "memory", path: "memory/witness.md", startLine, endLine, snippet: "cfkeyword20261009witness" }] }, "memory/witness.md", "cfkeyword20261009witness"), expected);
check("wrong path rejected", witnessMatch({ results: [{ source: "memory", path: "memory/other.md", startLine: 1, endLine: 4, snippet: "marker" }] }, "memory/witness.md", "marker"), false);
check("wrong source rejected", witnessMatch({ results: [{ source: "sessions", path: "memory/witness.md", startLine: 1, endLine: 4, snippet: "marker" }] }, "memory/witness.md", "marker"), false);
const embeddings = declaredMemory(configure([], "embeddings", "openai", "embed-model", "EMBED_KEY"));
for (const [state, expected] of [["ready", "accepted"], ["pending", "UNSUPPORTED"], ["missing-provider-auth", "AUTH"], ["missing-model", "MODEL"]]) check(`embedding ${state}`, code(() => ready([{ agentId: "main", status: { ...status, provider: "openai", requestedProvider: "openai", model: "embed-model", custom: { providerState: { mode: state } }, vector: { enabled: true, available: true } } }], "main", embeddings)), expected);
const deploymentRoot = await mkdtemp(join(tmpdir(), "memory-deployment-"));
const deployment = await createDeploymentFixture({ root: deploymentRoot }).catch(async (error) => {
  await rm(deploymentRoot, { recursive: true, force: true });
  throw error;
});
try {
  const app = { name: "memory-check", description: "fixture", commands: { memory: managementCommands.memory } };
  const path = join(deploymentRoot, "config", "desired-state.json");
  await writeFile(path, JSON.stringify(next)); const before = await readFile(path, "utf8");
  for (const argv of [["configure", "--mode", "keyword", "--backend", "builtin"], ["index", "--agent", "main"], ["verify", "--agent", "main"], ["status", "--deep", "--allow-spend", "--allow-download"]]) {
    const result = await executeCommand(app, "memory", { kind: "argv", argv }, { surface: "mcp", confirmed: false, transport: deployment.transport() });
    check(`unconfirmed ${argv[0]} exact stage`, result.stage, "confirm"); checkTrue(`unconfirmed ${argv[0]} typed error`, result.error instanceof ConfirmationRequiredError);
    check(`unconfirmed ${argv[0]} no contacts`, deployment.contacts(), []); check(`unconfirmed ${argv[0]} no writes`, await readFile(path, "utf8"), before);
  }
  for (const argv of [["index", "--agent", "main", "--allow-spend", "--allow-download"], ["verify", "--agent", "main", "--model-checksum", "a".repeat(64)]]) {
    const refused = await executeCommand(app, "memory", { kind: "argv", argv }, { surface: "mcp", confirmed: true, transport: deployment.transport() });
    check("keyword contradictory approvals refused in prepare", refused.stage, "prepare"); check("contradiction zero contacts", deployment.contacts(), []);
  }
  await writeFile(path, JSON.stringify(configure([], "embeddings", "local", "/home/node/.openclaw/models/approved.gguf", undefined, "/home/node/.openclaw/models/approved.gguf")));
  const missing = await executeCommand(app, "memory", { kind: "argv", argv: ["index", "--agent", "main"] }, { surface: "mcp", confirmed: true, transport: deployment.transport() });
  check("missing local approval before contact", missing.stage, "prepare"); check("missing approval zero contacts", deployment.contacts(), []);
  const disabledLocal = configure(configure([], "embeddings", "local", "/home/node/.openclaw/models/a.gguf", undefined, "/home/node/.openclaw/models/a.gguf"), "disabled");
  await writeFile(path, JSON.stringify(disabledLocal));
  const skipped = await executeCommand(app, "memory", { kind: "argv", argv: ["index", "--agent", "main"] }, { surface: "mcp", confirmed: true, transport: deployment.transport() });
  check("disabled local history reaches run", skipped.stage, "run"); check("disabled history succeeds", skipped.error, undefined); check("disabled history no contacts", deployment.contacts(), []);
  check("disabled preserved local history consumer skips", await consume({} as Context, declaredMemory(disabledLocal), "main", false, true), { ok: true, changed: false, outcomes: [{ state: "skipped-intentional-disabled" }] });
  const localArgs = ["configure", "--mode", "embeddings", "--backend", "builtin", "--provider", "local", "--model-path", "/home/node/.openclaw/models/approved.gguf", "--model-checksum", "a".repeat(64), "--model-source", "approved-source", "--model-version", "pinned-version"];
  resetEnvReads();
  const inferred = await executeCommand(app, "memory", { kind: "argv", argv: localArgs }, { surface: "mcp", confirmed: true, transport: deployment.transport() });
  check("local omitted model configure reaches run", inferred.stage, "run"); check("local omitted model succeeds", inferred.error, undefined);
  check("local inference zero contacts", deployment.contacts(), []); check("local inference zero env reads", envReads(), 0);
  const inferredText = await readFile(path, "utf8"), inferredOps = JSON.parse(inferredText) as { path: string; value: unknown }[];
  check("local model leaf inferred absolute identity", inferredOps.find((op) => op.path === "agents.defaults.memorySearch.model"), { path: "agents.defaults.memorySearch.model", value: "/home/node/.openclaw/models/approved.gguf" });
  resetEnvReads();
  const contradictory = await executeCommand(app, "memory", { kind: "argv", argv: [...localArgs, "--model", "arbitrary-label"] }, { surface: "mcp", confirmed: true, transport: deployment.transport() });
  check("contradictory local identity rejected in prepare", contradictory.stage, "prepare"); checkTrue("contradictory local identity has error", contradictory.error !== undefined);
  check("contradictory identity zero contacts", deployment.contacts(), []); check("contradictory identity zero env reads", envReads(), 0);
  check("contradictory identity no declaration write", await readFile(path, "utf8"), inferredText);
  for (const invalidPath of ["/home/node/.openclaw/models//approved.gguf", "/home/node/.openclaw/models\\approved.gguf"]) {
    resetEnvReads();
    const invalidArgs = localArgs.map((arg) => arg === "/home/node/.openclaw/models/approved.gguf" ? invalidPath : arg);
    const invalid = await executeCommand(app, "memory", { kind: "argv", argv: invalidArgs }, { surface: "mcp", confirmed: true, transport: deployment.transport() });
    check("noncanonical local path prepare refusal", invalid.stage, "prepare"); checkTrue("noncanonical path has typed error", invalid.error !== undefined);
    check("noncanonical path zero contacts", deployment.contacts(), []); check("noncanonical path zero env reads", envReads(), 0);
    check("noncanonical path no declaration write", await readFile(path, "utf8"), inferredText);
    check("public leaf builder rejects noncanonical path", code(() => ownedPatch("embeddings", "local", undefined, undefined, invalidPath)), "MODEL");
  }
  await writeFile(path, before);
  const plan = await executeCommand(app, "memory", { kind: "argv", argv: ["plan", "--mode", "keyword", "--backend", "builtin"] }, { surface: "mcp", confirmed: false, transport: deployment.transport() });
  check("local plan reaches run", plan.stage, "run"); check("local plan no contacts", deployment.contacts(), []);
  const configured = await executeCommand(app, "memory", { kind: "argv", argv: ["configure", "--mode", "disabled", "--backend", "builtin"] }, { surface: "mcp", confirmed: true, transport: deployment.transport() });
  check("local configure succeeds", configured.error, undefined); check("local configure no contacts", deployment.contacts(), []);
const calls: { command: string; args: string[]; timeout?: number }[] = [];
let discoveryFailure = false;
const transport = { exec: async (command: string, args: string[], options: ExecOptions = {}) => {
  calls.push({ command, args, timeout: options.timeoutMs });
  if (args[0] === "ps") return { code: discoveryFailure ? 1 : 0, stdout: "owned-container\n", stderr: "", ...(discoveryFailure ? { timedOut: true as const } : {}) };
  const n = args.indexOf("-e"); return { code: 0, stdout: "{}", stderr: n < 0 ? "" : `\nCFHELPER:${args[n + 3]}:{"kind":"completed","code":0}\n` };
} } as unknown as Transport;
const introspection = new ContainerIntrospection(transport, () => ({} as Settings), () => "gateway");
const helper = new HelperContainer(transport, async () => { throw new Error("unexpected compose"); }, (service, all, timeout) => introspection.containerId(service, all, timeout));
const ctx = { runtime: { execInHelper: helper.execInHelper.bind(helper) } } as unknown as Context;
await cli(ctx, ["memory", "status", "--json"], () => 50000);
const exec = calls[1], wrapperAt = exec.args.indexOf("-e"), childBudget = Number(exec.args[wrapperAt + 2]);
checkTrue("supervisor child remaining bounded", childBudget > 0 && childBudget <= 50000);
check("transport gets independent ten-second grace", exec.timeout, childBudget + 10000);
discoveryFailure = true; calls.length = 0;
let failed = "none"; try { await cli(ctx, ["memory", "status", "--json"], () => 50000); } catch (e) { failed = (e as MemoryError).code; }
check("discovery error not hidden", failed, "UNREACHABLE"); check("failed discovery never execs", calls.length, 1);
calls.length = 0; failed = "none";
try { await cli(ctx, ["memory", "index", "--force"], budget(0)); } catch (e) { failed = (e as MemoryError).code; }
check("expired before mutation", failed, "DEADLINE"); check("expired makes no calls", calls, []);
check("disabled intentional no helper", await consume(ctx, { enabled: false }, "main", false, true), { ok: true, changed: false, outcomes: [{ state: "skipped-intentional-disabled" }] });
{
  const indexed: string[][] = [];
  const fixture = { runtime: { execCommand: resourceSnapshotFixture(keyword, ["main", "broken"]), execInHelper: async (service: string, args: string[]) => {
    check("consumer selects cli-helper", service, "cli-helper");
    if (args[0] === "agents") return { code: 0, stdout: '[{"id":"main"},{"id":"broken"}]', stderr: "" };
    if (args[1] === "status") return { code: 0, stdout: JSON.stringify([{ agentId: "main", status }, { agentId: "broken", status: { ...status, fts: { enabled: true, available: false } } }]), stderr: "" };
    indexed.push(args); return { code: 0, stdout: "", stderr: "" };
  } } } as unknown as Context;
  const result = await consume(fixture, keyword, undefined, true, false);
  check("partial agent failure retained", result.ok, false);
  check("only ready keyword indexed; no deep/auth", indexed, [["memory", "index", "--agent", "main", "--force"]]);
  checkTrue("no private result/credential output", !JSON.stringify(result).includes("PRIVATE_"));
}
const scratch = nativeFs.realpathSync.native(await mkdtemp(join(tmpdir(), "memory-exclusive-")));
try {
  const workspace = join(scratch, "workspace");
  const memoryDir = join(workspace, "memory");
  await mkdir(memoryDir, { recursive: true });
  const file = join(memoryDir, "witness.md");
  function create(uid: number, w = workspace, f = file) {
    const shim = `const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const uid=Number(process.argv[1]),args=process.argv.slice(2),source=fs.readFileSync(0,'utf8');
const root=fs.realpathSync.native(process.cwd()),identity=fs.lstatSync(root),leases=new Set();
const denied=()=>{throw Error('outside child allocation or unowned descriptor')};
const inside=p=>{const r=path.relative(root,p);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep))};
function canonical(p,follow=true,depth=0,base=root){
  if(typeof p!=='string'||depth>40)denied();
  const raw=path.sep==='/'?p:p.replaceAll('/',path.sep),anchor=path.parse(raw).root;
  let remaining=raw,at=base;
  if(anchor){
    if(!path.isAbsolute(raw))denied();
    const compare=s=>path.sep==='/'?s:s.toLowerCase(),prefix=root.endsWith(path.sep)?root:root+path.sep;
    if(compare(raw)===compare(root))remaining='';
    else if(compare(raw).startsWith(compare(prefix)))remaining=raw.slice(prefix.length);
    else denied();
    at=root;
  }
  if(!inside(at))denied();
  const current=fs.lstatSync(root);if(current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino)denied();
  const parts=remaining.split(path.sep).filter(Boolean);
  for(let i=0;i<parts.length;i++){
    const parent=at;at=path.join(at,parts[i]);
    if(!inside(at))denied();
    if(!follow&&i===parts.length-1&&!raw.endsWith(path.sep)&&parts[i]!=='.'&&parts[i]!=='..')break;
    let s;try{s=fs.lstatSync(at)}catch(e){if(e.code!=='ENOENT')throw e;continue}
    if(s.isSymbolicLink()){
      try{at=fs.realpathSync.native(at);if(!inside(at))denied()}catch(e){if(e.code!=='ENOENT')throw e;at=canonical(fs.readlinkSync(at),true,depth+1,parent)}
    }else{at=fs.realpathSync.native(at);if(!inside(at))denied()}
  }
  if(!inside(at))denied();return at;
}
function checked(p,follow=true){canonical(p,follow);return p}
const lease=fd=>{if(fd<=2||!leases.has(fd))denied();return fd};
function close(fd){lease(fd);try{return fs.closeSync(fd)}finally{leases.delete(fd)}}
function release(){for(const fd of leases){try{fs.closeSync(fd)}catch{}leases.delete(fd)}}
process.on('exit',release);
const metadata=stat=>Object.assign(stat,{uid:1000,mode:stat.mode&~0o077});
const fixture={
  realpathSync:(p,...options)=>fs.realpathSync.native(checked(p),...options),
  lstatSync:(p,...options)=>metadata(fs.lstatSync(checked(p,false),...options)),
  mkdirSync:(p,...options)=>fs.mkdirSync(checked(p),...options),
  openSync:(p,...options)=>{const fd=fs.openSync(checked(p),...options);if(fd<=2){fs.closeSync(fd);denied()}leases.add(fd);return fd},
  fstatSync:(fd,...options)=>metadata(fs.fstatSync(lease(fd),...options)),
  writeFileSync:(p,...options)=>fs.writeFileSync(typeof p==='number'?lease(p):checked(p),...options),
  closeSync:close,
  unlinkSync:(p,...options)=>fs.unlinkSync(checked(p,false),...options),
  rmdirSync:(p,...options)=>fs.rmdirSync(checked(p,false),...options)
};
try{vm.runInNewContext(source,{require:name=>{if(name==='node:fs')return fixture;if(name==='node:path')return {resolve:(...args)=>path.resolve(...args),join:(...args)=>path.join(...args),dirname:p=>path.dirname(p),sep:path.sep};throw Error('unsupported module')},console,process:{platform:'linux',argv:['node',...args],getuid:()=>uid,exit:code=>{release();process.exit(code)}}})}finally{release()}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["NODE_OPTIONS", "NODE_PATH"].includes(name.toUpperCase())));
    const child = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${scratch}`, `--allow-fs-write=${scratch}`, "-e", shim, String(uid), w, f, "fixed-marker"], {
      cwd: scratch, env, input: WITNESS_CREATE_SCRIPT, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    if (child.error || child.signal || child.status === null || ![0, 73, 74].includes(child.status)) {
      throw Object.assign(Error(`witness child failed: ${child.error?.message ?? child.signal ?? child.status}\n${child.stdout}\n${child.stderr}`), { cause: child.error, signal: child.signal, status: child.status, stdout: child.stdout, stderr: child.stderr });
    }
    return child.status;
  }
  check("exclusive creation under uid1000 metadata contract", create(1000), 0); const original = await lstat(file);
  check("real collision preserves file", create(1000), 73); check("collision inode retained", (await lstat(file)).ino, original.ino);
  check("root cannot create witness", create(0), 74); check("non1000 cannot create witness", create(1001), 74);
  const link = join(scratch, "linked");
  await symlink(workspace, link, "junction");
  const linkedFile = join(link, "memory", "other.md");
  check("real workspace symlink blocked", create(1000, link, linkedFile), 74);
} finally { await rm(scratch, { recursive: true, force: true }); }
{
  let pluginCalls = 0;
  const localCtx = { settings: { dataDir: "/managed" }, paths: { toContainer: (path: string) => path.endsWith("/models") ? "/container/models" : "/container" }, runtime: {
    execCommand: async (service: string, _command: string, args: string[]) => { check("model/native probe uses correct helper", service, "cli-helper"); return args[1] === NATIVE_PATH_CHECK_SCRIPT ? nativeHelperFixture : { code: 0, stdout: "", stderr: "" }; },
    execInHelper: async (service: string, args: string[]) => { check("plugin uses correct helper", service, "cli-helper"); if (args[1] === "inspect" && args.includes("--all")) pluginCalls++; return nativeReadFixture(args); },
  } } as unknown as Context;
  const config = { ...embeddings, provider: "local", model: "/container/models/approved.gguf", local: { modelPath: "/container/models/approved.gguf" } }, approval = { checksum: "a".repeat(64), source: "approved-source", version: "pinned-version" };
  await localPrerequisites(localCtx, config, () => 50000, approval); await localPrerequisites(localCtx, config, () => 50000, approval);
  check("matching local model repeatable without delivery", pluginCalls, 2);
  localCtx.runtime.execCommand = async () => ({ code: 3, stdout: "", stderr: "" });
  let failure = "none"; try { await localPrerequisites(localCtx, config, () => 50000, approval); } catch (e) { failure = (e as MemoryError).code; }
  check("mismatched model stops before plugin/index", failure, "MODEL"); check("mismatch no extra plugin call", pluginCalls, 2);
}
{
  const clock = Date.now; let now = 100;
  try {
    Date.now = () => now; let execs = 0;
    const expired = new HelperContainer({ exec: async () => { execs++; return { code: 0, stdout: "", stderr: "" }; } } as unknown as Transport, async () => { throw Error("compose"); }, async () => { now += 51; return "owned"; });
    let caught = false; try { await expired.execInHelper("cli-helper", [], { timeoutMs: 50 }); } catch { caught = true; }
    check("discovery expiration refuses exec", caught, true); check("discovery expiration no exec", execs, 0);
  } finally { Date.now = clock; }
  const absent = new HelperContainer(transport, async () => { throw Error("compose"); }, async (service) => service === "cli" ? "wrong-service" : undefined);
  let caught = "none"; try { await absent.execInHelper("cli-helper", [], { timeoutMs: 50000 }); } catch (e) { caught = (e as Error).name; }
  check("cli is not cli-helper identity", caught, "HelperNotRunning");
}
for (const scenario of ["success", "wrong", "index-fail", "collision", "cleanup-fail", "expired"] as const) {
  const operations: string[] = [], owned = new Map<string, string>(); let indexCalls = 0;
  const fixture = { settings: { dataDir: "/managed" }, paths: { fromContainer: (p: string) => p.replace("/container", "/managed") }, runtime: {
    execCommand: async (_service: string, _command: string, args: string[]) => {
      if (args[1] === WITNESS_CREATE_SCRIPT) { operations.push("create"); if (scenario === "collision") return { code: 73, stdout: "", stderr: "" }; owned.set(args[3], "fixed-owned-content"); return { code: 0, stdout: '{"dev":1,"ino":23}', stderr: "" }; }
      operations.push("cleanup"); if (scenario === "cleanup-fail") return { code: 2, stdout: "", stderr: "" }; owned.delete(args[2]); return { code: 0, stdout: "", stderr: "" };
    },
    execInHelper: async (_service: string, args: string[]) => {
      operations.push(args[1]); if (args[1] === "index") { indexCalls++; return { code: scenario === "index-fail" && indexCalls === 1 ? 1 : 0, stdout: "", stderr: "missing-provider-auth" }; }
      if (args[1] === "status") return { code: 0, stdout: JSON.stringify([{ agentId: "main", status }]), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ results: [{ source: "memory", path: scenario === "wrong" ? "memory/unrelated.md" : "memory/fixedwitness.md", startLine: 1, endLine: 4, snippet: "independent fixedwitness fixture" }] }), stderr: "" };
    },
  } } as unknown as Context;
  let failure: unknown;
  try { await witness(fixture, "main", { workspaceDir: "/container/workspace" }, scenario === "expired" ? budget(0) : () => 50000, "fixedwitness"); } catch (e) { failure = e; }
  const expected = scenario === "success" ? undefined : scenario === "wrong" ? "SEARCH" : scenario === "index-fail" ? "AUTH" : scenario === "cleanup-fail" ? "CLEANUP" : scenario === "expired" ? "DEADLINE" : "UNREACHABLE";
  check(`witness ${scenario} primary outcome`, failure ? (failure as MemoryError).code : undefined, expected);
  check(`witness ${scenario} owned cleanup`, owned.size, scenario === "cleanup-fail" ? 1 : 0);
  if (scenario === "expired") check("expired before witness WRITE", operations, []);
  if (scenario === "collision") check("collision never cleanup/index", operations, ["create"]);
  if (["success", "wrong", "index-fail"].includes(scenario)) check(`witness ${scenario} cleanup reindex`, operations.slice(-2), ["cleanup", "index"]);
  if (scenario === "cleanup-fail") check("cleanup safe cause retained", failureFacts(failure).cleanup, { code: "UNREACHABLE", exitCode: 2 });
}
{
  const fixture = { runtime: { execCommand: resourceSnapshotFixture(embeddings), execInHelper: async (_service: string, args: string[]) => {
    if (args[0] === "agents") return { code: 0, stdout: '[{"id":"main"}]', stderr: "" };
    if (args.includes("--deep")) return { code: 1, stdout: "PRIVATE_DIAGNOSTIC", stderr: "missing-provider-auth" };
    return { code: 0, stdout: JSON.stringify([{ agentId: "main", status: { ...status, provider: "openai", requestedProvider: "openai" } }]), stderr: "" };
  } } } as unknown as Context;
  const result = await consume(fixture, embeddings, "main", false, false, { spend: true, download: true });
  check("deep failure retains normal partial", (result.outcomes[0] as { status: unknown[] }).status.length, 1);
  check("deep failure conservatively records initialization attempt", result.changed, true); check("failed deep attempted fact", result.resourcePreflightAttempted, true); checkTrue("deep error private text excluded", !JSON.stringify(result).includes("PRIVATE_"));
}
check("unrelated dotted config preserved", configure([{ path: "plugins.entries", value: { "unrelated.plugin": { enabled: true } } }], "keyword")[0], { path: "plugins.entries", value: { "unrelated.plugin": { enabled: true } } });
{
  const timed = new ContainerIntrospection({ exec: async () => ({ code: 0, stdout: "wrong-id", stderr: "", timedOut: true }) } as unknown as Transport, () => ({} as Settings), () => "gateway");
  let rejected = false; try { await timed.containerId("cli-helper", false, 50000); } catch { rejected = true; }
  check("discovery timedOut code0 rejected", rejected, true);
  for (const expire of [false, true]) {
    const listeners: Record<string, (...a: unknown[]) => void> = {}, timers: { fn: () => void; ms: number; cleared: boolean }[] = [], signals: string[] = [];
    let memberAlive = true;
    let receipt = "";
    const fakeProcess = { argv: ["node", "50", "fixed-nonce", "node", "child"], kill: (pid: number, signal: string | number) => {
      if (signal === 0 && !memberAlive) throw Object.assign(new Error("absent"), { code: "ESRCH" });
      if (signal !== 0) signals.push(`${pid}:${signal}`);
    }, on() {}, exitCode: 0, exit() { throw Error("unexpected reserve expiry"); }, stderr: { write(text: string) { receipt += text; } } };
    runInNewContext(HELPER_TIMEOUT_SUPERVISOR, { require: () => ({ spawn: () => ({ pid: 42, on: (name: string, fn: (...a: unknown[]) => void) => { listeners[name] = fn; } }) }), setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimeout: (t?: { cleared: boolean }) => { if (t) t.cleared = true; }, process: fakeProcess });
    if (expire) timers[0].fn();
    check("supervisor not complete before leader close", receipt, "");
    listeners.close(0); check("leader close does not cancel descendant deadline", timers[0].cleared, false);
    checkTrue("normal/expired leader kills owned descendants", signals.includes("-42:SIGKILL"));
    check("descendants still alive keeps result pending", receipt, "");
    memberAlive = false; timers.at(-1)!.fn();
    check("confirmed group receipt outcome", receipt, `\nCFHELPER:fixed-nonce:{"kind":"${expire ? "timeout" : "completed"}","code":${expire ? 124 : 0}}\n`);
    check("deadline timer cleared after quiescence", timers[0].cleared, true);
    check("reserve timer cleared after quiescence", timers[1].cleared, true);
  }
}
{
  const root = nativeFs.realpathSync.native(await mkdtemp(join(tmpdir(), "memory-hash-")));
  try {
    const file = join(root, "approved.gguf"); await writeFile(file, "abc");
    async function hash(expected: string, selected = file) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["NODE_OPTIONS", "NODE_PATH"].includes(name.toUpperCase())));
      const shim = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const args=process.argv.slice(1),source=fs.readFileSync(0,'utf8');
const root=fs.realpathSync.native(process.cwd()),identity=fs.lstatSync(root),leases=new Set();
const denied=()=>{throw Error('outside child allocation or unowned descriptor')};
const inside=p=>{const r=path.relative(root,p);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep))};
function canonical(p,follow=true,depth=0,base=root){
  if(typeof p!=='string'||depth>40)denied();
  const raw=path.sep==='/'?p:p.replaceAll('/',path.sep),anchor=path.parse(raw).root;
  let remaining=raw,at=base;
  if(anchor){
    if(!path.isAbsolute(raw))denied();
    const compare=s=>path.sep==='/'?s:s.toLowerCase(),prefix=root.endsWith(path.sep)?root:root+path.sep;
    if(compare(raw)===compare(root))remaining='';
    else if(compare(raw).startsWith(compare(prefix)))remaining=raw.slice(prefix.length);
    else denied();
    at=root;
  }
  if(!inside(at))denied();
  const current=fs.lstatSync(root);if(current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino)denied();
  const parts=remaining.split(path.sep).filter(Boolean);
  for(let i=0;i<parts.length;i++){
    const parent=at;at=path.join(at,parts[i]);
    if(!inside(at))denied();
    if(!follow&&i===parts.length-1&&!raw.endsWith(path.sep)&&parts[i]!=='.'&&parts[i]!=='..')break;
    let s;try{s=fs.lstatSync(at)}catch(e){if(e.code!=='ENOENT')throw e;continue}
    if(s.isSymbolicLink()){
      try{at=fs.realpathSync.native(at);if(!inside(at))denied()}catch(e){if(e.code!=='ENOENT')throw e;at=canonical(fs.readlinkSync(at),true,depth+1,parent)}
    }else{at=fs.realpathSync.native(at);if(!inside(at))denied()}
  }
  if(!inside(at))denied();return at;
}
function checked(p,follow=true){canonical(p,follow);return p}
const lease=fd=>{if(fd<=2||!leases.has(fd))denied();return fd};
function open(p,...options){const fd=fs.openSync(checked(p),...options);if(fd<=2){fs.closeSync(fd);denied()}leases.add(fd);return fd}
function close(fd){lease(fd);try{return fs.closeSync(fd)}finally{leases.delete(fd)}}
function release(){for(const fd of leases){try{fs.closeSync(fd)}catch{}leases.delete(fd)}}
process.on('exit',release);
const fixture={
  realpathSync:(p,...options)=>fs.realpathSync.native(checked(p),...options),
  statSync:(p,...options)=>fs.statSync(checked(p),...options),
  openSync:open,
  fstatSync:(fd,...options)=>fs.fstatSync(lease(fd),...options),
  readSync:(fd,...options)=>fs.readSync(lease(fd),...options),
  readFileSync:(p,...options)=>fs.readFileSync(typeof p==='number'?lease(p):checked(p),...options),
  closeSync:close,
  createReadStream:(p,options)=>{
    const selected=checked(p),settings=typeof options==='string'?{encoding:options}:{...options};
    const fd=settings.fd===undefined?open(selected,settings.flags??'r',settings.mode):lease(settings.fd);
    try{
      const stream=fs.createReadStream(selected,{...settings,fd,fs:{
        read:(fd,...args)=>fs.read(lease(fd),...args),
        close:(fd,callback)=>{lease(fd);fs.close(fd,error=>{leases.delete(fd);callback(error)})}
      }});
      stream.on('error',()=>{if(leases.has(fd)){try{close(fd)}catch{}}});
      return stream;
    }catch(error){if(leases.has(fd)){try{close(fd)}catch{}}throw error}
  }
};
try{vm.runInNewContext(source,{require:name=>{if(name==='node:fs')return fixture;if(name==='node:path')return {resolve:(...args)=>path.resolve(...args),join:(...args)=>path.join(...args),dirname:p=>path.dirname(p),sep:path.sep};if(name==='node:crypto')return {createHash:(...args)=>crypto.createHash(...args)};throw Error('unsupported module')},process:{argv:['node',...args],exit:code=>{release();process.exit(code)}}})}catch(error){release();throw error}`;
      const child = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${root}`, "-e", shim, selected, root, expected], {
        cwd: root, env, input: MODEL_CHECK_SCRIPT, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      });
      if (child.error || child.signal || child.status === null || ![0, 2, 3].includes(child.status)) {
        throw Object.assign(Error(`model child failed: ${child.error?.message ?? child.signal ?? child.status}\n${child.stdout}\n${child.stderr}`), { cause: child.error, signal: child.signal, status: child.status, stdout: child.stdout, stderr: child.stderr });
      }
      return child.status;
    }
    check("actual streamed SHA256 success", await hash("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"), 0);
    check("actual streamed SHA256 mismatch", await hash("a".repeat(64)), 3);
    check("actual missing model", await hash("a".repeat(64), join(root, "absent.gguf")), 2);
  } finally { await rm(root, { recursive: true, force: true }); }
}
{
  const recorded: { args: string[]; options: ExecOptions }[] = [];
  let kind = "timeout", childCode = 124;
  const bounded = new HelperContainer({ exec: async (_command: string, args: string[], options: ExecOptions = {}) => { recorded.push({ args, options }); const n = args.indexOf("-e"); return n < 0 ? { code: 124, stdout: "", stderr: "" } : { code: 0, stdout: '{"original":true}\n', stderr: `child stderr without newline\nCFHELPER:${args[n + 3]}:${JSON.stringify({ kind, code: childCode })}\n` }; } } as unknown as Transport, async () => { throw Error("compose"); }, async () => "owned");
  check("supervisor timeout receipt becomes timedOut", (await bounded.execInHelper("cli-helper", ["memory", "status"], { input: "", timeoutMs: 50000, allowFailure: true })).timedOut, true);
  const plain = await bounded.execInHelper("cli-helper", ["memory", "status"], { input: "" });
  check("no-timeout does not reinterpret exit124", plain.timedOut, undefined);
  check("no-timeout original argv", recorded[1].args, ["exec", "-i", ...(process.stdout.isTTY ? ["-t"] : []), "owned", "node", "dist/index.js", "memory", "status"]);
  check("no-timeout unchanged option", recorded[1].options.timeoutMs, undefined);
  const protocol = await bounded.execInHelper("cli-helper", ["mcp", "serve"], { stdioProtocol: true, timeoutMs: 50000 });
  check("protocol original argv", recorded[2].args, ["exec", "-i", "owned", "node", "dist/index.js", "mcp", "serve"]);
  check("protocol unchanged exit124", protocol.timedOut, undefined); check("protocol still enabled", recorded[2].options.stdioProtocol, true);
  kind = "completed";
  for (childCode of [124, 125]) {
    const completed = await bounded.execInHelper("cli-helper", [], { input: "", timeoutMs: 50000, allowFailure: true });
    check("ordinary completed status preserved", completed.code, childCode); check("ordinary124/125 not timeout", completed.timedOut, undefined);
    check("child JSON stdout unchanged", completed.stdout, '{"original":true}\n'); check("frame removed without changing stderr prefix", completed.stderr, "child stderr without newline");
  }
  kind = "uncertain"; let uncertainty: unknown;
  try { await bounded.execInHelper("cli-helper", [], { input: "", timeoutMs: 50000, allowFailure: true }); } catch (e) { uncertainty = e; }
  check("uncertain receipt distinct fatal code", (uncertainty as { code: string }).code, "HELPER_QUIESCENCE");
}
for (const [rawCode, typed] of [["missing-provider-auth", "AUTH"], ["missing-model", "MODEL"], ["missing-plugin", "PLUGIN"], ["unreachable", "UNREACHABLE"], ["disabled", "DISABLED"]]) {
  const row = { agentId: "error-only", error: { code: rawCode, message: "PRIVATE_DIAGNOSTIC" } };
  check(`error-only ${typed} readiness`, code(() => ready([row], "error-only", keyword)), typed);
  check(`error-only ${typed} safe projection`, safeStatus([row])[0], { agentId: "error-only", ok: false, error: { code: rawCode } });
  check("error sibling retained", safeStatus([row, { agentId: "main", status }]).length, 2);
}
for (const different of [true, false]) {
  const config = declaredMemory(configure([], "embeddings", "local", "/container/models/a.gguf", undefined, "/container/models/a.gguf")), calls: string[] = [];
  const resourceRead = resourceSnapshotFixture({ ...config, local: { modelPath: different ? "/container/models/b.gguf" : "/container/models/a.gguf" } });
  const fixture = { settings: { dataDir: "/managed" }, paths: { toContainer: (path: string) => path.endsWith("/models") ? "/container/models" : "/container" }, runtime: {
    execCommand: async (_service: string, _command: string, args: string[]) => {
      if (args[1] === RESOURCE_SNAPSHOT_SCRIPT) { calls.push("resources"); return resourceRead(_service, _command, args); }
      const native = args[1] === NATIVE_PATH_CHECK_SCRIPT; calls.push(native ? "paths" : "hash");
      return native ? nativeHelperFixture : { code: 0, stdout: "", stderr: "" };
    },
    execInHelper: async (_service: string, args: string[]) => {
      calls.push(args.includes("--deep") ? "deep" : args[0] === "plugins" ? "plugin" : args[1]);
      if (args[0] === "agents") return { code: 0, stdout: '[{"id":"main"}]', stderr: "" };
      if (args[0] === "--version" || args[0] === "plugins" || (args[0] === "config" && args[2] === "plugins")) return nativeReadFixture(args);
      if (args[1] === "index") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: JSON.stringify([{ agentId: "main", status: { ...status, provider: "local", requestedProvider: "local", model: "/container/models/a.gguf", vector: { enabled: true, available: true }, custom: { providerState: { mode: "ready" } } } }]), stderr: "" };
    },
  } } as unknown as Context;
  let failure: unknown;
  try { await consume(fixture, config, "main", false, false, { checksum: "a".repeat(64), source: "approved", version: "pinned", spend: true, download: true }); } catch (e) { failure = e; }
  check("live A/B pinned model outcome", failure ? (failure as MemoryError).code : "success", different ? "STALE" : "success");
  if (different) checkTrue("A/B mismatch no hash/plugin/deep/index/write", !calls.some(call => ["hash", "paths", "plugin", "deep", "index"].includes(call)));
  else checkTrue("same A hashes and indexes", calls.includes("hash") && calls.includes("index"));
}
{
  const indexAttempts: string[][] = [];
  const fixture = { runtime: { execCommand: resourceSnapshotFixture(embeddings), execInHelper: async (_service: string, args: string[]) => {
    if (args[0] === "agents") return { code: 0, stdout: '[{"id":"main"}]', stderr: "" };
    if (args[1] === "index") { indexAttempts.push(args); return { code: 0, stdout: "", stderr: "" }; }
    return { code: 0, stdout: JSON.stringify([{ agentId: "main", status: { ...status, provider: "openai", requestedProvider: "openai", model: "embed-model" } }]), stderr: "" };
  } } } as unknown as Context;
  check("pending fixture begins without indexing", indexAttempts, []);
  const result = await consume(fixture, embeddings, "main", false, false, { spend: true, download: true });
  check("pending readiness never attempts index", indexAttempts, []);
  check("pending readiness explicit unsupported cause", (result.outcomes[0] as { code: string }).code, "UNSUPPORTED");
  check("successful deep then pending refusal conservative changed", result.changed, true); check("successful deep attempted fact", result.resourcePreflightAttempted, true); check("pending deep refused", result.ok, false);
}
{
  const fatal = Object.assign(new Error("owned group unknown"), { code: "HELPER_QUIESCENCE", exitCode: 125 });
  const mutations: string[] = [];
  const fixture = { runtime: { execCommand: resourceSnapshotFixture(keyword, ["main", "second"]), execInHelper: async (_service: string, args: string[]) => {
    if (args[0] === "agents") return { code: 0, stdout: '[{"id":"main"},{"id":"second"}]', stderr: "" };
    if (args[1] === "status") return { code: 0, stdout: JSON.stringify([{ agentId: "main", status }, { agentId: "second", status }]), stderr: "" };
    mutations.push(args.join(" ")); throw fatal;
  } } } as unknown as Context;
  const result = await consume(fixture, keyword, undefined, true, false);
  check("quiescence stops next agent index", mutations, ["memory index --agent main --force"]);
  check("remaining agent explicitly not attempted", result.outcomes[1], { agentId: "second", ok: false, state: "not-attempted", code: "QUIESCENCE" });
  const witnessCalls: string[] = [];
  const witnessCtx = { settings: { dataDir: "/managed" }, paths: { fromContainer: (p: string) => p.replace("/container", "/managed") }, runtime: { execCommand: async () => { witnessCalls.push("create"); return { code: 0, stdout: '{"dev":1,"ino":2}', stderr: "" }; }, execInHelper: async () => { witnessCalls.push("index"); throw fatal; } } } as unknown as Context;
  let failure: unknown; try { await witness(witnessCtx, "main", { workspaceDir: "/container/workspace" }, () => 50000, "fixed"); } catch (e) { failure = e; }
  check("witness uncertainty fatal typed", (failure as MemoryError).code, "QUIESCENCE"); check("uncertain writer cleanup and reindex deferred", witnessCalls, ["create", "index"]);
  const reserveTimers: (() => void)[] = []; const exitSentinel = {}; let reserveExit = 0;
  let reserveReceipt = "";
  const reserveProcess = { argv: ["node", "50", "fixed-nonce", "node", "child"], kill() {}, on() {}, stderr: { write(text: string) { reserveReceipt += text; } }, exitCode: 0, exit(n: number) { reserveExit = n; throw exitSentinel; } };
  runInNewContext(HELPER_TIMEOUT_SUPERVISOR, { require: () => ({ spawn: () => ({ pid: 42, on() {} }) }), setTimeout: (fn: () => void) => { reserveTimers.push(fn); return 1; }, clearTimeout() {}, process: reserveProcess });
  try { reserveTimers[1](); } catch (e) { if (e !== exitSentinel) throw e; }
  check("unconfirmed reserve framed outcome", reserveReceipt, '\nCFHELPER:fixed-nonce:{"kind":"uncertain","code":125}\n'); check("reserve wrapper status not child outcome", reserveExit, 0);
  const helper125 = new HelperContainer({ exec: async () => ({ code: 125, stdout: "", stderr: "" }) } as unknown as Transport, async () => { throw Error("compose"); }, async () => "owned");
  let helperError: unknown; try { await helper125.execInHelper("cli-helper", [], { timeoutMs: 50000 }); } catch (e) { helperError = e; }
  check("supervisor reserve125 stable fatal code", (helperError as { code: string }).code, "HELPER_QUIESCENCE");
}
{
  const local = declaredMemory(configure([], "embeddings", "local", "/outside/a.gguf", undefined, "/outside/a.gguf")); let writes = 0;
  const fixture = { settings: { dataDir: "/managed" }, paths: { toContainer: () => "/container/models" }, runtime: {
    execCommand: async (_service: string, _command: string, args: string[]) => {
      if (args[1] === RESOURCE_SNAPSHOT_SCRIPT) return resourceSnapshotFixture(local)(_service, _command, args);
      writes++; throw Error("must not hash");
    }, execInHelper: async (_s: string, a: string[]) => {
      if (a[0] === "agents") return { code: 0, stdout: '[{"id":"main"}]', stderr: "" };
      if (a.includes("--deep") || a[0] === "plugins" || a[1] === "index") { writes++; throw Error("must not initialize"); }
      return { code: 0, stdout: JSON.stringify([{ agentId: "main", status }]), stderr: "" };
    },
  } } as unknown as Context;
  let failure: unknown; try { await consume(fixture, local, "main", false, false, { spend: true, download: true }); } catch (e) { failure = e; }
  check("outside managed root rejected", (failure as MemoryError).code, "MODEL"); check("outside root no hash/deep/index", writes, 0);
}
{
  const indexed: string[] = [];
  const child125 = new HelperContainer({ exec: async (_c: string, a: string[]) => { const n = a.indexOf("-e"); return { code: 0, stdout: "", stderr: `\nCFHELPER:${a[n + 3]}:{"kind":"completed","code":125}\n` }; } } as unknown as Transport, async () => { throw Error("compose"); }, async () => "owned");
  const fixture = { runtime: { execCommand: resourceSnapshotFixture(keyword, ["main", "second"]), execInHelper: async (service: string, a: string[], options: { input?: string; allowFailure?: boolean; timeoutMs?: number }) => {
    if (a[0] === "agents") return { code: 0, stdout: '[{"id":"main"},{"id":"second"}]', stderr: "" };
    if (a[1] === "status") return { code: 0, stdout: JSON.stringify([{ agentId: "main", status }, { agentId: "second", status }]), stderr: "" };
    indexed.push(a[3]); return child125.execInHelper(service, a, options);
  } } } as unknown as Context;
  const result = await consume(fixture, keyword, undefined, true, false);
  check("ordinary child125 permits next-agent partial attempt", indexed, ["main", "second"]);
  checkTrue("ordinary child125 never quiescence", !JSON.stringify(result).includes("QUIESCENCE"));
}
{
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const emitted: string[] = [], argv: string[][] = []; let captured = false;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const h = new HelperContainer({ exec: async (_c: string, a: string[], options: ExecOptions) => {
      argv.push(a); captured = options.stream === false;
      const n = a.indexOf("-e"); return { code: 0, stdout: '{"original":true}\n', stderr: `original stderr\nCFHELPER:${a[n + 3]}:{"kind":"completed","code":0}\n` };
    } } as unknown as Transport, async () => { throw Error("compose"); }, async () => "owned");
    await withOutputSink((s) => emitted.push(s), () => h.execInHelper("cli-helper", [], { timeoutMs: 50000 }));
    check("supervised TTY never gets PTY", argv[0].slice(0, 4), ["exec", "-i", "owned", "node"]);
    check("supervised TTY transport captured", captured, true);
    check("stream forwarding preserves stdout/stderr no private frame", emitted, ['{"original":true}\n', "original stderr"]);
  } finally { if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor); else Reflect.deleteProperty(process.stdout, "isTTY"); }
}
for (const malformed of ["null", "[]", "not-json", '{"kind":"completed","code":999}', "wrong-nonce", "missing"]) {
  const leaked: string[] = [];
  const h = new HelperContainer({ exec: async (_c: string, a: string[]) => { const n = a.indexOf("-e"); return { code: 0, stdout: "child", stderr: malformed === "missing" ? "no receipt" : `\nCFHELPER:${malformed === "wrong-nonce" ? "incorrect" : a[n + 3]}:${malformed}\n` }; } } as unknown as Transport, async () => { throw Error("compose"); }, async () => "owned");
  let failure: unknown; await withOutputSink((s) => leaked.push(s), async () => { try { await h.execInHelper("cli-helper", [], { timeoutMs: 50000 }); } catch (e) { failure = e; } });
  check(`receipt ${malformed} stable uncertainty`, (failure as { code: string }).code, "HELPER_QUIESCENCE"); check("malformed receipt never forwarded", leaked, []);
}
{
  const rejected = new Error("PRIVATE_TRANSPORT");
  const h = new HelperContainer({ exec: async () => { throw rejected; } } as unknown as Transport, async () => { throw Error("compose"); }, async () => "owned");
  let failure: unknown; try { await h.execInHelper("cli-helper", [], { timeoutMs: 50000 }); } catch (e) { failure = e; }
  check("supervised transport rejection stable uncertainty", (failure as { code: string }).code, "HELPER_QUIESCENCE");
  failure = undefined;
  try { await h.execInHelper("cli-helper", []); } catch (e) { failure = e; }
  check("unsupervised rejection unchanged", failure, rejected);
}
for (const childCode of [124, 125]) {
  const callbacks: Record<string, (...a: unknown[]) => void> = {}; let receipt = "";
  runInNewContext(HELPER_TIMEOUT_SUPERVISOR, { require: () => ({ spawn: () => ({ pid: 42, on: (name: string, fn: (...a: unknown[]) => void) => { callbacks[name] = fn; } }) }), setTimeout: () => 1, clearTimeout() {}, process: { argv: ["node", "50", "known-nonce", "node", "child"], on() {}, kill: (_pid: number, signal: string | number) => { if (signal === 0) throw Object.assign(Error("gone"), { code: "ESRCH" }); }, stderr: { write: (s: string) => { receipt += s; } }, exitCode: 0 } });
  callbacks.close(childCode);
  check("VM ordinary child status framed completed", receipt, `\nCFHELPER:known-nonce:{"kind":"completed","code":${childCode}}\n`);
}
{
  const secret = "memory-captured-failure-secret-20261009";
  registerSecret(secret);
  for (const childCode of [124, 125]) {
    const captured: string[] = []; let nonce = "";
    const helper = new HelperContainer({ exec: async (_command: string, args: string[], options: ExecOptions) => {
      const at = args.indexOf("-e"); nonce = args[at + 3];
      if (options.stream !== false || options.allowFailure !== true) throw Error("supervised failure was not captured");
      return { code: 0, stdout: "stdout must not replace stderr diagnosis\n", stderr: `embedding prerequisite rejected\ncredential=${secret}\nCFHELPER:${nonce}:{"kind":"completed","code":${childCode}}\n` };
    } } as unknown as Transport, async () => { throw Error("unexpected compose"); }, async () => "owned");
    let failure: unknown;
    await withOutputSink((chunk) => captured.push(chunk), async () => {
      try { await helper.execInHelper("cli-helper", ["memory", "index", "--agent", "main", "--credential", secret], { input: "", timeoutMs: 50000 }); } catch (error) { failure = error; }
    });
    const diagnostic = failure as Error & { fullCommand?: string; exitCode?: number; timedOut?: boolean; code?: string };
    checkTrue(`captured child${childCode} rejects as Error`, failure instanceof Error);
    check(`captured child${childCode} ordinary exit cause`, diagnostic.exitCode, childCode);
    check(`captured child${childCode} not a timeout`, diagnostic.timedOut, undefined);
    check(`captured child${childCode} not group uncertainty`, diagnostic.code, undefined);
    checkTrue(`captured child${childCode} retains independent stderr`, diagnostic.message.includes("embedding prerequisite rejected") && diagnostic.message.includes("credential=***"));
    checkTrue(`captured child${childCode} masks message and argv`, !`${diagnostic.message}\n${diagnostic.fullCommand}`.includes(secret) && diagnostic.fullCommand?.includes("***") === true);
    checkTrue(`captured child${childCode} strips all receipt diagnostics`, !`${diagnostic.message}\n${diagnostic.fullCommand}`.includes("CFHELPER:") && !`${diagnostic.message}\n${diagnostic.fullCommand}`.includes(nonce));
    check(`captured child${childCode} no output/frame leakage`, captured, []);
  }
}
} finally { await deployment.dispose(); }
finish("memory");
