// `./clawforge plan` — what the declaration implies, as an ordered list of actions, without doing
// any of it.
//
// This is the command that stops a coder having to remember the framework's internals. The
// dependencies were always real — configuration is read at startup so it has to be applied
// before a restart; provisioning talks to the gateway so the gateway has to be up first;
// a missing secret stops the instance from starting at all, so it comes before either — but
// they lived in whoever had learned them. Here they live in one function, with the finding
// that motivates each step attached to it.
//
// Read-only, like inspect: a plan you have to trust because running it is the only way to
// see it is not a plan.
//
// Two kinds of action. Most name a command this framework can run, and `./clawforge apply`
// executes exactly those. A few are advisory — nothing on this side can perform them
// (an MCP client owns its own processes) or performing them automatically would defeat
// their purpose (rewriting the lock file would silently re-pin whatever just drifted).

import { log, info, die } from "#src/core/log.ts";
import { emit, isCaptured } from "#src/core/output.ts";
import { gatherInspection } from "./inspect/gather.ts";
import { currentComposition, declarationChecksum } from "../management/lock.ts";
import { isHealthy } from "#src/service/inspection.ts";
import { withSetSource } from "#src/set/artifacts/source.ts";
import { withUnpackedArtifact } from "#src/set/artifacts/install.ts";
import type { Inspection, Problem, ProblemCode } from "#src/service/inspection.ts";
import type { Context } from "#src/core/context.ts";

export interface PlanAction {
  /** Stable identifier, so a report about a step can name it: "apply-config",
   *  "provision-agent:example-recipe". */
  readonly id: string;
  readonly summary: string;
  /** The framework command this step runs, absent for an advisory step. */
  readonly command?: string;
  /** Which findings this step resolves — why it is in the list at all. */
  readonly because: ProblemCode[];
  /** True when `./clawforge apply` cannot or must not perform it. */
  readonly advisory?: boolean;
}

export interface Plan {
  readonly deployment: string;
  /** What the declaration was when this plan was computed. `apply` refuses a plan whose
   *  declaration has changed since — the steps below were chosen for a different repository
   *  state and applying them would enact a decision nobody made. */
  readonly declarationChecksum: string;
  readonly healthy: boolean;
  readonly problems: readonly Problem[];
  readonly actions: readonly PlanAction[];
}

function has(problems: readonly Problem[], ...codes: ProblemCode[]): boolean {
  return problems.some((entry) => codes.includes(entry.code));
}

function found(problems: readonly Problem[], ...codes: ProblemCode[]): ProblemCode[] {
  return [...new Set(problems.filter((entry) => codes.includes(entry.code)).map((entry) => entry.code))];
}

/** Which recipes have findings of their own, and which. Recipe work is per recipe rather
 *  than one blanket step: re-provisioning a recipe that is already correct is wasted time
 *  on a live instance, and a report that says which recipe needed what is the useful one. */
function recipeWork(inspection: Inspection): Map<string, ProblemCode[]> {
  const perRecipe = new Map<string, ProblemCode[]>();
  const recipeCodes: ProblemCode[] = ["RECIPE_MIRROR_DRIFT", "AGENT_MISSING", "MCP_SERVER_MISSING", "CRON_DRIFT"];

  for (const entry of inspection.problems) {
    if (!recipeCodes.includes(entry.code)) continue;
    // The remedy a recipe finding carries is "./clawforge provision-agent <recipe>" — the recipe
    // name is taken from there rather than re-parsed out of the human sentence.
    const recipe = entry.nextAction.startsWith("./clawforge provision-agent ")
      ? entry.nextAction.slice("./clawforge provision-agent ".length).trim()
      : undefined;
    if (recipe === undefined) continue;
    const codes = perRecipe.get(recipe) ?? [];
    if (!codes.includes(entry.code)) codes.push(entry.code);
    perRecipe.set(recipe, codes);
  }
  return perRecipe;
}

/** SET_OBJECT_ORPHANED problems carry their remedy as "./clawforge set forget --kind <kind> --name
 *  <name>" — the same convention recipeWork uses for provision-agent, and for the same
 *  reason: the kind and name are taken from there rather than re-parsed out of the human
 *  sentence. */
const FORGET_PATTERN = /^\.\/clawforge set forget --kind (\S+) --name (.+)$/;

/** Orphaned objects, turned into steps. An agent is always advisory — deleting one prunes
 *  its workspace and memory, and that is a decision for whoever reads the plan, not something
 *  `./clawforge apply` performs on its own. An MCP server or cron job carries no memory of its own,
 *  so removing one is an ordinary executable step, same as provisioning it was. */
function orphanActions(inspection: Inspection): PlanAction[] {
  const actions: PlanAction[] = [];
  for (const entry of inspection.problems) {
    if (entry.code !== "SET_OBJECT_ORPHANED") continue;
    const match = FORGET_PATTERN.exec(entry.nextAction);
    if (match === null) continue;
    const [, kind, name] = match;
    if (kind !== "agent" && kind !== "mcp-server" && kind !== "cron-job") continue;
    if (kind === "agent") {
      actions.push({
        id: `remove-owned:${kind}:${name}`,
        summary: `agent "${name}" was created for a recipe no longer in the set — removing it would also prune its workspace and memory`,
        because: ["SET_OBJECT_ORPHANED"],
        advisory: true,
      });
    } else {
      actions.push({
        id: `remove-owned:${kind}:${name}`,
        summary: `remove the ${kind} "${name}", created for a recipe no longer in the set`,
        command: `./clawforge set forget --kind ${kind} --name ${name}`,
        because: ["SET_OBJECT_ORPHANED"],
      });
    }
  }
  return actions;
}

