// Checks declaration/parser agreement, manual refusal actions, local owner liveness,
// and explicit foreign-host confirmation without pinning diagnostic prose.

import { openclawCommands } from "#framework/commands/interface/index.ts";
import {
  takeLock,
  readLockHolder,
  refusalMessage,
  guardedWith,
  lockPath,
  isStale,
  STALE_AFTER_MS,
  type LockHolder,
} from "#framework/runtime/lock/instance-lock.ts";
import { refusalAdvice } from "#framework/runtime/lock/lock-claim.ts";
import { machineName } from "#framework/runtime/lock/process-identity.ts";
import { stubContext, refused } from "./fixture.ts";
import { UserError } from "#framework/core/io/log.ts";
import { readFile } from "node:fs/promises";
import type { Context } from "#framework/core/context.ts";
import type { CommandArgument } from "#framework/core/app.ts";
import type { GateCommand } from "#framework/integration/gate.ts";
import { check, finish } from "#checks/kit/harness.ts";

function declaresBreakLock(name: string): boolean {
  return (openclawCommands[name]?.arguments ?? []).some((argument) => argument.name === "break-lock");
}

/** True once a declaration list carries `--break-foreign-lock` as a value-taking option — a
 *  flag whose whole point is a host id has no meaning as a bare boolean flag. Generic over
 *  `CommandArgument[]` so the same rule applies to an AppCommand's declaration
 *  (openclawCommands, checked exhaustively below) and to a GateCommand's (gate.ts's `check`/
 *  `new-app`/`init`, the same shape, declared before a deployment even exists). */
function declaresBreakForeignLockOption(args: readonly CommandArgument[] | undefined): boolean {
  const argument = (args ?? []).find((entry) => entry.name === "break-foreign-lock");
  return argument !== undefined && argument.kind === "option";
}

function declaresBreakForeignLock(name: string): boolean {
  return declaresBreakForeignLockOption(openclawCommands[name]?.arguments);
}

// --- every command whose guardedWith()/withLockUnlessHeld() call carries a takeover
// declares it, and every command that deliberately does not is left undeclared too ------------

for (const name of ["up", "restart", "down", "restore", "push", "apply", "rollback", "apply-config", "recipe", "provision-agent", "set", "bootstrap", "pull", "configure-provider"]) {
  check(`${name} declares --break-lock`, declaresBreakLock(name), true);
}
for (const name of ["secrets"]) {
  check(`${name} does not declare --break-lock (its own parser rejects it)`, declaresBreakLock(name), false);
}

// backup is a second deliberate asymmetry: bare `backup` (create) takes the lock but its own
// guardedWith() call passes breakLockSupported: false (see backup/index.ts) and its creation
// parser (BACKUP_ARGUMENTS) still rejects the flag, same as before; `prune-replaced --apply`
// is the one action that both reads and needs it, so the merged declaration
// (BACKUP_ALL_ARGUMENTS) carries it for that action alone.
check("backup declares --break-lock (for prune-replaced --apply only)", declaresBreakLock("backup"), true);

// --- hermetic: every command in openclawCommands that declares --break-lock also declares
// --break-foreign-lock, checked over the whole declaration rather than a fixed list, so a
// command added later cannot silently reintroduce the gap an orphaned foreign guard hit --------

for (const [name] of Object.entries(openclawCommands)) {
  if (!declaresBreakLock(name)) continue;
  check(`${name} (declares --break-lock) also declares --break-foreign-lock`, declaresBreakForeignLock(name), true);
}

// secrets is the one deliberate asymmetry: --apply is the only action that takes the instance
// lock, and its own parser never accepts --break-lock (see secrets.ts) — but an orphaned guard
// from another machine still needs a way out, so --break-foreign-lock is declared alone.
check("secrets declares --break-foreign-lock despite never declaring --break-lock", declaresBreakForeignLock("secrets"), true);

// The rule above is generic over any CommandArgument[], including a gate command's — the
// shape check/new-app/init declare before a deployment exists. None of the three takes the
// instance lock today, so none declares --break-lock; this proves the same helper would still
// catch the gap if one ever did, without needing to import gate.ts's own side-effecting entry
// points (tools/clawforge.ts, framework/entry/bin.ts) just to reach their gateCommands arrays.
{
  const brokenGateCommand: Pick<GateCommand, "arguments"> = {
    arguments: [{ name: "break-lock", description: "x", kind: "flag" }],
  };
  check(
    "a gate-shaped declaration with --break-lock but no --break-foreign-lock is caught",
    declaresBreakForeignLockOption(brokenGateCommand.arguments),
    false,
  );
  const fixedGateCommand: Pick<GateCommand, "arguments"> = {
    arguments: [
      { name: "break-lock", description: "x", kind: "flag" },
      { name: "break-foreign-lock", description: "x", kind: "option" },
    ],
  };
  check(
    "and a matching --break-foreign-lock <hostId> option satisfies it",
    declaresBreakForeignLockOption(fixedGateCommand.arguments),
    true,
  );
}

