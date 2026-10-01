// R32-08: failure paths run their checks in the right order, and --json always answers.
//
//   - `logs`, `smoke` and `configure-provider` parsed their arguments only AFTER contacting
//     the target (configure-provider even after taking the instance lock): a typo cost a
//     round trip, was answered with a transport error or "lock held", and `--tail abc`
//     reached compose. Each refusal here must come from the argument parser itself, with a
//     transport that has recorded NOTHING.
//   - `recover-env` is dispatched outside runApp's command.run try (entry/cli.ts), so its
//     unknown-argument error skipped reportUnknownArgument and never pointed at --help.
//   - `expose ssh --local-port 99999` was accepted: PORT checked digits but no upper bound.
//   - `incident --dry-run` printed a "plan" built from failure notes and exited 0 when the
//     target was unreachable — the module itself calls such a plan worth nothing. A real run
//     still proceeds to rotate over a noted contain failure; only the dry run fails.
//   - The one --json failure contract: a command invoked with --json that fails after its
//     arguments parsed prints {error:{message}} on stdout and exits non-zero, unless it
//     already printed a JSON document of its own (status/doctor/upgrade --dry-run do).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, runApp } from "#framework/entry/cli.ts";
import { managementCommands } from "#framework/commands/interface/groups/openclawCommands.management.ts";
import { logs } from "#framework/commands/lifecycle/instance/logs.ts";
import { smoke } from "#framework/commands/lifecycle/smoke/index.ts";
import { configureProvider } from "#framework/commands/management/credentials/provider.ts";
import { exposeSsh } from "#framework/commands/operate/expose/ssh.ts";
import { runPhases, IncidentPhaseFailure } from "#framework/commands/operate/incident/index.ts";
import { useDeployment, envFile } from "#framework/runtime/deployment.ts";
import { withOutputSink, emit } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

useLinuxHost();

const UNREACHABLE = "ssh:r32-unreachable.invalid: connection refused";

/** A context whose every contact point records and then throws — any call means the
 *  command reached the target before finishing its own argument parsing. */
function unreachableContext(): { ctx: Context; contacts: string[] } {
  const contacts: string[] = [];
  const transport = {
    description: "stub",
    exec(command: string, args: string[]): never {
      contacts.push(`exec ${command} ${args.join(" ")}`);
      throw new Error(UNREACHABLE);
    },
    exists(): never {
      contacts.push("exists");
      throw new Error(UNREACHABLE);
    },
    readFile(): never {
      contacts.push("readFile");
      throw new Error(UNREACHABLE);
    },
  } as unknown as Transport;
  const ctx = {
    settings: { dataDir: "/srv/data", gatewayPort: "18799", serviceUrl: "http://127.0.0.1:18799", env: {} },
    transport,
    runtime: {
      isRunning(): never {
        contacts.push("isRunning");
        throw new Error(UNREACHABLE);
      },
    },
    paths: { toContainer: (path: string) => path, toTarget: async (path: string) => path },
  } as unknown as Context;
  return { ctx, contacts };
}

/** Captures stdout and turns a thrown error into its message (plus its constructor name). */
async function capture(body: () => Promise<unknown>): Promise<{ output: string; error: string; errorName: string }> {
  let output = "";
  let error = "";
  let errorName = "";
  try {
    await withOutputSink((chunk) => {
      output += chunk;
    }, body);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    errorName = caught instanceof Error ? caught.name : "";
  }
  return { output, error, errorName };
}

// --- arguments parsed before any contact -------------------------------------------------------

for (const kase of [
  { name: "logs", args: ["--zzz"], expect: "unknown argument: --zzz" },
  { name: "logs --tail abc", args: ["--tail", "abc"], expect: "--tail takes a number" },
  { name: "smoke", args: ["--zzz"], expect: "unknown argument: --zzz" },
  { name: "configure-provider", args: ["--zzz"], expect: "unknown argument: --zzz" },
  { name: "configure-provider --provider", args: ["--provider"], expect: "--provider" },
] as const) {
  const { ctx, contacts } = unreachableContext();
  const run = kase.name.startsWith("logs")
    ? logs(ctx, [...kase.args])
    : kase.name.startsWith("smoke")
      ? smoke(ctx, [...kase.args])
      : configureProvider(ctx, [...kase.args]);
  const { error } = await capture(() => run);
  checkTrue(`${kase.name}: refused by the argument parser, not the transport`, error.includes(kase.expect));
  check(`${kase.name}: the target was never contacted`, contacts, []);
}

// --- recover-env's unknown flag points at --help -----------------------------------------------

{
  const app: AppDefinition = {
    name: "argsfirst-fixture",
    description: "fixture",
    commands: { "recover-env": managementCommands["recover-env"] },
  };
  const { output } = await capture(() => runApp(app, ["recover-env", "--zzz"]));
  checkTrue("recover-env --zzz is reported as an unknown argument", output.includes("unknown argument: --zzz"));
  checkTrue("recover-env --zzz points at its own --help", output.includes("run ./clawforge recover-env --help"));
}

// --- expose ssh: the port is a port ------------------------------------------------------------

