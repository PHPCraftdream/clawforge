// The declared state `./clawforge inspect` reads: desired-state.json and the recipes
// directory, both local to this repository — never the target. Split out of observe.ts;
// see helpers.ts (this same directory) for the pure pieces these use, drift.ts for the
// per-facet declared-vs-target comparisons, and live.ts for what the target itself reports.

import { access, lstat, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deploymentName, desiredStateFile, recipesDir } from "#src/runtime/deployment.ts";
import { loadRecipeAgentBundle } from "#src/commands/management/provision-agent/index.ts";
import type { RecipeAgentBundle } from "#src/commands/management/provision-agent/index.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem, DeclaredState } from "#src/service/inspection.ts";
import type { Context } from "#src/core/context.ts";

/** A recipe's agent bundle, in the fields inspect compares against the instance. Parsed
 *  loosely on purpose: this is reading someone else's declaration to report on it, not
 *  validating it — provision-agent owns the validation and says so properly. */
export interface RecipeExpectation {
  readonly recipe: string;
  readonly bundle: RecipeAgentBundle;
}

export async function recipeExpectations(): Promise<RecipeExpectation[]> {
  const found: RecipeExpectation[] = [];
  let entries: string[];
  try {
    entries = (await readdir(recipesDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return found;
    throw new Error(`${recipesDir()} could not be read: ${(error as Error).message}`);
  }

  for (const recipe of entries.sort()) {
    const agentDir = resolve(recipesDir(), recipe, "agent");
    let stat;
    try {
      stat = await lstat(agentDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // No agent directory: a recipe can be a plain service. Not a finding.
        continue;
      }
      throw error;
    }
    if (!stat.isDirectory()) throw new Error(`${agentDir} is not a directory`);
    // Once the bundle exists, every loader failure must block reconciliation.
    found.push({ recipe, bundle: await loadRecipeAgentBundle(recipe) });
  }
  return found;
}

export async function declaredState(ctx: Context, problems: Problem[]): Promise<DeclaredState> {
  let config: { path: string; value: unknown }[] = [];
  let raw: string | undefined;
  try {
    raw = await readFile(desiredStateFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // A directory sitting where the file should be, a permissions error, or anything else
      // that is not "there is genuinely no file" must not be silently treated the same way
      // as a legitimate empty declaration — that is how a broken (or blocked) declaration
      // produced healthy: true with nothing ever saying it could not even be read.
      problems.push(problem("CONFIG_DRIFT", `${desiredStateFile()} could not be read: ${(error as Error).message}`));
    }
    // ENOENT: no file at all. A deployment with no desired state declares nothing about the
    // config — reported as an empty declaration rather than as a failure: inspect must still
    // work.
  }
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as { path: string; value?: unknown }[];
      config = parsed.map((entry) => ({ path: entry.path, value: entry.value }));
    } catch (error) {
      // The file EXISTS and was meant to declare something — silently treating that the same
      // way as "no file at all" is how a broken declaration produced healthy: true and
      // changed: false, with nothing wrong ever reported. Same code and remedy
      // observeConfig() (drift.ts) already uses for its own equivalent case, the LIVE config
      // failing to parse.
      problems.push(problem("CONFIG_DRIFT", `${desiredStateFile()} exists but is not valid JSON: ${(error as Error).message}`));
    }
  }

  return {
    deployment: deploymentName(),
    config,
    image: ctx.settings.image,
    recipes: (await recipeExpectations()).map((entry) => entry.recipe),
  };
}

/** The declaration's own existence. A fact about the folder, and only a finding while an
 *  instance is running to be re-declared — the caller gates it below the not-running
 *  early return, which is what the code's name claims ("missing" for WHOM). */
export async function observeDeclarationFile(problems: Problem[]): Promise<void> {
  const absent = await access(desiredStateFile()).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      // Unreadable for any other reason: declaredState()'s own read already reports it,
      // and a second finding for the same file would read as two problems.
      if (error.code === "ENOENT") return true;
      return false;
    },
  );
  if (absent) {
    problems.push(
      problem("DECLARATION_MISSING", `${desiredStateFile()} does not exist — a running instance nobody can re-declare from this repository`),
    );
  }
}
