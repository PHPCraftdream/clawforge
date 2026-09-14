// Where a deployment keeps its own files.
//
// An application is a deployment: its .env, desired state, secret stores, recipes and
// snapshots live in one directory, and several deployments can sit side by side sharing
// this framework. Nothing here may be resolved against the repository root, or two
// deployments would silently share one configuration.
//
// The gate sets the directory before any command runs.
//
// DESIGN NOTE — npm distribution (see env.ts for the
// matching note on the framework side). This module's contract — a directory is handed in
// once by whatever the entry point is, and everything else derives from it, never from the
// framework's own location — already needs no change for a second distribution mode:
//
//   - monorepo (today, this clawforge checkout): tools/clawforge.ts resolves
//     `resolve(monorepoRoot, "apps", name)` and calls `useDeployment()` with it — several
//     deployments side by side under apps/, picked by --app/OC_APP.
//   - installed-as-dependency: a consumer repo has exactly one app, at its own
//     project root — no apps/<name> nesting, since there is only ever one. The package's
//     own bin entry calls `useDeployment()` with that root directly (the directory holding
//     the thin ./clawforge shim the init/scaffold command writes, or simply process.cwd()).
//
// Both are just "a directory, handed in once" — this file does not need to know which
// mode produced it. The work is entirely on the caller side (the entry points next to
// tools/clawforge.ts and in the package), so this module stays mode-independent.

import { basename, resolve } from "node:path";
import { safeName } from "../core/names.ts";
import { setSourceDir } from "../set/artifacts/source.ts";

let activeDir: string | undefined;
let composeOverride: string | undefined;

export function useDeployment(directory: string): void {
  activeDir = directory;
}

/** The deployment's own identity — the directory it lives in, always. Everything that
 *  crosses a process boundary or becomes an argument to another invocation of this tooling —
 *  deploy's remote apps/<name> path and its --app argument, archive file names, a built
 *  set's default name — uses this, and only this. It is never affected by
 *  OC_COMPOSE_PROJECT: that override exists for the one thing Docker itself names, not for
 *  this deployment's own identity, and conflating the two is exactly what made deploy
 *  construct a remote --app argument its own target would refuse. */
export function deploymentName(): string {
  return basename(deploymentDir());
}

// Docker Compose's own project-name rule (compose-spec), wider than safeName's: lowercase
// alphanumeric, hyphens and underscores, starting with a letter or digit. Checked here so a
// typo in OC_COMPOSE_PROJECT fails with a clear message instead of deep inside a compose
// invocation.
const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Overrides what composeProjectName() returns, independent of deploymentName().
 *
 *  Docker's own project-name alphabet is wider than safeName's (it accepts underscores), and
 *  an instance that already exists under a name this deployment's directory cannot have
 *  should not have to be recreated just to be managed — set via OC_COMPOSE_PROJECT in .env,
 *  read once when the context is built. */
export function useComposeProjectOverride(name: string | undefined): void {
  if (name !== undefined && !COMPOSE_PROJECT_PATTERN.test(name)) {
    throw new Error(
      `invalid OC_COMPOSE_PROJECT "${name}" — Docker Compose project names are lowercase letters, digits, hyphens and underscores, starting with a letter or digit`,
    );
  }
  composeOverride = name;
}

/** The raw override, or undefined when none is set — for a caller that needs to save and
 *  restore it around a nested Context, the same shape as set/artifacts/source.ts's own
 *  setSourceDir(). */
export function composeProjectOverride(): string | undefined {
  return composeOverride;
}

/** What Docker actually calls this deployment's containers, networks and volumes — the
 *  directory's own name, unless OC_COMPOSE_PROJECT overrides it. The only consumer this is
 *  meant for is runtime-docker.ts's own compose invocations and the port-conflict check
 *  beside them; everywhere else wants deploymentName() instead. */
export function composeProjectName(): string {
  return composeOverride ?? deploymentName();
}

/** The active deployment directory. Throws rather than guessing: a wrong default here
 *  would read another deployment's credentials. */
export function deploymentDir(): string {
  if (activeDir === undefined) {
    throw new Error("no deployment selected — the entry point must call useDeployment()");
  }
  return activeDir;
}

/** Environment file, also what the container runtime reads for interpolation. */
export function envFile(): string {
  return resolve(deploymentDir(), ".env");
}

/** Declarative settings applied to the managed service.
 *
 *  Set-owned, so it follows the set source when one is in force: installing from an artifact
 *  reads the declaration out of the artifact while everything about the machine — .env, the
 *  secret stores, the lock — keeps coming from the deployment directory. */
export function desiredStateFile(): string {
  return resolve(setSourceDir() ?? deploymentDir(), "config", "desired-state.json");
}

/** Template listing the variables this deployment needs, without values. */
export function secretsTemplateFile(): string {
  return resolve(deploymentDir(), "config", "secrets.template.env");
}

/** Filled-in values for a named target, kept out of git. The name is checked because it
 *  comes from the command line: a store called ../../other/local would read another
 *  deployment's credentials. */
export function secretStoreFile(name: string): string {
  return resolve(deploymentDir(), "secrets", `${safeName("store", name)}.env`);
}

/** Where the deployment's secret stores live. */
export function secretsDir(): string {
  return resolve(deploymentDir(), "secrets");
}

/** Recipes belonging to this deployment — set-owned, so it follows the set source for the
 *  same reason desiredStateFile does. */
export function recipesDir(): string {
  return resolve(setSourceDir() ?? deploymentDir(), "recipes");
}
