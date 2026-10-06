// R32-08 + I5/I6: failure paths run their checks in the right order, and --json always answers.
//
// Every refusal below runs through the ONE pipeline (core/command/execute.ts) with a
// transport that records every contact, and asserts structure — the stage that refused,
// the error class, the named argument, zero contacts — not prose:
//
//   - a spec command's arguments are refused at the `parse` stage, before the deployment's
//     .env is even read; a prepare refusal (recover-env without .env) comes before any
//     contact with the target;
//   - an MCP call to a destructive command without confirm: true stops at the `confirm`
//     stage, also before any contact;
//   - a legacy command still runs as it always did (argv as is, parsed inside its run) —
//     but through the same pipeline, still without a single transport call on a typo;
//   - the one --json failure contract: a command invoked with --json that fails prints
//     {error:{message}} on stdout and exits non-zero, unless it already printed a JSON
//     document of its own (status/doctor/upgrade --dry-run do) or streamed to a child.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, runApp } from "#framework/entry/cli.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { commandBody, defineAction, materializeCommands, multiActionBody, unknownArgumentMessage } from "#framework/core/command/index.ts";
import { commandLine, renderAdvice } from "#framework/core/io/invocation/render.ts";
import { command } from "#framework/core/io/invocation/advice.ts";
import { PORT_RANGE } from "#framework/core/values/value.ts";
import { toArgv } from "#framework/integration/mcp/call.ts";
import { operateCommands } from "#framework/commands/interface/groups/openclawCommands.operate.ts";
import { configureProvider } from "#framework/commands/management/credentials/provider.ts";
import { exposeSsh } from "#framework/commands/operate/expose/ssh.ts";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { provisionAgent } from "#framework/commands/management/provision-agent/index.ts";
import { secrets } from "#framework/commands/management/secrets.ts";
import { useDeployment, envFile } from "#framework/runtime/deployment.ts";
import { spawnLocal } from "#framework/runtime/transport/exec.ts";
import { die, dieWithExitCode, UserError } from "#framework/core/io/log.ts";
import { withOutputSink, emit } from "#framework/core/io/output.ts";
import { ArgumentError, ConfirmationRequiredError, UnknownArgumentError } from "#framework/core/command/index.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import type { Context } from "#framework/core/context.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { lifecycleCommands } from "#framework/commands/interface/groups/openclawCommands.lifecycle.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

useLinuxHost();

const UNREACHABLE = "ssh:r32-unreachable.invalid: connection refused";

/** A transport whose every contact point records and then throws — any entry means the
 *  command reached the target before finishing its own argument parsing. */
