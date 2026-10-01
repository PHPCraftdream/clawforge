// Everything about a set that can be decided without a running instance.
//
// A coherence mistake caught here costs an edit; the same mistake caught during `apply`
// costs a half-changed instance and a rollback. Every question answerable from files alone
// is answered from files alone; what genuinely needs the instance is named as such.
//
// Deliberately NOT attempted: whether the pinned image's OpenClaw supports what the
// recipes use (needs the image; `apply` compares versions against the live instance); full
// cron semantics (rejects what is clearly not a schedule — "not rejected" is not "valid").

import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRecipeDefinition } from "#src/service/recipe.ts";
import { recipesDir, desiredStateFile } from "#src/runtime/deployment.ts";
import { collectSecretRefs } from "#src/service/secrets.ts";
import { readLock } from "#src/commands/management/lock.ts";
import { imagePinAdvice, recipeIncomplete, recipeMissingDir, recipeInvalidDefinition } from "#src/set/advice.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem } from "#src/service/inspection.ts";
import type { SetManifest } from "#src/set/artifacts/model.ts";
import { hasDigest } from "#src/runtime/docker/image-ref.ts";

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Deliberately shallow: `*`, `*\/N`, a number, a range, a list of those — rejects what is
 *  plainly not a schedule, passes everything that looks like one. Ranges aren't checked
 *  against each field's own bounds: the gateway is the real parser, and a second one here
 *  would eventually disagree with it. */
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

/** Why `value` is not a valid desired-state declaration, or undefined when it is — a list
 *  of { path, value } ops, the exact shape OpenClaw's `config set --batch-file` consumes.
 *  Exported so `set build` can refuse the same malformed declaration early, rather than
 *  only here or inside the container during an actual apply. */
export function desiredStateShapeError(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return "must be an array of { path, value } operations — got a single object instead of a list";
  }
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return `entry ${index} is not an object`;
    }
    if (typeof (entry as { path?: unknown }).path !== "string" || (entry as { path: string }).path === "") {
      return `entry ${index} has no non-empty string "path"`;
    }
    if (!Object.hasOwn(entry, "value")) return `entry ${index} has no "value"`;
  }
  return undefined;
}

/** Reads the desired state as declared, for the secret references inside it. A missing or
 *  empty declaration is a finding, not a legitimate empty one: the tree validator must give
 *  the same answer an artifact carrying no declaration would (parity), and a deployment with
 *  no declaration at all must not read as coherent. Everything else unreadable is a finding
 *  too — checksum verification only proves an artifact's bytes match the manifest, never
 *  that they parse. */
async function declaredConfig(problems: Problem[]): Promise<unknown> {
  // Resolved outside the try: desiredStateFile() throws when no deployment is selected at
  // all — a wiring error in the caller, not a finding about a set.
  const path = desiredStateFile();

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      problems.push(
        problem("SET_DECLARATION_INVALID", `${path} is missing or empty — a set without its config declaration would install an unconfigured instance`),
      );
      return [];
    }
    problems.push(
      problem("SET_DECLARATION_INVALID", `${path} could not be read: ${(error as Error).message}`),
    );
    return [];
  }
  if (raw.trim() === "") {
    problems.push(
      problem("SET_DECLARATION_INVALID", `${path} is missing or empty — a set without its config declaration would install an unconfigured instance`),
    );
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    problems.push(
      problem("SET_DECLARATION_INVALID", `${path} is not valid JSON: ${(error as Error).message}`),
    );
    return [];
  }
  const shapeError = desiredStateShapeError(parsed);
  if (shapeError !== undefined) {
    problems.push(
      problem("SET_DECLARATION_INVALID", `${path}: ${shapeError}`),
    );
    return [];
  }
  // collectSecretRefs walks a config OBJECT; the declaration is a list of path/value
  // pairs, so the values are what it has to be shown.
  return (parsed as { path: string; value?: unknown }[]).map((entry) => entry.value);
}

async function checkImagePinned(manifest: SetManifest, problems: Problem[]): Promise<void> {
  if (hasDigest(manifest.requires.image)) return;
  // One advice, shared with set build (set/advice.ts's imagePinAdvice): decided from the lock's
  // content, never from the file's existence — a committed lock travels in git, so it does
  // not imply a deployed instance.
  const advice = imagePinAdvice(manifest.requires.image, await readLock());
  problems.push(problem("SET_IMAGE_UNPINNED", advice.detail, advice.next));
}

/** The file checks run only where the files actually are: a working tree, or an unpacked
 *  artifact's staging directory (recipesDir() points into it). A packed artifact carries
 *  files as checksums — looking for those paths on this machine would flag a valid artifact. */
