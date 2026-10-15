import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, dirname, parse, sep, isAbsolute } from "node:path";
import { approveModel, MAX_MODEL_BYTES, MODEL_REDIRECT_HOSTS } from "#framework/commands/management/configuration/memory/setup/approval.ts";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { modelOperation, MODEL_SETUP_SCRIPT, type ModelFacts, type ModelNetwork, type ModelRequest, type ModelReceipt } from "#framework/commands/management/configuration/memory/setup/model.ts";
import { finish, requires, typeAssert } from "#checks/kit/harness.ts";

const bytes = Buffer.from("GGUFfixture-model-bytes");
const checksum = createHash("sha256").update(bytes).digest("hex");
const commit = "a".repeat(40);
const approval = { source: `https://huggingface.co/review/model/resolve/${commit}/model.gguf`, modelVersion: commit, checksum, pluginVersion: "1.2.3", maxBytes: 128 };
assert.ok(Object.isFrozen(approveModel(approval)));
for (const patch of [
  { source: approval.source + "?token=x" }, { source: approval.source + "#fragment" },
  { source: approval.source.replace("huggingface.co", "user:secret@huggingface.co") },
  { source: approval.source.replace("huggingface.co", "huggingface.co:444") },
  { source: approval.source.replace("https:", "http:") },
  { source: approval.source.replace(commit, "main") }, { source: approval.source.replace(commit, commit.toUpperCase()) },
  { source: approval.source.replace("huggingface.co", "cdn-lfs.hf.co") },
  { source: approval.source.replace("model.gguf", "nested/model.gguf") }, { source: approval.source + "\n" },
  { modelVersion: "b".repeat(40) }, { checksum: checksum.toUpperCase() }, { checksum: checksum + "\n" },
  { pluginVersion: "latest" }, { pluginVersion: "^1.2.3" }, { pluginVersion: "01.2.3" },
  { pluginVersion: "1.2.3-01" }, { pluginVersion: "1.2.3\n" },
  { maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: 1.5 }, { maxBytes: MAX_MODEL_BYTES + 1 }, { maxBytes: Infinity },
]) assert.throws(() => approveModel({ ...approval, ...patch }), /MODEL_APPROVAL/);
assert.equal(approveModel({ ...approval, pluginVersion: "1.2.3-rc.1+build.9" }).pluginVersion, "1.2.3-rc.1+build.9");
typeAssert("model approval rejects mutable, credentialed and unbounded inputs");

