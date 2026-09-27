// UX-04: a refusal must never advise a flag the refused command does not accept.
//
// `refusalMessage`/`unreadableLockMessage` take a `breakLockSupported` flag from the calling
// command's own `guarded()`/`withLockUnlessHeld()` call site (instance-lock.ts) rather than
// always assuming --break-lock is executable. This file cross-references that against
// openclawCommands' own declarations (the same list --help, the MCP schema and argv
// validation read — commands/interface/index.ts), proves the message wording actually changes
// with the flag, proves the new pid-liveness fact in refusalMessage (task #33) fires only for
// a holder recorded on THIS machine, and proves bootstrap/pull's own parsers — which used to
// reject --break-lock before this fix even reached guarded() — now let it through.

import { openclawCommands } from "#framework/commands/interface/index.ts";
import {
  refusalMessage,
  unreadableLockMessage,
  guarded,
  parseBreakForeignLockHost,
  lockPath,
  type LockHolder,
} from "#framework/runtime/instance-lock.ts";
import { machineName } from "#framework/security/instance-mutation-guard.ts";
import { bootstrap } from "#framework/commands/lifecycle/bootstrap.ts";
import { pull } from "#framework/commands/lifecycle/state.ts";
import { stubContext } from "./fixture.ts";
import { readFile } from "node:fs/promises";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

function declaresBreakLock(name: string): boolean {
  return (openclawCommands[name]?.arguments ?? []).some((argument) => argument.name === "break-lock");
}

// --- every command whose guarded()/withLockUnlessHeld() call reads real argv for --break-lock
// declares it, and every command that deliberately does not is left undeclared too ------------

for (const name of ["up", "restart", "down", "restore", "push", "apply", "rollback", "apply-config", "recipe", "provision-agent", "set", "bootstrap", "pull"]) {
  check(`${name} declares --break-lock`, declaresBreakLock(name), true);
}
for (const name of ["backup", "configure-provider", "secrets"]) {
  check(`${name} does not declare --break-lock (its own parser rejects it)`, declaresBreakLock(name), false);
}

// --- the message itself only ever names a flag the caller says is supported -------------------

{
  const holder: LockHolder = { operationId: "op-1", what: "apply", by: "coder@box pid 1", takenAt: new Date().toISOString() };
  const supported = refusalMessage(holder, Date.now(), true);
  const unsupported = refusalMessage(holder, Date.now(), false);
  check("supported: advises --break-lock", supported.includes("--break-lock"), true);
  check("unsupported: never tells the reader to take it over here", unsupported.includes("take it over with --break-lock"), false);
  check("unsupported: says so plainly", unsupported.includes("does not accept --break-lock"), true);
  check("unsupported: still names a command that does", unsupported.includes("./clawforge up --break-lock"), true);
  // The example named above must itself actually accept the flag, or this message would repeat
  // exactly the bug it exists to fix.
  check("and that example command really does declare it", declaresBreakLock("up"), true);
}

{
  const unsupported = unreadableLockMessage({ settings: { dataDir: "/srv/clawforge" } } as unknown as Context, false);
  check("unreadable-holder message respects unsupported too", unsupported.includes("does not accept --break-lock"), true);
  check("and never bare-advises --break-lock", unsupported.includes("take it over with --break-lock"), false);
}

// --- task #33: a holder provably dead on THIS machine is named as such, never guessed at ------

{
  const holder: LockHolder = {
    operationId: "op-dead-here", what: "apply", by: "coder@box pid 99999999",
    takenAt: new Date().toISOString(), host: machineName(), pid: 99999999,
  };
  const message = refusalMessage(holder);
  check("a pid that does not exist on this machine is reported as gone", message.includes("not running on this machine"), true);
  check("and --break-lock is still the advice, not an automatic takeover", message.includes("--break-lock"), true);
}

{
  // The exact same dead pid, but recorded on a DIFFERENT machine: unverifiable from here, so
  // the message must not claim anything about it.
  const holder: LockHolder = {
    operationId: "op-dead-elsewhere", what: "apply", by: "coder@elsewhere pid 99999999",
    takenAt: new Date().toISOString(), host: `${machineName()}-not-this-one`, pid: 99999999,
  };
  const message = refusalMessage(holder);
  check("a pid recorded on another machine is never called dead from here", message.includes("not running on this machine"), false);
}

{
  // This process's own pid, recorded on this machine: unambiguously alive.
  const holder: LockHolder = {
    operationId: "op-alive", what: "apply", by: "coder@box pid 1",
    takenAt: new Date().toISOString(), host: machineName(), pid: process.pid,
  };
  const message = refusalMessage(holder);
  check("this process's own live pid is never called dead", message.includes("not running on this machine"), false);
}

// --- bootstrap/pull: the parser itself, not just the declaration, now accepts --break-lock ----
//
// Before this fix, bootstrap's and pull's own argument loops died on "unknown argument:
// --break-lock" before guarded()/withLockUnlessHeld() ever read it — declaring the flag alone
// would not have made `./clawforge bootstrap --break-lock` work. Passing a second, genuinely
// unknown flag alongside it and asserting the die() names THAT one (never --break-lock) proves
// break-lock itself parses cleanly, without needing to stand up bootstrap's whole environment:
// the parse loop runs synchronously before any transport call.

{
  let message = "";
  try {
    await bootstrap({} as unknown as Context, ["--break-lock", "--totally-unknown-flag"]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("bootstrap's own parser accepts --break-lock", message.includes("--break-lock"), false);
  check("and still rejects a genuinely unknown flag", message.includes("--totally-unknown-flag"), true);
}

{
  let message = "";
  try {
    await bootstrap({} as unknown as Context, ["--break-foreign-lock", "some-host", "--totally-unknown-flag"]);
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
    await pull({} as unknown as Context, ["--break-lock", "--totally-unknown-flag"]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("pull's own parser accepts --break-lock", message.includes("--break-lock"), false);
  check("and still rejects a genuinely unknown flag", message.includes("--totally-unknown-flag"), true);
}

// --- guarded() forwards --break-foreign-lock end to end, the same as --break-lock -------------

check("parseBreakForeignLockHost reads the value after the flag", parseBreakForeignLockHost(["--break-foreign-lock", "host-x"]), "host-x");
check("and is absent when the flag is not there", parseBreakForeignLockHost(["--break-lock"]), undefined);

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
    await guarded(ctx, "up", ["--break-foreign-lock", foreignMachine], async () => {
      ranBody = true;
    });
  } catch (error) {
    threw = error as Error;
  }
  check("guarded() reads --break-foreign-lock from real argv and takes the guard over", ranBody, true);
  check("without refusing", threw, undefined);
  check("and the guard it took over is cleaned up afterwards", dirs.has(guard), false);
}

// smoke declares no --break-lock, so each lock its run takes (the archive window, the
// standalone round-trip) must say so — a merge once dropped it from the archive window.
{
  const smokeSource = await readFile(new URL("../../../../framework/commands/lifecycle/smoke.ts", import.meta.url), "utf8");
  const smokeDeclares = declaresBreakLock("smoke");
  const calls = smokeSource.split("guarded(ctx,").slice(1);
  check("smoke still takes the instance lock somewhere", calls.length > 0, true);
  check("every smoke lock opts out of --break-lock advice smoke cannot accept",
    smokeDeclares || calls.every((call) => (call.split("\nasync function ")[0] ?? "").includes("breakLockSupported: false")), true);
}

process.stderr.write(failed === 0 ? "all instance lock advice checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