function recordingTransport(): { transport: Transport; contacts: string[] } {
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
  return { transport, contacts };
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

// --- a spec command: parse and prepare refuse before anything is touched -----------------------

{
  const app: AppDefinition = {
    name: "argsfirst-fixture",
    description: "fixture",
    commands: { "recover-env": operateCommands["recover-env"] },
  };

  {
    const { transport, contacts } = recordingTransport();
    const execution = await executeCommand(app, "recover-env", ["--zzz"], { surface: "terminal", transport });
    check("recover-env --zzz stops at the parse stage", execution.stage, "parse");
    checkTrue("recover-env --zzz is refused as an unknown argument", execution.error instanceof UnknownArgumentError);
    check("recover-env --zzz never contacts the target", contacts, []);
  }

  {
    // No .env at all: the prepare refusal is the answer, not the settings parser's, and it
    // lands before the pipeline builds the deployment scope (no transport call either).
    const emptyDir = await mkdtemp(join(tmpdir(), "clawforge-pipeline-noenv-"));
    useDeployment(emptyDir);
    const { transport, contacts } = recordingTransport();
    const execution = await executeCommand(app, "recover-env", [], { surface: "terminal", transport });
    check("recover-env without .env stops at the prepare stage", execution.stage, "prepare");
    checkTrue("recover-env without .env is refused as a user error", execution.error instanceof UserError);
    check("recover-env without .env never contacts the target", contacts, []);
    await rm(emptyDir, { recursive: true, force: true });
  }
}

// A spec command's confirmation-set flag rides an MCP confirm: true.
{
  const CONFIRM_FLAG = commandBody({
    effect: "destroy",
    arguments: [{ name: "force", description: "really do it", kind: "flag", setByConfirm: true }],
    run: async () => {},
  });
  const breaker = materializeCommands({ breaker: { summary: "destroys state", group: "low-level", ...CONFIRM_FLAG } }).breaker;
  check("confirm: true appends the command's setByConfirm flag", toArgv(breaker, { confirm: true }).includes("--force"), true);
  check("without a confirmation the flag is never invented", toArgv(breaker, {}).includes("--force"), false);

  // A multi-action body contributes only the SELECTED action's flags (the action word, or
  // the body's default) — never another action's.
  const SWAP = multiActionBody({
    effect: "destroy",
    action: { description: "which side" },
    defaultAction: "left",
    actions: {
      left: defineAction({ summary: "left", arguments: [{ name: "force", description: "really do it", kind: "flag", setByConfirm: true }], run: async () => {} }),
      right: defineAction({ summary: "right", arguments: [{ name: "zap", description: "zap too", kind: "flag", setByConfirm: true }], run: async () => {} }),
    },
  });
  const swapper = materializeCommands({ swapper: { summary: "swaps sides", group: "low-level", ...SWAP } }).swapper;
  check("the chosen action's setByConfirm flag rides the confirmation", toArgv(swapper, { action: "right", confirm: true }), ["right", "--zap"]);
  check("another action's setByConfirm flag is not invented", toArgv(swapper, { action: "right", confirm: true }).includes("--force"), false);
  check("a bare confirmation selects the default action's flag", toArgv(swapper, { confirm: true }), ["--force"]);
}

// --- the console surface still reports an unknown argument with the --help pointer -------------

{
  const helpPointer = `run ${commandLine(["recover-env", "--help"])}`;
  const app: AppDefinition = {
    name: "argsfirst-fixture",
    description: "fixture",
    commands: { "recover-env": operateCommands["recover-env"] },
  };
  const { output } = await capture(() => runApp(app, ["recover-env", "--zzz"]));
  checkTrue("recover-env --zzz is reported as an unknown argument", output.includes(unknownArgumentMessage("--zzz")));
  checkTrue("recover-env --zzz points at its own --help", output.includes(helpPointer));
}

// --- expose ssh: the port is a port ------------------------------------------------------------

{
  const fixed = {
    settings: { dataDir: "/srv/data", gatewayPort: "18799", serviceUrl: "http://127.0.0.1:18799", env: {}, location: "ssh", sshHost: "user@host" },
    transport: recordingTransport().transport,
    paths: { toContainer: (path: string) => path, toTarget: async (path: string) => path },
  } as unknown as Context;
  const { error } = await capture(() => exposeSsh(fixed, ["--local-port", "99999"]));
  checkTrue("expose ssh --local-port 99999 is refused", error.includes(PORT_RANGE));
}

// --- legacy commands: same pipeline, argv as is, still no contact on a typo ---------------------

const deployDir = await mkdtemp(join(tmpdir(), "clawforge-json-contract-"));
useDeployment(deployDir);
await writeFile(
  envFile(),
  ["OC_TARGET_LOCATION=local", "OC_DATA_DIR=/srv/data", "OPENCLAW_GATEWAY_PORT=18799", "OPENCLAW_GATEWAY_TOKEN=not-a-real-token-check-only-value", ""].join("\n"),
  "utf8",
);

// --- confirm: an MCP call to a destructive command without confirm: true stops there ------------

{
  let ran = false;
  const app: AppDefinition = {
    name: "confirm-fixture",
    description: "fixture",
    commands: {
      wipe: {
        summary: "destroys state",
        destructive: true,
        arguments: [{ name: "json", description: "Emit the outcome as JSON", kind: "flag" }],
        run: async () => {
          ran = true;
        },
      },
    },
  };
  const { transport, contacts } = recordingTransport();
  const refused = await executeCommand(app, "wipe", [], { surface: "mcp", transport });
  check("a destructive MCP call without confirm stops at the confirm stage", refused.stage, "confirm");
  checkTrue("the confirm refusal is a ConfirmationRequiredError", refused.error instanceof ConfirmationRequiredError);
  checkTrue("the confirm refusal names the command", (refused.error as Error).message.startsWith("wipe "));
  check("a refused destructive call never contacts the target", contacts, []);
  check("a refused destructive call never runs", ran, false);

  // The confirmed control builds a real local context; the run itself touches nothing.
  const allowed = await executeCommand(app, "wipe", [], { surface: "mcp", confirmed: true });
  check("the same call with confirm: true reaches the run stage", allowed.stage, "run");
  check("the confirmed call ran", ran, true);
}

try {
  for (const kase of [
    { name: "logs --zzz", command: "logs", argv: ["--zzz"] },
    { name: "logs --tail abc", command: "logs", argv: ["--tail", "abc"] },
    { name: "smoke --zzz", command: "smoke", argv: ["--zzz"] },
    { name: "configure-provider --zzz", command: "configure-provider", argv: ["--zzz"] },
    { name: "configure-provider --provider", command: "configure-provider", argv: ["--provider"] },
  ] as const) {
    const { transport, contacts } = recordingTransport();
    // Legacy commands keep their (ctx, args) signature; the pipeline is driven with a
    // declaration whose run delegates to the real function, so the whole console path
    // (environment decision, context, run) is exercised, not just the parser. A refusal
    // the command's own parser makes inside its run comes back as the execution's error —
    // still without a single transport call.
    const execution = await executeCommand(
      {
        name: "legacy-fixture",
        description: "fixture",
        commands: {
          logs: { summary: "logs", run: (ctx, args) => openclawCommands.logs.run(ctx, args) },
          smoke: { summary: "smoke", run: (ctx, args) => openclawCommands.smoke.run(ctx, args) },
          "configure-provider": { summary: "provider", run: (ctx, args) => configureProvider(ctx, args) },
        },
      },
      kase.command,
      [...kase.argv],
      { surface: "terminal", transport },
    );
    checkTrue(`${kase.name} stops at the run stage`, execution.stage === "run");
    checkTrue(`${kase.name} is refused by the command's own argument parsing`, execution.error instanceof UserError);
    check(`${kase.name}: the target was never contacted`, contacts, []);
  }

  // --- the --json failure contract, through the real entry point --------------------------------

  const remedy = command(["bootstrap"], { note: "then start it" });
  const contractApp: AppDefinition = {
    name: "json-contract-fixture",
    description: "fixture",
    commands: {
      boom: {
        summary: "always fails like an unreachable target would",
        arguments: [{ name: "json", kind: "flag", description: "Emit the outcome as JSON" }],
        run: async () => {
          throw new Error(UNREACHABLE);
        },
      },
      // Prints its own failure document first — status/doctor/upgrade --dry-run behave this
      // way — and must not get a second, trailing error document appended.
      ownDocument: {
        summary: "prints its own JSON, then fails",
        arguments: [{ name: "json", kind: "flag", description: "Emit the outcome as JSON" }],
        run: async () => {
          emit(`${JSON.stringify({ ok: false, problems: ["the check did not pass"] }, null, 2)}\n`);
          throw new Error("the check did not pass");
        },
      },
      // rf6-fix30: refuses the way requireBootstrapped does — a UserError carrying structured
      // advice — and the --json failure contract must carry that remedy, not only the message.
      advised: {
        summary: "refuses with structured advice",
        arguments: [{ name: "json", kind: "flag", description: "Emit the outcome as JSON" }],
        run: async () => {
          die("this deployment has never been bootstrapped", remedy);
        },
      },
      // cli/exec's shape: the whole tail is a child command line, the child streams its own
      // output (spawnLocal with no input streams, past the emit counter), then the wrapper
      // dies with the child's exit code. A `--json` in the tail is the CHILD's flag.
      passthrough: {
        summary: "streams a child's own JSON, then dies with its exit code",
        arguments: [{ name: "args", kind: "variadic", description: "passed through to the child" }],
        run: async () => {
          const result = await spawnLocal(process.execPath, ["-e", "process.stdout.write(JSON.stringify({child:'own document'}) + '\\n'); process.exit(3)"], { stream: true, allowFailure: true });
          dieWithExitCode(`child lint --json failed (exit ${result.code})`, result.code);
        },
      },
    },
  };

  const previousExit = process.exitCode;

  {
    // First, while the process-wide counters are still clean: the streamed child output
    // bypasses emit/emitRaw, so only the declaration gate keeps the contract off.
    const { output } = await capture(() => main(contractApp, ["passthrough", "lint", "--json"]));
    checkTrue("a passthrough command streams the child's own JSON", output.includes('"child":"own document"'));
    check("a passthrough --json failure appends no second error document", output.includes('"error"'), false);
    check("the passthrough failure exits with the child's code", process.exitCode === 3, true);
  }

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
    // rf6-fix30: the refusal's remedy travels with the document — nextActions the rendered
    // form, next the structured advice — instead of stopping at the message.
    const { output } = await capture(() => main(contractApp, ["advised", "--json"]));
    const document = /\{[\s\S]*\}/.exec(output)?.[0] ?? "";
    const parsed = JSON.parse(document) as { error?: { message?: string }; nextActions?: string[]; next?: Array<{ kind?: string; argv?: string[]; note?: string }> };
    checkTrue("a refusal with advice names the failure in its --json document", (parsed.error?.message ?? "").includes("bootstrapped"));
    checkTrue("the --json document renders the refusal's remedy", Array.isArray(parsed.nextActions) && parsed.nextActions[0] === renderAdvice(remedy));
    check("the --json document carries the refusal's structured remedy", parsed.next, [{ kind: "clawforge", argv: ["bootstrap"], note: "then start it" }]);
  }

  {
    const { output } = await capture(() => main(contractApp, ["boom"]));
    check("a failing non-json command prints no JSON document at all", output.includes("{"), false);
  }

  // R7-1: a `--json` that is an OPTION's value (`--interval --json`) is not the flag — the
  // parse-failure gate (jsonTokenGiven, the real tokenizer) must refuse it. The
  // existing `boom --json` case above is the given-flag control: a declared flag still prints.
  {
    const backupApp: AppDefinition = {
      name: "json-value-fixture",
      description: "fixture",
      commands: { backup: lifecycleCommands.backup },
    };
    const { output } = await capture(() => main(backupApp, ["backup", "install", "--interval", "--json"]));
    checkTrue("a --json that is an option's value still names the parse refusal", output.includes('got "--json"'));
    check("a --json that is an option's value prints no error document", output.includes('"error"'), false);
    checkTrue("the parse failure still exits non-zero", process.exitCode === 1);
  }

  // R8-1: an option written `--opt=value` is complete: the `--json` after it IS the flag, so a
  // parse failure still prints the error document the machine caller asked for.
  {
    const backupApp: AppDefinition = {
      name: "json-inline-fixture",
      description: "fixture",
      commands: { backup: lifecycleCommands.backup },
    };
    const { output } = await capture(() => main(backupApp, ["backup", "prune-replaced", "--keep=abc", "--json"]));
    checkTrue("a --json after an inline --opt=value is the flag: the error document is printed", output.includes('"error"'));
  }

  {
    const { output } = await capture(() => main(contractApp, ["ownDocument", "--json"]));
    const ownDoc = `${JSON.stringify({ ok: false, problems: ["the check did not pass"] }, null, 2)}\n`;
    checkTrue("a command that printed its own document gets no trailing error document", output.startsWith(ownDoc));
    // The stderr "error:" line lands in the sink too; only a second JSON document would
    // break the contract.
    check("no second document follows the command's own", output.slice(ownDoc.length).includes("{"), false);
  }

  // The contract through the pipeline itself, not just main(): the execution comes back
  // (stage run) and the document was already emitted by executeCommand.
  {
    let output = "";
    const { transport } = recordingTransport();
    const execution = await withOutputSink((chunk) => {
      output += chunk;
    }, async () => executeCommand(contractApp, "boom", ["--json"], { surface: "terminal", transport }));
    check("a failing command's execution names the run stage", execution.stage, "run");
    checkTrue("and carries the error", execution.error instanceof Error);
    checkTrue("the pipeline itself emitted the error document", output.includes('"error"') && output.includes("unreachable"));
  }

  process.exitCode = previousExit;
} finally {
  await rm(deployDir, { recursive: true, force: true });
}

