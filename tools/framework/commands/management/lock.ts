// `./clawforge lock` — pin what this instance is made of, so the same composition can be
// brought up again and the difference noticed when it is not.
//
// config/desired-state.json reproduces the *settings*, not which framework wrote them,
// which image ran (a tag moves, a digest doesn't), or which recipe content version the
// agent answered from. Two instances can satisfy the same declaration and not be the same
// instance.
//
// Meant to be committed, so it holds no secret values — only variable names.
//
// Boundary: this pins the composition, not the behaviour. The same lock brought up twice
// is the same code/image/wiki, and the model can still answer differently.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { frameworkRoot } from "#src/core/env.ts";
import { deploymentDir, deploymentName, desiredStateFile, recipesDir } from "#src/runtime/deployment.ts";
import { requirements } from "#src/service/secrets.ts";
import { listRecipeDirectories } from "#src/service/recipe.ts";
import { checksumOf, checksumOfFileMap, recipeFileChecksums, agentBundleChecksums } from "#src/service/checksums.ts";
import { openclawCliBatch } from "#src/service/openclaw-cli.ts";
import { nextActions, problem } from "#src/service/inspection.ts";
import type { Problem } from "#src/service/inspection.ts";
import type { Context } from "#src/core/context.ts";
import {
  PLUGINS_LIST_ARGS,
  SKILLS_LIST_ARGS,
  parsePluginsList,
  parseSkillsList,
  pluginsForLock,
  skillsForLock,
  compareExtensions,
} from "./extensions.ts";
import type { LockPlugin, LockSkill } from "./extensions.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";

export const LOCK_VERSION = 1;

/** Drives both lock's own parser and its openclawCommands declaration. */
export const LOCK_ARGUMENTS: CommandArgument[] = [
  { name: "check", description: "Compare against the existing lock instead of writing one", kind: "flag" },
  { name: "json", description: "Emit the lock, or the differences, as JSON", kind: "flag" },
];

/** Printed once the lock is written. Its own constant so it stays consistent with
 *  scaffold.ts's git-init note: the deployment directory is meant to become its own git
 *  repository (distinct from the framework's, since `apps/` is gitignored at monorepo root). */
export const COMMIT_ADVICE =
  "commit it in this deployment's own git repository (not the framework's, if the two differ) " +
  "— that is what makes the deployment reproducible rather than merely configured";

export interface DeploymentLock {
  readonly version: number;
  readonly deployment: string;
  readonly generatedAt: string;
  readonly framework?: string;
  readonly image: { readonly reference: string; readonly digest?: string };
  /** Checksum of config/desired-state.json as a whole: the settings are compared path by
   *  path elsewhere, so what the lock adds is "was this the same declaration at all". */
  readonly desiredState?: string;
  /** Per recipe: one checksum for its whole served content, plus individual files so a
   *  difference can be pointed at; separately the agent bundle, since a prompt edit changes
   *  behavior without touching served content. */
  readonly recipes: Record<
    string,
    {
      readonly checksum: string;
      readonly files: Record<string, string>;
      readonly agentChecksum?: string;
      readonly agentFiles?: Record<string, string>;
    }
  >;
  /** Names only. A lock file that carried values would be a credential store that looks
   *  like a manifest, and it is meant to be committed. */
  readonly secrets: readonly string[];
  /** OpenClaw plugins, from `plugins list --json`; bundled ones excluded (image digest
   *  already covers them). Optional so a pre-pinning lock reads as "not yet covered". */
  readonly plugins?: readonly LockPlugin[];
  /** OpenClaw skills, same bundled exclusion and optionality; no version (CLI doesn't report one). */
  readonly skills?: readonly LockSkill[];
}

export function lockFile(): string {
  return resolve(deploymentDir(), "config", "deployment.lock.json");
}

