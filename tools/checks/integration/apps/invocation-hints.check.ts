// The commands a message tells the user to run follow how the CLI was invoked: `./clawforge`
// from the monorepo gate or the committed shim, `clawforge` from the system-wide command
// (where `./clawforge` does not even run in cmd.exe or PowerShell). Covered: the helper
// itself, help (Usage and footer), doctor's refusal and its JSON, the MCP envelope built
// from it, and the entry's hand-over of the prefix.

import { renderUsage, renderFullCommandHelp } from "#framework/core/io/help-render.ts";
import {
  INVOKED_AS_ENV,
  INVOCATION_ENV,
  invocation,
  parseInvocation,
  parseLegacyInvokedAs,
  serializeInvocation,
  setInvocation,
  takeInvocationFromEnv,
  type Invocation,
} from "#framework/core/io/invocation/index.ts";
import { command, manual, shellLine } from "#framework/core/io/invocation/advice.ts";
import { commandLine } from "#framework/core/io/invocation/render.ts";
import { renderAdvice, shimInvocation, useGateCommands } from "#framework/core/io/invocation/render.ts";
import { die, formatError, registerSecret, UserError, reportError, info } from "#framework/core/io/log.ts";
import { emit, emitRaw, withOutputSink } from "#framework/core/io/output.ts";
import { structuredResult } from "#framework/integration/mcp/server.ts";
import { cronLine, displayCommandLine, posixTargetInvocation, schedulerIdentity, withScheduleRunner } from "#framework/commands/operate/schedule.ts";
import { watchInstall } from "#framework/commands/operate/watch/install.ts";
import { deploy } from "#framework/commands/management/deploy/index.ts";
import { bootstrapAndReport } from "#framework/commands/management/deploy/sync.ts";
import { deploymentName } from "#framework/runtime/deployment.ts";
import { cmdExeArgv } from "#checks/runtime/schedule/fixture.ts";
import type { Context } from "#framework/core/context.ts";
import { doctor } from "#framework/commands/orchestration/inspect/gather.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "#checks/runtime/convergence/inspect/fixture.ts";
import { check, finish } from "#checks/kit/harness.ts";
import type { AppDefinition } from "#framework/core/app.ts";

const HINT = "./clawforge";

const MONO: Invocation = { program: HINT, mode: "checkout", audience: "terminal" };
const GLOBAL: Invocation = { program: "clawforge", mode: "installed", audience: "terminal" };
const NAMED: Invocation = { ...MONO, app: { name: "staging", selectedBy: "flag" } };

async function capture(body: () => void | Promise<void>): Promise<string> {
  let text = "";
  await withOutputSink((chunk) => { text += chunk; }, async () => { await body(); });
  return text;
}

const app: AppDefinition = { name: "demo", description: "demo deployment", commands: openclawCommands } as AppDefinition;
const { deployment, stubContext } = await setupFixtureDeployment();

/** The sample outputs a user acts on, rendered under whatever prefix is set right now. */
async function samples(): Promise<{ usage: string; commandHelp: string; refusal: string; json: string; envelope: string; nextActions: string[] }> {
  const usage = await capture(() => renderUsage(app, []));
  const commandHelp = await capture(() => renderFullCommandHelp("logs", openclawCommands.logs));
  let refusal = "";
  let json = "";
  let machine = "";
  try {
    await withOutputSink((chunk) => { json += chunk; }, () => doctor(stubContext({ running: false }), ["--json"]), (chunk) => { machine += chunk; });
  } catch (error) {
    refusal = await capture(() => reportError(error));
  }
  const envelope = structuredResult({ summary: "s", structured: true, readOnly: true }, machine, "op");
  return { usage, commandHelp, refusal, json, envelope: JSON.stringify(envelope), nextActions: envelope?.nextActions ?? [] };
}

