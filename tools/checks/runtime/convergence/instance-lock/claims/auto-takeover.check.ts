// Automatic takeover of a lock whose own record proves its owner dead: a different boot id
// (the machine rebooted since the claim), or on the same boot a gone pid or a start identity
// that clearly disagrees (pid reuse). Also the refusals that must survive unchanged: a failed
// boot probe, a legacy record, a foreign host, an unknown pid namespace, a live owner, an
// incomparable boot source, malformed boot fields, an EPERM liveness check and a failed
// start-identity probe. Every scenario injects synthetic probe answers — the real host boot
// never influences a result.

import { machineName, platformProbes, START_TIME_TOLERANCE_MS, type ProcessStartIdentity } from "#framework/runtime/lock/process-identity.ts";
import { proveOwnerDead } from "#framework/runtime/lock/lock-claim.ts";
import { takeLock, readLockHolder } from "#framework/runtime/lock/instance-lock.ts";
import { stubContext, captureFailure, FIXTURE_LOCK_PATH, type LockFixture } from "../fixture.ts";
import { UserError } from "#framework/core/io/log.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { withOutputSink } from "#framework/core/io/output.ts";

const OLD_OPERATION_ID = "op-old";

/** A modern holder recorded an hour ago: local host (host proves machine AND pid namespace),
 *  pid, start identity, heartbeat — the grammar proveOwnerDead demands before it will act.
 *  Native `tick` start identity by default; scenarios wanting an approximate record delete
 *  `startKey`/`startSource` themselves. */
function baseHolder() {
  const anHourAgo = new Date(Date.now() - 60 * 3600_000).toISOString();
  return {
    operationId: OLD_OPERATION_ID,
    what: "restart",
    by: `someone@${machineName()} pid 17012`,
    takenAt: anHourAgo,
    generation: "g1",
    host: machineName(),
    pid: 17012,
    startedAt: anHourAgo,
    startKey: "tick:424242",
    startSource: "native",
    heartbeatAt: anHourAgo,
  };
}

const RECORDED_BOOT = "linux:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CURRENT_BOOT = "linux:11111111-2222-3333-4444-555555555555";

interface ProbeOptions {
  holder: Record<string, unknown>;
  bootIdentity: () => Promise<string | undefined>;
  kill?: (pid: number, signal: 0) => void;
  processStartIdentity: (pid: number) => Promise<ProcessStartIdentity | undefined>;
}

/** Seeds a held lock and patches the swappable probes; everything is restored in finally.
 *  The fixture is handed to the body so probe-dependent work runs while patched. */
async function withFixture(options: ProbeOptions, body?: (fixture: LockFixture) => Promise<void>) {
  const { ctx, files, dirs } = stubContext();
  dirs.add(FIXTURE_LOCK_PATH);
  files.set(`${FIXTURE_LOCK_PATH}/holder.json`, JSON.stringify(options.holder));
  const originalBoot = platformProbes.bootIdentity;
  const originalStartIdentity = platformProbes.processStartIdentity;
  const originalKill = process.kill;
  platformProbes.bootIdentity = options.bootIdentity;
  platformProbes.processStartIdentity = options.processStartIdentity;
  if (options.kill !== undefined) process.kill = ((pid: number, signal: 0) => { options.kill!(pid, signal); }) as typeof process.kill;
  try {
    await body?.({ ctx, files, dirs });
  } finally {
    platformProbes.bootIdentity = originalBoot;
    platformProbes.processStartIdentity = originalStartIdentity;
    process.kill = originalKill;
  }
  return { ctx, files, dirs };
}

async function proveWith(options: ProbeOptions) {
  let proof: Awaited<ReturnType<typeof proveOwnerDead>> | undefined;
  await withFixture(options, async ({ ctx }) => {
    proof = await proveOwnerDead(options.holder as never);
    void ctx;
  });
  return proof!;
}

/** Runs takeLock against the seeded lock INSIDE the patched fixture, capturing the failure. */
async function refusedWith(options: ProbeOptions) {
  let failure: unknown;
  const { ctx, files, dirs } = await withFixture(options, async (fixture) => {
    failure = await captureFailure(() => takeLock(fixture.ctx, "restart", "op-new").then((held) => held.release()));
  });
  return { failure, ctx, files, dirs };
}

