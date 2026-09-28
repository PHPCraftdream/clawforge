// `./clawforge lock` — pin what this instance is made of, so the same composition can be brought
// up again and the difference noticed when it is not.
//
// config/desired-state.json already reproduces the *settings*. What it does not say is
// which framework wrote them, which image actually ran (a tag moves; a digest does not),
// or which version of a recipe's content the agent was answering from. Two instances can
// satisfy the same declaration and still not be the same instance.
//
// The file is meant to be committed, so it holds no secret values — only the names of the
// variables the instance requires, which is a fact about the deployment rather than about
// anyone's credentials.
//
// The boundary, stated because it is easy to over-promise: this pins the composition, not
// the behaviour. The same lock, brought up twice, is the same code, the same image and the
// same wiki — and the model can still answer differently the second time. Reproducing an
// answer is a different problem and this file does not claim to solve it.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, die } from "#src/core/log.ts";
import { emit, isCaptured } from "#src/core/output.ts";
import { frameworkRoot } from "#src/core/env.ts";
import { deploymentDir, deploymentName, desiredStateFile, recipesDir } from "#src/runtime/deployment.ts";
import { requirements } from "#src/service/secrets.ts";
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
} from "#src/extensions/index.ts";
import type { LockPlugin, LockSkill } from "#src/extensions/index.ts";

export const LOCK_VERSION = 1;

/** Printed once the lock is written. Its own constant so it can be checked against
 *  scaffold.ts's own git-init note for staying consistent (UX-12): `apps/` is entirely
 *  gitignored at the monorepo root (root .gitignore, docs/architecture.md), and
 *  setupProjectMcp already writes a NESTED .gitignore into every deployment directory — the
 *  two only make sense together if the deployment directory is meant to become a git
 *  repository of its own. A bare "commit it" read as if this repository's own history was the
 *  target, which apps/'s own ignore rule makes impossible in monorepo mode; installed mode's
 *  deployment directory usually already is its own repository, which this still holds for. */
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
  /** Per recipe: one checksum standing for its whole served content, plus the individual
   *  files so a difference can be pointed at rather than merely announced — and separately
   *  the agent bundle, because a prompt edit changes what the agent does without touching a
   *  byte of what it serves. */
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
  /** OpenClaw plugins, read from `openclaw plugins list --json` — bundled ones left out
   *  (extensions/index.ts's header: the image digest above already covers them). Optional so
   *  a lock written before this framework knew to pin them parses as "not yet covered"
   *  (compareLock) rather than "none installed". */
  readonly plugins?: readonly LockPlugin[];
  /** OpenClaw skills, read from `openclaw skills list --json` — same bundled exclusion, same
   *  optionality, and no version (extensions/index.ts's header: this CLI does not report
   *  one). */
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
  try {
    return (await readdir(recipesDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** What the lock would say if written now. Exported so `plan` and the checks can ask for it
 *  without writing anything — computing it is read-only by nature.
 *
 *  `includeExtensions` defaults to false: `plan`/`apply` call this only for
 *  declarationChecksum() below, which never reads plugins/skills (they are observed facts
 *  about the instance, not part of the declaration a plan is computed from — the same
 *  reasoning that already keeps the image digest out of it) — asking for a plugin/skill
 *  inventory on their behalf would spend a container on an answer nobody looks at. `lock`
 *  itself (both the write and the --check path) always asks for it; `inspect`/`doctor`
 *  never call this for it either, reusing observeLive's own batched read instead
 *  (gather.ts) rather than paying for a second container. */
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
    // One container for both reads, the same batching openclawCliBatch exists for — a
    // pre-bootstrap or otherwise unreachable target answers every slot with a failed result,
    // which parsePluginsList/parseSkillsList already read as "none" rather than throwing.
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

/** One checksum for everything a plan is computed from — the declaration and the recipe
 *  content, and nothing else.
 *
 *  Deliberately not the whole lock: `generatedAt` changes every time it is taken and the
 *  image digest changes when someone pulls, neither of which invalidates a plan. What
 *  invalidates a plan is the declaration having been edited between planning and applying,
 *  which is exactly what this covers. */
export function declarationChecksum(composition: DeploymentLock): string {
  return checksumOf(
    JSON.stringify({
      desiredState: composition.desiredState ?? null,
      recipes: Object.fromEntries(
        Object.keys(composition.recipes)
          .sort()
          // Both halves: a plan computed before someone edited an agent's prompt is as stale
          // as one computed before they edited the wiki, and covering only the served content
          // let a prompt change slip past the staleness check entirely.
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
 *  Warnings, not blocking problems, and deliberately: an instance that drifted from its
 *  lock is still working, and the reader is the one who decides whether the difference was
 *  intended. Reporting it as a failure would train people to ignore it — which is how a
 *  reproducibility claim quietly becomes decorative.
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
  // The digest, not the tag: `extended-stable` is the same string before and after it moves
  // to a different image, which is exactly the change a lock exists to notice.
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
    // Named rather than counted: "the recipe changed" sends the reader to look for it
    // themselves, which is the work this command was supposed to do.
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

    // A lock written before the bundle was recorded pins less than this framework knows how
    // to pin, and the gap hides itself: comparing only when the locked side has a value
    // means an absent one reads as agreement, so nothing is ever reported and the
    // reproducibility claim quietly covers less than it says. Named as its own finding, and
    // left for the reader to re-pin deliberately — rewriting it here would be the rubber
    // stamp this file refuses to be.
    if (locked.agentChecksum === undefined && now.agentChecksum !== undefined) {
      problems.push(
        problem(
          "LOCK_DRIFT",
          `recipe "${name}": the lock predates agent-bundle pinning and does not record it — re-pin to cover the agent's prompts`,
        ),
      );
    }

    // The agent bundle separately: a prompt edit changes what the agent does without
    // touching a byte of what the recipe serves, so a single checksum reported it as no
    // change at all.
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

  // Plugins/skills, only when the caller actually fetched them: lock's own --check path
  // always does (includeExtensions), and inspect/doctor supply them from observeLive's own
  // batched read (gather.ts) — but a bare currentComposition(ctx), which is all plan/apply
  // ever ask for (declarationChecksum never reads either field), leaves current.plugins/
  // skills undefined, and an absent answer must not read as "nothing installed".
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
  const jsonOnly = args.includes("--json");
  const checkOnly = args.includes("--check");
  for (const arg of args) {
    if (arg !== "--json" && arg !== "--check") die(`unknown argument: ${arg}`);
  }

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
