// Everything about a set that can be decided without a running instance.
//
// The point is where the error is found, not that it is found: a coherence mistake caught
// here costs an edit, and the same mistake caught during `apply` costs a half-changed
// instance and a rollback. So every question answerable from files alone is answered from
// files alone, and the ones that genuinely need the instance are named as such rather than
// guessed at.
//
// What is deliberately NOT attempted here:
//
//   - whether the pinned image's OpenClaw actually supports what the recipes use. Knowing
//     that means having the image, which means a target; probing `--help` text for feature
//     detection would test the help text rather than the capability, and break silently the
//     day someone rewords it. `apply` compares versions against the live instance, where the
//     answer is real.
//   - full cron semantics. This rejects what is clearly not a schedule (see cronProblem);
//     a set whose schedule passes here is not thereby proven to run when its author meant.
//     Saying so is the point — "not rejected" and "valid" are different claims.

import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { recipesDir, desiredStateFile } from "../deployment.ts";
import { collectSecretRefs } from "../secrets.ts";
import { problem } from "../inspection.ts";
import type { Problem } from "../inspection.ts";
import type { SetManifest } from "./model.ts";

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Whether a cron field is one this framework will accept.
 *
 *  Deliberately shallow: `*`, `*\/N`, a number, a range, a list of those. It rejects a field
 *  that is plainly not a schedule — a word, an empty entry, a stray character — and passes
 *  everything that looks like one. Ranges are not checked against each field's own bounds,
 *  because the gateway is what actually parses these and a second, subtly different parser
 *  here would eventually disagree with it and be wrong in a way nobody could see. */
function cronFieldLooksValid(field: string): boolean {
  return field.split(",").every((part) => /^(\*|\d+)(-\d+)?(\/\d+)?$/.test(part));
}

/** The reason a cron expression is refused, or undefined when it is accepted. */
export function cronProblem(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/).filter((field) => field !== "");
  if (fields.length !== 5) {
    return `expected five fields, got ${fields.length} (${JSON.stringify(expression)})`;
  }
  const bad = fields.filter((field) => !cronFieldLooksValid(field));
  return bad.length === 0 ? undefined : `field(s) ${bad.map((field) => JSON.stringify(field)).join(", ")} are not schedule terms`;
}

/** Reads the desired state as declared, for the secret references inside it. Absent or
 *  unparseable is not this function's finding to report — `set build` already refuses to
 *  build from a declaration it cannot read, so anything reaching here has one. */
async function declaredConfig(): Promise<unknown> {
  try {
    const entries = JSON.parse(await readFile(desiredStateFile(), "utf8")) as { path: string; value?: unknown }[];
    // collectSecretRefs walks a config OBJECT; the declaration is a list of path/value
    // pairs, so the values are what it has to be shown.
    return entries.map((entry) => entry.value);
  } catch {
    return [];
  }
}

/** Every finding a set can produce without a gateway.
 *
 *  Takes the manifest rather than a directory: `set build` already collected the tree into
 *  one, and validating a built artifact must give exactly the same answers as validating the
 *  tree it came from. Two collectors would be two answers. */