export async function frameworkVersion(): Promise<string | undefined> {
  for (const candidate of [resolve(frameworkRoot, "package.json"), resolve(frameworkRoot, "..", "package.json")]) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "@clawforge/framework") return parsed.version;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function recipeNames(): Promise<string[]> {
  return (await listRecipeDirectories(recipesDir()))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** What the lock would say if written now. Exported so `plan` and the checks can ask for it
 *  without writing anything.
 *
 *  `includeExtensions` defaults to false: `plan`/`apply` only need declarationChecksum(),
 *  which never reads plugins/skills (observed instance facts, not part of the declaration),
 *  so asking for that inventory would spend a container nobody looks at. `lock` always
 *  asks for it; `inspect`/`doctor` reuse observeLive's own batched read instead. */
export async function currentComposition(
  ctx: Context,
  options?: { readonly includeExtensions?: boolean },
): Promise<DeploymentLock> {
  const recipes: DeploymentLock["recipes"] = {};
  for (const name of await recipeNames()) {
    const dir = resolve(recipesDir(), name);
    const files = await recipeFileChecksums(dir);
    const agentFiles = await agentBundleChecksums(dir);
    recipes[name] = {
      checksum: checksumOfFileMap(files),
      files,
      ...(Object.keys(agentFiles).length === 0 ? {} : { agentChecksum: checksumOfFileMap(agentFiles), agentFiles }),
    };
  }

  let desiredState: string | undefined;
  try {
    desiredState = checksumOf(await readFile(desiredStateFile(), "utf8"));
  } catch {
    desiredState = undefined;
  }

  let plugins: LockPlugin[] | undefined;
  let skills: LockSkill[] | undefined;
  if (options?.includeExtensions === true) {
    // One container for both reads. An unreachable target answers every slot with a failed
    // result, which parsePluginsList/parseSkillsList read as "none" rather than throwing.
    const [pluginsResult, skillsResult] = await openclawCliBatch(ctx, [[...PLUGINS_LIST_ARGS], [...SKILLS_LIST_ARGS]]);
    plugins = pluginsForLock(parsePluginsList(pluginsResult));
    skills = skillsForLock(parseSkillsList(skillsResult));
  }

  return {
    version: LOCK_VERSION,
    deployment: deploymentName(),
    generatedAt: new Date().toISOString(),
    framework: await frameworkVersion(),
    image: { reference: ctx.settings.image, digest: await ctx.runtime.imageReference() },
    desiredState,
    recipes,
    secrets: (await requirements(ctx)).map((entry) => entry.name).sort(),
    ...(plugins === undefined ? {} : { plugins }),
    ...(skills === undefined ? {} : { skills }),
  };
}

/** One checksum for everything a plan is computed from — declaration and recipe content
 *  only. Not the whole lock: `generatedAt` and the image digest change without invalidating
 *  a plan; only an edited declaration does. */
export function declarationChecksum(composition: DeploymentLock): string {
  return checksumOf(
    JSON.stringify({
      desiredState: composition.desiredState ?? null,
      recipes: Object.fromEntries(
        Object.keys(composition.recipes)
          .sort()
          // Both halves: an edited agent prompt is as stale as an edited wiki page.
          .map((name) => [name, `${composition.recipes[name].checksum}:${composition.recipes[name].agentChecksum ?? ""}`]),
      ),
    }),
  );
}

export async function readLock(): Promise<DeploymentLock | undefined> {
  try {
    return JSON.parse(await readFile(lockFile(), "utf8")) as DeploymentLock;
  } catch {
    return undefined;
  }
}

/** Everything the lock pins that no longer holds.
 *
 *  Warnings, not blocking problems: an instance that drifted from its lock is still
 *  working, and the reader decides whether the difference was intended.
 *
 *  `generatedAt` is not compared: it says when the lock was taken, not what it pins. */
export function compareLock(lock: DeploymentLock | undefined, current: DeploymentLock): Problem[] {
  if (lock === undefined) {
    return [problem("LOCK_MISSING", `no ${"config/deployment.lock.json"} — this instance's composition is not pinned`)];
  }
  if (lock.version !== LOCK_VERSION) {
    return [problem("LOCK_DRIFT", `the lock file is version ${lock.version}, this framework writes version ${LOCK_VERSION}`)];
  }

  const problems: Problem[] = [];

  if (lock.framework !== undefined && current.framework !== undefined && lock.framework !== current.framework) {
    problems.push(problem("LOCK_DRIFT", `framework is ${current.framework}, locked at ${lock.framework}`));
  }
  // The digest, not the tag: a tag stays the same string even after it moves to a different image.
  if (lock.image.digest !== undefined && current.image.digest !== undefined && lock.image.digest !== current.image.digest) {
    problems.push(problem("LOCK_DRIFT", `image digest is ${current.image.digest}, locked at ${lock.image.digest}`));
  }
  if (lock.desiredState !== undefined && current.desiredState !== undefined && lock.desiredState !== current.desiredState) {
    problems.push(problem("LOCK_DRIFT", "config/desired-state.json has changed since the lock was written"));
  }

  for (const [name, locked] of Object.entries(lock.recipes)) {
    const now = current.recipes[name];
    if (now === undefined) {
      problems.push(problem("LOCK_DRIFT", `recipe "${name}" is locked but no longer present`));
      continue;
    }
    // Named rather than counted: "the recipe changed" leaves the reader to find it themselves.
    if (now.checksum !== locked.checksum) {
      const changed = Object.keys({ ...locked.files, ...now.files })
        .filter((rel) => locked.files[rel] !== now.files[rel])
        .sort();
      problems.push(
        problem(
          "LOCK_DRIFT",
          `recipe "${name}" differs from the lock in ${changed.length} file(s): ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}`,
        ),
      );
    }

    // A lock written before the bundle was recorded pins less than this framework can, and
    // an absent value would otherwise silently read as agreement — named as its own finding.
    if (locked.agentChecksum === undefined && now.agentChecksum !== undefined) {
      problems.push(
        problem(
          "LOCK_DRIFT",
          `recipe "${name}": the lock predates agent-bundle pinning and does not record it — re-pin to cover the agent's prompts`,
        ),
      );
    }

    // Separately: a prompt edit changes agent behavior without touching served content.
    if (locked.agentChecksum !== undefined && now.agentChecksum !== locked.agentChecksum) {
      const changed = Object.keys({ ...locked.agentFiles, ...now.agentFiles })
        .filter((rel) => (locked.agentFiles ?? {})[rel] !== (now.agentFiles ?? {})[rel])
        .sort();
      problems.push(
        problem(
          "LOCK_DRIFT",
          `recipe "${name}": the agent bundle differs from the lock in ${changed.length} file(s): ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}`,
        ),
      );
    }
  }

  for (const name of Object.keys(current.recipes)) {
    if (lock.recipes[name] === undefined) {
      problems.push(problem("LOCK_DRIFT", `recipe "${name}" is present but not in the lock`));
    }
  }

  const newSecrets = current.secrets.filter((name) => !lock.secrets.includes(name));
  if (newSecrets.length > 0) {
    problems.push(problem("LOCK_DRIFT", `the instance now requires ${newSecrets.join(", ")}, which the lock does not list`));
  }

  // Plugins/skills, only when the caller actually fetched them: a bare currentComposition
  // (what plan/apply ask for) leaves these undefined, and absent must not read as "none".
  if (current.plugins !== undefined && lock.plugins === undefined && current.plugins.length > 0) {
    problems.push(problem("LOCK_DRIFT", "the lock predates plugin pinning and does not record it — re-pin to cover installed plugins"));
  }
  if (current.skills !== undefined && lock.skills === undefined && current.skills.length > 0) {
    problems.push(problem("LOCK_DRIFT", "the lock predates skill pinning and does not record it — re-pin to cover installed skills"));
  }
  if (current.plugins !== undefined || current.skills !== undefined) {
    problems.push(...compareExtensions(lock.plugins, current.plugins ?? [], lock.skills, current.skills ?? []));
  }

  return problems;
}

export async function lock(ctx: Context, args: string[]): Promise<void> {
  const parsed = parseDeclaredArgs(LOCK_ARGUMENTS, args);
  const jsonOnly = parsed.json === true;
  const checkOnly = parsed.check === true;

  const current = await currentComposition(ctx, { includeExtensions: true });

  if (checkOnly) {
    const problems = compareLock(await readLock(), current);
    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify({ deployment: current.deployment, problems, nextActions: nextActions(problems) }, null, 2)}\n`);
      return;
    }
    if (problems.length === 0) {
      log("the instance matches config/deployment.lock.json");
      return;
    }
    log(`${problems.length} difference(s) from the lock`);
    for (const entry of problems) info(`${entry.code}  ${entry.detail}`);
    return;
  }

  await writeFile(lockFile(), `${JSON.stringify(current, null, 2)}\n`, "utf8");

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify({ deployment: current.deployment, changed: true, lock: current }, null, 2)}\n`);
    return;
  }

  log(`wrote ${lockFile()}`);
  info(`framework  ${current.framework ?? "(unknown)"}`);
  info(`image      ${current.image.digest ?? current.image.reference}`);
  info(`recipes    ${Object.keys(current.recipes).length === 0 ? "(none)" : Object.keys(current.recipes).join(", ")}`);
  info(`secrets    ${current.secrets.length} name(s), no values`);
  info(`plugins    ${(current.plugins ?? []).length} third-party (bundled ones are covered by the image digest)`);
  info(`skills     ${(current.skills ?? []).length} third-party (bundled ones are covered by the image digest)`);
  info(COMMIT_ADVICE);
}