// --- the message itself only ever names a flag the caller says is supported -------------------

{
  // A stale holder (heartbeatAt absent, taken long past STALE_AFTER_MS): --break-lock is
  // actually on the table here, so it is the case worth telling supported from unsupported.
  const holder: LockHolder = {
    operationId: "op-1", what: "apply", by: "coder@box pid 1",
    takenAt: new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString(), host: machineName(), pid: 99999999,
  };
  const supported = refusalMessage(holder, Date.now(), true);
  check("supported: advises --break-lock", supported.includes("--break-lock"), true);
  const advice = refusalAdvice(holder, false);
  check("unsupported takeover is a manual decision", advice.kind, "manual");
  check("unsupported advice never invents mutation argv", "argv" in advice, false);
}

{
  // A live, recently-refreshed holder is a different case entirely: `recipe install` can hold
  // this lock for a whole build, and it is never told to break its own lock over that.
  const holder: LockHolder = {
    operationId: "op-live-fresh", what: "recipe install", by: "coder@box pid 1",
    takenAt: new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString(), heartbeatAt: new Date().toISOString(),
  };
  const message = refusalMessage(holder);
  check("a live heartbeat overrides an old takenAt", isStale(holder), false);
  check("and is never advised to break its own lock", message.includes("--break-lock"), false);
}

{
  const advice = refusalAdvice(undefined, false);
  check("unreadable-holder remediation is manual", advice.kind, "manual");
  check("unreadable-holder remediation has no mutation argv", "argv" in advice, false);
}

// --- only confirmed dead local owners permit explicit takeover -------------------------------

for (const state of ["dead-local", "foreign", "live-local"] as const) {
  const { ctx, files, dirs } = stubContext();
  const holder: LockHolder = {
    operationId: `op-${state}`, what: "apply", by: "owner",
    takenAt: new Date().toISOString(),
    host: state === "foreign" ? `${machineName()}-not-this-one` : machineName(),
    pid: state === "live-local" ? process.pid : 99999999,
  };
  const original = JSON.stringify(holder);
  dirs.add(lockPath(ctx));
  files.set(`${lockPath(ctx)}/holder.json`, original);
  let entered = false;
  let failure: unknown;
  const message = await refused(async () => {
    try { await guardedWith(ctx, "apply", { breakLock: false }, async () => { entered = true; }); }
    catch (error) { failure = error; throw error; }
  });
  check(`${state}: ordinary acquisition is a user refusal`, failure instanceof UserError, true);
  check(`${state}: ordinary acquisition never enters body`, entered, false);
  check(`${state}: ordinary acquisition preserves holder bytes`, files.get(`${lockPath(ctx)}/holder.json`), original);
  check(`${state}: refusal action is manual`, (failure as UserError).advice.map(entry => entry.kind), ["manual"]);
  check(`${state}: refusal action has no mutation argv`, (failure as UserError).advice.some(entry => "argv" in entry), false);
  check(`${state}: explicit takeover flag eligibility`, message.includes("--break-lock"), state !== "live-local");
  if (state === "foreign") check("foreign refusal requires host-confirmation flag", message.includes("--break-foreign-lock"), true);

  if (state === "dead-local") {
    const held = await takeLock(ctx, "apply", "replacement", { breakLock: true });
    check("confirmed dead local owner permits explicit takeover", (await readLockHolder(ctx))?.operationId, "replacement");
    await held.release();
  } else {
    failure = undefined;
    await refused(async () => {
      try { await guardedWith(ctx, "apply", { breakLock: true }, async () => { entered = true; }); }
      catch (error) { failure = error; throw error; }
    });
    check(`${state}: unconfirmed takeover is a user refusal`, failure instanceof UserError, true);
    check(`${state}: unconfirmed takeover never enters body`, entered, false);
    check(`${state}: unconfirmed takeover preserves holder bytes`, files.get(`${lockPath(ctx)}/holder.json`), original);
  }
}

