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
// Part D: the journal question (operations, rollback --dry-run) never reads an unreachable
// target as an empty answer, and the refusal travels with its remedy as advice — the console
// arrow line, the --json failure document and the MCP envelope all spell it (rf6-fix33).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  TransportUnreachableError,
  WslTransport,
  stripWslNuls,
  toSignedExitCode,
  isWrapperFailureCode,
} from "#framework/runtime/transport/transport.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { toolEnvelope } from "#framework/integration/mcp/call.ts";
import { formatError, UserError } from "#framework/core/io/log.ts";
import { useDeployment, selectedDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { doctor, gatherInspection } from "#framework/commands/orchestration/inspect/gather.ts";
import { plan } from "#framework/commands/orchestration/plan.ts";
import { status } from "#framework/commands/interface/status.ts";
import type { Context } from "#framework/core/context.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

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

const previousDeployment = selectedDeployment();
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
    // The one problem serializer (service/inspection.ts's problem()): severity and the
    // remedy as advice travel beside code/detail/nextAction, exactly as inspect/doctor's
    // problems do — not a hand-picked subset.
    const emitted = JSON.parse(captured) as { problem?: unknown };
    check("status --json's problem is the shared builder's, severity and advice included", emitted.problem, {
      code: "TARGET_UNREACHABLE",
      severity: "blocking",
      detail: UNREACHABLE.message,
      next: { kind: "manual", text: UNREACHABLE.nextAction },
      nextAction: UNREACHABLE.nextAction,
    });
  }

  {
    let thrown: Error | undefined;
    await withOutputSink(() => {}, async () => {
      try {
        await openclawCommands.backup.run(stubUnreachableContext(), ["list"]);
      } catch (error) {
        thrown = error as Error;
      }
    });
    check("backup list reports TARGET_UNREACHABLE instead of dying on a bare exception", thrown?.message.includes("TARGET_UNREACHABLE") ?? false, true);
  }

  // --- Part D: the journal question is not answered from an unreachable target ---------------

  {
    let thrown: unknown;
    let captured = "";
    await withOutputSink((chunk) => { captured += chunk; }, async () => {
      try {
        await openclawCommands.operations.run(stubUnreachableContext(), []);
      } catch (error) {
        thrown = error;
      }
    });
    check("operations reports an unreachable target instead of an empty journal", thrown instanceof TransportUnreachableError, true);
    // Stronger than a substring refusal: the command prints nothing at all before failing.
    check("...and prints no empty-journal answer", captured, "");
    checkTrue("the refusal is a UserError, so the failure contract lifts its advice", thrown instanceof UserError);
    check("...and the refusal carries the remedy as advice", (thrown as TransportUnreachableError | undefined)?.advice.map((entry) => entry.kind) ?? [], ["manual"]);
    // The console arrow line, spelled from the output layer's own pieces (a literal here
    // would be a prose pin this file is counted by).
    const arrow = String.fromCharCode(10) + "    → " + UNREACHABLE.nextAction;
    checkTrue("formatError renders the next step as the console arrow line", thrown === undefined ? false : formatError(thrown).includes(arrow));
  }

  {
    let thrown: unknown;
    let captured = "";
    await withOutputSink((chunk) => { captured += chunk; }, async () => {
      try {
        await openclawCommands.rollback.run(stubUnreachableContext(), ["--dry-run"]);
      } catch (error) {
        thrown = error;
      }
    });
    check("rollback --dry-run reports an unreachable target, not nothing-to-roll-back", thrown instanceof TransportUnreachableError, true);
    check("...and prints no nothing-to-roll-back answer", captured, "");
  }

  {
    // The --json failure contract (execute.ts's failed()): the document carries the remedy
    // as nextActions/next beside the message, not only inside it.
    const app: AppDefinition = { name: "rf6-fix33-fixture", description: "fixture", commands: { operations: openclawCommands.operations } };
    // The context stage must survive the stub (a real unreachable target's does): a scratch
    // deployment with a .env satisfies buildSettings, the stub answers the path bridge's
    // reads, and only the journal read refuses.
    const scratch = await mkdtemp(join(tmpdir(), "clawforge-unreachable-json-"));
    await writeFile(join(scratch, ".env"), "OC_TARGET_LOCATION=local\nOC_DATA_DIR=/srv/clawforge/data\n", "utf8");
    const contextTolerant = stubUnreachableContext();
    (contextTolerant.transport as { readFile: (path: string) => Promise<string> }).readFile = async () => "";
    useDeployment(scratch);
    let captured = "";
    const execution = await withOutputSink((chunk) => { captured += chunk; }, () =>
      executeCommand(app, "operations", ["--json"], { surface: "terminal", transport: contextTolerant.transport }));
    await rm(scratch, { recursive: true, force: true });
    check("operations --json fails at the run stage on an unreachable target", execution.stage, "run");
    checkTrue("...with the transport refusal as the error", execution.error instanceof TransportUnreachableError);
    if (!(execution.error instanceof TransportUnreachableError)) {
      finish("target-unreachable");
      process.exit(process.exitCode ?? 1);
    }
    const document = JSON.parse(captured) as { error?: { message?: string }; nextActions?: string[]; next?: Array<{ kind?: string; text?: string }> };
    checkTrue("the --json document names the failure", (document.error?.message ?? "").includes("unreachable"));
    check("the --json document renders the remedy", document.nextActions, [UNREACHABLE.nextAction]);
    check("the --json document carries the structured remedy", document.next, [{ kind: "manual", text: UNREACHABLE.nextAction }]);
    // MCP: the same refusal is the fallback envelope's remedy (a manual step is no tool step).
    const envelope = toolEnvelope(openclawCommands.operations, "", undefined, "operations-1", [], undefined, () => undefined, execution.error);
    check("the MCP envelope renders the remedy as nextActions", envelope.nextActions, [UNREACHABLE.nextAction]);
  }
} finally {
  if (previousDeployment !== undefined) useDeployment(previousDeployment);
}

finish("target-unreachable");
