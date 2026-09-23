// `./clawforge plan` — the recovery group: the operator-side steps a plan emits before it
// repairs the instance.
//
// The instance-side half of the order (secrets, config, restart, recipes) is pinned in
// security/acceptance/plan.check.ts. This file pins the other half: the steps planned for
// findings about the operator's own folder — a stale .env, an incomplete local store, a
// missing declaration. It lives one level up from runtime/convergence/ because that folder
// sits at the layout law's seven-entry cap (foundation/layout.check.ts), and the recovery
// rules lead the list because every step behind them writes to the target — the values
// these steps recover exist nowhere else, and the flags and the order here are the
// difference between a recovery and a wipe.

import { planActions } from "#framework/commands/orchestration/plan.ts";
import { problem } from "#framework/service/inspection.ts";
import type { Inspection, Problem } from "#framework/service/inspection.ts";

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

// --- recovery: the operator side, before anything repairs the instance ----------------------

{
  const actions = planActions(inspectionWith([
    problem("ENV_STALE", "OPENCLAW_GATEWAY_PORT differs from the running container"),
    problem("STORE_INCOMPLETE", "ZAI_API_KEY (provider zai) is present on the target but has no value in the store"),
    problem("DECLARATION_MISSING", "config/desired-state.json does not exist"),
  ]));
  check("recovery is planned as recover-env, then the two dumps", actions.map((action) => action.id), [
    "recover-env",
    "secrets-dump",
    "apply-config-dump",
  ]);
  check("each recovery step names the finding that put it there", actions.map((action) => action.because), [
    ["ENV_STALE"],
    ["STORE_INCOMPLETE"],
    ["DECLARATION_MISSING"],
  ]);
  const recover = actions.find((action) => action.id === "recover-env");
  const dump = actions.find((action) => action.id === "apply-config-dump");
  const store = actions.find((action) => action.id === "secrets-dump");
  // A divergence between .env and the container is two readings the plan cannot tell apart —
  // a rotted file, or an edit the container has not caught up with. Planning the repair as an
  // executable step picked a side and rewrote deliberate edits (P2-03, round 3); the step
  // names both directions instead and leaves the choice with the reader.
  check("the .env step is advisory — a divergence alone never plans a write to .env", [recover?.advisory, recover?.command], [true, undefined]);
  check("it names both directions", [(recover?.summary ?? "").includes("--adopt-runtime"), (recover?.summary ?? "").includes("./clawforge up")], [true, true]);
  // The declaration is absent whenever this step is planned, so the dump's own --force
  // refusal — which protects an EXISTING declaration — has nothing to refuse.
  check("the declaration dump is the executable one, run as the command it names", [dump?.advisory ?? false, dump?.command], [false, "./clawforge apply-config --dump"]);
  // STORE_INCOMPLETE only fires when the store file exists, so the dump it plans would hit
  // the refusal every time; passing --force for it would overwrite a store whose contents
  // only the reader can judge. Advisory is how a plan says "decision, not repair".
  check("the store dump is advisory, with no command for apply to run", [store?.advisory, store?.command], [true, undefined]);
  check("and it says why: the refusal is the safeguard", (store?.summary ?? "").includes("--force"), true);
}

// A diverged .env on its own must plan nothing executable at all — that is the whole point
// of the advisory step (P2-03, round 3, at the plan layer).
{
  const actions = planActions(inspectionWith([
    problem("ENV_STALE", "OPENCLAW_GATEWAY_PORT differs from the running container"),
  ]));
  check("a diverged .env alone plans no executable step", actions.every((action) => action.advisory === true), true);
  check("and the divergence is still carried, as the advisory step's finding", actions.map((action) => action.because), [["ENV_STALE"]]);
}

// Recovery reads back what only the target still holds. `secrets --apply` REPLACES the
// target's config/.env with the names the local store supplies — applied before the dump,
// it would destroy exactly the values the dump exists to recover.
{
  const mixed = ids([problem("STORE_INCOMPLETE", "x"), problem("SECRET_MISSING", "y")]);
  check("the store dump precedes the apply that would overwrite what it reads", mixed.indexOf("secrets-dump") < mixed.indexOf("secrets"), true);
  const withDrift = ids([problem("DECLARATION_MISSING", "x"), problem("CONFIG_DRIFT", "y")]);
  check("the declaration dump precedes the apply-config that writes the target", withDrift.slice(0, 2), ["apply-config-dump", "apply-config"]);
}

process.stderr.write(failed === 0 ? "all plan checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