function preserved(files: Map<string, string>, dirs: Set<string>): unknown[] {
  return [
    (JSON.parse(files.get(`${FIXTURE_LOCK_PATH}/holder.json`) ?? "{}") as { operationId?: string }).operationId,
    dirs.has(FIXTURE_LOCK_PATH),
  ];
}

/** Default start identity for an acquisition: a native tick record. */
const NATIVE_ACQUISITION = async (): Promise<ProcessStartIdentity> =>
  ({ startedAt: new Date().toISOString(), key: "tick:1", source: "native" });

// --- 1. a different boot id: the machine rebooted since the claim --------------------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  const proof = await proveWith({
    holder, bootIdentity: async () => CURRENT_BOOT, processStartIdentity: NATIVE_ACQUISITION,
  });
  check("a different boot proves death as rebooted", [proof.proven, proof.reason], [true, "rebooted"]);

  let output = "";
  let newHolder: { operationId?: string; startSource?: string; generation?: string } = {};
  let lockRootKept = false;
  await withFixture({ holder, bootIdentity: async () => CURRENT_BOOT, processStartIdentity: NATIVE_ACQUISITION },
    async ({ ctx, files, dirs }) => {
      let entered = false;
      await withOutputSink((chunk) => { output += chunk; }, async () => {
        const held = await takeLock(ctx, "restart", "op-new");
        entered = true;
        // State is read before release: releasing removes the holder and the lock directory.
        newHolder = JSON.parse(files.get(`${FIXTURE_LOCK_PATH}/holder.json`) ?? "{}") as {
          operationId?: string; startSource?: string; generation?: string;
        };
        lockRootKept = dirs.has(FIXTURE_LOCK_PATH);
        await held.release();
      });
      check("a rebooted owner is taken over without --break-lock", entered, true);
      check("the new holder names the new operation with a native start record",
        [newHolder.operationId, newHolder.startSource], ["op-new", "native"]);
      check("the old generation is gone", newHolder.generation === "g1", false);
      check("the notice names the old operation id and the reason",
        [output.includes(OLD_OPERATION_ID), output.includes("rebooted")], [true, true]);
      check("the lock directory survives as ours", lockRootKept, true);
    });
}

// --- 2. same boot, recorded pid is gone -----------------------------------------------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  const kill = (_pid: number, signal: 0) => {
    check("the liveness probe uses signal 0 only", signal, 0);
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  };
  const proof = await proveWith({ holder, bootIdentity: async () => RECORDED_BOOT, kill, processStartIdentity: NATIVE_ACQUISITION });
  check("a gone pid on the same boot proves death as process-gone", [proof.proven, proof.reason], [true, "process-gone"]);

  await withFixture({ holder, bootIdentity: async () => RECORDED_BOOT, kill, processStartIdentity: NATIVE_ACQUISITION },
    async ({ ctx }) => {
      const held = await takeLock(ctx, "restart", "op-new");
      check("a process-gone owner is taken over automatically", (await readLockHolder(ctx))?.operationId, "op-new");
      await held.release();
    });
}

// --- 3. same boot, pid alive with a different native start identity (pid reuse) ---------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  const proof = await proveWith({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => {},
    processStartIdentity: async () => ({ startedAt: "2000-01-01T00:00:00Z", key: "tick:999999", source: "native" }),
  });
  check("a different native start key on the same boot proves pid-reused", [proof.proven, proof.reason], [true, "pid-reused"]);

  const subProof = await proveWith({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => {},
    processStartIdentity: async () => ({ startedAt: holder.startedAt as string, key: "tick:424242", source: "native" }),
  });
  check("an equal native start key is a live owner, not proof", [subProof.proven, subProof.reason], [false, undefined]);

  await withFixture({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => {},
    processStartIdentity: async () => ({ startedAt: "2000-01-01T00:00:00Z", key: "tick:999999", source: "native" }),
  }, async ({ ctx }) => {
    const held = await takeLock(ctx, "restart", "op-new");
    check("a pid-reused owner is taken over automatically", (await readLockHolder(ctx))?.operationId, "op-new");
    await held.release();
  });
}

