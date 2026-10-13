import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { LocalTransport } from "#framework/runtime/transport/transport.ts";
import { appendPrivateJournal, appendPrivateIntent, appendPrivateResult, privatePseudonym, privatePseudonymKey, privatePseudonymLookup, PrivateDataError, readPendingPrivateIntents, type JsonValue } from "#framework/security/privacy/private-config.ts";
import type { Context } from "#framework/core/context.ts";
import { fixture, recording } from "./fixture.ts";

async function refusal(name: string, body: () => Promise<unknown>, code: string) {
  let actual: unknown;
  try { await body(); } catch (error) { actual = error instanceof PrivateDataError ? error.code : error; }
  check(name, actual, code);
}

const f = await fixture();
const r = recording();
const keyPath = "/fixture/data/vault/key.json";
try {
  // All key-helper paths are lock-free now; every pseudonym call runs under owning()
  // against the fake transport, like u5.check's journal appends.
  await r.owning(async () => {
    // 0. Concurrent same-process first-callers queue on the in-process create guard, so
    // all three calls create-or-read exactly one key and all succeed.
    const sameProcess = await Promise.all([1, 2, 3].map(() => privatePseudonymKey(r.ctx, keyPath)));
    check("same-process creators share one key", new Set(sameProcess).size, 1);
    check("same-process creators match published key", sameProcess[0], JSON.parse(r.files.get(keyPath)!).key as string);

    // 1. Determinism through the fake transport's Map-backed file store.
    const first = await privatePseudonym(r.ctx, keyPath, { recipe: "u5b", namespace: "users", value: "alice" });
    const second = await privatePseudonym(r.ctx, keyPath, { recipe: "u5b", namespace: "users", value: "alice" });
    check("deterministic token", second, first);
    const envelope = JSON.parse(r.files.get(keyPath)!);
    check("key envelope shape", { version: envelope.version, keyBytes: Buffer.from(envelope.key, "base64").length, extraKeys: Object.keys(envelope).length - 2 }, { version: 1, keyBytes: 32, extraKeys: 0 });

    // 2. Domain separation and token shape.
    const otherNamespace = await privatePseudonym(r.ctx, keyPath, { recipe: "u5b", namespace: "orders", value: "alice" });
    const otherRecipe = await privatePseudonym(r.ctx, keyPath, { recipe: "other", namespace: "users", value: "alice" });
    const bob = await privatePseudonym(r.ctx, keyPath, { recipe: "u5b", namespace: "users", value: "bob" });
    const samples = [first, otherNamespace, otherRecipe, bob];
    checkTrue("different namespace separates", first !== otherNamespace);
    checkTrue("different recipe separates", first !== otherRecipe);
    checkTrue("all tokens differ", new Set(samples).size === samples.length);
    check("token shape", samples.map(token => /^v1\.[A-Za-z0-9_-]{43}$/.test(token)), [true, true, true, true]);
    check("constant token length", new Set(samples.map(token => token.length)).size, 1);
    checkTrue("token never contains raw value", samples.every(token => !token.includes("alice") && !token.includes("bob")));

    // 3. Length-prefixed fields: concatenated-equal splits never collide.
    const splits: Array<[string, string]> = [["ab", "c"], ["a", "bc"], ["a", "bcd"], ["ab", "cd"], ["abc", "d"]];
    const splitTokens = await Promise.all(splits.map(([namespace, value]) => privatePseudonym(r.ctx, keyPath, { recipe: "u5b", namespace, value })));
    check("no cross-split collisions", new Set(splitTokens).size, splits.length);
    const lookup = await privatePseudonymLookup(r.ctx, keyPath, { recipe: "u5b", namespace: "users", candidate: "alice" });
    check("lookup matches pseudonym", lookup, first);

    // 4. Concurrent first-callers on a real transport land on one, never-rewritten key file.
    await requires("linux-host", "u5b concurrent key creation", async () => {
      await requires("posix-sh", "u5b concurrent shell", async () => {
        await requires("gnu-userland", "u5b concurrent atomic rename", async () => {
          const rounds = 5;
          const workers = 4;
          function worker(root: string): Promise<{ keyHash: string; pseudonym: string }> {
            return new Promise((resolve, reject) => {
              const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./u5b-worker.ts", import.meta.url)), root, "fixed-value"], { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
              let output = "", errors = "";
              child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
              const timer = setTimeout(() => { child.kill(); reject(Error(`u5b worker timeout; stdout=${output}; stderr=${errors}`)); }, 120_000);
              child.on("error", reject);
              child.on("close", code => { clearTimeout(timer); if (code !== 0) reject(Error(errors)); else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } });
            });
          }
          for (let round = 0; round < rounds; round++) {
            // Fresh fixture per round: a lucky schedule in one round cannot pass the check.
            const real = await fixture();
            try {
              const ctx = { settings: { dataDir: real.root, env: {} }, transport: new LocalTransport() } as unknown as Context;
              const reports = await Promise.all(Array.from({ length: workers }, () => worker(real.root)));
              check(`round ${round}: workers share one key fingerprint`, new Set(reports.map(report => report.keyHash)).size, 1);
              check(`round ${round}: workers share one pseudonym`, new Set(reports.map(report => report.pseudonym)).size, 1);
              check(`round ${round}: exactly one key file`, await readdir(`${real.root}/vault`), ["key.json"]);
              const key = JSON.parse((await readFile(`${real.root}/vault/key.json`)).toString("utf8"));
              checkTrue(`round ${round}: published key is 32 bytes`, Buffer.from(key.key, "base64").length === 32);
              const before = await readFile(`${real.root}/vault/key.json`);
              const parentKey = await privatePseudonymKey(ctx, `${real.root}/vault/key.json`);
              check(`round ${round}: parent reads the same key`, createHash("sha256").update(parentKey).digest("hex"), reports[0].keyHash);
              check(`round ${round}: key file never rewritten`, await readFile(`${real.root}/vault/key.json`), before);
            } finally { await real.dispose(); }
          }
          // POSIX-only: a pre-existing permissive parent is narrowed to owner-only by the
          // key's parent preparation, not left as created.
          await requires("posix-modes", "u5b parent mode narrowing", async () => {
            const real = await fixture();
            try {
              const transport = new LocalTransport();
              await transport.exec("mkdir", ["-m", "755", `${real.root}/vault`]);
              const reports = await Promise.all(Array.from({ length: workers }, () => worker(real.root)));
              check("permissive-parent round: workers share one key", new Set(reports.map(report => report.keyHash)).size, 1);
              const mode = await transport.exec("stat", ["-c", "%a", `${real.root}/vault`]);
              check("permissive parent narrowed to 700", Number.parseInt(mode.stdout.trim(), 8) & 0o777, 0o700);
            } finally { await real.dispose(); }
          });
          // Portable refusal: a parent that is a regular file means the key path cannot
          // exist; the first bounded read refuses content-free before anything is created.
          const blocked = await fixture();
          try {
            const ctx = { settings: { dataDir: blocked.root, env: {} }, transport: new LocalTransport() } as unknown as Context;
            await (new LocalTransport()).exec("mkdir", ["-p", blocked.root]);
            await (new LocalTransport()).writeFile(`${blocked.root}/vault`, "not a directory");
            await refusal("file-parent key path refused", () => privatePseudonymKey(ctx, `${blocked.root}/vault/key.json`), "io");
          } finally { await blocked.dispose(); }
        });
      });
    });

    // 5. A registered key can never be journaled: structural refusal, no bytes written.
    const journal = "/fixture/data/vault/u5b.jsonl";
    const before = [...r.files];
    await refusal("journal refuses embedded key", () => appendPrivateJournal(r.ctx, journal, { note: r.files.get(keyPath)! } as { [key: string]: JsonValue }), "secret");
    check("key refusal preserves all bytes", [...r.files], before);

    // 7. Intent/result crash-gap semantics, newest-first journal order.
    const intents = "/fixture/data/vault/u5b-intents.jsonl";
    await appendPrivateIntent(r.ctx, intents, { id: "A", kind: "send" });
    await appendPrivateIntent(r.ctx, intents, { id: "B", kind: "send" });
    check("pending after two intents", await readPendingPrivateIntents(r.ctx, intents, { limit: 100 }), { ids: ["B", "A"], truncated: false, corrupt: 0 });
    await appendPrivateIntent(r.ctx, intents, { id: "B", kind: "send" });
    check("duplicate intent not double-reported", (await readPendingPrivateIntents(r.ctx, intents, { limit: 100 })).ids, ["B", "A"]);
    await appendPrivateResult(r.ctx, intents, { id: "A", kind: "send", outcome: "done" });
    check("pending after one result", (await readPendingPrivateIntents(r.ctx, intents, { limit: 100 })).ids, ["B"]);
    await appendPrivateResult(r.ctx, intents, { id: "B", kind: "send", outcome: "failed" });
    check("pending empty after all results", await readPendingPrivateIntents(r.ctx, intents, { limit: 100 }), { ids: [], truncated: false, corrupt: 0 });

    // 6. Tampered/short/wrong-version keys refuse content-free, with no key material in the
    // message. Same parse path as the real fixture: the fake transport serves the bytes.
    for (const [name, text, code] of [
      ["bad json", "{", "invalid"],
      ["short key", JSON.stringify({ version: 1, key: Buffer.from("too-short").toString("base64") }), "invalid"],
      ["wrong version", JSON.stringify({ version: 2, key: Buffer.alloc(32, 7).toString("base64") }), "version"],
      ["non-canonical base64", JSON.stringify({ version: 1, key: `${Buffer.alloc(32, 7).toString("base64")}AAA` }), "invalid"],
    ] as const) {
      r.files.set(keyPath, text);
      let message: string | undefined;
      try { await privatePseudonymKey(r.ctx, keyPath); } catch (error) { message = error instanceof PrivateDataError ? error.message : undefined; }
      check(`tampered key refused: ${name}`, message?.endsWith(`${code})`), true);
      // Content-free: bounded length and none of the tampered bytes (the would-be key) survive.
      checkTrue(`tampered key message content-free: ${name}`, message !== undefined && message.length < 64 && !message.includes(text));
    }
  });
} finally { await f.dispose(); }
finish("private structured U5b");
