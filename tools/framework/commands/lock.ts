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
import { log, info, die } from "../log.ts";
import { emit, isCaptured } from "../output.ts";
import { frameworkRoot } from "../env.ts";
import { deploymentDir, deploymentName, desiredStateFile, recipesDir } from "../deployment.ts";
import { requirements } from "../secrets.ts";
import { checksumOf, checksumOfFileMap, recipeFileChecksums, agentBundleChecksums } from "../checksums.ts";
import { problem } from "../inspection.ts";
import type { Problem } from "../inspection.ts";
import type { Context } from "../context.ts";

export const LOCK_VERSION = 1;

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
 *  without writing anything — computing it is read-only by nature. */
export async function currentComposition(ctx: Context): Promise<DeploymentLock> {
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

  return {
    version: LOCK_VERSION,
    deployment: deploymentName(),
    generatedAt: new Date().toISOString(),
    framework: await frameworkVersion(),
    image: { reference: ctx.settings.image, digest: await ctx.runtime.imageReference() },
    desiredState,
    recipes,
    secrets: (await requirements(ctx)).map((entry) => entry.name).sort(),
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
      const changed = Object.keys({ ...(locked.agentFiles ?? {}), ...(now.agentFiles ?? {}) })
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

  return problems;
}

export async function lock(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = args.includes("--json");
  const checkOnly = args.includes("--check");
  for (const arg of args) {
    if (arg !== "--json" && arg !== "--check") die(`unknown argument: ${arg}`);
  }

  const current = await currentComposition(ctx);

  if (checkOnly) {
    const problems = compareLock(await readLock(), current);
    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify({ deployment: current.deployment, problems, nextActions: problems.length === 0 ? [] : ["./clawforge lock"] }, null, 2)}\n`);
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
  info("commit it: this is what makes the deployment reproducible rather than merely configured");
}
