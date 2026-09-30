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
import { cronLine } from "#framework/commands/operate/schedule.ts";
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