{
  const { ctx } = unreachableContext();
  const fixed = {
    ...ctx,
    settings: { ...(ctx as unknown as { settings: object }).settings, location: "ssh", sshHost: "user@host" },
  } as unknown as Context;
  const { error } = await capture(() => exposeSsh(fixed, ["--local-port", "99999"]));
  checkTrue("expose ssh --local-port 99999 is refused", error.includes("must be a port number between 1 and 65535"));
}

// --- incident --dry-run: a plan that could not check the target is not a plan -------------------

const stubOperations = {
  preserve: async () => ({ phase: "preserve" as const, actions: ["kept"], notes: [], files: [] }),
  rotate: async () => ({ phase: "rotate" as const, actions: ["rotated"], notes: [] }),
  audit: async () => ({ phase: "audit" as const, actions: [], notes: [] }),
  collect: async () => ({ phase: "collect" as const, actions: [], notes: [] }),
  // audit's security/doctorLint only feed the report; a successful stub needs neither.
} as unknown as Parameters<typeof runPhases>[2];

{
  const { ctx } = unreachableContext();
  // runPhases itself reads the deployment dir for the evidence path; a throwaway one keeps
  // this block independent of where the check process happens to run.
  const incidentDir = await mkdtemp(join(tmpdir(), "clawforge-incident-dryrun-"));
  useDeployment(incidentDir);
  // contain is not injectable — the real containExposure runs, and the unreachable transport
  // makes its tailscale probe throw, exactly the reported failure.
  let failure: unknown;
  try {
    await runPhases(ctx, { dryRun: true, keepExposure: false, tail: "500" }, stubOperations);
  } catch (caught) {
    failure = caught;
  }
  checkTrue("incident --dry-run with an unreachable target fails", failure instanceof IncidentPhaseFailure);
  checkTrue("the failure names the contain phase's transport error", (failure as Error).message.includes("unreachable"));
  const report = (failure as IncidentPhaseFailure).report;
  check("the report still reaches the caller", report.phases[0].notes.some((note) => note.includes("contain failed unexpectedly")), true);

  // The control: a real run still proceeds to rotate over the same contain failure.
  let realRunFailed = false;
  try {
    await runPhases(ctx, { dryRun: false, keepExposure: false, tail: "500" }, stubOperations);
  } catch {
    realRunFailed = true;
  }
  check("a real run still proceeds over a noted contain failure", realRunFailed, false);
  await rm(incidentDir, { recursive: true, force: true });
}

// --- the --json failure contract, through the real entry point ----------------------------------

const deployDir = await mkdtemp(join(tmpdir(), "clawforge-json-contract-"));
useDeployment(deployDir);
await writeFile(
  envFile(),
  ["OC_TARGET_LOCATION=local", "OC_DATA_DIR=/srv/data", "OPENCLAW_GATEWAY_PORT=18799", "OPENCLAW_GATEWAY_TOKEN=not-a-real-token-check-only-value", ""].join("\n"),
  "utf8",
);

const contractApp: AppDefinition = {
  name: "json-contract-fixture",
  description: "fixture",
  commands: {
    boom: {
      summary: "always fails like an unreachable target would",
      run: async () => {
        throw new Error(UNREACHABLE);
      },
    },
    // Prints its own failure document first — status/doctor/upgrade --dry-run behave this
    // way — and must not get a second, trailing error document appended.
    ownDocument: {
      summary: "prints its own JSON, then fails",
      run: async () => {
        emit(`${JSON.stringify({ ok: false, problems: ["the check did not pass"] }, null, 2)}\n`);
        throw new Error("the check did not pass");
      },
    },
  },
};

try {
  const previousExit = process.exitCode;

  {
    const { output } = await capture(() => main(contractApp, ["boom", "--json"]));
    // The sink captures stderr too; the document is the output's one {...} block.
    const document = /\{[\s\S]*\}/.exec(output)?.[0] ?? "";
    let parsed: { error?: { message?: string } } | undefined;
    try {
      parsed = JSON.parse(document) as { error?: { message?: string } };
    } catch {
      parsed = undefined;
    }
    checkTrue("a failing --json command prints an error document", parsed?.error?.message !== undefined);
    checkTrue("the error document carries the failure's message", (parsed?.error?.message ?? "").includes("unreachable"));
    check("--json failure exits non-zero", process.exitCode === 1, true);
  }

  {
    const { output } = await capture(() => main(contractApp, ["boom"]));
    check("a failing non-json command prints no JSON document at all", output.includes("{"), false);
  }

  {
    const { output } = await capture(() => main(contractApp, ["ownDocument", "--json"]));
    const ownDoc = `${JSON.stringify({ ok: false, problems: ["the check did not pass"] }, null, 2)}\n`;
    checkTrue("a command that printed its own document gets no trailing error document", output.startsWith(ownDoc));
    // The stderr "error:" line lands in the sink too; only a second JSON document would
    // break the contract.
    check("no second document follows the command's own", output.slice(ownDoc.length).includes("{"), false);
  }

  process.exitCode = previousExit;
} finally {
  await rm(deployDir, { recursive: true, force: true });
}

finish("failure order and --json contract");
