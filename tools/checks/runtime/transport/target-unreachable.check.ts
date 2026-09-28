// TARGET_UNREACHABLE — wsl.exe/ssh failing to reach the target, as opposed to a command
// that ran there and exited non-zero: a wrong OC_WSL_DISTRO, WSL not running, ssh never
// connecting. Before this, doctor/plan/status/backup list each died on a bare exception
// text — `could not check whether … exists (exit 4294967295):` with nothing after the
// colon, because wsl.exe's own error ("There is no distribution with the supplied name.")
// is UTF-16LE and spawnLocal decodes every channel as UTF-8, leaving it NUL-interleaved and
// blank to the eye.
//
// Part A: the pure mechanism, byte-accurate — no process spawned. Part B: a real wsl.exe
// call against a distro name that cannot exist, so this passes identically whether wsl.exe
// is missing entirely (any non-Windows runner, or Windows without WSL) or present but
// unable to find the distro (a WSL-equipped machine) — both are TransportUnreachableError.
// Part C: a stub Transport/Runtime (never spawns anything) wired through the real
// doctor/plan/status/backup-list commands, pinning that each now reports TARGET_UNREACHABLE
// plainly instead of crashing.

import { resolve } from "node:path";
import {
  TransportUnreachableError,
  WslTransport,
  stripWslNuls,
  toSignedExitCode,
  isWrapperFailureCode,
} from "#framework/runtime/transport/transport.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { useDeployment, currentDeploymentDir } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { doctor, gatherInspection } from "#framework/commands/orchestration/inspect/gather.ts";
import { plan } from "#framework/commands/orchestration/plan.ts";
import { status } from "#framework/commands/interface/status.ts";
import { backupList } from "#framework/commands/lifecycle/backup/list.ts";
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

// --- Part A: the decode/classification mechanism, byte-accurate -----------------------------

{
  // What wsl.exe actually writes, and what spawnLocal's UTF-8 decode of those exact bytes
  // actually produces — the real mechanism behind "exit 4294967295):" with nothing after it.
  const message = "There is no distribution with the supplied name.";
  const wslOwnBytes = Buffer.from(message, "utf16le");
  const misdecodedAsUtf8 = wslOwnBytes.toString("utf8");
  check("UTF-16LE bytes decoded as UTF-8 are NOT the original text", misdecodedAsUtf8 === message, false);
  check("...every character survives, with a stray NUL after it", misdecodedAsUtf8.replaceAll("\u0000", ""), message);
  check("stripWslNuls recovers wsl.exe's own message exactly", stripWslNuls(misdecodedAsUtf8), message);
}

check("toSignedExitCode: wsl.exe's own -1, unsigned by Windows, signs back to -1", toSignedExitCode(4294967295), -1);
check("toSignedExitCode: a real exit code is untouched", toSignedExitCode(255), 255);
check("toSignedExitCode: 0 is untouched", toSignedExitCode(0), 0);

check("isWrapperFailureCode: -1 (wsl.exe's own failure) is one", isWrapperFailureCode(-1), true);
check("isWrapperFailureCode: 0 is not", isWrapperFailureCode(0), false);
check("isWrapperFailureCode: 255 (the top of a real guest exit status) is not", isWrapperFailureCode(255), false);
check("isWrapperFailureCode: 256 (impossible for a real guest exit) is one", isWrapperFailureCode(256), true);

// --- Part B: a real wsl.exe call against a distro that cannot exist -------------------------

{
  const distro = "clawforge-check-definitely-missing-distro";
  const transport = new WslTransport(distro);
  let error: unknown;
  try {
    await transport.exec("true", [], { timeoutMs: 15_000 });
  } catch (thrown) {
    error = thrown;
  }
  // Whichever branch fired — wsl.exe absent from PATH entirely, or present and unable to
  // find the distro — both are TransportUnreachableError, never a bare Error.
  check("a WSL distro that cannot exist raises TransportUnreachableError", error instanceof TransportUnreachableError, true);
  const unreachable = error as TransportUnreachableError;
  check("...naming the transport it tried to reach", unreachable.message.includes(distro), true);
  // wsl.exe absent (Linux CI) names the tool to install; present, the variable to fix.
  check("...with a next step naming OC_WSL_DISTRO or wsl.exe", /OC_WSL_DISTRO|wsl.exe/.test(unreachable.nextAction ?? ""), true);
}