async function checkRecipesComplete(manifest: SetManifest, checkFiles: boolean, problems: Problem[]): Promise<void> {
  for (const [name, recipe] of Object.entries(manifest.recipes)) {
    const declaresAgent = recipe.agent !== undefined;
    // The remedies are the advice owners in set/advice.ts — one wording per gap, shared
    // with set build and the checks.

    if (checkFiles) {
      const dir = resolve(recipesDir(), name);
      if (!(await exists(dir))) {
        // An unpacked artifact has a directory only where the manifest lists files in it.
        // A recipe that carries no portable content unpacks to nothing — and the tree it
        // was built from answers for that (the dir-exists branch below), so the artifact
        // must give the same answer, not a weaker one (R32-05: the tree reported three
        // blocking recipes, its own artifact one).
        if (declaresAgent || Object.keys(recipe.files).length > 0) {
          problems.push(recipeMissingDir(name, `recipe "${name}" is declared but ${dir} does not exist`));
        } else {
          problems.push(recipeMissingDir(name, `recipe "${name}" is neither an MCP recipe (server.ts) nor a service (recipe.json)`));
        }
        continue;
      }
      // server.ts is required only of a recipe that declares an agent — that's what makes
      // it an MCP recipe. A recipe without one is a plain service (its own compose stack,
      // recipe.json); demanding server.ts of it was a false positive against a real deployment.
      if (declaresAgent && !(await exists(resolve(dir, "server.ts")))) {
        problems.push(recipeIncomplete(name, `recipe "${name}" declares an agent but has no server.ts — that is the file the gateway is registered to spawn`, `adding server.ts to recipes/${name}`));
      }
      if (!declaresAgent && !(await exists(resolve(dir, "recipe.json"))) && !(await exists(resolve(dir, "server.ts")))) {
        problems.push(recipeMissingDir(name, `recipe "${name}" is neither an MCP recipe (server.ts) nor a service (recipe.json)`));
      }
      if (declaresAgent && !(await exists(resolve(dir, "agent", "config.json")))) {
        problems.push(recipeIncomplete(name, `recipe "${name}" declares an agent but has no agent/config.json`, `adding agent/config.json to recipes/${name}`));
      }
      // Parse the definition with the loader recipe list and recipe install use, so a
      // recipe.json `recipe list` calls broken is a finding here too instead of failing
      // only mid-apply on the target (R33-08). The loader's own message names the file.
      const definitionPath = resolve(dir, "recipe.json");
      if (await exists(definitionPath)) {
        try {
          parseRecipeDefinition(name, await readFile(definitionPath, "utf8"));
        } catch (error) {
          problems.push(recipeInvalidDefinition(name, (error as Error).message));
        }
      }
    }

    // A recipe serving nothing isn't provably a mistake (a plain service recipe is
    // legitimate), so only an empty checksum map WITH an agent bundle is reported.
    if (declaresAgent && Object.keys(recipe.files).length === 0) {
      problems.push(
        recipeIncomplete(name, `recipe "${name}" declares an agent but serves no content — the agent would have nothing to read`, `adding content to recipes/${name} and rebuilding`, "set build"),
      );
    }
  }
}

function checkReferencesResolve(manifest: SetManifest, problems: Problem[]): void {
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
}

function checkSchedulesValid(manifest: SetManifest, problems: Problem[]): void {
  for (const [name, recipe] of Object.entries(manifest.recipes)) {
    const schedule = recipe.agent?.cronSchedule;
    if (schedule === undefined) continue;
    const reason = cronProblem(schedule);
    if (reason !== undefined) {
      problems.push(problem("SET_SCHEDULE_INVALID", `recipe "${name}": ${reason}`));
    }
  }
}

/** The gateway resolves SecretRefs at startup and reports a missing one only in its log, as
 *  a crash loop. A set that references a variable it does not require is that failure,
 *  declared in advance. */
async function checkSecretsDeclared(manifest: SetManifest, problems: Problem[]): Promise<void> {
  const declaredSecrets = new Set(manifest.secrets);
  for (const ref of collectSecretRefs(await declaredConfig(problems))) {
    if (!declaredSecrets.has(ref.name)) {
      problems.push(
        problem("SET_SECRET_UNDECLARED", `the declaration references ${ref.name} (${ref.usedBy}) but the set does not require it by name`),
      );
    }
  }
}

/** Every finding a set can produce without a gateway. Takes the manifest rather than a
 *  directory: `set build` already collected the tree into one, and validating a built
 *  artifact must answer exactly as validating the tree it came from. */
export async function validateSet(manifest: SetManifest, options: { checkFiles?: boolean } = {}): Promise<Problem[]> {
  const problems: Problem[] = [];
  await checkImagePinned(manifest, problems);
  await checkRecipesComplete(manifest, options.checkFiles === true, problems);
  checkReferencesResolve(manifest, problems);
  checkSchedulesValid(manifest, problems);
  await checkSecretsDeclared(manifest, problems);
  return problems;
}
