// `./clawforge plan` — the order, and why each step is in the list.
//
// The order is the whole product: it encodes dependencies a coder used to have to know.
// Getting it wrong is not a crash, it is a run that reports success and leaves the instance
// on the old configuration — which is what happened by hand before this command existed.
// So each rule is asserted as a rule, against inspections built to provoke it.

import { planActions } from "../framework/commands/plan.ts";
import { problem } from "../framework/inspection.ts";
import type { Inspection, Problem } from "../framework/inspection.ts";

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

function inspectionWith(problems: Problem[], running = true): Inspection {
  return {
    declared: { deployment: "example", config: [], image: "example/image:tag", recipes: ["demo"] },
    observed: {
      running,
      health: running ? "healthy" : undefined,
      probes: {},
      config: {},
      secrets: [],
      agents: [],
      mcpServers: [],
      cronJobs: [],
      foreignObjects: [],
    },
    problems,
  };
}

function ids(problems: Problem[], running = true): string[] {
  return planActions(inspectionWith(problems, running)).map((action) => action.id);
}

// --- nothing wrong, nothing to do --------------------------------------------------------

check("a clean inspection produces an empty plan", ids([]), []);

// --- the order is the product -------------------------------------------------------------

{
  // Everything at once, which is also the order the rules have to resolve against each
  // other: a secret missing, a setting drifted, and a recipe that needs re-provisioning.
  const everything = ids([
    problem("CONFIG_DRIFT", "gateway.mode differs"),
    problem("RECIPE_MIRROR_DRIFT", "demo differs", "./clawforge provision-agent demo"),
    problem("SECRET_MISSING", "ZAI_API_KEY"),
  ]);
  check("secrets, then config, then restart, then recipes", everything, [
    "secrets",
    "apply-config",
    "restart",
    "provision-agent:demo",
    "reconnect-mcp",
  ]);
}

// A missing secret stops the instance from starting at all, so nothing that needs it to be
// up may be attempted first.
check("secrets come before anything that needs the instance", ids([problem("SECRET_MISSING", "x"), problem("CONFIG_DRIFT", "y")]).slice(0, 2), ["secrets", "apply-config"]);

// Configuration is read at startup. Applied after the restart, it would need a second one —
// which is exactly the mistake this order exists to prevent.
check("configuration is applied before the restart that reads it", ids([problem("CONFIG_DRIFT", "y")]), ["apply-config", "restart"]);

// A drifted setting implies a restart even though nothing has reported RESTART_REQUIRED yet:
// the step above is about to write a file the running instance will not read.
check("drift alone is enough to plan the restart", ids([problem("CONFIG_DRIFT", "y")]).includes("restart"), true);

{
  // A stopped instance reads its configuration when it starts, so starting IS the restart.
  // Planning both would restart a container that had just come up with the right settings.
  const downWithDrift = ids([problem("GATEWAY_DOWN", "not running"), problem("CONFIG_DRIFT", "y")], false);
  check("a stopped instance is started, not started and then restarted", downWithDrift, ["apply-config", "up"]);
  check("and the start comes after the configuration it will read", downWithDrift.indexOf("apply-config") < downWithDrift.indexOf("up"), true);
  // The failure this pairing prevents: an inspection that skipped the comparison because the
  // instance was down planned only [up], and the instance came back on a configuration
  // nobody had applied — with apply reporting success. The plan is only as good as the
  // finding, so both halves are asserted.
  check("a plan for a stopped, drifted instance is never just a start", downWithDrift.length > 1, true);
}

// Provisioning talks to a running gateway, so it cannot precede the step that provides one.
{
  const withRecipe = ids([problem("GATEWAY_DOWN", "not running"), problem("AGENT_MISSING", "demo agent", "./clawforge provision-agent demo")], false);
  check("recipes are provisioned after the gateway is up", withRecipe.indexOf("up") < withRecipe.indexOf("provision-agent:demo"), true);
}

// --- steps say why they are there ---------------------------------------------------------

{
  const actions = planActions(inspectionWith([problem("CONFIG_DRIFT", "gateway.mode differs")]));
  check("each step names the findings it resolves", actions[0].because, ["CONFIG_DRIFT"]);
  check("and the command it will run", actions[0].command, "./clawforge apply-config");
}

// --- one step per recipe, and only for recipes that need one -------------------------------

{
  const actions = planActions(
    inspectionWith([
      problem("CRON_DRIFT", "wrong schedule", "./clawforge provision-agent alpha"),
      problem("AGENT_MISSING", "no agent", "./clawforge provision-agent beta"),
      problem("MCP_SERVER_MISSING", "no server", "./clawforge provision-agent beta"),
    ]),
  );
  const recipeSteps = actions.filter((action) => action.id.startsWith("provision-agent:"));
  check("one step per recipe, not one per finding", recipeSteps.map((action) => action.id), ["provision-agent:alpha", "provision-agent:beta"]);
  check("and a recipe's step carries all of its findings", recipeSteps[1].because.sort(), ["AGENT_MISSING", "MCP_SERVER_MISSING"]);
}

// --- advisory steps: what apply must not do ------------------------------------------------

{
  const actions = planActions(inspectionWith([problem("RECIPE_MIRROR_DRIFT", "demo", "./clawforge provision-agent demo")]));
  const reconnect = actions.find((action) => action.id === "reconnect-mcp");
  check("changed recipe files raise the client-reconnect advisory", reconnect !== undefined, true);
  // Nothing on this side can perform it: the client owns the server process it started.
  check("which is advisory and has no command", [reconnect?.advisory, reconnect?.command], [true, undefined]);
}

{
  const actions = planActions(inspectionWith([problem("LOCK_DRIFT", "image digest moved")]));
  const lockStep = actions.find((action) => action.id === "lock");
  check("a lock difference is surfaced", lockStep !== undefined, true);
  // Re-pinning automatically would rubber-stamp whatever drifted, which is the opposite of
  // what a lock is for.
  check("but never applied automatically", lockStep?.advisory, true);
  check("and it is the only step, since nothing else is wrong", actions.length, 1);
}

{
  // The advisory steps must not make an otherwise clean instance look like it needs work
  // from apply: apply runs the executable ones, and there are none here.
  const actions = planActions(inspectionWith([problem("LOCK_MISSING", "no lock file")]));
  check("a warning-only plan has nothing for apply to run", actions.filter((action) => action.advisory !== true), []);
}

process.stderr.write(failed === 0 ? "all plan checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
