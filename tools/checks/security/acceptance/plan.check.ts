// `./clawforge plan` — the order, and why each step is in the list.
//
// The order is the whole product: it encodes dependencies a coder used to have to know.
// Getting it wrong is not a crash, it is a run that reports success and leaves the instance
// on the old configuration — which is what happened by hand before this command existed.
// So each rule is asserted as a rule, against inspections built to provoke it.

import { command } from "#framework/core/io/invocation/advice.ts";
import { planActions, planIsClean } from "#framework/commands/orchestration/plan.ts";
import { problem, PROBLEM_CODES } from "#framework/service/inspection.ts";
import type { Inspection, Problem, ProblemCode } from "#framework/service/inspection.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

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
    problem("RECIPE_MIRROR_DRIFT", "demo differs", command(["provision-agent", "demo"])),
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

check("a missing secret on a running instance is followed by a restart", ids([problem("SECRET_MISSING", "x")]), ["secrets", "restart"]);
check("a missing secret on a stopped instance is handled by its start", ids([problem("GATEWAY_DOWN", "not running"), problem("SECRET_MISSING", "x")], false), ["secrets", "up"]);

// Configuration is read at startup. Applied after the restart, it would need a second one —
// which is exactly the mistake this order exists to prevent.
check("configuration is applied before the restart that reads it", ids([problem("CONFIG_DRIFT", "y")]), ["apply-config", "restart"]);

// A drifted setting implies a restart even though nothing has reported RESTART_REQUIRED yet:
// the step above is about to write a file the running instance will not read.
checkTrue("drift alone is enough to plan the restart", ids([problem("CONFIG_DRIFT", "y")]).includes("restart"));

{
  // A stopped instance reads its configuration when it starts, so starting IS the restart.
  // Planning both would restart a container that had just come up with the right settings.
  const downWithDrift = ids([problem("GATEWAY_DOWN", "not running"), problem("CONFIG_DRIFT", "y")], false);
  check("a stopped instance is started, not started and then restarted", downWithDrift, ["apply-config", "up"]);
  checkTrue("and the start comes after the configuration it will read", downWithDrift.indexOf("apply-config") < downWithDrift.indexOf("up"));
  // The failure this pairing prevents: an inspection that skipped the comparison because the
  // instance was down planned only [up], and the instance came back on a configuration
  // nobody had applied — with apply reporting success. The plan is only as good as the
  // finding, so both halves are asserted.
  checkTrue("a plan for a stopped, drifted instance is never just a start", downWithDrift.length > 1);
}

// Provisioning talks to a running gateway, so it cannot precede the step that provides one.
{
  const withRecipe = ids([problem("GATEWAY_DOWN", "not running"), problem("AGENT_MISSING", "demo agent", command(["provision-agent", "demo"]))], false);
  checkTrue("recipes are provisioned after the gateway is up", withRecipe.indexOf("up") < withRecipe.indexOf("provision-agent:demo"));
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
      problem("CRON_DRIFT", "wrong schedule", command(["provision-agent", "alpha"])),
      problem("AGENT_MISSING", "no agent", command(["provision-agent", "beta"])),
      problem("MCP_SERVER_MISSING", "no server", command(["provision-agent", "beta"])),
    ]),
  );
  const recipeSteps = actions.filter((action) => action.id.startsWith("provision-agent:"));
  check("one step per recipe, not one per finding", recipeSteps.map((action) => action.id), ["provision-agent:alpha", "provision-agent:beta"]);
  check("and a recipe's step carries all of its findings", recipeSteps[1].because.sort(), ["AGENT_MISSING", "MCP_SERVER_MISSING"]);
}

// --- advisory steps: what apply must not do ------------------------------------------------

{
  const actions = planActions(inspectionWith([problem("RECIPE_MIRROR_DRIFT", "demo", command(["provision-agent", "demo"]))]));
  const reconnect = actions.find((action) => action.id === "reconnect-mcp");
  checkTrue("changed recipe files raise the client-reconnect advisory", reconnect !== undefined);
  // Nothing on this side can perform it: the client owns the server process it started.
  check("which is advisory and has no command", [reconnect?.advisory, reconnect?.command], [true, undefined]);
}