export async function validateSet(manifest: SetManifest, options: { checkFiles?: boolean } = {}): Promise<Problem[]> {
  const problems: Problem[] = [];

  // --- the image is pinned ------------------------------------------------------------
  if (!manifest.requires.image.includes("@sha256:")) {
    problems.push(
      problem(
        "SET_IMAGE_UNPINNED",
        `the set requires image ${manifest.requires.image}, which is a tag — a set that names a tag installs whatever that tag means on the day it is installed`,
      ),
    );
  }

  // --- recipes are complete -------------------------------------------------------------
  //
  // Checked against the working tree only when asked: a built artifact carries its files as
  // checksums rather than paths on this machine, and looking for them here would report a
  // valid artifact as broken on any machine that did not happen to build it.
  for (const [name, recipe] of Object.entries(manifest.recipes)) {
    const declaresAgent = recipe.agent !== undefined;

    if (options.checkFiles === true) {
      const dir = resolve(recipesDir(), name);
      if (!(await exists(dir))) {
        problems.push(problem("SET_RECIPE_INCOMPLETE", `recipe "${name}" is declared but ${dir} does not exist`));
        continue;
      }
      // server.ts is required only of a recipe that declares an agent, because that is what
      // makes it an MCP recipe: provision-agent registers the gateway to spawn exactly that
      // file. A recipe without an agent bundle is a plain service — its own compose stack,
      // installed by `./clawforge recipe install`, described by recipe.json — and demanding a
      // server.ts of it was a false positive found by running this against a real
      // deployment. A validator that fires on a correct set is one people learn to skip,
      // which costs more than the rule was ever worth.
      if (declaresAgent && !(await exists(resolve(dir, "server.ts")))) {
        problems.push(problem("SET_RECIPE_INCOMPLETE", `recipe "${name}" declares an agent but has no server.ts — that is the file the gateway is registered to spawn`));
      }
      if (!declaresAgent && !(await exists(resolve(dir, "recipe.json"))) && !(await exists(resolve(dir, "server.ts")))) {
        problems.push(problem("SET_RECIPE_INCOMPLETE", `recipe "${name}" is neither an MCP recipe (server.ts) nor a service (recipe.json)`));
      }
      if (declaresAgent && !(await exists(resolve(dir, "agent", "config.json")))) {
        problems.push(problem("SET_RECIPE_INCOMPLETE", `recipe "${name}" declares an agent but has no agent/config.json`));
      }
    }

    // The mirror is what the recipe serves. A recipe that serves nothing is not a mistake
    // this can prove — a plain service recipe is legitimate — so only an empty checksum map
    // WITH an agent bundle is reported: an agent with nothing to read is one that was
    // supposed to have content.
    if (declaresAgent && Object.keys(recipe.files).length === 0) {
      problems.push(
        problem("SET_RECIPE_INCOMPLETE", `recipe "${name}" declares an agent but serves no content — the agent would have nothing to read`),
      );
    }
  }

  // --- references resolve -----------------------------------------------------------------
  const declaredAgents = new Set(
    Object.values(manifest.recipes)
      .map((recipe) => recipe.agent?.agentId)
      .filter((id): id is string => id !== undefined),
  );
  const declaredServers = new Set(
    Object.values(manifest.recipes)
      .map((recipe) => recipe.agent?.mcpServerName)
      .filter((name): name is string => name !== undefined),
  );

  for (const [recipeName, checks] of Object.entries(manifest.acceptance)) {
    if (manifest.recipes[recipeName] === undefined) {
      problems.push(problem("SET_REFERENCE_BROKEN", `acceptance is declared for recipe "${recipeName}", which the set does not contain`));
      continue;
    }
    for (const check of checks) {
      const agent = typeof check.agent === "string" ? check.agent : undefined;
      if (agent !== undefined && !declaredAgents.has(agent)) {
        problems.push(
          problem("SET_REFERENCE_BROKEN", `recipe "${recipeName}": acceptance check ${JSON.stringify(check.name ?? check.kind)} names agent "${agent}", which no recipe in this set declares`),
        );
      }
      const server = typeof check.server === "string" ? check.server : undefined;
      if (server !== undefined && !declaredServers.has(server)) {
        problems.push(
          problem("SET_REFERENCE_BROKEN", `recipe "${recipeName}": acceptance check ${JSON.stringify(check.name ?? check.kind)} names MCP server "${server}", which no recipe in this set declares`),
        );
      }
    }
  }

  // --- schedules are schedules -------------------------------------------------------------
  for (const [name, recipe] of Object.entries(manifest.recipes)) {
    const schedule = recipe.agent?.cronSchedule;
    if (schedule === undefined) continue;
    const reason = cronProblem(schedule);
    if (reason !== undefined) {
      problems.push(problem("SET_SCHEDULE_INVALID", `recipe "${name}": ${reason}`));
    }
  }

  // --- every referenced secret has a name in the set ------------------------------------------
  //
  // The gateway resolves SecretRefs at startup and reports a missing one only in its log, as
  // a crash loop. A set that references a variable it does not require is that failure,
  // declared in advance.
  const declaredSecrets = new Set(manifest.secrets);
  for (const ref of collectSecretRefs(await declaredConfig())) {
    if (!declaredSecrets.has(ref.name)) {
      problems.push(
        problem("SET_SECRET_UNDECLARED", `the declaration references ${ref.name} (${ref.usedBy}) but the set does not require it by name`),
      );
    }
  }

  return problems;
}