const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "clawwright-model-check-")));
fs.chmodSync(root, 0o700);
const rootIdentity = fs.lstatSync(root, { bigint: true });
const basenameInRoot = (p: string): string => {
  const name = relative(root, p);
  assert.ok(!isAbsolute(name) && name !== ".." && !name.startsWith(".." + sep));
  assert.equal(join(root, name), p);
  const current = fs.lstatSync(root, { bigint: true });
  assert.ok(current.isDirectory() && !current.isSymbolicLink());
  assert.equal(current.dev, rootIdentity.dev); assert.equal(current.ino, rootIdentity.ino);
  assert.equal(fs.realpathSync(root), root);
  assert.equal(fs.realpathSync(dirname(join(root, name))), root);
  return name;
};
interface ChildInput {
  input: ModelRequest; root: string; port: number; addresses: { address: string; family: number }[];
  refuseUnlink: boolean; primitive: string; validate: string; script: string; hosts: readonly string[];
  mode: "primitive" | "script" | "stalled"; uid: number; confirmClose?: boolean; stalled?: string;
}
interface ChildMessage {
  kind: string; id?: number; delay?: number; receipt?: ModelReceipt; facts?: ModelFacts;
  output?: string; exitCode?: number; error?: string;
}
function childProgram() {
  const assert: typeof import("node:assert/strict") = require("node:assert/strict");
  const fs: typeof import("node:fs") = require("node:fs");
  const path: typeof import("node:path") = require("node:path");
  const { runInNewContext }: typeof import("node:vm") = require("node:vm");
  const { EventEmitter }: typeof import("node:events") = require("node:events");
  const { request: httpRequest }: typeof import("node:http") = require("node:http");
  const crypto: typeof import("node:crypto") = require("node:crypto");
  const net: typeof import("node:net") = require("node:net");
  const send = (message: ChildMessage) => process.send!(message);
  let sequence = 0;
  const acknowledgments = new Map<number, () => void>();
  const acknowledged = (kind: string, receipt?: ModelReceipt) => new Promise<void>(resolve => {
    const id = ++sequence; acknowledgments.set(id, resolve); send({ kind, id, receipt });
  });
  let clock = 0;
  const timers = new Map<number, { callback: () => void; active: boolean }>();
  process.on("message", (message: { kind: string; id: number; now: number }) => {
    if (message.kind === "ack") { acknowledgments.get(message.id)?.(); acknowledgments.delete(message.id); }
    if (message.kind === "fire") {
      clock = message.now;
      const timer = timers.get(message.id);
      if (timer?.active) { timer.active = false; timer.callback(); }
    }
  });
  process.once("message", async (spec: ChildInput) => {
    try {
      const allocation = fs.realpathSync.native(spec.root), identity = fs.lstatSync(allocation, { bigint: true });
      const relativeTarget = (p: string) => {
        const name = path.relative(allocation, p);
        assert.ok(!path.isAbsolute(name) && name !== ".." && !name.startsWith(".." + path.sep));
        assert.equal(path.join(allocation, name), p);
        const current = fs.lstatSync(allocation, { bigint: true });
        assert.ok(current.isDirectory() && !current.isSymbolicLink());
        assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
        assert.equal(fs.realpathSync(allocation), allocation);
        return name;
      };
      const follow = (p: string, depth = 0): string => {
        assert.ok(depth < 40);
        relativeTarget(allocation);
        if (p === allocation) return fs.realpathSync.native(p);
        assert.ok(p.startsWith(allocation + path.sep));
        const parent = follow(path.dirname(p), depth + 1);
        const leaf = path.basename(p);
        const candidate = parent + path.sep + leaf;
        let actual: string;
        try { actual = fs.realpathSync.native(candidate); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          let target: string | undefined;
          try { if (fs.lstatSync(candidate).isSymbolicLink()) target = fs.readlinkSync(candidate); }
          catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
          if (target !== undefined) return follow(path.isAbsolute(target) ? target : parent + path.sep + target, depth + 1);
          actual = leaf === "." ? parent : leaf === ".." ? path.dirname(parent) : candidate;
        }
        const name = path.relative(allocation, actual);
        assert.ok(!path.isAbsolute(name) && name !== ".." && !name.startsWith(".." + path.sep));
        return actual;
      };
      const readable = (p: string) => {
        if (p !== allocation && allocation.startsWith(p.endsWith(path.sep) ? p : p + path.sep)) return p;
        relativeTarget(p); if (p !== allocation) follow(path.dirname(p)); return p;
      };
      const stats = (s: fs.BigIntStats) => new Proxy(s, { get(target, property) {
        if (property === "uid") return 1000n;
        if (property === "mode") return target.mode & ~0o077n;
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const leases = new Set<number>();
      const leased = (fd: number) => { assert.ok(leases.has(fd)); return fd; };
      const fixtureFs = Object.freeze({
        constants: fs.constants,
        lstatSync: (p: string, options?: { bigint: true }) => options?.bigint ? stats(fs.lstatSync(readable(p), options)) : fs.lstatSync(readable(p)),
        realpathSync: (p: string) => { readable(p); follow(p); return fs.realpathSync(p); },
        fstatSync: (fd: number, options: { bigint: true }) => stats(fs.fstatSync(leased(fd), options)),
        openSync: (p: string, flags: number, mode?: number) => {
          const name = relativeTarget(p);
          if (p !== allocation) follow(path.dirname(p));
          if (!(flags & fs.constants.O_NOFOLLOW)) follow(p);
          const fd = fs.openSync(path.join(allocation, name), flags, mode); leases.add(fd); return fd;
        },
        readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => fs.readSync(leased(fd), buffer, offset, length, position),
        readFileSync: (fd: number, encoding: "utf8") => fs.readFileSync(leased(fd), encoding),
        writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => fs.writeSync(leased(fd), buffer, offset, length),
        writeFileSync: (fd: number, data: string) => fs.writeFileSync(leased(fd), data),
        // Node >= 24.20 refuses fsync under the Permission Model; the request itself is what is asserted.
        fsyncSync: (fd: number) => { try { fs.fsyncSync(leased(fd)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED") throw error; } },
        closeSync: (fd: number) => { fs.closeSync(leased(fd)); leases.delete(fd); },
        linkSync: (source: string, destination: string) => {
          const from = relativeTarget(source), to = relativeTarget(destination);
          follow(path.dirname(source)); follow(path.dirname(destination));
          fs.linkSync(path.join(allocation, from), path.join(allocation, to));
        },
        unlinkSync: (p: string) => {
          const name = relativeTarget(p); follow(path.dirname(p));
          if (spec.refuseUnlink) throw new Error("fixture cleanup refusal");
          fs.unlinkSync(path.join(allocation, name));
        },
      });
      let reportReady = Promise.resolve();
      const network = {
        lookup: async () => { await reportReady; return spec.addresses; },
        request: (options: import("node:https").RequestOptions) => {
          send({ kind: "request" });
          assert.equal(options.protocol, "https:"); assert.equal(options.port, 443);
          assert.equal(options.servername, options.hostname); assert.equal(options.rejectUnauthorized, true);
          assert.equal(options.agent, false); assert.equal(options.auth, undefined);
          assert.deepEqual(JSON.parse(JSON.stringify(options.headers)), { Accept: "application/octet-stream", "Accept-Encoding": "identity" });
          assert.ok(spec.hosts.includes(String(options.hostname)));
          const lookup = options.lookup as (host: string, options: object, cb: (error: unknown, address: string, family: number) => void) => void;
          lookup(String(options.hostname), {}, (error, address, family) => {
            assert.equal(error, null); assert.equal(address, spec.addresses[0].address); assert.equal(family, spec.addresses[0].family);
          });
          const native = httpRequest({ hostname: "127.0.0.1", port: spec.port, path: "/fixture", method: "GET", headers: options.headers, agent: false });
          const proxy = new EventEmitter();
          let responseReady = Promise.resolve();
          Object.defineProperty(proxy, "closed", { get: () => native.closed });
          Object.assign(proxy, { end: () => native.end(), destroy: (error?: Error) => native.destroy(error) });
          native.on("error", error => proxy.emit("error", error));
          native.on("close", () => { void responseReady.then(() => proxy.emit("close")); });
          native.on("response", res => {
            res.pause();
            responseReady = acknowledged("response").then(() => { proxy.emit("response", res); });
          });
          return proxy;
        },
      };
      const load = ((name: string) => {
        switch (name) {
          case "node:fs": return fixtureFs;
          case "node:path": return { join: path.join, parse: path.parse, sep: path.sep, isAbsolute: path.isAbsolute, normalize: path.normalize };
          case "node:crypto": return { createHash: crypto.createHash };
          case "node:net": return { BlockList: net.BlockList, isIP: net.isIP };
          case "node:dns/promises": return { lookup: network.lookup };
          case "node:https": return { request: network.request };
          default: throw new Error(`fixture module refused: ${name}`);
        }
      }) as NodeRequire;
      let output = "";
      const vmProcess = { argv: ["node", JSON.stringify(spec.input)], getuid: () => spec.uid, exitCode: 0,
        stdout: { write: (text: string) => {
          output += text;
          const row = JSON.parse(text) as { kind: string; receipt?: ModelReceipt };
          if (row.kind === "model-staging") reportReady = acknowledged("report", row.receipt);
        } } };
      const context = { load, require: load, input: spec.input, hosts: spec.hosts,
        report: (receipt: ModelReceipt) => { reportReady = acknowledged("report", receipt); },
        platform: { getuid: () => spec.uid }, process: vmProcess, Buffer, URL, setTimeout, clearTimeout };
      let facts: ModelFacts | undefined;
      // 10 s is a runaway-loop guard for the in-VM script, not a speed bound: a loaded host must not fail it.
      if (spec.mode === "script") await runInNewContext(spec.script, context, { timeout: 10_000 });
      else {
        let io: unknown = network;
        if (spec.mode === "stalled") {
          io = runInNewContext(`(${spec.stalled})(confirmClose,notifyAwait,lookup,addresses)`, {
            lookup: async () => { await reportReady; return spec.addresses; }, addresses: spec.addresses,
            EventEmitter, confirmClose: spec.confirmClose,
            notifyAwait: () => queueMicrotask(() => send({ kind: "await" })),
          });
          Object.assign(context, {
            Date: { now: () => clock },
            setTimeout: (callback: () => void, delay: number) => {
              const id = ++sequence; timers.set(id, { callback, active: true }); send({ kind: "timer", id, delay }); return id;
            },
            clearTimeout: (id: number) => { const timer = timers.get(id); if (timer) timer.active = false; send({ kind: "clear", id }); },
          });
        }
        facts = await runInNewContext(`const validate=(${spec.validate});(${spec.primitive})(input,validate,hosts,load,network,report,platform)`, { ...context, network: io }, { timeout: 10_000 }) as ModelFacts;
      }
      await reportReady;
      send({ kind: "result", facts, output, exitCode: vmProcess.exitCode });
      process.disconnect!();
    } catch (error) { send({ kind: "failure", error: String(error) }); process.disconnect!(); process.exitCode = 1; }
  });
}
let refuseUnlink = false;
let body = bytes, location: string | undefined, redirects = 0, calls = 0;
let beforeResponse: (() => void) | undefined;
let addresses = [{ address: "8.8.8.8", family: 4 }];
const server = createServer((req, res) => {
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers.cookie, undefined);
  if (redirects > 0) {
    redirects--;
    res.writeHead(302, { Location: location ?? "https://cdn-lfs.hf.co/model.gguf" }); res.end(); return;
  }
  res.writeHead(200, { "Content-Type": "application/octet-stream" });
  res.write(body.subarray(0, 2)); res.write(body.subarray(2, 7)); res.end(body.subarray(7));
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const bound = server.address();
assert.ok(bound && typeof bound !== "string");
const port = bound.port;
const ownedChildren = new Set<{ cancel: (reason: unknown) => void; reaped: Promise<void> }>();
const reapChildren = async () => {
  const owned = [...ownedChildren];
  for (const child of owned) child.cancel(new Error("model fixture cancellation"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(owned.map(child => child.reaped)), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("model child reaping deadline; allocation retained")), 10000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
};
const executeChild = (input: ModelRequest, report: (receipt: ModelReceipt) => void = () => {},
  mode: ChildInput["mode"] = "primitive", uid = 1000,
  onMessage: (message: ChildMessage, send: (message: { kind: string; id: number; now: number }) => void) => void = () => {},
  confirmClose?: boolean, stalledSource?: string) => new Promise<ChildMessage>((resolveResult, reject) => {
  const child = spawn(process.execPath, ["--permission", `--allow-fs-write=${root}`, `--allow-fs-read=${parse(root).root}`,
    "--eval", `(${childProgram.toString()})()`], {
    cwd: root, env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let result: ChildMessage | undefined, failure: unknown, stderr = "", closed = false, terminationRequested = false;
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  let markReaped!: () => void;
  const reaped = new Promise<void>(resolve => { markReaped = resolve; });
  const cancel = (reason: unknown) => {
    if (closed || terminationRequested) return;
    terminationRequested = true;
    failure = reason;
    cancellationTimer = setTimeout(() => reject(failure), 10000);
    try { child.kill("SIGKILL"); }
    catch (error) { failure = new AggregateError([reason, error], "model child termination failed", { cause: reason }); }
  };
  const owner = { cancel, reaped }; ownedChildren.add(owner);
  const safetyTimer = setTimeout(() => cancel(new Error("model child real wall-clock safety deadline")), 60000);
  const send = (message: unknown) => {
    if (closed || failure) return;
    try { child.send(message as Parameters<typeof child.send>[0], error => { if (error) cancel(error); }); }
    catch (error) { cancel(error); }
  };
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout!.resume();
  child.on("error", error => cancel(error));
  child.on("message", (message: ChildMessage) => {
    if (failure) return;
    try {
      if (message.kind === "request") calls++;
      else if (message.kind === "report") { assert.ok(message.receipt); report(message.receipt); send({ kind: "ack", id: message.id }); }
      else if (message.kind === "response") { beforeResponse?.(); send({ kind: "ack", id: message.id }); }
      else if (message.kind === "result") result = message;
      else if (message.kind === "failure") cancel(new Error(message.error));
      else onMessage(message, send);
    } catch (error) { cancel(error); }
  });
  child.on("close", code => {
    closed = true; clearTimeout(safetyTimer);
    if (cancellationTimer) clearTimeout(cancellationTimer);
    markReaped(); ownedChildren.delete(owner);
    if (failure) reject(failure);
    else if (code !== 0 || !result) reject(new Error(`model child exit ${code}: ${stderr}`));
    else resolveResult(result);
  });
  send({ input, root, port, addresses, refuseUnlink, primitive: modelOperation.toString(), validate: approveModel.toString(),
    script: MODEL_SETUP_SCRIPT, hosts: MODEL_REDIRECT_HOSTS, mode, uid, confirmClose,
    stalled: stalledSource } satisfies ChildInput);
});
const request = (patch: Partial<ModelRequest> = {}): ModelRequest => ({ operation: "download", approval, root, filename: `${randomUUID()}.gguf`, token: randomUUID(), timeoutMs: 10000, ...patch });
const run = async (input: ModelRequest, report: (receipt: ModelReceipt) => void = () => {}, uid = 1000): Promise<ModelFacts> => {
  const result = await executeChild(input, report, "primitive", uid);
  assert.ok(result.facts); return result.facts;
};
// Retire only a completed case's exact inode, never a replacement or live stage.
const retirePublication = (destination: string, identity: { dev: string | bigint; ino: string | bigint }) => {
  const currentRoot = fs.lstatSync(root, { bigint: true });
  assert.equal(currentRoot.dev, rootIdentity.dev); assert.equal(currentRoot.ino, rootIdentity.ino);
  assert.ok(currentRoot.isDirectory()); assert.equal(fs.realpathSync(root), root);
  const name = basenameInRoot(destination);
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/);
  const current = fs.lstatSync(join(root, name), { bigint: true });
  assert.ok(current.isFile()); assert.equal(current.nlink, 1n);
  assert.equal(String(current.dev), String(identity.dev)); assert.equal(String(current.ino), String(identity.ino));
  fs.unlinkSync(join(root, name));
};
try {
  const good = request();
  const goodDestination = join(root, good.filename);
  let goodReceipt: ModelReceipt | undefined;
  const result = await run(good, value => { goodReceipt = value; });
  assert.equal(result.code, "MODEL_DOWNLOADED"); assert.equal(result.changed, true);
  assert.deepEqual(fs.readFileSync(goodDestination), bytes);
  const before = calls;
  assert.equal((await run({ ...good, operation: "inspect" })).code, "MODEL_PRESENT");
  assert.equal((await run(good)).changed, false); assert.equal(calls, before);
  assert.ok(goodReceipt);
  const goodStage = join(root, `.cfmodel-${good.token}.stage`);
  const goodReceiptPath = join(root, `.cfmodel-${good.token}.receipt`);
  assert.equal(fs.existsSync(goodStage), false); assert.equal(fs.existsSync(goodReceiptPath), false);
  const wrong = request();
  const wrongDestination = join(root, wrong.filename);
  fs.writeFileSync(wrongDestination, "GGUFwrong", { mode: 0o600 });
  const wrongIdentity = fs.lstatSync(wrongDestination, { bigint: true });
  assert.equal((await run(wrong)).code, "MODEL_CONTENT");
  assert.equal(fs.readFileSync(wrongDestination, "utf8"), "GGUFwrong"); assert.equal(calls, before);
  retirePublication(wrongDestination, wrongIdentity);
  const large = request();
  const largeDestination = join(root, large.filename);
  fs.writeFileSync(largeDestination, Buffer.alloc(129), { mode: 0o600 });
  const largeIdentity = fs.lstatSync(largeDestination, { bigint: true });
  assert.equal((await run(large)).code, "MODEL_FILE"); assert.equal(fs.statSync(largeDestination).size, 129);
  retirePublication(largeDestination, largeIdentity);
  for (const corrupt of [Buffer.from("GGUFbad"), Buffer.from("NOTGfixture-model-bytes"), Buffer.alloc(129)]) {
    body = corrupt;
    const input = request();
    const destination = join(root, input.filename);
    const ownedStage = join(root, `.cfmodel-${input.token}.stage`);
    const receiptPath = join(root, `.cfmodel-${input.token}.receipt`);
    const failure = await run(input);
    assert.equal(failure.ok, false); assert.equal(failure.changed, true); assert.equal(failure.retainedStage, false);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(ownedStage), false);
    assert.equal(fs.existsSync(receiptPath), false);
  }
  {
    const oversize = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(256, 7)]);
    body = oversize;
    const input = request({ approval: { ...approval, checksum: createHash("sha256").update(oversize).digest("hex"), maxBytes: 128 } });
    const destination = join(root, input.filename);
    const ownedStage = join(root, `.cfmodel-${input.token}.stage`);
    const receiptPath = join(root, `.cfmodel-${input.token}.receipt`);
    const failure = await run(input);
    assert.equal(failure.code, "MODEL_SIZE", "MODEL_STREAM_CAP");
    assert.equal(failure.ok, false, "MODEL_STREAM_CAP_REFUSED");
    assert.equal(fs.existsSync(destination), false, "MODEL_STREAM_CAP_NO_PUBLICATION");
    assert.equal(failure.retainedStage, false);
    assert.equal(fs.existsSync(ownedStage), false); assert.equal(fs.existsSync(receiptPath), false);
    body = bytes;
  }
  {
    const input = request();
    const destination = join(root, input.filename);
    const ownedStage = join(root, `.cfmodel-${input.token}.stage`);
    const receiptPath = join(root, `.cfmodel-${input.token}.receipt`);
    const userBytes = Buffer.from("user-published-during-response");
    let userIdentity: fs.BigIntStats | undefined;
    let userInode: bigint | undefined;
    beforeResponse = () => {
      fs.writeFileSync(destination, userBytes, { flag: "wx", mode: 0o600 });
      userIdentity = fs.lstatSync(destination, { bigint: true });
      userInode = userIdentity.ino;
    };
    let failure;
    try { failure = await run(input); } finally { beforeResponse = undefined; }
    assert.equal(failure.code, "MODEL_EXISTS", "MODEL_PUBLICATION_NO_CLOBBER");
    assert.deepEqual(fs.readFileSync(destination), userBytes, "MODEL_PUBLICATION_USER_BYTES");
    assert.equal(fs.lstatSync(destination, { bigint: true }).ino, userInode, "MODEL_PUBLICATION_USER_INODE");
    assert.equal(fs.existsSync(ownedStage), false, "MODEL_PUBLICATION_OWN_STAGE_CLEANED");
    assert.equal(fs.existsSync(receiptPath), false);
    assert.ok(userIdentity); retirePublication(destination, userIdentity);
  }
  body = bytes;
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.1.1", "224.0.0.1", "::1", "fe80::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    addresses = [{ address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }];
    const input = request();
    const destination = join(root, input.filename);
    const ownedStage = join(root, `.cfmodel-${input.token}.stage`);
    const receiptPath = join(root, `.cfmodel-${input.token}.receipt`);
    const count = calls;
    const failure = await run(input);
    assert.equal(failure.code, "MODEL_DNS", "MODEL_PUBLIC_DNS"); assert.equal(calls, count, "MODEL_PUBLIC_DNS_NO_REQUEST");
    assert.equal(failure.retainedStage, false);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(ownedStage), false); assert.equal(fs.existsSync(receiptPath), false);
  }
  // Reject every denied answer, even after a public IPv4 answer, before requesting.
  for (const address of [
    "2001::", "2001:0:0:0:0:0:0:1", "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:01FF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF",
    "2001:db8::", "2001:0DB8:0000:0000:0000:0000:0000:0001",
    "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
    "2002::", "2002:0808:0808::1", "2002:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF",
    "3fff::", "3FFF:0000:0000:0000:0000:0000:0000:0001",
    "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
    "1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "4000::",
    "::", "::8.8.8.8", "::ffff:8.8.8.8", "::ffff:808:808",
    "0000:0000:0000:0000:0000:FFFF:0808:0808",
    "64:ff9b::808:808", "64:ff9b:1::808:808", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2606:4700::1111%eth0", "2606:4700::1111%1", "2606:4700::8.8.8.8",
    "2001:::1", "2001::1::1", "2001:4860:0:0:0:0:1", "2001:4860:0:0:0:0:0:0:1",
    "2001:4860:00000:0:0:0:0:1", "2001:4860::gggg", "[2606:4700::1111]",
  ]) {
    addresses = [{ address: "8.8.8.8", family: 4 }, { address, family: 6 }];
    const input = request();
    const destination = join(root, input.filename);
    const ownedStage = join(root, `.cfmodel-${input.token}.stage`);
    const receiptPath = join(root, `.cfmodel-${input.token}.receipt`);
    const count = calls;
    const failure = await run(input);
    assert.equal(failure.code, "MODEL_DNS", address);
    assert.equal(calls, count, `no request for ${address}`);
    assert.equal(failure.retainedStage, false, address);
    assert.equal(fs.existsSync(destination), false, address);
    assert.equal(fs.existsSync(ownedStage), false, address);
    assert.equal(fs.existsSync(receiptPath), false, address);
  }
  // Real fixture downloads exercise CIDR edges and equivalent textual forms;
  // the adapter above checks the exact IPv6 address/family supplied by pinned lookup.
  for (const address of [
    "2000::", "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:200::", "2001:0200:0000:0000:0000:0000:0000:0000",
    "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", "2001:db9::",
    "2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "2003::",
    "3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "3fff:1000::",
    "3FFF:1000:0000:0000:0000:0000:0000:0000",
    "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:4860:4860::8888", "2001:4860:4860:0:0:0:0:8888",
    "2606:4700:4700::1111", "2606:4700:4700:0000:0000:0000:0000:1111",
    "2a00:1450:4001:81b::200e", "2A00:1450:4001:081B:0000:0000:0000:200E",
  ]) {
    addresses = [{ address, family: 6 }, { address: "8.8.8.8", family: 4 }];
    const input = request();
    const destination = join(root, input.filename);
    const ownedStage = join(root, `.cfmodel-${input.token}.stage`);
    const receiptPath = join(root, `.cfmodel-${input.token}.receipt`);
    const count = calls;
    let publishedReceipt: ModelReceipt | undefined;
    const success = await run(input, value => { publishedReceipt = value; });
    assert.equal(success.code, "MODEL_DOWNLOADED", address);
    assert.equal(success.ok, true, address);
    assert.equal(calls, count + 1, address);
    assert.deepEqual(fs.readFileSync(destination), bytes, address);
    assert.equal(fs.existsSync(ownedStage), false, address);
    assert.equal(fs.existsSync(receiptPath), false, address);
    assert.ok(publishedReceipt, address);
    retirePublication(destination, publishedReceipt.stage);
  }
  addresses = [{ address: "8.8.8.8", family: 4 }];
  for (const host of MODEL_REDIRECT_HOSTS) {
    redirects = 1; location = `https://${host}/fixture?signature=fixture`;
    const input = request();
    const destination = join(root, input.filename);
    const ownedStage = join(root, `.cfmodel-${input.token}.stage`);
    const receiptPath = join(root, `.cfmodel-${input.token}.receipt`);
    let publishedReceipt: ModelReceipt | undefined;
    assert.equal((await run(input, value => { publishedReceipt = value; })).code, "MODEL_DOWNLOADED");
    assert.deepEqual(fs.readFileSync(destination), bytes);
    assert.equal(fs.existsSync(ownedStage), false); assert.equal(fs.existsSync(receiptPath), false);
    assert.ok(publishedReceipt); retirePublication(destination, publishedReceipt.stage);
  }
  for (const url of ["https://evil.invalid/model", "http://cdn-lfs.hf.co/model", "https://user:secret@cdn-lfs.hf.co/model", "https://cdn-lfs.hf.co:444/model"]) {
    redirects = 1; location = url;
    const input = request();
    const destination = join(root, input.filename);
    const ownedStage = join(root, `.cfmodel-${input.token}.stage`);
    const receiptPath = join(root, `.cfmodel-${input.token}.receipt`);
    const failure = await run(input);
    assert.equal(failure.code, "MODEL_REDIRECT", "MODEL_REDIRECT_POLICY");
    assert.equal(failure.retainedStage, false);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(ownedStage), false); assert.equal(fs.existsSync(receiptPath), false);
  }
  redirects = 4; location = "https://cdn-lfs.hf.co/model";
  {
    const input = request();
    const destination = join(root, input.filename);
    const ownedStage = join(root, `.cfmodel-${input.token}.stage`);
    const receiptPath = join(root, `.cfmodel-${input.token}.receipt`);
    const failure = await run(input);
    assert.equal(failure.code, "MODEL_REDIRECT", "MODEL_REDIRECT_HOP_CAP"); redirects = 0;
    assert.equal(failure.retainedStage, false);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(ownedStage), false); assert.equal(fs.existsSync(receiptPath), false);
  }
  const collision = request();
  const stage = join(root, `.cfmodel-${collision.token}.stage`);
  fs.writeFileSync(stage, "user-owned", { mode: 0o600 });
  assert.equal((await run(collision)).code, "MODEL_EXISTS"); assert.equal(fs.readFileSync(stage, "utf8"), "user-owned");
  const retained = request();
  const retainedStage = join(root, `.cfmodel-${retained.token}.stage`);
  const retainedReceiptPath = join(root, `.cfmodel-${retained.token}.receipt`);
  let receipt: ModelReceipt | undefined;
  body = Buffer.from("GGUFcorrupt"); refuseUnlink = true;
  const failed = await run(retained, (value) => { receipt = value; });
  refuseUnlink = false; body = bytes;
  assert.equal(failed.changed, true); assert.equal(failed.retainedStage, true); assert.ok(receipt);
  assert.equal((await run({ ...retained, operation: "cleanup", receipt })).code, "MODEL_QUIESCENCE");
  const forged = { ...receipt, stage: { ...receipt.stage, ino: "0" } };
  assert.equal((await run({ ...retained, operation: "cleanup", receipt: forged, quiescent: true })).code, "MODEL_CLEANUP_IDENTITY");
  assert.equal((await run({ ...retained, operation: "cleanup", receipt, quiescent: true })).code, "MODEL_CLEANED");
  assert.equal(fs.existsSync(retainedStage), false);
  assert.equal(fs.existsSync(retainedReceiptPath), false);
  await requires("symlink", "managed model file symlink boundary", async () => {
    const target = goodDestination;
    const symlink = request();
    const symlinkDestination = join(root, symlink.filename);
    fs.symlinkSync(target, symlinkDestination);
    const symlinkIdentity = fs.lstatSync(symlinkDestination, { bigint: true });
    assert.equal((await run(symlink)).code, "MODEL_FILE");
    assert.deepEqual(fs.readFileSync(target), bytes);
    const current = fs.lstatSync(symlinkDestination, { bigint: true });
    assert.ok(current.isSymbolicLink());
    assert.equal(current.dev, symlinkIdentity.dev); assert.equal(current.ino, symlinkIdentity.ino);
    fs.unlinkSync(symlinkDestination);
  });
  retirePublication(goodDestination, goodReceipt.stage);
  const missingRoot = join(root, "missing");
  assert.equal((await run(request({ root: missingRoot }))).ok, false);
  assert.equal((await run(request({ filename: "../outside.gguf" }))).code, "MODEL_INPUT");
  assert.equal((await run(request(), undefined, 0)).code, "MODEL_INPUT");
  const vmInput = request();
  const vmDestination = join(root, vmInput.filename);
  const vmStage = join(root, `.cfmodel-${vmInput.token}.stage`);
  const vmReceiptPath = join(root, `.cfmodel-${vmInput.token}.receipt`);
  const vmResult = await executeChild(vmInput, undefined, "script");
  const output = vmResult.output ?? "";
  const vmProcess = { exitCode: vmResult.exitCode };
  const vmRows = output.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; code?: string; receipt?: ModelReceipt });
  assert.deepEqual(vmRows.map((row) => row.kind), ["model-staging", "model-result"]);
  assert.equal(vmRows[1].code, "MODEL_DOWNLOADED"); assert.equal(vmProcess.exitCode, 0);
  assert.deepEqual(fs.readFileSync(vmDestination), bytes);
  assert.equal(fs.existsSync(vmStage), false); assert.equal(fs.existsSync(vmReceiptPath), false);
  assert.ok(vmRows[0].receipt); retirePublication(vmDestination, vmRows[0].receipt.stage);
  const stalledNetwork = (confirmClose: boolean, notifyAwait: () => void, lookup: () => Promise<unknown>, addresses: { address: string; family: number }[]): ModelNetwork => ({
    lookup: async () => { await lookup(); return addresses; },
    request: (() => {
      const req = new EventEmitter();
      const res = new EventEmitter() as EventEmitter & {
        closed: boolean; complete: boolean; statusCode: number; headers: object;
        destroy: () => void; [Symbol.asyncIterator]: () => AsyncIterator<Buffer>;
      };
      res.closed = false; res.complete = false; res.statusCode = 200; res.headers = {};
      res.destroy = () => { if (confirmClose && !res.closed) { res.closed = true; res.emit("close"); } };
      res[Symbol.asyncIterator] = () => ({ next: () => { notifyAwait(); return new Promise(() => {}); } });
      Object.assign(req, { end: () => { req.emit("response", res as unknown as IncomingMessage); req.emit("close"); }, destroy: () => {} });
      return req;
    }) as unknown as ModelNetwork["request"],
  });
  for (const confirmClose of [true, false]) {
    const input = request({ timeoutMs: 100 });
    let captured: ModelReceipt | undefined, now = 0, expiryFired = false;
    interface Timer { id: number; callback: () => void; delay: number; active: boolean }
    const timers: Timer[] = [];
    let notifyAwait!: () => void, notifyCleanup!: (timer: Timer) => void;
    const awaitingBody = new Promise<void>(resolve => { notifyAwait = resolve; });
    const awaitingCleanup = new Promise<Timer>(resolve => { notifyCleanup = resolve; });
    const pending = executeChild(input, value => { captured = value; }, "stalled", 1000, (message, send) => {
      if (message.kind === "await") notifyAwait();
      if (message.kind === "clear") { const timer = timers.find(timer => timer.id === message.id); if (timer) timer.active = false; }
      if (message.kind === "timer") {
        assert.ok(message.id !== undefined && message.delay !== undefined);
        const id = message.id;
        const timer = { id, callback: () => send({ kind: "fire", id, now }), delay: message.delay, active: true };
        timers.push(timer); if (expiryFired) notifyCleanup(timer);
      }
    }, confirmClose, stalledNetwork.toString()).then(result => { assert.ok(result.facts); return result.facts; });
    void pending.catch(() => {});
    const endedBeforeReadiness = pending.then(() => { throw new Error("model child completed before scripted readiness"); });
    void endedBeforeReadiness.catch(() => {});
    await Promise.race([awaitingBody, endedBeforeReadiness]);
    const expirationTimers = timers.filter(timer => timer.active && timer.delay === input.timeoutMs);
    if (expirationTimers.length !== 2) throw new Error("stalled body did not reach response and iterator deadline boundaries");
    now = input.timeoutMs; expiryFired = true;
    for (const timer of expirationTimers) { timer.active = false; timer.callback(); }
    if (!confirmClose) { const cleanupTimer = await Promise.race([awaitingCleanup, endedBeforeReadiness]); now += cleanupTimer.delay; cleanupTimer.active = false; cleanupTimer.callback(); }
    const failure = await pending;
    assert.equal(failure.code, confirmClose ? "MODEL_DEADLINE" : "MODEL_QUIESCENCE");
    assert.equal(failure.changed, true); assert.equal(failure.retainedStage, !confirmClose);
    const ownedStage = join(root, `.cfmodel-${input.token}.stage`);
    const receiptPath = join(root, `.cfmodel-${input.token}.receipt`);
    const destination = join(root, input.filename);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(ownedStage), !confirmClose);
    assert.equal(fs.existsSync(receiptPath), !confirmClose);
    if (!confirmClose) {
      assert.ok(captured);
      const denied = { ...input, operation: "cleanup", receipt: captured, quiescent: false };
      assert.equal((await run(denied as unknown as ModelRequest)).code, "MODEL_QUIESCENCE");
      assert.ok(fs.existsSync(ownedStage));
      const cleanup = { ...input, operation: "cleanup" as const, receipt: captured, quiescent: true as const, timeoutMs: 10000 };
      const original = join(root, `.cfmodel-${input.token}.stage.saved`);
      fs.renameSync(ownedStage, original);
      fs.mkdirSync(ownedStage);
      assert.equal((await run(cleanup)).code, "MODEL_CLEANUP_IDENTITY", "MODEL_CLEANUP_DIRECTORY_IDENTITY");
      assert.ok(fs.statSync(ownedStage).isDirectory());
      fs.rmdirSync(ownedStage);
      fs.writeFileSync(ownedStage, "replacement", { mode: 0o600 });
      assert.equal((await run(cleanup)).code, "MODEL_CLEANUP_IDENTITY", "MODEL_CLEANUP_FILE_IDENTITY");
      assert.equal(fs.readFileSync(ownedStage, "utf8"), "replacement");
      fs.unlinkSync(ownedStage); fs.renameSync(original, ownedStage);
      assert.equal((await run(cleanup)).code, "MODEL_CLEANED");
      assert.equal(fs.existsSync(ownedStage), false); assert.equal(fs.existsSync(receiptPath), false);
      assert.equal(fs.existsSync(original), false);
    }
  }
  typeAssert("model helper string, body deadlines and quiescent identity cleanup use actual primitives");
  typeAssert("model delivery uses streamed fixture bytes, pinned DNS and identity-checked no-clobber files");
} finally {
  try { await reapChildren(); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  fs.rmSync(root, { recursive: true, force: true });
}
finish("memory setup model");
