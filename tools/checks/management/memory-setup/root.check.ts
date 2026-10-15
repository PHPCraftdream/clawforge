import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, basename, dirname, parse, sep, isAbsolute, normalize } from "node:path";
import { runInNewContext } from "node:vm";
import { modelRootOperation, type RootRequest, type RootFacts } from "#framework/commands/management/configuration/memory/setup/root.ts";
import { finish, typeAssert } from "#checks/kit/harness.ts";

const temporary = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "clawwright-root-check-")));
const config = join(temporary, "config");
const models = join(config, "models");
const savedModels = join(config, "models.saved");
fs.mkdirSync(config, { mode: 0o700 });
let uid = 1000n, mounts = config, shadow = "", mkdirs = 0;
const metadata = (s: fs.BigIntStats) => new Proxy(s, { get(target, key) {
  if (key === "uid") return uid;
  if (key === "mode") return target.mode & ~0o077n;
  const value: unknown = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
} });
const temporaryIdentity = fs.lstatSync(temporary, { bigint: true });
const checkParent = () => {
  const allocation = fs.lstatSync(temporary, { bigint: true });
  assert.ok(allocation.isDirectory() && !allocation.isSymbolicLink());
  assert.equal(allocation.dev, temporaryIdentity.dev); assert.equal(allocation.ino, temporaryIdentity.ino);
  assert.equal(fs.realpathSync(temporary), temporary);
};
const relativeInAllocation = (file: string) => {
  const name = relative(temporary, file);
  assert.ok(!isAbsolute(name) && name !== ".." && !name.startsWith(".." + sep));
  assert.equal(join(temporary, name), file);
  checkParent();
  return name;
};
const confinedTarget = (file: string, depth = 0): string => {
  assert.ok(depth < 40);
  checkParent();
  if (file === temporary) return fs.realpathSync.native(file);
  assert.ok(file.startsWith(temporary + sep));
  const parent = confinedTarget(dirname(file), depth + 1);
  const leaf = basename(file);
  const candidate = parent + sep + leaf;
  let actual: string;
  try { actual = fs.realpathSync.native(candidate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let target: string | undefined;
    try { if (fs.lstatSync(candidate).isSymbolicLink()) target = fs.readlinkSync(candidate); }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
    if (target !== undefined) return confinedTarget(isAbsolute(target) ? target : parent + sep + target, depth + 1);
    actual = leaf === "." ? parent : leaf === ".." ? dirname(parent) : candidate;
  }
  const name = relative(temporary, actual);
  assert.ok(!isAbsolute(name) && name !== ".." && !name.startsWith(".." + sep));
  return actual;
};
const readablePath = (file: string) => {
  if (file !== temporary && temporary.startsWith(file.endsWith(sep) ? file : file + sep)) return file;
  relativeInAllocation(file);
  if (file !== temporary) confinedTarget(dirname(file));
  return file;
};
const fixtureFs = Object.freeze({
  lstatSync: (file: string, options?: { bigint: true }) => options?.bigint ? metadata(fs.lstatSync(readablePath(file), options)) : fs.lstatSync(readablePath(file)),
  realpathSync: (file: string) => { readablePath(file); confinedTarget(file); return fs.realpathSync(file); },
  readFileSync: (file: string, encoding: "utf8") => {
    assert.equal(file, "/proc/self/mountinfo"); assert.equal(encoding, "utf8");
    return [mounts, ...(shadow ? [shadow] : [])].map((mount) => `1 0 0:1 / ${mount.replaceAll("\\", "\\134").replaceAll(" ", "\\040")} rw - fixture fixture rw\n`).join("");
  },
  mkdirSync: (file: string, options: fs.MakeDirectoryOptions) => {
    mkdirs++;
    const name = relativeInAllocation(file);
    if (file !== temporary) confinedTarget(dirname(file));
    if (options.recursive) confinedTarget(file);
    fs.mkdirSync(join(temporary, name), options);
  },
});
const load = ((name: string) => {
  switch (name) {
    case "node:fs": return fixtureFs;
    case "node:path": return Object.freeze({ join, parse, sep, isAbsolute, normalize });
    default: throw new Error(`fixture module refused: ${name}`);
  }
}) as NodeRequire;
const processFixture = { platform: "linux", getuid: () => 1000, env: { OPENCLAW_STATE_DIR: config, OPENCLAW_CONFIG_DIR: config, OPENCLAW_CONFIG_PATH: join(config, "openclaw.json") } };
const run = (input: RootRequest): RootFacts => runInNewContext(`(${modelRootOperation.toString()})(input,load)`, {
  input, process: processFixture, load,
}, { timeout: 1000 }) as RootFacts;
try {
  const missing = run({ operation: "inspect", configRoot: config });
  assert.equal(missing.code, "ROOT_MISSING"); assert.equal(mkdirs, 0); assert.equal(fs.existsSync(models), false); assert.ok(missing.config);
  assert.equal(run({ operation: "create", configRoot: config }).code, "ROOT_IDENTITY"); assert.equal(mkdirs, 0);
  const created = run({ operation: "create", configRoot: config, expected: missing.config });
  assert.equal(created.code, "ROOT_CREATED"); assert.equal(created.created, true); assert.equal(mkdirs, 1); assert.ok(created.models);
  const original = fs.lstatSync(models, { bigint: true });
  const inspected = run({ operation: "inspect", configRoot: config, expected: missing.config, expectedModels: created.models });
  assert.equal(inspected.code, "ROOT_PRESENT"); assert.equal(inspected.changed, false); assert.equal(mkdirs, 1);
  assert.equal(String(original.ino), inspected.models?.ino);
  fs.renameSync(models, savedModels); fs.mkdirSync(models, { mode: 0o700 });
  assert.equal(run({ operation: "inspect", configRoot: config, expectedModels: created.models }).code, "ROOT_IDENTITY");
  fs.rmdirSync(models); fs.renameSync(savedModels, models);
  shadow = models;
  assert.equal(run({ operation: "inspect", configRoot: config }).code, "ROOT_BOUNDARY");
  assert.equal(mkdirs, 1); shadow = "";
  assert.equal(run({ operation: "inspect", configRoot: config }).code, "ROOT_PRESENT");
  uid = 0n;
  assert.equal(run({ operation: "inspect", configRoot: config }).code, "ROOT_BOUNDARY"); uid = 1000n;
  mounts = dirname(config);
  assert.equal(run({ operation: "inspect", configRoot: config }).code, "ROOT_BOUNDARY"); mounts = config;
  processFixture.env.OPENCLAW_CONFIG_PATH = join(temporary, "wrong.json");
  assert.equal(run({ operation: "inspect", configRoot: config }).code, "ROOT_BOUNDARY");
  processFixture.env.OPENCLAW_CONFIG_PATH = join(config, "openclaw.json");
  fs.renameSync(models, savedModels);
  fs.writeFileSync(models, "private-file", { mode: 0o600 });
  assert.equal(run({ operation: "create", configRoot: config, expected: missing.config }).code, "ROOT_IDENTITY");
  assert.equal(fs.readFileSync(models, "utf8"), "private-file"); assert.equal(mkdirs, 1);
  typeAssert("actual root primitive VM preserves read-only inspection and rejects replaced roots, ownership and mount mismatch");
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
finish("memory setup root");