// --- recipe/provision-agent/secrets: a typo refuses locally, before lock or transport ---------
// R33-07 (the R32-08 class): the purely local check for a bad recipe or store name must run
// before requireBootstrapped/guarded/any transport call, so `--dry-run` and the real run
// answer the same typo identically and no round trip is spent on it.

function unreachableContext(): { ctx: Context; contacts: string[] } {
  const { transport, contacts } = recordingTransport();
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

{
  for (const kase of [
    { name: "recipe install", args: ["install", "nosuch"], expect: 'recipe "nosuch" not found' },
    { name: "recipe install --dry-run", args: ["install", "nosuch", "--dry-run"], expect: 'recipe "nosuch" not found' },
    { name: "recipe verify", args: ["verify", "nosuch"], expect: 'recipe "nosuch" not found' },
    { name: "recipe onboard", args: ["onboard", "nosuch"], expect: 'recipe "nosuch" not found' },
    { name: "recipe diagnose", args: ["diagnose", "nosuch"], expect: 'recipe "nosuch" not found' },
  ] as const) {
    const recording = unreachableContext();
    const { error } = await capture(() => recipe(recording.ctx, [...kase.args]));
    checkTrue(`${kase.name} with a typo is refused by the recipe lookup`, error.includes(kase.expect));
    check(`${kase.name}: the target was never contacted`, recording.contacts, []);
  }
}

{
  const recording = unreachableContext();
  const { error } = await capture(() => provisionAgent(recording.ctx, ["nosuch"]));
  checkTrue("provision-agent with a typo is refused by the recipe lookup", error.includes('recipe "nosuch" not found') || error.includes("nosuch"));
  check("provision-agent: the target was never contacted", recording.contacts, []);
}

{
  for (const kase of [
    { name: "secrets --apply --store ../x", store: "../x", expect: "invalid store name" },
    { name: "secrets --apply --store nosuch", store: "nosuch", expect: "not found" },
  ] as const) {
    const recording = unreachableContext();
    const { error } = await capture(() => secrets(recording.ctx, ["--apply", "--store", kase.store]));
    checkTrue(`${kase.name} is refused locally`, error.includes(kase.expect));
    check(`${kase.name}: the target was never contacted`, recording.contacts, []);
  }
}

// The parser's own refusals name their argument, structurally — bind turns a bad value into
// an ArgumentError carrying the argument's declared name (I9: structure, not prose).
{
  const error = new ArgumentError("--tail takes a number of lines, not \"abc\"", "tail");
  check("an ArgumentError names its argument", error.argument, "tail");
}

finish("pipeline: failure order, stages and --json contract");