// --- bootstrap/pull: the parser itself, not just the declaration, now accepts --break-lock ----
//
// Before this fix, bootstrap's and pull's own argument loops died on "unknown argument:
// --break-lock" before guardedWith()/withLockUnlessHeld() ever read it — declaring the flag alone
// would not have made `./clawforge bootstrap --break-lock` work. Passing a second, genuinely
// unknown flag alongside it and asserting the die() names THAT one (never --break-lock) proves
// break-lock itself parses cleanly, without needing to stand up bootstrap's whole environment:
// the parse loop runs synchronously before any transport call.

{
  let message = "";
  try {
    await openclawCommands.bootstrap.run({} as unknown as Context, ["--break-lock", "--totally-unknown-flag"]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("bootstrap's own parser accepts --break-lock", message.includes("--break-lock"), false);
  check("and still rejects a genuinely unknown flag", message.includes("--totally-unknown-flag"), true);
}

{
  let message = "";
  try {
    await openclawCommands.bootstrap.run({} as unknown as Context, ["--break-foreign-lock", "some-host", "--totally-unknown-flag"]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("bootstrap's own parser accepts --break-foreign-lock <hostId>", message.includes("--break-foreign-lock"), false);
  check("without swallowing the host id as an unknown flag", message.includes("some-host"), false);
  check("and still rejects a genuinely unknown flag after it", message.includes("--totally-unknown-flag"), true);
}

{
  let message = "";
  try {
    await openclawCommands.pull.run({} as unknown as Context, ["--break-lock", "--totally-unknown-flag"]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("pull's own parser accepts --break-lock", message.includes("--break-lock"), false);
  check("and still rejects a genuinely unknown flag", message.includes("--totally-unknown-flag"), true);
}

// backup and smoke refuse --break-lock at their own parsers, matching the
// breakLockSupported: false their lock call sites pass — the refusal must come from
// the parser naming the flag, not silently accepting it.

{
  let message = "";
  try {
    await openclawCommands.backup.run({} as unknown as Context, ["--break-lock", "--totally-unknown-flag"]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("backup's own parser rejects --break-lock", message.includes("--break-lock"), true);
}

{
  let message = "";
  try {
    await openclawCommands.smoke.run({} as unknown as Context, ["--break-lock", "--totally-unknown-flag"]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("smoke's own parser rejects --break-lock", message.includes("--break-lock"), true);
}

// --- guardedWith takes a foreign mutation guard over when given the host id --------------------

{
  const { ctx, files, dirs } = stubContext();
  const home = lockPath(ctx).replace(/\/operation\.lock$/, "");
  const guard = `${home}/operation.mutation`;
  const foreignMachine = `${machineName()}-elsewhere`;
  dirs.add(guard);
  files.set(`${guard}/owner.json`, JSON.stringify({ generation: "g", pid: 12345, machine: foreignMachine, takenAt: new Date().toISOString() }));

  let ranBody = false;
  let threw: Error | undefined;
  try {
    await guardedWith(ctx, "up", { breakLock: false, breakForeignLockHost: foreignMachine }, async () => {
      ranBody = true;
    });
  } catch (error) {
    threw = error as Error;
  }
  check("guardedWith takes a foreign guard over with an explicit host id", ranBody, true);
  check("without refusing", threw, undefined);
  check("and the guard it took over is cleaned up afterwards", dirs.has(guard), false);
}

// smoke declares no --break-lock, so each lock its run takes (the archive window, the
// standalone round-trip — both in smoke/round-trip.ts) must say so — a merge once dropped
// it from the archive window.
{
  const optsOut = (source: string): string[] => source.split("guardedWith(ctx,").slice(1);
  const smokeSource = await readFile(new URL("../../../../framework/commands/lifecycle/smoke/round-trip.ts", import.meta.url), "utf8");
  const smokeCalls = optsOut(smokeSource);
  check("smoke still takes the instance lock somewhere", smokeCalls.length > 0, true);
  check("every smoke lock opts out of --break-lock advice smoke cannot accept",
    declaresBreakLock("smoke") || smokeCalls.every((call) => (call.split("\nasync function ")[0] ?? "").includes("breakLockSupported: false")), true);

  const backupSource = await readFile(new URL("../../../../framework/commands/lifecycle/backup/index.ts", import.meta.url), "utf8");
  const backupCalls = optsOut(backupSource);
  check("backup still takes the instance lock somewhere", backupCalls.length > 0, true);
  check("backup's create-path lock opts out too (its parser rejects --break-lock)",
    backupCalls.every((call) => (call.split("\nasync function ")[0] ?? "").includes("breakLockSupported: false")), true);
}

finish("instance lock advice");
