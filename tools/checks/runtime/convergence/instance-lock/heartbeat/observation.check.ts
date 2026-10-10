import { observeInstanceLock, lockPath, withInstanceLock } from "#framework/runtime/lock/instance-lock.ts";
import { acquireOrTakeOver, type LockOptions } from "#framework/runtime/lock/lock-claim.ts";
import { machineName, platformProbes } from "#framework/runtime/lock/process-identity.ts";
import { stubContext, type LockFixture } from "../fixture.ts";
import { UserError } from "#framework/core/io/log.ts";
import type { Context } from "#framework/core/context.ts";
import { secrets } from "#framework/commands/management/secrets.ts";
import { check, finish } from "#checks/kit/harness.ts";

const original = platformProbes.processStartedAt;
const now = Date.parse("2026-10-09T12:00:00Z");
const startedAt = "2026-10-09T10:00:00Z";
function fixture(age: number, host = machineName()) {
  const target = stubContext();
  const path = lockPath(target.ctx);
  target.dirs.add(path);
  target.files.set(`${path}/holder.json`, JSON.stringify({ operationId: "op-fixture", what: "apply", by: "fixture", host, pid: process.pid, startedAt, takenAt: new Date(now - age).toISOString(), heartbeatAt: new Date(now - age).toISOString(), generation: "fixture" }));
  target.ctx.transport.exists = async (name) => target.dirs.has(name) || target.files.has(name);
  return target;
}
function mutationOperationsInAdvice(advice: string): string[] {
  const words = (advice.match(/\S+/g) ?? []).map((word) => word.replace(/^[^a-zA-Z0-9_-]+|[^a-zA-Z0-9_-]+$/g, ""));
  const commandNames = ["up", "restart", "lock"];
  return words.filter((word, index) => commandNames.includes(word) && words[index + 1] === "--break-lock");
}

async function refusalConsumer(label: string, target: LockFixture, options: LockOptions): Promise<string> {
  const before = JSON.stringify([...target.files]);
  let takeovers = 0;
  const exec = target.ctx.transport.exec.bind(target.ctx.transport);
  target.ctx.transport.exec = async (command, args, execution) => {
    if (command === "mv" || command === "rm") takeovers += 1;
    return exec(command, args, execution);
  };
  let thrown: unknown;
  let bodyCalls = 0;
  try {
    await withInstanceLock(target.ctx, label, "refusal-fixture", options, async () => { bodyCalls += 1; });
  } catch (error) { thrown = error; }
  check(`${label} refusal never runs operation body`, bodyCalls, 0);
  check(`${label} acquisition refuses with UserError`, thrown instanceof UserError, true);
  const advice = thrown instanceof UserError ? thrown.advice : [];
  check(`${label} refusal carries one manual advice`, advice.map((entry) => entry.kind), ["manual"]);
  check(`${label} refusal never guesses mutation argv`, advice.some((entry) => "argv" in entry), false);
  check(`${label} refusal does not displace or delete the owner`, takeovers, 0);
  check(`${label} refusal preserves holder record`, JSON.stringify([...target.files]), before);
  return advice.filter((entry) => entry.kind === "manual").map((entry) => entry.text).join("\n");
}

for (const [advice, operations] of [
  ["up --break-lock", ["up"]],
  ["restart --break-lock", ["restart"]],
  ["lock --break-lock", ["lock"]],
  ["up --break-lock.", ["up"]],
  ["restart --break-lock,", ["restart"]],
  ["lock --break-lock,", ["lock"]],
  ["'up --break-lock'.", ["up"]],
  ['"restart --break-lock",', ["restart"]],
  ["`lock --break-lock`.", ["lock"]],
  ["up\n--break-lock.", ["up"]],
  ["restart\n--break-lock,", ["restart"]],
  ["lock\n--break-lock.", ["lock"]],
  ["Rerun the intended operation with --break-lock.", []],
  ["This command does not accept --break-lock; choose an intended operation supporting explicit takeover.", []],
  ["Wait for the owner; unknown owners cannot be taken over by age.", []],
  ["backup --break-lock, startup --break-lock, up --break-lock-extra", []],
] satisfies [string, string[]][]) {
  check(`advice helper operation/flag relationship ${JSON.stringify(advice)}`, mutationOperationsInAdvice(advice), operations);
}

const contextAccesses = { get: 0, has: 0, ownKeys: 0 };
const parserContext: Context = new Proxy(stubContext().ctx, {
  get() { contextAccesses.get += 1; throw new Error("parser accessed context"); },
  has() { contextAccesses.has += 1; throw new Error("parser inspected context"); },
  ownKeys() { contextAccesses.ownKeys += 1; throw new Error("parser enumerated context"); },
});
let parserError: unknown;
try {
  await secrets(parserContext, ["--apply", "--break-lock"]);
} catch (error) { parserError = error; }
check("secrets parser refuses unsupported break-lock with UserError", parserError instanceof UserError, true);
check("secrets parser refuses unsupported break-lock before context access", contextAccesses, { get: 0, has: 0, ownKeys: 0 });

