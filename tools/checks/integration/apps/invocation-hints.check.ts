// The commands a message tells the user to run follow how the CLI was invoked: `./clawforge`
// from the monorepo gate or the committed shim, `clawforge` from the system-wide command
// (where `./clawforge` does not even run in cmd.exe or PowerShell). Covered: the helper
// itself, help (Usage and footer), doctor's refusal and its JSON, the MCP envelope built
// from it, and the entry's hand-over of the prefix.

import { renderUsage, renderFullCommandHelp } from "#framework/core/io/help-render.ts";
import { INVOKED_AS_ENV, cli, invocation, localizeHints, setInvocation, takeInvokedAs } from "#framework/core/io/invocation.ts";
import { reportError, info, infoRaw } from "#framework/core/io/log.ts";
import { emit, emitRaw, withOutputSink } from "#framework/core/io/output.ts";
import { structuredResult } from "#framework/integration/mcp/server.ts";
import { cronLine, displayCommandLine, posixTargetInvocation, schedulerIdentity, withScheduleRunner } from "#framework/commands/operate/schedule.ts";
import { backupInstall } from "#framework/commands/lifecycle/backup/install.ts";
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

  check("nothing set: the monorepo prefix", invocation(), HINT);
  check("cli() renders the prefix and the rest", cli("bootstrap --check"), "./clawforge bootstrap --check");
  setInvocation("clawforge");
  check("cli() follows the prefix", cli("bootstrap --check"), "clawforge bootstrap --check");
  check("a bare hint is rewritten", localizeHints("run ./clawforge up, then `./clawforge logs`."), "run clawforge up, then `clawforge logs`.");
  check("a hint naming its own --app keeps it", localizeHints("run ./clawforge --app x bootstrap"), "run clawforge --app x bootstrap");
  check("a quoted argv element is left alone", localizeHints("&& './clawforge' 'backup'"), "&& './clawforge' 'backup'");
  check("a path and a regex source are left alone", localizeHints("apps/x/./clawforge y \\./clawforge z"), "apps/x/./clawforge y \\./clawforge z");
  setInvocation("./clawforge --app staging");
  check("a non-default deployment is named", localizeHints("run ./clawforge up"), "run ./clawforge --app staging up");
  check("and not twice", localizeHints("run ./clawforge --app x up"), "run ./clawforge --app x up");
  check("emitRaw never rewrites data", await capture(() => emitRaw("./clawforge up\n")), "./clawforge up\n");
  check("emit rewrites machine output", await capture(() => emit("./clawforge up\n")), "./clawforge --app staging up\n");
  check("info rewrites diagnostics", await capture(() => info("./clawforge up")).then((text) => text.includes("./clawforge --app staging up")), true);
  // Lines copied into another shell or host are printed verbatim under any prefix.
  const cron = cronLine(60, { cwd: "/srv/app1", command: "./clawforge", args: ["--app", "app1", "backup"] }, "backup", "app1");
  const remote = [
    `would bootstrap remotely afterwards: cd /opt/oc && ./clawforge --app staging bootstrap`,
    `bring it up there with: cd /opt/oc && ./clawforge --app staging bootstrap`,
    `provider keys are not copied — install them there: ./clawforge --app staging secrets --apply`,
    `  bash -lc "cd /srv/app1 && ./clawforge backup"`,
  ];
  for (const prefix of ["clawforge", "./clawforge --app x"]) {
    setInvocation(prefix);
    for (const line of [cron, ...remote]) {
      check(`infoRaw keeps the line verbatim under "${prefix}"`, await capture(() => infoRaw(line)).then((text) => text.includes(line)), true);
    }
    check(`info would rewrite the cron line under "${prefix}"`, await capture(() => info(cron)).then((text) => text.includes(cron)), false);
  }
  // --- the call sites: what they print is what they install or pass on -----------------------
  // A bare `./clawforge` in a stubbed command would be rewritten by info(), so reverting any
  // infoRaw call site to info() turns one of these red under a non-default prefix.

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
    { label: "backup install", run: (ctx: Context, args: string[]) => backupInstall(ctx, args), job: "backup", jobArgs: ["backup"], minutes: 1440 },
    { label: "watch install", run: (ctx: Context, args: string[]) => watchInstall(ctx, args), job: "watch", jobArgs: ["watch", "check"], minutes: 5 },
  ];

  for (const prefix of ["clawforge", "./clawforge --app x"]) {
    setInvocation(prefix);
    const at = `under "${prefix}"`;
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

  setInvocation("");
  check("blank falls back to the monorepo prefix", invocation(), HINT);

  process.env[INVOKED_AS_ENV] = "./clawforge";
  check("the shim's variable is read", takeInvokedAs(), "./clawforge");
  check("and removed, so descendants never inherit it", process.env[INVOKED_AS_ENV], undefined);
  check("unset reads as undefined", takeInvokedAs(), undefined);

  // --- monorepo prefix: outputs keep ./clawforge --------------------------------------------

  const mono = await samples();
  check("monorepo: Usage", mono.usage.includes("Usage: ./clawforge <command> [options]"), true);
  check("monorepo: help footer", mono.usage.includes("Run `./clawforge help <command>` or `./clawforge <command> --help`"), true);
  check("monorepo: command Usage", mono.commandHelp.includes("Usage: ./clawforge logs"), true);
  check("monorepo: doctor's refusal", mono.refusal.includes("Next: ./clawforge secrets --apply, ./clawforge up"), true);
  check("monorepo: MCP nextActions", mono.nextActions, ["./clawforge secrets --apply", "./clawforge up"]);

  // --- system-wide prefix: no ./clawforge anywhere ------------------------------------------

  setInvocation("clawforge");
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
} finally {
  setInvocation("");
  await teardownFixtureDeployment(deployment);
}

finish("invocation hints");
