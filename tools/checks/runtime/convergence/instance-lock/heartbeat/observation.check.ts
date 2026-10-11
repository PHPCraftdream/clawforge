import { observeInstanceLock } from "#framework/runtime/lock/instance-lock.ts";
import { acquireOrTakeOver, readLockOwnerIdentity, type LockOptions } from "#framework/runtime/lock/lock-claim.ts";
import { machineName, platformProbes } from "#framework/runtime/lock/process-identity.ts";
import { stubContext, presenceModel, FIXTURE_LOCK_PATH, FIXTURE_LOCK_HOME, type LockFixture } from "../fixture.ts";
import { existsVia, probeEntryExists } from "#framework/runtime/transport/transport.ts";
import { PRESENCE_PROBE } from "#framework/runtime/transport/quoting.ts";
import { UserError } from "#framework/core/io/log.ts";
import { check, finish } from "#checks/kit/harness.ts";

const original = platformProbes.processStartedAt;
const now = Date.parse("2026-10-09T12:00:00Z");
const startedAt = "2026-10-09T10:00:00Z";
function fixture(age: number, host = machineName()) {
  const target = stubContext();
  const path = FIXTURE_LOCK_PATH;
  target.dirs.add(FIXTURE_LOCK_HOME);
  target.dirs.add(path);
  target.dirs.add(`${FIXTURE_LOCK_PATH}/gen-fixture`);
  target.files.set(`${path}/holder.json`, JSON.stringify({ operationId: "op-fixture", what: "apply", by: `coder@${host} pid ${process.pid}`, host, pid: process.pid, startedAt, takenAt: new Date(now - age).toISOString(), heartbeatAt: new Date(now - age).toISOString(), generation: "fixture" }));
  target.ctx.transport.exists = async (name) => target.dirs.has(name) || target.files.has(name);
  return target;
}
async function refusalConsumer(label: string, target: LockFixture, options: LockOptions): Promise<unknown> {
  const before = JSON.stringify([...target.files]);
  const directories = JSON.stringify([...target.dirs]);
  let takeovers = 0;
  const optionalRemoveEmptyTree = target.ctx.transport.removeEmptyTree;
  const removeEmptyTree: LockFixture["ctx"]["transport"]["removeEmptyTree"] = typeof optionalRemoveEmptyTree === "function"
    ? optionalRemoveEmptyTree.bind(target.ctx.transport)
    : undefined;
  const ctx: LockFixture["ctx"] = {
    ...target.ctx,
    transport: {
      ...target.ctx.transport,
      ...(removeEmptyTree ? {
        removeEmptyTree: async (...args: Parameters<NonNullable<LockFixture["ctx"]["transport"]["removeEmptyTree"]>>) => {
          takeovers += 1;
          return removeEmptyTree(...args);
        },
      } : {}),
    },
  };
  const exec = target.ctx.transport.exec.bind(target.ctx.transport);
  ctx.transport.exec = async (command, args, execution) => {
    if (command === "mv" || command === "rm" || command === "rmdir") takeovers += 1;
    return exec(command, args, execution);
  };
  const writeFile = target.ctx.transport.writeFile.bind(target.ctx.transport);
  const remove = target.ctx.transport.remove.bind(target.ctx.transport);
  ctx.transport.writeFile = async (...args) => { takeovers += 1; return writeFile(...args); };
  ctx.transport.remove = async (...args) => { takeovers += 1; return remove(...args); };
  let thrown: unknown;
  try { await acquireOrTakeOver(ctx, options); } catch (error) { thrown = error; }
  check(`${label} acquisition refuses with UserError`, thrown instanceof UserError, true);
  const advice = thrown instanceof UserError ? thrown.advice : [];
  check(`${label} refusal carries one manual advice`, advice.map((entry) => entry.kind), ["manual"]);
  check(`${label} refusal never guesses mutation argv`, advice.some((entry) => "argv" in entry), false);
  check(`${label} refusal does not displace or delete the owner`, takeovers, 0);
  check(`${label} refusal preserves holder record`, JSON.stringify([...target.files]), before);
  check(`${label} refusal preserves directories and claims`, JSON.stringify([...target.dirs]), directories);
  check(`${label} refusal preserves lock root`, target.dirs.has(FIXTURE_LOCK_PATH), true);
  return thrown;
}