{
  const actions = planActions(inspectionWith([problem("LOCK_DRIFT", "image digest moved")]));
  const lockStep = actions.find((action) => action.id === "lock");
  checkTrue("a lock difference is surfaced", lockStep !== undefined);
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

// --- plugins/skills: always advisory, never one apply runs unattended ----------------------
//
// Third-party code is a supply-chain surface, and this framework does not even have proof
// its own reinstall command names the right package (commands/management/extensions.ts's header) — so a
// finding always becomes a step for the reader, never one apply performs.

{
  const detail = 'plugin "acme-tool" is version 2.0.0, locked at 1.0.0 — reinstall the pinned version: ./clawforge cli plugins install acme-tool@1.0.0 --force';
  const actions = planActions(inspectionWith([problem("PLUGIN_DRIFT", detail)]));
  check("a plugin drift finding becomes exactly one step", actions.length, 1);
  check("carrying the finding's own command, verbatim", actions[0].summary, detail);
  check("advisory — apply never runs it unattended", actions[0].advisory, true);
  check("with no command field of its own to be picked up by a runner", actions[0].command, undefined);
  check("naming the finding it resolves", actions[0].because, ["PLUGIN_DRIFT"]);
}

{
  const detail = 'skill "acme-skill" (source clawhub) is locked but no longer installed — reinstall it: ./clawforge cli skills install acme-skill --force';
  const actions = planActions(inspectionWith([problem("SKILL_DRIFT", detail)]));
  check("a skill drift finding becomes exactly one step too", actions.length, 1);
  check("also advisory", actions[0].advisory, true);
  check("naming SKILL_DRIFT, not PLUGIN_DRIFT", actions[0].because, ["SKILL_DRIFT"]);
}

{
  // Several findings at once — an added plugin nobody pinned, plus a removed skill — each
  // becomes its own step with its own stable id, never merged into one blanket line the way
  // LOCK_DRIFT's single re-pin advice is: a reader deciding what to do with one plugin must
  // not have to parse a sentence about a different skill to find it.
  const actions = planActions(
    inspectionWith([
      problem("PLUGIN_DRIFT", 'plugin "extra-tool" (source npm) is installed but not in the lock — review it, then either remove it or run ./clawforge lock to pin it deliberately'),
      problem("SKILL_DRIFT", 'skill "acme-skill" (source clawhub) is locked but no longer installed — reinstall it: ./clawforge cli skills install acme-skill --force'),
    ]),
  );
  check("each drifted plugin/skill is its own step", actions.length, 2);
  checkTrue("every one of them advisory", actions.every((action) => action.advisory === true));
  check("with distinct ids", new Set(actions.map((action) => action.id)).size, 2);
}

// --- coverage: every problem code produces a step, not just the ones this file names above -

// A plan that stays silent about a problem it did not fix is indistinguishable from one
// that found nothing wrong at all. fallbackActions() is the backstop that keeps that from
// happening; every code is asserted here in isolation so a new ProblemCode with no step
// fails this check instead of silently making "nothing to do" a lie.

{
  const missing: ProblemCode[] = [];
  for (const code of Object.keys(PROBLEM_CODES) as ProblemCode[]) {
    const actions = planActions(inspectionWith([problem(code, `synthetic ${code} finding`)]));
    if (actions.length === 0) missing.push(code);
  }
  check("every ProblemCode plans at least one step on its own", missing, []);
}

// NOT_BOOTSTRAPPED specifically: first in the list, advisory (this framework has no runner
// for it), and naming its own remedy.
{
  const actions = planActions(inspectionWith([problem("NOT_BOOTSTRAPPED", "no data directory yet")], false));
  check("NOT_BOOTSTRAPPED comes first", actions[0]?.id, "problem:NOT_BOOTSTRAPPED");
  check("it is advisory, with no command for apply to run", [actions[0]?.advisory, actions[0]?.command], [true, undefined]);
  checkTrue("and it points at bootstrap", (actions[0]?.summary ?? "").includes("./clawforge bootstrap"));
}

// A code this file already gives a specific step to (e.g. LOCK_DRIFT, above) must not also
// get the generic fallback step — one step per finding, not two.
{
  const actions = planActions(inspectionWith([problem("LOCK_DRIFT", "image digest moved")]));
  check("a code with a specific step never also gets the generic one", actions.filter((action) => action.id === "problem:LOCK_DRIFT"), []);
}

// --- "nothing to do" is a claim about the deployment, never inferred from the step count ---

checkTrue("healthy with no problems at all is the only clean plan", planIsClean({ healthy: true, problems: [] }));
check("healthy but with a warning is not clean", planIsClean({ healthy: true, problems: [problem("LOCK_MISSING", "no lock file")] }), false);
check("unhealthy is never clean, whatever the problem list says", planIsClean({ healthy: false, problems: [] }), false);

finish("plan");
