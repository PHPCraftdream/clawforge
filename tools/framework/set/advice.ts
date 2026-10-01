// One owner per piece of advice decided from a set's state (refactor plan stage 1 item 3):
// the image pin, and the recipe-completeness remedy per gap. `set validate`, `set build` and
// the checks call these; nothing formulates its own wording.

import { problem } from "#src/service/inspection.ts";
import type { Problem } from "#src/service/inspection.ts";
import type { DeploymentLock } from "#src/commands/management/lock.ts";

/** One source of image-pin advice for `set validate` and `set build`, decided from the
 *  lock's CONTENT, never from the file's existence: a lock is meant to be committed, so
 *  "a lock exists" says nothing about whether an instance was ever deployed on this machine.
 *  `lock` records {reference: OPENCLAW_IMAGE, digest: RepoDigests[0] of the local image that
 *  reference names} — never the running container's image — so the advice describes what each
 *  command does instead of claiming a state it cannot see. */
export function imagePinAdvice(requiredImage: string, lock: DeploymentLock | undefined): { detail: string; nextAction: string } {
  if (lock === undefined) {
    return {
      detail: `the set requires image ${requiredImage}, which is a tag — a set that names a tag installs whatever that tag means on the day it is installed; no lock was ever recorded here, and ./clawforge lock records the digest of the local image that OPENCLAW_IMAGE names, so the tag must exist locally first`,
      nextAction: "./clawforge bootstrap",
    };
  }
  if (lock.image.digest === undefined) {
    return {
      detail: `the set requires image ${requiredImage}, which is a tag, and the recorded lock (for ${lock.image.reference}) carries no digest — ./clawforge lock records the digest of the local image that OPENCLAW_IMAGE names, so the tag must be pulled before it can pin`,
      nextAction: `./clawforge bootstrap (before the first deployment) or ./clawforge upgrade --image ${requiredImage} (on a deployed instance), then ./clawforge lock`,
    };
  }
  return {
    detail: `the set requires image ${requiredImage}, which is a tag — a set that names a tag installs whatever that tag means on the day it is installed; the recorded lock was taken for ${lock.image.reference}, so the deployment was last pinned to a different image`,
    nextAction: `./clawforge upgrade --image ${requiredImage} to move the deployment to the image now declared — ./clawforge lock afterwards only if the gateway then runs it (lock records the local image's digest, not the running container's)`,
  };
}

/** The recipe-completeness finding, with the remedy naming the exact edit for THIS gap, as a
 *  runnable command with the reason in parentheses (R33-08). An artifact's content is fixed
 *  in the tree it was built from and rebuilt. */
export function recipeIncomplete(recipe: string, detail: string, fix: string, command = "./clawforge set validate"): Problem {
  return problem("SET_RECIPE_INCOMPLETE", detail, `${command}  (after ${fix})`);
}

/** A recipe directory that is absent, or neither an MCP recipe nor a service: the remedy
 *  points at the tree and a rebuild, the only place the gap can be closed. */
export function recipeMissingDir(recipe: string, detail: string): Problem {
  return recipeIncomplete(
    recipe,
    detail,
    `adding recipe.json or server.ts to recipes/${recipe}, or removing the directory`,
    "./clawforge set build",
  );
}

/** A recipe.json that does not parse the way recipe list/install read it: the loader's own
 *  message is the detail, the file to fix is the remedy. */
export function recipeInvalidDefinition(recipe: string, message: string): Problem {
  return problem("SET_RECIPE_INVALID", message, `./clawforge set validate  (after fixing recipes/${recipe}/recipe.json)`);
}