const historicalOwner = {
  operationId: "20260919205351298-restart-e1f2f4", what: "restart",
  by: "Computer@PC pid 17012", takenAt: "2026-09-19T20:53:51.503Z",
};
function historicalFixture(record: unknown = historicalOwner) {
  const target = stubContext();
  const root = FIXTURE_LOCK_PATH;
  target.dirs.add(FIXTURE_LOCK_HOME);
  target.dirs.add(root);
  target.dirs.add(`${FIXTURE_LOCK_PATH}/gen-preserved`);
  target.files.set(`${root}/holder.json`, `${JSON.stringify(record, null, 2)}\n`);
  target.files.set(`${root}/keep.txt`, "unrelated old bytes");
  target.ctx.transport.exists = async (name) => target.dirs.has(name) || target.files.has(name);
  return target;
}

try {
  {
    const target = stubContext();
    const path = FIXTURE_LOCK_PATH;
    const model = presenceModel(target.files, target.dirs, FIXTURE_LOCK_HOME);
    model.links.set(path, "/srv/missing-referent");
    const before = JSON.stringify([[...target.files], [...target.dirs], [...model.links], [...model.parents]]);
    const ctx = { ...target.ctx, transport: new Proxy(target.ctx.transport, {
      get(base, key) {
        if (key === "existsEntry") return undefined;
        if (key === "exec") return async (command: string, args: string[], options?: { input?: unknown }) => {
          if (command !== "sh" || options?.input !== PRESENCE_PROBE) throw new Error("unexpected observation probe");
          return model.probe(args[2]!, args[3] === "entry");
        };
        return Reflect.get(base, key);
      },
    }) };
    check("observer dangling referent follow-target is absent", await existsVia((command, args, options) => ctx.transport.exec(command, args, options), path), false);
    check("observer dangling entry is present", await probeEntryExists(ctx.transport, path), true);
    const facts = await observeInstanceLock(ctx, now);
    check("observer dangling lock is unknown without takeover", [facts.state, facts.takeover], ["unknown", "none"]);
    check("observer dangling entry preserves target and referent", JSON.stringify([[...target.files], [...target.dirs], [...model.links], [...model.parents]]), before);
    model.parents.set(FIXTURE_LOCK_HOME, false);
    const blocked = JSON.stringify([[...target.files], [...target.dirs], [...model.links], [...model.parents]]);
    check("observer blocked entry parent remains unknown", (await observeInstanceLock(ctx, now)).state, "unknown");
    check("observer blocked entry preserves target and referent", JSON.stringify([[...target.files], [...target.dirs], [...model.links], [...model.parents]]), blocked);
  }
  {
    // Direct observer/acquirer only: mutation-guard probes are deliberately outside this trap.
    const kill = process.kill;
    let kills = 0;
    let births = 0;
    process.kill = (() => { kills += 1; throw new Error("historical PID must not be probed locally"); }) as typeof process.kill;
    platformProbes.processStartedAt = async () => { births += 1; throw new Error("historical birth must not be probed locally"); };
    try {
      for (const observedAt of [Date.parse(historicalOwner.takenAt) + 1000, now]) {
        const target = historicalFixture();
        let mutations = 0;
        const trap = async (): Promise<never> => { mutations += 1; throw new Error("historical observation attempted mutation"); };
        target.ctx.transport.exec = trap;
        target.ctx.transport.writeFile = trap;
        target.ctx.transport.mkdirp = trap;
        target.ctx.transport.remove = trap;
        const before = JSON.stringify([...target.files]);
        const directories = JSON.stringify([...target.dirs]);
        const facts = await observeInstanceLock(target.ctx, observedAt);
        check("actual historical current/old observation is remote legacy-by", [facts.state, facts.identitySource, facts.host, facts.pid, facts.takeover], ["remote", "legacy-by", "PC", 17012, "foreign-confirmation-required"]);
        check("actual historical age is retained without proving death", facts.ageMs, observedAt - Date.parse(historicalOwner.takenAt));
        check("actual historical public DTO excludes username and raw by", /Computer@|"by"/.test(JSON.stringify(facts)), false);
        check("actual historical advice is manual without argv", [facts.next?.kind, facts.next !== undefined && "argv" in facts.next], ["manual", false]);
        check("actual historical observer attempts zero mutations even through catches", mutations, 0);
        check("actual historical observer preserves bytes", JSON.stringify([...target.files]), before);
        check("actual historical observer preserves directories and claims", JSON.stringify([...target.dirs]), directories);
        check("actual historical observer preserves lock root", target.dirs.has(FIXTURE_LOCK_PATH), true);
      }
      const physical = historicalFixture({ ...historicalOwner, host: "PC", pid: 17012 });
      check("structured physical PC without PID scope is remote, never auto-dead", (await observeInstanceLock(physical.ctx, now)).state, "remote");
      await refusalConsumer("historical direct missing confirmation", historicalFixture(), { breakLock: true });
      const claimed = historicalFixture();
      await acquireOrTakeOver(claimed.ctx, { breakLock: true, breakForeignLockHost: "PC" });
      const root = FIXTURE_LOCK_PATH;
      check("historical exact both claims NEW EMPTY ROOT before publication", [claimed.dirs.has(root), [...claimed.files.keys()].filter((path) => path.startsWith(`${root}/`)), [...claimed.dirs].filter((path) => path.startsWith(`${root}/`))], [true, [], []]);
      check("historical and physical-only observer/acquirer never calls process.kill", kills, 0);
      check("historical and physical-only observer/acquirer never calls platform birth", births, 0);
    } finally { process.kill = kill; platformProbes.processStartedAt = original; }
  }

  const malformed: [string, unknown][] = [
    ["null record", null], ["array record", []], ["missing operation", { ...historicalOwner, operationId: "" }],
    ["missing timestamp", { ...historicalOwner, takenAt: undefined }], ["invalid timestamp", { ...historicalOwner, takenAt: "not-a-date" }],
  ];
  for (const field of ["host", "pid", "startedAt", "generation", "heartbeatAt"] as const) {
    for (const value of [null, undefined]) {
      // JSON omits undefined: use the reader directly to test OWN undefined, not absence.
      check(`own ${field}=${String(value)} never falls back to by`, readLockOwnerIdentity({ ...historicalOwner, [field]: value }), undefined);
      if (value === null) malformed.push([`null ${field}`, { ...historicalOwner, [field]: value }]);
    }
    malformed.push([`partial ${field}`, { ...historicalOwner, [field]: field === "pid" ? 17012 : field === "host" ? "PC" : field === "generation" ? "token" : "2026-09-19T20:53:51.503Z" }]);
  }
  for (const by of [
    "Computer@PC pid 017012", "Computer@PC pid 0", "Computer@PC pid -1",
    "Computer@PC pid 9007199254740992", "Computer@PC pid 17012 pid 2",
    "Computer@PC pid 17012\n", "Computer@PC pid 17012\r", "Computer@PC\u0000 pid 17012",
    "Computer@-PC pid 17012", "Computer@PC..invalid pid 17012", "Computer@PC:win32 pid 17012",
    "Computer@PC/unsafe pid 17012", "Computer@PC pid 17012 ", "Computer@PC pid 17012 extra",
    `${"a".repeat(65)}@PC pid 17012`, `Computer@${"a".repeat(64)} pid 17012`,
  ]) malformed.push([`unsafe by ${JSON.stringify(by)}`, { ...historicalOwner, by }]);
  for (const fields of [
    { host: "OTHER-PC", pid: 17012 }, { host: "PC", pid: 17013 },
    { host: "OTHER-PC", pid: 17012, generation: "valid-token" },
    { host: "PC", pid: 17012, generation: "valid-token" },
    { host: "PC:win32", pid: 17012 },
    { host: "PC:win32", pid: 17012, generation: "valid-token" },
    { host: "PC", pid: 17012, startedAt: null }, { host: "PC", pid: 17012, heartbeatAt: "bad" },
    { host: "PC", pid: 17012, generation: "" }, { host: "PC\n", pid: 17012 },
  ]) malformed.push([`mixed structured ${JSON.stringify(fields)}`, { ...historicalOwner, ...fields }]);
  for (const [label, record] of malformed) {
    check(`${label} shared identity reader refuses`, readLockOwnerIdentity(record), undefined);
    const target = historicalFixture(record);
    const before = JSON.stringify([[...target.files], [...target.dirs]]);
    const facts = await observeInstanceLock(target.ctx, now);
    check(`${label} observation preserves bytes directories and claims`, JSON.stringify([[...target.files], [...target.dirs]]), before);
    check(`${label} observation remains unknown without takeover`, [facts.state, facts.takeover, facts.host, facts.pid], ["unknown", "none", undefined, undefined]);
    await refusalConsumer(label, target, { breakLock: true, breakForeignLockHost: "PC" });
    const host = (record as { host?: unknown } | null)?.host;
    if (typeof host === "string") {
      await refusalConsumer(`${label} exact structured host cannot override`, historicalFixture(record), { breakLock: true, breakForeignLockHost: host });
    }
  }

  platformProbes.processStartedAt = async () => startedAt;
  for (const age of [1000, 86400000]) {
    const target = fixture(age);
    const facts = await observeInstanceLock(target.ctx, now);
    check("recent and old live owner is live", facts.state, "live");
    check("live owner has no takeover advice", facts.takeover, "none");
    await refusalConsumer("local live", target, { breakLock: true });
    await refusalConsumer("local live exact foreign flag cannot override", fixture(age), { breakLock: true, breakForeignLockHost: machineName() });
  }
  platformProbes.processStartedAt = async () => "2026-10-09T11:00:00Z";
  const reused = fixture(1000);
  check("reused PID is not original owner", (await observeInstanceLock(reused.ctx, now)).state, "dead");
  await refusalConsumer("reused owner without explicit break", reused, {});
  await acquireOrTakeOver(reused.ctx, { breakLock: true });
  check("dead explicit takeover claims an empty replacement directory", [reused.dirs.has(FIXTURE_LOCK_PATH), [...reused.files.keys()].filter((path) => path.startsWith(`${FIXTURE_LOCK_PATH}/`)), [...reused.dirs].filter((path) => path.startsWith(`${FIXTURE_LOCK_PATH}/`))], [true, [], []]);
  const foreign = fixture(86400000, "foreign:linux-123");
  check("foreign process is remote, not dead", (await observeInstanceLock(foreign.ctx, now)).state, "remote");
  await refusalConsumer("foreign without host confirmation", foreign, { breakLock: true });
  await refusalConsumer("foreign wrong confirmation", fixture(86400000, "foreign:linux-123"), { breakLock: true, breakForeignLockHost: "wrong-host" });
  const confirmedForeign = fixture(86400000, "foreign:linux-123");
  await acquireOrTakeOver(confirmedForeign.ctx, { breakLock: true, breakForeignLockHost: "foreign:linux-123" });
  check("foreign exact confirmation claims an empty replacement directory", [confirmedForeign.dirs.has(FIXTURE_LOCK_PATH), [...confirmedForeign.files.keys()].filter((path) => path.startsWith(`${FIXTURE_LOCK_PATH}/`)), [...confirmedForeign.dirs].filter((path) => path.startsWith(`${FIXTURE_LOCK_PATH}/`))], [true, [], []]);
  const uncertain = fixture(86400000);
  const kill = process.kill;
  process.kill = (() => { throw Object.assign(new Error("unavailable"), { code: "EIO" }); }) as typeof process.kill;
  try {
    check("old unknown owner cannot become dead", (await observeInstanceLock(uncertain.ctx, now)).state, "unknown");
    await refusalConsumer("local unknown", uncertain, { breakLock: true });
    await refusalConsumer("local unknown exact foreign flag cannot override", fixture(86400000), { breakLock: true, breakForeignLockHost: machineName() });
  } finally { process.kill = kill; }
  const dead = fixture(1000);
  const deadKill = process.kill;
  process.kill = (() => { throw Object.assign(new Error("fixture process absent"), { code: "ESRCH" }); }) as typeof process.kill;
  try {
    await refusalConsumer("dead without explicit break, supported", fixture(1000), { breakLockSupported: true });
    await refusalConsumer("nonbreak dead", dead, { breakLockSupported: false });
  } finally { process.kill = deadKill; }
  const target = fixture(1000);
  let attempts = 0;
  const trap = async (): Promise<never> => { attempts += 1; throw new Error("observation attempted mutation"); };
  target.ctx.transport.exec = trap;
  target.ctx.transport.writeFile = trap;
  target.ctx.transport.remove = trap;
  const before = JSON.stringify([...target.files]);
  const directories = JSON.stringify([...target.dirs]);
  await observeInstanceLock(target.ctx, now);
  check("observe never writes or executes transport mutations", JSON.stringify([...target.files]), before);
  check("read-only observer still reports reused owner through throwing mutation traps", (await observeInstanceLock(target.ctx, now)).state, "dead");
  check("observer never attempts mutations even when catches swallow traps", attempts, 0);
  check("observer preserves directories and claims", JSON.stringify([...target.dirs]), directories);
  check("observer preserves lock root", target.dirs.has(FIXTURE_LOCK_PATH), true);
  target.dirs.clear();
  target.files.clear();
  check("absent lock is explicit", (await observeInstanceLock(target.ctx, now)).state, "absent");
  target.dirs.add(FIXTURE_LOCK_PATH);
  check("unreadable holder remains unknown", (await observeInstanceLock(target.ctx, now)).state, "unknown");
  target.ctx.transport.exists = async () => { throw new Error("permission denied private-path"); };
  Object.defineProperty(target.ctx.transport, "existsEntry", { value: target.ctx.transport.exists });
  const unreadable = await observeInstanceLock(target.ctx, now);
  check("unreadable existence does not imply absent", unreadable.state, "unknown");
  check("unreadable existence permits no takeover", unreadable.takeover, "none");
  check("unreadable existence carries manual advice", unreadable.next?.kind, "manual");
  check("unreadable existence advice never guesses mutation argv", unreadable.next !== undefined && "argv" in unreadable.next, false);
  check("unreadable existence excludes private transport path", /private-path/.test(JSON.stringify(unreadable)), false);
} finally { platformProbes.processStartedAt = original; }
finish("instance-lock-observation");