// --- 4. approximate records: the start-time tolerance still decides --------------------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  delete (holder as Record<string, unknown>).startKey;
  holder.startSource = "approximate";
  const proof = await proveWith({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => {},
    processStartIdentity: async () =>
      ({ startedAt: new Date(Date.parse(holder.startedAt as string) + 2 * START_TIME_TOLERANCE_MS).toISOString(), source: "approximate" }),
  });
  check("an approximate start beyond the tolerance proves pid-reused", [proof.proven, proof.reason], [true, "pid-reused"]);

  const jitter = await proveWith({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => {},
    processStartIdentity: async () =>
      ({ startedAt: new Date(Date.parse(holder.startedAt as string) + START_TIME_TOLERANCE_MS / 3).toISOString(), source: "approximate" }),
  });
  check("jitter within START_TIME_TOLERANCE_MS keeps an approximate owner safe",
    [jitter.proven, jitter.reason], [false, undefined]);
}

// --- 5. the boot probe cannot answer: never proves death -------------------------------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  const { failure, files, dirs } = await refusedWith({ holder, bootIdentity: async () => undefined, processStartIdentity: NATIVE_ACQUISITION });
  check("a failed boot probe refuses instead of taking over", failure instanceof UserError, true);
  check("a failed boot probe preserves the holder and lock root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 6. legacy record without the identity fields ----------------------------------------------------

{
  const legacy: Record<string, unknown> = { ...baseHolder() };
  delete legacy.bootId;
  delete legacy.startedAt;
  delete legacy.startKey;
  delete legacy.startSource;
  const { failure, files, dirs } = await refusedWith({ holder: legacy, bootIdentity: async () => CURRENT_BOOT, processStartIdentity: NATIVE_ACQUISITION });
  check("a legacy record is refused, not taken over", failure instanceof UserError, true);
  check("a legacy record refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 7. foreign host ---------------------------------------------------------------------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT, host: "other-host:linux-1234" };
  const { failure, files, dirs } = await refusedWith({ holder, bootIdentity: async () => CURRENT_BOOT, processStartIdentity: NATIVE_ACQUISITION });
  check("a foreign host is refused even with a boot id", failure instanceof UserError, true);
  check("a foreign host refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 8. same boot, pid alive with the recorded native start identity: a live owner --------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  const { failure, files, dirs } = await refusedWith({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => {},
    processStartIdentity: async () => ({ startedAt: holder.startedAt as string, key: "tick:424242", source: "native" }),
  });
  check("a live owner with the recorded start identity is refused", failure instanceof UserError, true);
  check("a live owner refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 9. boot probe answers with a different SOURCE: never compared ------------------------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  const { failure, files, dirs } = await refusedWith({
    holder,
    bootIdentity: async () => "mac:2026-10-15T04:12:00Z",
    kill: () => {},
    processStartIdentity: async () => ({ startedAt: "2000-01-01T00:00:00Z", key: "tick:999999", source: "native" }),
  });
  check("a different-source boot id is not compared and not proof", failure instanceof UserError, true);
  check("a source-mismatch refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 10. malformed boot id in the record: not proof ---------------------------------------------------

for (const invalid of ["--------", "mac:2026-02-30T04:12:00Z"]) {
  const holder = { ...baseHolder(), bootId: invalid };
  const { failure, files, dirs } = await refusedWith({ holder, bootIdentity: async () => CURRENT_BOOT, processStartIdentity: NATIVE_ACQUISITION });
  check(`a malformed boot id (${invalid}) is refused, not taken over`, failure instanceof UserError, true);
  check(`a malformed boot id (${invalid}) preserves holder and root`, preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 11. unknown PID namespace: never our process table ------------------------------------------------

{
  // Derived from machineName()'s own scope rather than the host platform: the refusal must
  // treat a same-host record from ANY other pid scope as unknown, never as dead.
  const own = machineName();
  const baseHost = own.slice(0, own.lastIndexOf(":"));
  const host = `${baseHost}:${own.endsWith(":win32") ? "linux-4026531836" : "win32"}`;
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT, host };
  const { failure, files, dirs } = await refusedWith({ holder, bootIdentity: async () => CURRENT_BOOT, processStartIdentity: NATIVE_ACQUISITION });
  check("a same-host record from another pid namespace is refused", failure instanceof UserError, true);
  check("an unknown-namespace refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 12. liveness check fails with EPERM: not proof of death --------------------------------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  const { failure, files, dirs } = await refusedWith({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); },
    processStartIdentity: NATIVE_ACQUISITION,
  });
  check("an EPERM liveness check refuses instead of proving death", failure instanceof UserError, true);
  check("an EPERM refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 13. the start-identity probe cannot answer: never proves death --------------------------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  const { failure, files, dirs } = await refusedWith({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => {},
    processStartIdentity: async () => undefined,
  });
  check("a failed start-identity probe refuses instead of proving death", failure instanceof UserError, true);
  check("a failed start-identity refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 14. malformed native startKey on the record: doubt, never the approximate fallback -------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT, startKey: "tick:garbage", startSource: "native" };
  const { failure, files, dirs } = await refusedWith({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => {},
    // Wildly different startedAt: if the approximate comparison ran, this would prove death.
    processStartIdentity: async () => ({ startedAt: "1990-01-01T00:00:00Z", key: "tick:999999", source: "native" }),
  });
  check("a malformed record startKey refuses instead of falling back to the approximate comparison", failure instanceof UserError, true);
  check("a malformed startKey refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 15. approximate record vs a native probe answer: incomparable sides, refusal --------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  delete (holder as Record<string, unknown>).startKey;
  holder.startSource = "approximate";
  const { failure, files, dirs } = await refusedWith({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => {},
    processStartIdentity: async () => ({ startedAt: "1990-01-01T00:00:00Z", key: "tick:999999", source: "native" }),
  });
  check("a native probe answer against an approximate record is refused", failure instanceof UserError, true);
  check("a native-vs-approximate refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 16. native record vs an approximate probe answer: incomparable sides, refusal -------------------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  const { failure, files, dirs } = await refusedWith({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => {},
    processStartIdentity: async () => ({ startedAt: "1990-01-01T00:00:00Z", source: "approximate" }),
  });
  check("an approximate probe answer against a native record is refused", failure instanceof UserError, true);
  check("an approximate-vs-native refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 17. positive same-source Windows boot change -----------------------------------------------------

{
  const holder = { ...baseHolder(), bootId: "win:2026-01-01T00:00:00Z", startKey: "win:2026-01-01T00:00:00Z" };
  const proof = await proveWith({
    holder,
    bootIdentity: async () => "win:2026-06-01T00:00:00Z",
    kill: () => {},
    processStartIdentity: NATIVE_ACQUISITION,
  });
  check("a same-source Windows boot change proves death as rebooted", [proof.proven, proof.reason], [true, "rebooted"]);
}

// --- 18. impossible mac date in the record: the date validator rejects it, not the source -------------

{
  const holder = { ...baseHolder(), bootId: "mac:2026-02-30T04:12:00Z" };
  const { failure, files, dirs } = await refusedWith({
    holder,
    bootIdentity: async () => "mac:2026-10-15T04:12:00Z",
    kill: () => {},
    processStartIdentity: NATIVE_ACQUISITION,
  });
  check("an impossible mac date in the record is refused even on a matching mac boot", failure instanceof UserError, true);
  check("an impossible mac date refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

// --- 19. native-marked record without a key vs an approximate answer: incomplete, refusal --------

{
  const holder = { ...baseHolder(), bootId: RECORDED_BOOT };
  delete (holder as Record<string, unknown>).startKey;
  holder.startSource = "native";
  const { failure, files, dirs } = await refusedWith({
    holder,
    bootIdentity: async () => RECORDED_BOOT,
    kill: () => {},
    processStartIdentity: async () => ({ startedAt: "1990-01-01T00:00:00Z", source: "approximate" }),
  });
  check("a native-marked keyless record never reaches the drift comparison", failure instanceof UserError, true);
  check("a keyless native record refusal preserves holder and root", preserved(files, dirs), [OLD_OPERATION_ID, true]);
}

finish("instance lock auto-takeover");
