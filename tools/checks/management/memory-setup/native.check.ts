import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { installNativePlugin, readNativeSnapshot, requireNativeLoaded, nativeFailure, nativeAbsentOperation, NATIVE_PATH_CHECK_SCRIPT, NATIVE_ABSENCE_CHECK_SCRIPT, type NativeIO } from "#framework/commands/management/configuration/memory/native.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { runInNewContext } from "node:vm";
import { posix, join } from "node:path";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Independent fixtures from install-inspection.native.txt:84-89,385-395 and
// official-plugin-manifest.txt:8-9. These are source-evidenced shapes, not live receipts.
const root = "/home/node/.openclaw", version = "2026.6.34", name = "@openclaw/llama-cpp-provider";
function inspection() {
  return { plugin: { id: "llama-cpp", name: "llama.cpp Provider", status: "loaded", version,
    source: `${root}/npm/projects/provider/node_modules/@openclaw/llama-cpp-provider/dist/index.js` },
  install: { source: "npm", resolvedName: name, resolvedVersion: version, version, spec: `${name}@${version}`,
    installPath: `${root}/npm/projects/provider/node_modules/@openclaw/llama-cpp-provider`, integrity: "sha512-independent-fixture" } };
}
function result(value: unknown): ExecResult { return { code: 0, stdout: JSON.stringify(value), stderr: "" }; }
function fixture(rows: unknown = [inspection()], policy: unknown = {}) {
  const calls: string[][] = []; let current = rows;
  let absence: ExecResult = result({ absent: true });
  let install: ExecResult = { code: 0, stdout: "", stderr: "" };
  let helper = result({ platform: "linux", arch: "x64", nodeVersion: "v24.15.0", configRoot: root });
  const io: NativeIO = {
    async cli(args, _intent) {
      calls.push(args);
      if (args[0] === "--version") return { code: 0, stdout: "OpenClaw 2026.6.34\n", stderr: "" };
      if (args.includes("--help")) return { code: 0, stdout: "--all --json --pin", stderr: "" };
      if (args[0] === "config") return result(policy);
      if (args[1] === "inspect") return result(current);
      if (args[1] === "install") { if (install.code === 0) current = [inspection()]; return install; }
      throw Error("unexpected native CLI call");
    },
    async node(script, args, _intent) {
      calls.push([script === NATIVE_ABSENCE_CHECK_SCRIPT ? "absence" : "paths", ...args]);
      return script === NATIVE_ABSENCE_CHECK_SCRIPT ? absence : helper;
    },
  };
  return { io, calls, setAbsence: (r: ExecResult) => { absence = r; }, setInstall: (r: ExecResult) => { install = r; }, setHelper: (r: ExecResult) => { helper = r; } };
}
function mutations(calls: string[][]) { return calls.filter((a) => a[1] === "install" && !a.includes("--help") || a[1] === "enable"); }
async function rejected(action: () => Promise<unknown>) {
  try { await action(); return undefined; } catch (error) { return nativeFailure(error); }
}
{
  const f = fixture(), snapshot = await readNativeSnapshot(f.io, root);
  check("actual id accepted despite display name", requireNativeLoaded(snapshot).id, "llama-cpp");
  check("record version retained", snapshot.plugin?.version, version);
  check("exact already loaded installation repeatable", (await installNativePlugin(f.io, root, version, false)).changed, false);
  check("existing exact no mutations", mutations(f.calls), []);
}
for (const exact of ["1.2.3-rc-test", "1.2.3+build-test", "1.2.3-rc-test+build-test", "1.2.3-0", "1.2.3+001"]) {
  const row = inspection();
  row.plugin.version = exact; row.install.version = exact; row.install.resolvedVersion = exact; row.install.spec = `${name}@${exact}`;
  const f = fixture([row]);
  check(`exact prerelease/build approval accepted ${exact}`, (await installNativePlugin(f.io, root, exact, false)).snapshot.plugin?.version, exact);
  check("exact version no unnecessary install", mutations(f.calls), []);
}
for (const invalid of ["1.2.3-01", "01.2.3", "1.2.3-rc..test", "1.2.3+build..test", "1.2.3+", "latest", "^1.2.3", `1.2.3+${"a".repeat(128)}`]) {
  const f = fixture();
  checkTrue(`invalid exact approval refuses ${invalid}`, await rejected(() => installNativePlugin(f.io, root, invalid, true)) !== undefined);
  check("invalid exact approval zero helper contacts", f.calls, []);
}
for (const [label, change] of [
  ["display name is not package", (row: ReturnRow) => { row.install.resolvedName = "llama.cpp Provider"; }],
  ["wrong id", (row: ReturnRow) => { row.plugin.id = "other"; }],
  ["status version mismatch", (row: ReturnRow) => { row.plugin.version = "2026.6.33"; }],
  ["record version mismatch", (row: ReturnRow) => { row.install.version = "2026.6.33"; }],
  ["unknown source", (row: ReturnRow) => { row.install.source = "unknown"; }],
  ["outside install path", (row: ReturnRow) => { row.install.installPath = "/tmp/plugin"; }],
  ["shadowed source", (row: ReturnRow) => { row.plugin.source = `${root}/different/index.js`; }],
  ["control metadata", (row: ReturnRow) => { row.install.integrity = "private\nraw"; }],
] as const) {
  const row = inspection(); change(row); const f = fixture([row]);
  checkTrue(label, await rejected(() => installNativePlugin(f.io, root, version, true)) !== undefined);
  check(`${label} no mutation`, mutations(f.calls), []);
}
interface ReturnRow {
  plugin: { id: string; name: string; status: string; version: string; source: string };
  install: { source: string; resolvedName: string; resolvedVersion: string; version: string; spec: string; installPath: string; integrity: string };
}
for (const rows of [{ plugins: [inspection()] }, [inspection(), inspection()], [{ plugin: { id: "llama-cpp" } }], [null]]) {
  const f = fixture(rows);
  checkTrue("unsupported/collision inventory refused", await rejected(() => installNativePlugin(f.io, root, version, true)) !== undefined);
  check("unsupported inventory no mutations", mutations(f.calls), []);
}
{
  const row: { plugin: ReturnRow["plugin"]; install: Partial<ReturnRow["install"]> } = inspection();
  delete row.install.resolvedVersion;
  check("exact spec/version fallback", (await readNativeSnapshot(fixture([row]).io, root)).plugin?.version, version);
  row.install.spec = `${name}@latest`;
  checkTrue("missing resolved version nonexact spec refused", await rejected(() => readNativeSnapshot(fixture([row]).io, root)) !== undefined);
}
for (const policy of [{ deny: ["llama-cpp"] }, { enabled: false }, { entries: { "llama-cpp": { enabled: false } } }]) {
  for (const rows of [[], [inspection()]]) {
    const f = fixture(rows, policy);
    checkTrue("explicit deny/disable refuses even approval", await rejected(() => installNativePlugin(f.io, root, version, true)) !== undefined);
    check("explicit policy never overridden", mutations(f.calls), []);
  }
}
for (const status of ["disabled", "error", "pending"]) {
  const row = inspection(); row.plugin.status = status; const f = fixture([row]);
  checkTrue("existing not-ready no install repair", await rejected(() => installNativePlugin(f.io, root, version, true)) !== undefined);
  check("existing not-ready no enable", mutations(f.calls), []);
}
{
  const f = fixture([inspection()]);
  checkTrue("different approved version refuses", await rejected(() => installNativePlugin(f.io, root, "2026.6.35", true)) !== undefined);
  check("different approved no overwrite", mutations(f.calls), []);
}
{
  const f = fixture([]);
  checkTrue("missing no approval refuses", await rejected(() => installNativePlugin(f.io, root, version, false)) !== undefined);
  check("missing no approval no mutation", mutations(f.calls), []);
  const installed = await installNativePlugin(f.io, root, version, true);
  check("approved install reports changed", installed.changed, true);
  check("exact pin without force", mutations(f.calls), [["plugins", "install", `${name}@${version}`, "--pin"]]);
  checkTrue("absence precedes mutation", f.calls.findIndex((a) => a[0] === "absence") < f.calls.findIndex((a) => a[1] === "install" && !a.includes("--help")));
}
for (const absence of [result({ absent: false }), { code: 2, stdout: "PRIVATE_RECORD", stderr: "PRIVATE_SQLITE" }]) {
  const f = fixture([]); f.setAbsence(absence);
  const failure = await rejected(() => installNativePlugin(f.io, root, version, true));
  checkTrue("orphan/unreadable records refuse", failure !== undefined);
  check("absence failure no mutation", mutations(f.calls), []);
  checkTrue("safe failure excludes records", !JSON.stringify(failure).includes("PRIVATE_"));
  check("failed absence persistence attempt retained", failure?.nativePersistenceAttempted, true);
  check("failed absence not a plugin install attempt", failure?.mutationAttempted, false);
}
{
  const f = fixture([]); f.setInstall({ code: 1, stdout: "PRIVATE_DTO", stderr: "incompatible plugin API PRIVATE_AUTH" });
  const failure = await rejected(() => installNativePlugin(f.io, root, version, true));
  check("native compatibility failure attempted truth", failure?.mutationAttempted, true);
  check("native compatibility exit retained", failure?.exitCode, 1);
  checkTrue("native failure no raw diagnostics", !JSON.stringify(failure).includes("PRIVATE_"));
  check("native failure no retry/force/rollback", mutations(f.calls).length, 1);
}
{
  const f = fixture([inspection()], { allow: ["other"] });
  checkTrue("restrictive allow existing loaded not repaired", await rejected(() => installNativePlugin(f.io, root, version, true)) !== undefined);
  check("restrictive allow existing no mutations", mutations(f.calls), []);
}
{
  const f = fixture([]), original = f.io.cli;
  f.io.cli = async (args, intent) => args.includes("--help") ? { code: 0, stdout: "unsupported flags", stderr: "" } : original(args, intent);
  checkTrue("unsupported inspect capabilities refuse", await rejected(() => installNativePlugin(f.io, root, version, true)) !== undefined);
  check("unsupported capabilities no mutation", mutations(f.calls), []);
}
{
  const f = fixture([]), original = f.io.cli;
  f.io.cli = async (args, intent) => args[1] === "install" && args.includes("--help") ? { code: 0, stdout: "no pin capability", stderr: "" } : original(args, intent);
  checkTrue("unsupported pin capability refuses", await rejected(() => installNativePlugin(f.io, root, version, true)) !== undefined);
  check("unsupported pin no mutation", mutations(f.calls), []);
}
{
  const f = fixture([]); f.setInstall({ code: 0, timedOut: true, stdout: "PRIVATE_DTO", stderr: "PRIVATE_TIMEOUT" });
  const failure = await rejected(() => installNativePlugin(f.io, root, version, true));
  check("native install timeout retained", failure?.timedOut, true);
  check("timeout remains mutation attempted", failure?.mutationAttempted, true);
  check("timeout no second install", mutations(f.calls).length, 1);
}
for (const platform of ["win32", "darwin"]) {
  const f = fixture(); f.setHelper(result({ platform, configRoot: root, nodeVersion: "v24.15.0", arch: "x64" }));
  checkTrue("unsupported helper platform refuses", await rejected(() => readNativeSnapshot(f.io, root)) !== undefined);
}
// Execute the actual path probe in VM with independent filesystem/mount facts;
// only OS boundaries substituted. No native DTO/parser logic mocked.
function probe(platform = "linux", realRoot = root, nested = false, config = root) {
  const row = inspection(), source = row.plugin.source, install = row.install.installPath;
  let exit = 0, output = ""; const sentinel = {};
  const fs = { realpathSync: (p: string) => p === root ? realRoot : p,
    statSync: () => ({ isDirectory: () => true }),
    readFileSync: () => `1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / ${root} rw - ext4 /dev/fixture rw${nested ? `\n3 2 0:3 / ${install} rw - tmpfs tmpfs rw` : ""}` };
  try { runInNewContext(NATIVE_PATH_CHECK_SCRIPT, { require: (id: string) => id === "node:fs" ? fs : posix,
    console: { log: (text: string) => { output = text; } }, process: { argv: ["node", root, install, source], platform, arch: "x64", version: "v24.15.0",
      env: { OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_DIR: config, OPENCLAW_CONFIG_PATH: `${root}/openclaw.json` },
      exit: (code: number) => { exit = code; throw sentinel; } } }); } catch (error) { if (error !== sentinel) throw error; }
  return { exit, output };
}
check("actual probe canonical persistent mount", probe().exit, 0);
check("actual probe root symlink refusal", probe("linux", "/different").exit, 2);
check("actual probe nested ephemeral mount refusal", probe("linux", root, true).exit, 2);
check("actual probe environment mismatch refusal", probe("linux", root, false, "/tmp/config").exit, 2);
check("actual probe platform refusal", probe("win32").exit, 2);
// Same operation serialized into the helper script; real directory discovery and
// store filesystem boundaries, with only the native record-reader exports substituted.
{
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "native-absence-")));
  try {
    const state = join(scratch, "state");
    const dist = join(scratch, "dist");
    const store = join(state, "fixture.sqlite");
    await mkdir(state); await mkdir(dist);
    const reader = join(dist, "installed-plugin-index-record-reader-fixture.js");
    await writeFile(reader, "export {};\n");
    let persisted: unknown = {}, recovered: unknown = {}, reads = 0;
    let exports: Record<string, unknown> = {
      o: (options: { stateDir: string }) => { check("actual operation passes persistent state", options.stateDir, state); return store; },
      r: async () => { reads++; return persisted; }, t: async () => recovered,
    };
    const absenceFs = { readdirSync: fs.readdirSync, lstatSync: fs.lstatSync, realpathSync: fs.realpathSync, readFileSync: fs.readFileSync };
    const dependencies = { fs: absenceFs, path, fileURL: (p: string) => pathToFileURL(p).href,
      load: async (url: string) => { check("actual operation discovers exact native module", url, pathToFileURL(reader).href); return exports; } };
    const run = () => nativeAbsentOperation(state, "llama-cpp", name, scratch, dependencies);
    check("real filesystem absent store recovered empty", await run(), { absent: true });
    check("absent store never opens persistence", reads, 0);
    await writeFile(store, "not a database; native reader boundary substituted");
    check("existing store checked through native reader", await run(), { absent: true });
    check("existing store persistence read", reads, 1);
    const npm = join(state, "npm");
    const project = join(npm, "projects", "fixture");
    await mkdir(project, { recursive: true });
    const manifest = join(project, "package.json");
    await writeFile(manifest, "invalid-json");
    checkTrue("actual malformed project manifest refuses empty loader", await rejected(run) !== undefined);
    await writeFile(manifest, JSON.stringify({ dependencies: { [name]: version } }));
    checkTrue("actual residual official dependency refuses empty loader", await rejected(run) !== undefined);
    await writeFile(manifest, "{}");
    const residual = join(project, "node_modules", "@openclaw", "llama-cpp-provider");
    await mkdir(residual, { recursive: true });
    checkTrue("actual residual official package bytes refuse empty loader", await rejected(run) !== undefined);
    await rm(residual, { recursive: true });
    check("unrelated readable project permits absence", await run(), { absent: true });
    const deniedFS = { ...absenceFs, lstatSync: ((file: fs.PathLike) => {
      if (file === store) throw Object.assign(Error("unreadable"), { code: "EACCES" });
      return fs.lstatSync(file);
    }) as typeof fs.lstatSync };
    checkTrue("actual EACCES store never treated absent", await rejected(() => nativeAbsentOperation(state, "llama-cpp", name, scratch, { ...dependencies, fs: deniedFS })) !== undefined);
    for (const records of [null, [], { "llama-cpp": { source: "npm" } }, { other: { source: "npm", resolvedName: name } },
      { other: { source: "npm", spec: `${name}@${version}` } }, { other: { source: "unknown" } },
      { first: { source: "path", installPath: store }, second: { source: "path", installPath: store } }]) {
      persisted = records; recovered = {};
      checkTrue("actual persisted unknown/orphan/collision refuses", await rejected(run) !== undefined);
      persisted = {}; recovered = records;
      checkTrue("actual recovered unknown/orphan/collision refuses", await rejected(run) !== undefined);
    }
    persisted = {}; recovered = {};
    const outsideStore = join(scratch, "outside.sqlite");
    exports = { ...exports, o: () => outsideStore };
    checkTrue("actual store outside state refuses", await rejected(run) !== undefined);
    exports = { o: () => store, r: async () => ({}), t: async () => ({}) };
    // VM executes precisely the function serialized by NATIVE_ABSENCE_CHECK_SCRIPT.
    const vmOperation = runInNewContext(`(${nativeAbsentOperation.toString()})`);
    const vmFacts = await vmOperation(state, "llama-cpp", name, scratch, dependencies);
    check("actual serialized operation VM absence", JSON.parse(JSON.stringify(vmFacts)), { absent: true });
    const secondReader = join(dist, "installed-plugin-index-record-reader-second.js");
    await writeFile(secondReader, "export {};\n");
    checkTrue("actual ambiguous reader refuses", await rejected(run) !== undefined);
    await rm(secondReader);
    exports = {};
    checkTrue("actual unsupported exports refuse", await rejected(run) !== undefined);
    // Default import path exercised against an actual local ESM module, not a fake
    // absence result. No native database is opened by this authored fixture module.
    const packageManifest = join(scratch, "package.json");
    await writeFile(packageManifest, '{"type":"module"}\n');
    await writeFile(reader, `export const o=()=>${JSON.stringify(store)};export const r=async()=>({});export const t=async()=>({});\n`);
    check("actual local dynamic import and record operation", await nativeAbsentOperation(state, "llama-cpp", name, scratch,
      { fs: absenceFs, path, fileURL: (p: string) => pathToFileURL(p).href }), { absent: true });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
finish("memory-setup/native");