// --- Part C: doctor/plan/status/backup list, wired through a stub transport -----------------

const UNREACHABLE = new TransportUnreachableError(
  "wsl:Nope is unreachable — wsl.exe exited -1: There is no distribution with the supplied name.",
  "check OC_WSL_DISTRO — list the real names with `wsl.exe -l -q`",
);

function stubUnreachableContext(): Context {
  const fail = async (): Promise<never> => { throw UNREACHABLE; };
  return {
    settings: {
      image: "ghcr.io/openclaw/openclaw@sha256:abc",
      dataDir: "/srv/clawforge/data",
      backupDir: "/srv/clawforge/backups",
      serviceUrl: "http://127.0.0.1:18789",
    },
    transport: {
      description: "wsl:Nope",
      exec: fail,
      readFile: fail,
      writeFile: fail,
      exists: fail,
      mkdirp: fail,
      remove: fail,
      listFiles: fail,
    },
    runtime: {
      description: "docker",
      isRunning: fail,
      showStatus: fail,
      runningConnectionFacts: fail,
      health: fail,
      probe: fail,
      imageReference: fail,
    },
  } as unknown as Context;
}

const previousDeployment = currentDeploymentDir();
// A path that does not exist on disk: declaredState() reads it with the same ENOENT
// tolerance it gives a genuinely empty deployment, so nothing here needs a real fixture.
useDeployment(resolve(monorepoRoot, "apps", "clawforge-check-target-unreachable"));

try {
  {
    const inspection = await gatherInspection(stubUnreachableContext());
    check("gatherInspection never throws for an unreachable target", inspection.problems.length, 1);
    check("...it reports TARGET_UNREACHABLE", inspection.problems[0]?.code, "TARGET_UNREACHABLE");
    check("...blocking severity", inspection.problems[0]?.severity, "blocking");
    check("...the transport's own message travels, not a blank string", inspection.problems[0]?.detail, UNREACHABLE.message);
    check("...and its own next step, not the catalog's generic one", inspection.problems[0]?.nextAction, UNREACHABLE.nextAction);
    check("observed.running is false", inspection.observed.running, false);
  }

  {
    let thrown: Error | undefined;
    await withOutputSink(() => {}, async () => {
      try {
        await doctor(stubUnreachableContext(), []);
      } catch (error) {
        thrown = error as Error;
      }
    });
    check("doctor reports TARGET_UNREACHABLE instead of dying on a bare exception", thrown?.message.includes("TARGET_UNREACHABLE") ?? false, true);
  }

  {
    let captured = "";
    await withOutputSink((chunk) => { captured += chunk; }, () => plan(stubUnreachableContext(), []));
    // plan is read-only: an all-advisory problem list must never throw. The generic
    // fallback in planActions() ("every code the steps above did not name is still
    // shown") is what turns TARGET_UNREACHABLE into a step without planActions() needing
    // a case of its own for it.
    check("plan names TARGET_UNREACHABLE as a step, not a crash", captured.includes("TARGET_UNREACHABLE"), true);
    check("...with the transport's own next step", captured.includes(UNREACHABLE.nextAction ?? "\0"), true);
  }

  {
    let thrown: Error | undefined;
    let captured = "";
    await withOutputSink((chunk) => { captured += chunk; }, async () => {
      try {
        await status(stubUnreachableContext(), ["--json"]);
      } catch (error) {
        thrown = error as Error;
      }
    });
    check("status --json reports TARGET_UNREACHABLE instead of dying on a bare exception", thrown?.message.includes("TARGET_UNREACHABLE") ?? false, true);
    check("...and emits it as structured JSON first", captured.includes('"TARGET_UNREACHABLE"'), true);
  }

  {
    let thrown: Error | undefined;
    await withOutputSink(() => {}, async () => {
      try {
        await backupList(stubUnreachableContext(), []);
      } catch (error) {
        thrown = error as Error;
      }
    });
    check("backup list reports TARGET_UNREACHABLE instead of dying on a bare exception", thrown?.message.includes("TARGET_UNREACHABLE") ?? false, true);
  }
} finally {
  if (previousDeployment !== undefined) useDeployment(previousDeployment);
}

process.stderr.write(failed === 0 ? "all target-unreachable checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
