import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { readPrivateState, writePrivateState, appendPrivateJournal, readPrivateJournal, registerPrivateSecret, PrivateDataError, type JsonValue, type PrivateJournalReadOptions } from "#framework/security/privacy/private-config.ts";
import { fixture, recording } from "./fixture.ts";

async function refusal(name: string, body: () => Promise<unknown>, code: string) {
  let actual: unknown;
  try { await body(); } catch (error) { actual = error instanceof PrivateDataError ? error.code : error; }
  check(name, actual, code);
}
const f = await fixture();
const r = recording();
const path = "/fixture/data/vault/deep/state.json";
const journal = "/fixture/data/vault/events.jsonl";
const options = { version: 1 };
const readOptions: PrivateJournalReadOptions = { limit: 100 };
try {
  check("missing state", await readPrivateState(r.ctx, path, options), undefined);
  const value = { text: "personal", list: [1, true, null] };
  await writePrivateState(r.ctx, path, value, options);
  check("state roundtrip", await readPrivateState(r.ctx, path, options), value);
  check("strict envelope", JSON.parse(r.files.get(path)!), { version: 1, value });
  check("all boundary parents chmod 700", r.events.filter(e => e.command === "chmod" && e.args[0] === "700").map(e => e.args[1]), ["/fixture/data/vault", "/fixture/data/vault/deep"]);
  const creationTokens = ["umask", "077;", "mkdir", "-p", "--", '"$1"'];
  checkTrue("parents protected from creation", r.events.some(e => {
    const tokens = e.args[1]?.split(" ") ?? [];
    return e.command === "sh" && tokens.length === creationTokens.length && tokens.every((token, index) => token === creationTokens[index]);
  }));
  await writePrivateState(r.ctx, "/fixture/data/exact/state.json", value, options);
  check("exact file declaration roundtrip", await readPrivateState(r.ctx, "/fixture/data/exact/state.json", options), value);
  await refusal("version mismatch", () => readPrivateState(r.ctx, path, { version: 2 }), "version");
  const saved = r.files.get(path)!;
  for (const version of [-1, 1.5]) {
    const unchanged = [...r.files];
    await refusal(`negative/fractional read version ${version}`, () => readPrivateState(r.ctx, path, { version }), "invalid");
    await refusal(`negative/fractional write version ${version}`, () => writePrivateState(r.ctx, path, value, { version }), "invalid");
    check(`invalid version ${version} preserves bytes`, [...r.files], unchanged);
  }
  r.files.set(path, "{");
  await refusal("invalid envelope", () => readPrivateState(r.ctx, path, options), "invalid");
  r.files.set(path, saved);
  const reject = (_: unknown): _ is JsonValue => false;
  const throwing = (_: unknown): _ is JsonValue => { throw Error("sensitive validator"); };
  for (const validate of [reject, throwing]) {
    await refusal("read validator refusal", () => readPrivateState(r.ctx, path, { ...options, validate }), "validation");
    await refusal("write validator refusal", () => writePrivateState(r.ctx, path, value, { ...options, validate }), "validation");
    check("validator leaves bytes", r.files.get(path), saved);
  }
  const accept = (v: unknown): v is typeof value => typeof v === "object" && v !== null && "text" in v;
  await writePrivateState(r.ctx, path, value, { ...options, validate: accept });
  check("guard accepted on read", await readPrivateState(r.ctx, path, { ...options, validate: accept }), value);
  const mutate = (v: unknown): v is JsonValue => { (v as Record<string, unknown>).bad = () => {}; return true; };
  await refusal("write validator mutation rechecked", () => writePrivateState(r.ctx, path, {}, { ...options, validate: mutate }), "invalid");
  await refusal("read validator mutation rechecked", () => readPrivateState(r.ctx, path, { ...options, validate: mutate }), "invalid");
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const invalid of [{ fn: () => {} }, cycle]) {
    await refusal("strict JSON refuses lossy values", () => writePrivateState(r.ctx, path, invalid, options), "invalid");
    await refusal("journal strict JSON", () => appendPrivateJournal(r.ctx, journal, invalid as { [key: string]: JsonValue }), "invalid");
  }
  const before = [...r.files];
  await refusal("outside write policy", () => writePrivateState(r.ctx, "/fixture/data/public/new.json", {}, options), "policy");
  await refusal("outside read policy", () => readPrivateState(r.ctx, "/fixture/data/public/new.json", options), "policy");
  await refusal("outside journal policy", () => appendPrivateJournal(r.ctx, "/fixture/data/public/events", {}), "policy");
  check("outside creates no files", [...r.files], before);
  r.control.failPublish = true;
  await refusal("failed atomic state publication", () => writePrivateState(r.ctx, path, { changed: true }, options), "io");
  check("failed write preserves bytes and cleans staging", [...r.files], before);
  r.control.failPublish = false;
  for (const [code, expected] of [[41, "symlink"], [43, "io"], [1, "io"], [42, undefined]] as const) {
    r.control.readCode = code;
    if (expected) await refusal("bounded read distinction", () => readPrivateState(r.ctx, path, options), expected);
    else check("explicit missing sentinel", await readPrivateState(r.ctx, path, options), undefined);
  }
  r.control.readCode = 42; r.control.timedOut = true;
  await refusal("timeout cannot masquerade as missing", () => readPrivateState(r.ctx, path, options), "io");
  r.control.readCode = 0; r.control.timedOut = false;
  r.files.set(path, "x".repeat(1_048_577));
  await refusal("bounded read byte sentinel", () => readPrivateState(r.ctx, path, options), "size");
  checkTrue("every bounded shell has operation timeout", r.events.filter(e => e.args[1]?.startsWith("p=$1")).every(e => e.options?.timeoutMs === 10_000 && e.args[4] === "1048577"));
  r.files.set(path, saved);
  await r.owning(async () => {
    const oversizedBefore = [...r.files];
    const oversizedEvents = r.events.length;
    await refusal("oversized journal record typed size", () => appendPrivateJournal(r.ctx, journal, { value: "x".repeat(1_048_576) }, { maxBytes: 1_048_576 }), "size");
    check("oversized journal record writes no content", [...r.files], oversizedBefore);
    check("oversized journal record makes no transport calls", r.events.slice(oversizedEvents), []);

    const exactJournal = "/fixture/data/exact/state.json";
    r.files.delete(exactJournal);
    await appendPrivateJournal(r.ctx, exactJournal, { item: 1 });
    const exactFirst = r.files.get(exactJournal)!;
    const exactBytes = Buffer.byteLength(exactFirst);
    await appendPrivateJournal(r.ctx, exactJournal, { item: 2 }, { maxBytes: exactBytes * 2 });
    check("exact-file journal appends until rotation boundary", (await readPrivateJournal(r.ctx, exactJournal, readOptions)).records.map(record => record.item), [2, 1]);
    check("exact-file journal stays unrotated", [...r.files.keys()].filter(p => p.startsWith(`${exactJournal}.`)), []);
    const exactBefore = [...r.files];
    await refusal("exact-file journal rotation typed policy", () => appendPrivateJournal(r.ctx, exactJournal, { item: 3 }, { maxBytes: exactBytes * 2 }), "policy");
    check("exact-file rotation refusal preserves all bytes", [...r.files], exactBefore);

    const orderedJournal = "/fixture/data/vault/ordered.jsonl";
    for (let item = 1; item <= 5; item++) {
      await appendPrivateJournal(r.ctx, orderedJournal, { item }, { maxBytes: exactBytes * 2, maxRotations: 3 });
    }
    check("ordering spans two rotations", [r.files.has(`${orderedJournal}.1`), r.files.has(`${orderedJournal}.2`)], [true, true]);
    const ordered = await readPrivateJournal(r.ctx, orderedJournal, readOptions);
    check("newest-first order within and across rotations", { items: ordered.records.map(record => record.item), corrupt: ordered.corrupt, truncated: ordered.truncated }, { items: [5, 4, 3, 2, 1], corrupt: 0, truncated: false });

    await appendPrivateJournal(r.ctx, journal, { item: 1, timestamp: "caller" });
    const line = r.files.get(journal)!;
    const bytes = Buffer.byteLength(line);
    const first = JSON.parse(line);
    check("append record", first.item, 1);
    checkTrue("timestamp overwritten UTC", /^\d{4}-.*Z$/.test(first.timestamp) && first.timestamp !== "caller");
    await appendPrivateJournal(r.ctx, journal, { item: 2 }, { maxBytes: bytes * 2, maxRotations: 3 });
    check("exact rotation boundary remains current", r.files.has(`${journal}.1`), false);
    await appendPrivateJournal(r.ctx, journal, { item: 3 }, { maxBytes: bytes * 2, maxRotations: 3 });
    check("crossing boundary rotates", r.files.get(`${journal}.1`)?.split("\n").filter(Boolean).length, 2);
    r.files.set(`${journal}.3`, line); r.files.set(`${journal}.8`, line);
    await appendPrivateJournal(r.ctx, journal, { item: 4 }, { maxRotations: 1 });
    check("lower retention removes higher stale siblings without rotation", [r.files.has(`${journal}.3`), r.files.has(`${journal}.8`)], [false, false]);
    r.files.delete(`${journal}.1`); r.files.set(`${journal}.2`, line); r.files.set(`${journal}.3`, line);
    await appendPrivateJournal(r.ctx, journal, { item: 5 }, { maxBytes: bytes, maxRotations: 3 });
    check("rotation clears gap destination", r.files.has(`${journal}.2`), false);
    check("rotation moves older existing sibling", r.files.get(`${journal}.3`), line);
    r.control.failReadPath = `${journal}.8`;
    const preflight = [...r.files];
    await refusal("all touched siblings read before any writes", () => appendPrivateJournal(r.ctx, journal, { item: 6 }, { maxBytes: bytes, maxRotations: 0 }), "io");
    check("preflight refusal preserves all bytes", [...r.files], preflight);
    r.control.failReadPath = "";
    registerPrivateSecret("q!"); registerPrivateSecret('esc"\\\n');
    const longSecret = "u5-existing-registry-credential";
    registerPrivateSecret(longSecret);
    await refusal("long registered secret refusal", () => appendPrivateJournal(r.ctx, journal, { value: `prefix:${longSecret}:suffix` }), "secret");
    check("long registered secret refusal preserves all bytes", [...r.files], preflight);
    const secretRecords: Array<{ [key: string]: JsonValue }> = [{ value: "q!" }, { value: 'esc"\\\n' }, { nested: [{ value: "q!" }] }, { "q!": "value" }];
    for (const record of secretRecords) {
      await refusal("secret refusal", () => appendPrivateJournal(r.ctx, journal, record), "secret");
      check("secret refusal byte-identical", [...r.files], preflight);
    }
    await appendPrivateJournal(r.ctx, journal, { item: 7 }, { maxBytes: bytes, maxRotations: 0 });
    check("zero retention removes every sibling", [...r.files.keys()].filter(p => p.startsWith(`${journal}.`)), []);
    const siblings = await Promise.allSettled([appendPrivateJournal(r.ctx, journal, { item: 8 }), appendPrivateJournal(r.ctx, journal, { item: 9 })]);
    check("held-lock siblings one accepted", siblings.filter(s => s.status === "fulfilled").length, 1);
    check("held-lock sibling typed busy", siblings.filter(s => s.status === "rejected").map(s => s.reason.code), ["busy"]);
  });
  const good = JSON.stringify({ item: "valid", timestamp: "2026-01-01T00:00:00.000Z" });
  r.files.set(journal, `${good}\nnot-json\n{}\n${good}\npartial`);
  const result = await readPrivateJournal(r.ctx, journal, readOptions);
  check("corrupt skips and count", { count: result.records.length, corrupt: result.corrupt, truncated: result.truncated }, { count: 2, corrupt: 3, truncated: false });
  check("read limit truncation", (await readPrivateJournal(r.ctx, journal, { limit: 1 })).truncated, true);
} finally { await f.dispose(); }
finish("private structured U5");