try {
  platformProbes.processStartedAt = async () => startedAt;
  for (const age of [1000, 86400000]) {
    const target = fixture(age);
    const facts = await observeInstanceLock(target.ctx, now);
    check("recent and old live owner is live", facts.state, "live");
    check("live owner has no takeover advice", facts.takeover, "none");
    await refusalConsumer("local live", target, { breakLock: true });
  }
  platformProbes.processStartedAt = async () => "2026-10-09T11:00:00Z";
  const reused = fixture(1000);
  check("reused PID is not original owner", (await observeInstanceLock(reused.ctx, now)).state, "dead");
  await refusalConsumer("reused owner without explicit break", reused, {});
  await acquireOrTakeOver(reused.ctx, { breakLock: true });
  check("dead explicit takeover claims an empty replacement directory", [reused.dirs.has(lockPath(reused.ctx)), reused.files.has(`${lockPath(reused.ctx)}/holder.json`)], [true, false]);
  const foreign = fixture(86400000, "foreign:linux-123");
  check("foreign process is remote, not dead", (await observeInstanceLock(foreign.ctx, now)).state, "remote");
  await refusalConsumer("foreign without host confirmation", foreign, { breakLock: true });
  const wrongForeignAdvice = await refusalConsumer("foreign wrong confirmation", fixture(86400000, "foreign:linux-123"), { breakLock: true, breakForeignLockHost: "wrong-host" });
  check("foreign refusal advice requires exact recorded host", ((match) => [match?.[1], match?.[2] ?? match?.[3]])(/(?:^|\s)(--break-foreign-lock)\s+(?:"([^"]+)"|([^\s".,]+))(?=\s|$|[.,])/.exec(wrongForeignAdvice)), ["--break-foreign-lock", "foreign:linux-123"]);
  await acquireOrTakeOver(foreign.ctx, { breakLock: true, breakForeignLockHost: "foreign:linux-123" });
  check("foreign exact confirmation claims an empty replacement directory", [foreign.dirs.has(lockPath(foreign.ctx)), foreign.files.has(`${lockPath(foreign.ctx)}/holder.json`)], [true, false]);
  const uncertain = fixture(86400000);
  const kill = process.kill;
  process.kill = (() => { throw Object.assign(new Error("unavailable"), { code: "EIO" }); }) as typeof process.kill;
  try {
    check("old unknown owner cannot become dead", (await observeInstanceLock(uncertain.ctx, now)).state, "unknown");
    await refusalConsumer("local unknown", uncertain, { breakLock: true });
  } finally { process.kill = kill; }
  const dead = fixture(1000);
  const deadKill = process.kill;
  process.kill = (() => { throw Object.assign(new Error("fixture process absent"), { code: "ESRCH" }); }) as typeof process.kill;
  try {
    const supportedAdvice = await refusalConsumer("dead without explicit break, supported", fixture(1000), { breakLockSupported: true });
    check("supported dead refusal names only explicit takeover permission", /--break-lock/.test(supportedAdvice), true);
    check("supported dead refusal never invents a mutation operation", mutationOperationsInAdvice(supportedAdvice), []);
    const adviceText = await refusalConsumer("nonbreak dead", dead, { breakLockSupported: false });
    const deadFacts = await observeInstanceLock(dead.ctx, now);
    check("nonbreak refusal retains independently proven death", deadFacts.state, "dead");
    check("nonbreak refusal leaves explicit permission necessary", deadFacts.takeover, "explicit-break-lock");
    check("nonbreak dead refusal never substitutes an arbitrary operation", mutationOperationsInAdvice(adviceText), []);
  } finally { process.kill = deadKill; }
  const target = fixture(1000);
  let attempts = 0;
  const trap = async (): Promise<never> => { attempts += 1; throw new Error("observation attempted mutation"); };
  target.ctx.transport.exec = trap;
  target.ctx.transport.writeFile = trap;
  target.ctx.transport.remove = trap;
  const before = JSON.stringify([...target.files]);
  await observeInstanceLock(target.ctx, now);
  check("observe never writes or executes transport mutations", JSON.stringify([...target.files]), before);
  check("read-only observer still reports reused owner through throwing mutation traps", (await observeInstanceLock(target.ctx, now)).state, "dead");
  check("observer never attempts mutations even when catches swallow traps", attempts, 0);
  target.dirs.clear();
  target.files.clear();
  check("absent lock is explicit", (await observeInstanceLock(target.ctx, now)).state, "absent");
  target.dirs.add(lockPath(target.ctx));
  check("unreadable holder remains unknown", (await observeInstanceLock(target.ctx, now)).state, "unknown");
  target.ctx.transport.exists = async () => { throw new Error("permission denied private-path"); };
  const unreadable = await observeInstanceLock(target.ctx, now);
  check("unreadable existence does not imply absent", unreadable.state, "unknown");
  check("unreadable existence permits no takeover", unreadable.takeover, "none");
  check("unreadable existence carries manual advice", unreadable.next?.kind, "manual");
  check("unreadable existence advice never guesses mutation argv", unreadable.next !== undefined && "argv" in unreadable.next, false);
} finally { platformProbes.processStartedAt = original; }
finish("instance-lock-observation");