try {
  // --- the helper -----------------------------------------------------------------------------

  check("nothing set: the monorepo prefix", invocation(), MONO);
  check("commandLine renders the prefix and the rest", commandLine(["bootstrap", "--check"]), "./clawforge bootstrap --check");
  setInvocation(GLOBAL);
  check("commandLine follows the prefix", commandLine(["bootstrap", "--check"]), "clawforge bootstrap --check");
  setInvocation(NAMED);
  check("the app part is in the prefix", commandLine([]), "./clawforge --app staging");
  check("emitRaw never rewrites data", await capture(() => emitRaw("./clawforge up\n")), "./clawforge up\n");
  // The flip: the output layer rewrites nothing. A document and a diagnostic alike leave as
  // they were built, whatever invocation is set right now — advice-matrix.check.ts's P3
  // holds the same law for every advice row, through this very info().
  check("emit passes machine output through", await capture(() => emit("./clawforge up\n")), "./clawforge up\n");
  check("info passes a diagnostic through, adding no --app of its own", await capture(() => info("./clawforge up")).then((text) => text.includes("./clawforge up") && !text.includes("./clawforge --app staging up")), true);
  // Lines copied into another shell or host are printed verbatim under any prefix.
  const cron = cronLine(60, { cwd: "/srv/app1", command: "./clawforge", args: ["--app", "app1", "backup"] }, "backup", "app1");
  const remote = [
    `would bootstrap remotely afterwards: cd /opt/oc && ./clawforge --app staging bootstrap`,
    `bring it up there with: cd /opt/oc && ./clawforge --app staging bootstrap`,
    `provider keys are not copied — install them there: ./clawforge --app staging secrets --apply`,
    `  bash -lc "cd /srv/app1 && ./clawforge backup"`,
  ];
  for (const value of [GLOBAL, { ...MONO, app: { name: "x", selectedBy: "flag" } }] as const) {
    setInvocation(value);
    const prefix = commandLine([]);
    for (const line of [cron, ...remote]) {
      check(`info keeps the line verbatim under "${prefix}"`, await capture(() => info(line)).then((text) => text.includes(line)), true);
    }
  }
  // --- the call sites: what they print is what they install or pass on -----------------------
  // What each of these prints is a line built for another shell, host or scheduler. info()
  // now prints it as it was built, so reverting a site to a hand-written text — or making it
  // render for this terminal — turns one of these red under a non-default prefix.

  const ok = { code: 0, stdout: "", stderr: "" };
  const REMOTE = "/mnt/x/clawforge";
  const sshCtx = {
    transport: {
      description: "ssh:user@host",
      async exec(_command: string, args: string[]) { return { ...ok, stdout: `${args[3]}\n` }; },
    },
    settings: { remotePath: "/opt/openclaw" },
  } as unknown as Context;
  const wslTransport = {
    description: "wsl:Ubuntu-24.04",
    clientInvocation: (entry: string, args: string[]) => ({ command: "./clawforge", args: [entry, ...args] }),
  };
  const wslCtx = { transport: wslTransport, paths: { async toTarget() { return REMOTE; } }, settings: {} } as unknown as Context;
  const deployCtx = {
    transport: { description: "local", async exec() { return ok; } },
    runtime: { requiredTools: [] },
    settings: { remotePath: "/opt/openclaw", gatewayPort: 18789 },
  } as unknown as Context;
  const jobs = [
    { label: "backup install", run: (ctx: Context, args: string[]) => openclawCommands.backup.run(ctx, ["install", ...args]), job: "backup", jobArgs: ["backup"], minutes: 1440 },
    { label: "watch install", run: (ctx: Context, args: string[]) => watchInstall(ctx, args), job: "watch", jobArgs: ["watch", "check"], minutes: 5 },
  ];

  for (const value of [GLOBAL, { ...MONO, app: { name: "x", selectedBy: "flag" } }] as const) {
    setInvocation(value);
    const at = `under "${commandLine([])}"`;
    for (const { label, run, job, jobArgs, minutes } of jobs) {
      const crontab = cronLine(minutes, await posixTargetInvocation(sshCtx, jobArgs), job, await schedulerIdentity(sshCtx));
      check(`${label} prints the crontab line it would install ${at}`, (await capture(() => run(sshCtx, []))).includes(crontab), true);

      // Windows, unsupported transport: the printed lines are the transport's and schtasks' own.
      const applied: string[][] = [];
      const recorder = async (_command: string, args: readonly string[]) => { applied.push([...args]); return ok; };
      const printed = await capture(() => withScheduleRunner(recorder, () => run(wslCtx, []), "win32"));
      await capture(() => withScheduleRunner(recorder, () => run(wslCtx, ["--apply"]), "win32"));
      const manual = wslTransport.clientInvocation(REMOTE, ["--app", deploymentName(), ...jobArgs]);
      const rows = printed.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "").split("\n").map((row) => row.trim());
      check(`${label} prints the transport's own command line ${at}`, rows.includes(displayCommandLine(manual.command, manual.args)), true);
      const schtasks = rows.find((row) => row.startsWith("schtasks "));
      check(`${label}: the printed schtasks line, parsed by cmd.exe, is what --apply passes ${at}`, cmdExeArgv(schtasks ?? ""), ["schtasks", ...(applied[0] ?? [])]);
    }

    const name = deploymentName();
    const bootstrap = `cd /opt/openclaw && ./clawforge --app ${name} bootstrap`;
    const dry = await capture(() => deploy(deployCtx, ["user@host", "--dry-run"]));
    check(`deploy --dry-run prints the remote bootstrap line verbatim ${at}`, dry.includes(`would bootstrap remotely afterwards: ${bootstrap}`), true);
    const skipped = await capture(() => bootstrapAndReport(deployCtx, "user@host", "/opt/openclaw", name, false, undefined));
    check(`deploy's manual bootstrap hint is verbatim ${at}`, skipped.includes(`bring it up there with: ${bootstrap}`), true);
    const done = await capture(() => bootstrapAndReport(deployCtx, "user@host", "/opt/openclaw", name, true, undefined));
    check(`deploy's provider-keys hint is verbatim ${at}`, done.includes(`provider keys are not copied — install them there: ./clawforge --app ${name} secrets --apply`), true);
  }

  setInvocation(MONO);
  check("the entry default is the monorepo prefix, without an app part", commandLine([]), HINT);
  check("the default names no deployment", invocation().app, undefined);

  // --- the value between processes: versioned JSON in CLAWFORGE_INVOCATION -------------------

  for (const value of [
    MONO,
    GLOBAL,
    NAMED,
    { program: "../../clawforge", mode: "checkout", app: { name: "app1", selectedBy: "cwd" }, audience: "mcp" },
    { program: "../../clawforge", mode: "local-package", audience: "mcp" },
  ] as const) {
    check(`serialize then parse is the identity: ${serializeInvocation(value)}`, parseInvocation(serializeInvocation(value)), value);
  }
  check("the serialized form carries the version", JSON.parse(serializeInvocation(MONO)).version, 1);

  process.env[INVOCATION_ENV] = serializeInvocation(NAMED);
  process.env[INVOKED_AS_ENV] = HINT;
  check("both set, as the shim and launcher now write them: the JSON wins", takeInvocationFromEnv(), NAMED);
  check(
    "both variables are removed, so descendants never inherit them",
    process.env[INVOCATION_ENV] === undefined && process.env[INVOKED_AS_ENV] === undefined,
    true,
  );

  process.env[INVOCATION_ENV] = "not json";
  check("malformed JSON reads as unset", takeInvocationFromEnv(), undefined);
  process.env[INVOCATION_ENV] = '{"version":2,"program":"clawforge","mode":"installed","audience":"terminal"}';
  check("an unknown version reads as unset", takeInvocationFromEnv(), undefined);
  process.env[INVOCATION_ENV] = '{"version":1,"program":"clawforge","mode":"sometimes","audience":"terminal"}';
  check("an unknown mode reads as unset", takeInvocationFromEnv(), undefined);
  process.env[INVOCATION_ENV] = '{"version":1,"program":"clawforge","mode":"installed","audience":"terminal","extra":true}';
  check("an extra field reads as unset — never half a value", takeInvocationFromEnv(), undefined);
  process.env[INVOCATION_ENV] = '{"version":1,"program":"","mode":"installed","audience":"terminal"}';
  check("an empty program reads as unset", takeInvocationFromEnv(), undefined);
  process.env[INVOCATION_ENV] = '{"version":1,"program":"clawforge","mode":"installed","audience":"terminal","app":{"name":"x","selectedBy":"sometimes"}}';
  check("an unknown app selection reads as unset", takeInvocationFromEnv(), undefined);

  process.env[INVOKED_AS_ENV] = "./clawforge --app staging";
  check("the legacy shim variable is mapped onto the value", takeInvocationFromEnv(), NAMED);
  check("it is removed, so descendants never inherit it", process.env[INVOKED_AS_ENV], undefined);
  process.env[INVOKED_AS_ENV] = "clawforge";
  check("legacy without a suffix maps to the program alone", takeInvocationFromEnv(), GLOBAL);
  process.env[INVOKED_AS_ENV] = "/usr/local/bin/clawforge";
  check("a bare path ending in clawforge is still checkout mode", takeInvocationFromEnv(), { program: "/usr/local/bin/clawforge", mode: "checkout", audience: "terminal" });
  process.env[INVOKED_AS_ENV] = "   ";
  check("blank legacy reads as unset", takeInvocationFromEnv(), undefined);
  check("parseLegacyInvokedAs agrees with the env path", parseLegacyInvokedAs("../../clawforge --app app1"), { program: "../../clawforge", mode: "checkout", app: { name: "app1", selectedBy: "flag" }, audience: "terminal" });

  // --- monorepo prefix: outputs keep ./clawforge --------------------------------------------

  const mono = await samples();
  check("monorepo: Usage", mono.usage.includes("Usage: ./clawforge <command> [options]"), true);
  check("monorepo: help footer", mono.usage.includes("Run `./clawforge help <command>` or `./clawforge <command> --help`"), true);
  check("monorepo: command Usage", mono.commandHelp.includes("Usage: ./clawforge logs"), true);
  check("monorepo: doctor's refusal", mono.refusal.includes("Next: ./clawforge secrets --apply, ./clawforge up"), true);
  check("monorepo: MCP nextActions", mono.nextActions, ["./clawforge secrets --apply", "./clawforge up"]);

  // --- system-wide prefix: no ./clawforge anywhere ------------------------------------------

  setInvocation(GLOBAL);
  const global = await samples();
  check("global: Usage", global.usage.includes("Usage: clawforge <command> [options]"), true);
  check("global: help footer", global.usage.includes("Run `clawforge help <command>` or `clawforge <command> --help`"), true);
  check("global: command Usage", global.commandHelp.includes("Usage: clawforge logs"), true);
  check("global: doctor's refusal", global.refusal.includes("Next: clawforge secrets --apply, clawforge up"), true);
  check("global: doctor's JSON nextActions", global.json.includes('"clawforge up"'), true);
  check("global: MCP nextActions are what a human would type", global.nextActions, ["clawforge secrets --apply", "clawforge up"]);
  for (const [name, text] of Object.entries(global)) {
    if (typeof text === "string") check(`global: ${name} has no ./clawforge`, text.includes(HINT), false);
  }
  check("global: MCP nextActions have no ./clawforge", global.nextActions.some((entry) => entry.includes(HINT)), false);

  // --- the advice renderer --------------------------------------------------------------------
  // One renderer turns advice — a clawforge command, a shell line, a manual step — into the
  // exact text a user pastes. The `--app` rule and the argument quoting live there and only
  // there; advice.ts is data.

  const SELECTIONS: readonly { readonly label: string; readonly on: Invocation; readonly named: boolean }[] = [
    { label: "no app", on: MONO, named: false },
    { label: "openclaw", on: { ...MONO, app: { name: "openclaw", selectedBy: "flag" } }, named: false },
    { label: "flag", on: { ...MONO, app: { name: "demo", selectedBy: "flag" } }, named: true },
    { label: "env", on: { ...MONO, app: { name: "demo", selectedBy: "env" } }, named: true },
    { label: "sole", on: { ...MONO, app: { name: "demo", selectedBy: "sole" } }, named: true },
    { label: "cwd", on: { ...MONO, app: { name: "demo", selectedBy: "cwd" } }, named: false },
    { label: "default", on: { ...MONO, app: { name: "demo", selectedBy: "default" } }, named: false },
  ];
  const STATUS = `${HINT} status`;
  const DEMO_STATUS = `${HINT} --app demo status`;
  const DEMO_LOGS = `${HINT} --app demo logs`;
  const NEW_APP_LINE = `${HINT} new-app <name>`;
  const CHECK_LINE = `${HINT} check`;
  const DEMO_CHECK = `${HINT} --app demo check`;
  const SPACED_LOGS = `${HINT} logs 'a b'`;
  const NOTED_UP = `${HINT} up  (after the change)`;
  const MANUAL_TEXT = "reconnect the MCP client (in Claude Code: /mcp)";
  const SHELL_TEXT = "cd /srv && ./clawforge backup";
  const SHELL_NOTE = "on the target";
  const NOTED_SHELL = `${SHELL_TEXT}  (${SHELL_NOTE})`;
  const ARROW = "\n    → ";

  // 1. The `--app` rule per selectedBy: the pasted command names the deployment exactly when the
  //    invocation on screen would not re-select it by itself.
  for (const { label, on, named } of SELECTIONS) {
    setInvocation(on);
    check(`a status advice line under ${label}`, renderAdvice(command(["status"])), named ? DEMO_STATUS : STATUS);
  }

  // 2. Gate commands run before a deployment is resolved, so they never receive an --app — the
  //    same names both entries register before any command runs.
  const GATE_NAMES = ["new-app", "check", "list", "remove-app", "version", "completion", "init"];
  useGateCommands(GATE_NAMES);
  const FLAG_DEMO: Invocation = { ...MONO, app: { name: "demo", selectedBy: "flag" } };
  setInvocation(FLAG_DEMO);
  check("a gate command never gets an --app", renderAdvice(command(["new-app", "<name>"])), NEW_APP_LINE);
  check("the check runner itself never gets one", renderAdvice(command(["check"])), CHECK_LINE);

  // 3. An explicit app on the advice wins over the invocation, gate command or not.
  setInvocation(MONO);
  check("an explicit app under no app", renderAdvice(command(["status"], { app: "demo" })), DEMO_STATUS);
  check("an explicit app on a gate command", renderAdvice(command(["check"], { app: "demo" })), DEMO_CHECK);

  // 4. Quoting follows the program's shape, not the shell's: a path spelling is a POSIX shell
  //    (single quotes), the bare system-wide command is cmd/PowerShell (double quotes). A
  //    placeholder <…> stays bare under both.
  check("a spaced word under a path spelling", renderAdvice(command(["logs", "a b"])), SPACED_LOGS);
  check("a placeholder stays bare under a path spelling", renderAdvice(command(["new-app", "<name>"])), NEW_APP_LINE);
  setInvocation(GLOBAL);
  check("a spaced word under the bare program", renderAdvice(command(["logs", "a b"])), `clawforge logs "a b"`);
  check("a placeholder stays bare under the bare program", renderAdvice(command(["new-app", "<name>"])), "clawforge new-app <name>");

  // 5. A note trails the line, after two spaces.
  setInvocation(MONO);
  check("a note trails the command", renderAdvice(command("up", { note: "after the change" })), NOTED_UP);

  // 6. A shell line is its own text, byte for byte, under every invocation; only a note appends.
  for (const shell of ["posix", "cmd", "pwsh"] as const) {
    for (const { label, on } of SELECTIONS) {
      setInvocation(on);
      check(`a ${shell} line is verbatim under ${label}`, renderAdvice(shellLine(shell, SHELL_TEXT)), SHELL_TEXT);
      check(`a ${shell} line keeps its note under ${label}`, renderAdvice(shellLine(shell, SHELL_TEXT, { note: SHELL_NOTE })), NOTED_SHELL);
    }
  }

  // 7. A manual step is its own text.
  setInvocation(MONO);
  check("a manual step is its text", renderAdvice(manual(MANUAL_TEXT)), MANUAL_TEXT);

  // 8. shimInvocation: text that leaves the terminal spells the shim program itself, and a
  //    bare-program invocation is untouched by it.
  setInvocation(GLOBAL);
  check("the shim invocation spells the checkout program", renderAdvice(command(["status"]), shimInvocation()), STATUS);
  check("the shim invocation names its app", renderAdvice(command(["status"]), shimInvocation("demo")), DEMO_STATUS);
  check("a bare-program invocation is untouched by the shim", renderAdvice(command(["status"])), "clawforge status");

  // 9. The error path: die and UserError carry advice, formatError appends one rendered line
  //    per piece, and reportError prints the whole thing verbatim through the output sink.
  let failure: unknown;
  try {
    die("bootstrap failed", command(["logs"]));
  } catch (error) {
    failure = error;
  }
  setInvocation(MONO);
  check("formatError appends the advice line under the checkout prefix", formatError(failure), `bootstrap failed${ARROW}${HINT} logs`);
  setInvocation(GLOBAL);
  check("the advice line follows the bare program", formatError(failure), `bootstrap failed${ARROW}clawforge logs`);
  setInvocation(FLAG_DEMO);
  check("the advice line names the deployment", formatError(failure), `bootstrap failed${ARROW}${DEMO_LOGS}`);
  setInvocation(MONO);
  check(
    "a manual step trails the message",
    formatError(new UserError("bad", { advice: [manual("see the guide")] })),
    `bad${ARROW}see the guide`,
  );

  // A registered secret is masked in the message and in the advice. There is no unregister, so
  // the value is unique to this file and nothing below asserts on unrelated text.
  const SECRET = "token-value-1234567890";
  registerSecret(SECRET);
  check(
    "a secret is masked in the message and the advice",
    formatError(new UserError(`gateway rejected ${SECRET}`, { advice: [manual(`put ${SECRET} in .env`)] })),
    `gateway rejected ***${ARROW}put *** in .env`,
  );
  const reported = await capture(() => reportError(new UserError("nope", { advice: [command("up")] })));
  const plainText = reported.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  check("reportError prints the error and its advice line", plainText, `error: nope${ARROW}${HINT} up\n`);

  // 10. The renderer's fixed point is now the whole output layer: every line above prints
  //     exactly as renderAdvice() built it, so there is no rewriting left to describe.
  setInvocation(MONO);
} finally {
  setInvocation(MONO);
  await teardownFixtureDeployment(deployment);
}

finish("invocation hints");