/** The ordered steps. Exported so `apply` executes exactly this list and the checks can
 *  assert the order without a live instance. */
export function planActions(inspection: Inspection): PlanAction[] {
  const { problems } = inspection;
  const actions: PlanAction[] = [];

  // 1. Secrets first: a missing one stops the instance from starting, so every later step
  //    would be working against something that cannot come up.
  if (has(problems, "SECRET_MISSING")) {
    actions.push({
      id: "secrets",
      summary: "install the missing secrets on the target",
      command: "./clawforge secrets --apply",
      because: found(problems, "SECRET_MISSING"),
    });
  }

  // 2. Configuration before anything starts or restarts: it is read at startup, so applying
  //    it afterwards would need a second restart nobody planned.
  if (has(problems, "CONFIG_DRIFT")) {
    actions.push({
      id: "apply-config",
      summary: "push config/desired-state.json onto the instance",
      command: "./clawforge apply-config",
      because: found(problems, "CONFIG_DRIFT"),
    });
  }

  // 3. Bring it up, or restart it — never both. A stopped instance reads the configuration
  //    when it starts, so starting it is already the restart.
  if (has(problems, "GATEWAY_DOWN")) {
    actions.push({
      id: "up",
      summary: "start the gateway",
      command: "./clawforge up",
      because: found(problems, "GATEWAY_DOWN"),
    });
  } else if (has(problems, "RESTART_REQUIRED", "CONFIG_DRIFT") ||
    (inspection.observed.running && has(problems, "SECRET_MISSING"))) {
    // Drift and newly installed secrets are read only at startup. A stopped instance takes
    // the `up` branch above, so only a running one needs this restart.
    actions.push({
      id: "restart",
      summary: "restart so the instance reads the configuration on disk",
      command: "./clawforge restart",
      because: found(problems, "RESTART_REQUIRED", "CONFIG_DRIFT", "SECRET_MISSING"),
    });
  }

  // 4. Recipes last among the executable steps: provisioning talks to a running gateway.
  for (const [recipe, codes] of [...recipeWork(inspection)].sort(([a], [b]) => a.localeCompare(b))) {
    actions.push({
      id: `provision-agent:${recipe}`,
      summary: `re-provision recipe "${recipe}" (files, agent, MCP server, cron)`,
      command: `./clawforge provision-agent ${recipe}`,
      because: codes,
    });
  }

  // 4b. Objects this framework created for a recipe the set no longer declares this way —
  //     dropped entirely, or renamed. After provisioning, not before: a rename shows up as
  //     one recipe's work adding the new name and this removing the old one, and the new one
  //     should exist before the old one goes.
  actions.push(...orphanActions(inspection));

  // 5. Advisory. Mirrored recipe files changing is precisely when a client that has been
  //    holding that recipe's MCP server open is serving the old content — nothing here can
  //    reconnect it, because the client owns that process.
  if (recipeWork(inspection).size > 0) {
    actions.push({
      id: "reconnect-mcp",
      summary: "reconnect the MCP client: a server it started earlier is serving the previous files",
      because: ["MCP_RESTART_REQUIRED"],
      advisory: true,
    });
  }

  // The lock is never rewritten automatically. Re-pinning whatever drifted is how a
  // reproducibility claim turns into a rubber stamp; the decision is the reader's.
  if (has(problems, "LOCK_MISSING", "LOCK_DRIFT")) {
    actions.push({
      id: "lock",
      summary: "review the difference from the lock, then run ./clawforge lock to re-pin it deliberately",
      because: found(problems, "LOCK_MISSING", "LOCK_DRIFT"),
      advisory: true,
    });
  }

  return actions;
}

/** Exported so `apply` can compute a plan itself rather than being handed one — a plan
 *  passed between processes would be a file format, and there is nothing yet that needs
 *  one. */
export async function computePlan(ctx: Context): Promise<Plan> {
  const inspection = await gatherInspection(ctx);
  return {
    deployment: inspection.declared.deployment,
    declarationChecksum: declarationChecksum(await currentComposition(ctx)),
    healthy: isHealthy(inspection),
    problems: inspection.problems,
    actions: planActions(inspection),
  };
}

export async function plan(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = args.includes("--json");
  let artifact: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--set") {
      artifact = args[index + 1] ?? die("--set needs an artifact path");
      index += 1;
      continue;
    }
    die(`unknown argument: ${arg}`);
  }

  // One engine, two sources: with --set the declaration comes from the artifact and
  // everything about the machine keeps coming from the deployment. Without it, nothing
  // changes.
  const computed = artifact === undefined
    ? await computePlan(ctx)
    : await withUnpackedArtifact(artifact, (staging) => withSetSource(staging, () => computePlan(ctx)));

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(computed, null, 2)}\n`);
    return;
  }

  if (computed.actions.length === 0) {
    log(`${computed.deployment} is what this repository declares — nothing to do`);
    return;
  }

  const executable = computed.actions.filter((action) => action.advisory !== true);
  log(`${computed.actions.length} step(s) — ${executable.length} that ./clawforge apply will run`);
  computed.actions.forEach((action, index) => {
    info(`${index + 1}. ${action.summary}`);
    info(`     ${action.advisory === true ? "(you)" : action.command}   because ${action.because.join(", ")}`);
  });
  log("apply it: ./clawforge apply");
}
