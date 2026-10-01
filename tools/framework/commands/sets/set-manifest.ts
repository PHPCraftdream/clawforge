// `./clawforge set build` — collect everything a deployment installs into ONE artifact.
// The vocabulary (manifest, the three entities set/instance/state, content id) lives in
// set/model.ts; this is the gatherer that feeds it, written to sets/<name>-<id>.tar.gz.
//
// A set builds with NO running instance, so target-side readers (secrets.ts's
// requirements(ctx), runtime.imageReference()) are never used here — ctx.transport and
// ctx.runtime are untouched; only ctx.settings (declared image) is read.

import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { die } from "#src/core/io/log.ts";
import { parseEnv } from "#src/core/env.ts";
import { safeName } from "#src/core/values/names.ts";
import { spawnLocal } from "#src/runtime/transport/transport.ts";
import type { Context } from "#src/core/context.ts";
import { deploymentDir, desiredStateFile, recipesDir, secretsTemplateFile } from "#src/runtime/deployment.ts";
import { collectSecretRefs } from "#src/service/secrets.ts";
import { recipeNames } from "#src/service/recipe.ts";
import { desiredStateShapeError } from "#src/set/ownership/validate.ts";
import { checksumOf, checksumOfFileMap, recipeFileChecksums, agentBundleChecksums } from "#src/service/checksums.ts";
import { frameworkVersion, readLock, imagePinAdvice } from "#src/commands/management/lock.ts";
import { parseAgentConfig } from "#src/commands/management/provision-agent/index.ts";
import type { AgentConfig } from "#src/commands/management/provision-agent/index.ts";
import { loadChecks } from "#src/commands/orchestration/accept.ts";
import type { AcceptanceCheck } from "#src/commands/orchestration/accept.ts";
import { DESIRED_STATE_PATH, buildSetManifest, setManifestId } from "#src/set/artifacts/model.ts";
import type { SetManifest, SetRecipe } from "#src/set/artifacts/model.ts";
import { assertNoSecretValues, localSecretValues, MIN_VALUE_LENGTH } from "./set-secrets-guard.ts";
import { renameOverPrivateFile } from "#src/security/privacy/private-file.ts";
import { hasDigest } from "#src/runtime/docker/image-ref.ts";

/** What one build produced. The id is setManifestId(manifest); the artifact carries it in
 *  its file name, so two builds of unchanged content land on the same path. */
export interface SetBuild {
  readonly name: string;
  readonly id: string;
  readonly artifact: string;
  readonly manifest: SetManifest;
}

/** Secret NAMES, derived from the declaration the set carries — never from a live instance
 *  (secrets.ts's requirements(ctx) reads openclaw.json ON THE TARGET, which a set must not
 *  need). Two sources, both traveling with the set: SecretRefs in desired-state.json, and
 *  config/secrets.template.env (names only, from `secrets --template`). The app's own
 *  secrets hook is deliberately not consulted (usually depends on live target state); the
 *  gateway token is absent too, since each target generates its own. */
async function desiredSecretNames(desiredState: unknown): Promise<string[]> {
  const names = collectSecretRefs(desiredState).map((ref) => ref.name);
  try {
    names.push(...Object.keys(parseEnv(await readFile(secretsTemplateFile(), "utf8"))));
  } catch {
    // No template yet — `./clawforge secrets --template` writes one.
  }
  return names;
}

/** The image the set pins, as a digest — a tag moves, the digest is what was proven.
 *
 *  Read from config/deployment.lock.json (recorded at `./clawforge lock` time) rather than
 *  re-resolved via runtime.imageReference(), which needs a reachable target this command
 *  must not depend on. An already-digest OPENCLAW_IMAGE is honoured directly.
 *
 *  A recorded digest answers only for the reference it was proven under: a lock left over
 *  from a previous OPENCLAW_IMAGE must not pin this build to the wrong digest. */
async function requiredImage(image: string, tolerateUnpinned: boolean): Promise<string> {
  if (hasDigest(image)) return image;
  const lock = await readLock();
  if (lock?.image.digest !== undefined) {
    if (lock.image.reference !== image) {
      if (tolerateUnpinned) return image;
      // Same decision set validate reports — one advice, not two commands guessing.
      const advice = imagePinAdvice(image, lock);
      die(
        `the lock's digest does not belong to ${image} — it was recorded for ${lock.image.reference}, ` +
          "and pinning it here would put the previous image's runtime under a declaration that no longer names it.\n" +
          `${advice.nextAction}. Or set OPENCLAW_IMAGE to a @sha256 reference.`,
      );
    }
    return lock.image.digest;
  }
  // validate keeps going with the tag in requires.image, so checkImagePinned can report
  // SET_IMAGE_UNPINNED alongside everything else; only build refuses outright.
  if (tolerateUnpinned) return image;
  const advice = imagePinAdvice(image, lock);
  die(
    `no image digest to pin the set to — ${advice.detail}\n${advice.nextAction}. ` +
      "Or set OPENCLAW_IMAGE to a @sha256 reference.",
  );
}

/** The recipe's parsed agent declaration, read with provision-agent's own parser, so a set
 *  and provisioning can't disagree on defaults. */
async function agentDeclaration(recipe: string): Promise<AgentConfig> {
  let raw: string;
  try {
    raw = await readFile(resolve(recipesDir(), recipe, "agent", "config.json"), "utf8");
  } catch {
    die(`recipe "${recipe}" has an agent/ bundle without agent/config.json — provision-agent requires it`);
  }
  return parseAgentConfig(JSON.parse(raw));
}

/** True only for a genuinely absent recipes directory. Any other errno means a source that
 *  exists and cannot be read, which must never pass for an empty inventory. */
export function absentRecipesSource(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** A set name derived from the deployment's, since the two don't share an alphabet: a
 *  deployment directory name is free-form, a set name goes through safeName's narrow rule.
 *  Deterministic (the name is part of the manifest, hence the id); if nothing valid
 *  survives derivation, the caller is asked for a name instead of getting an arbitrary one. */
export function defaultSetName(deployment: string): string {
  const derived = deployment
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "");
  if (derived === "") {
    die(`no set name could be derived from deployment "${deployment}" — pass one with --name`);
  }
  return derived;
}

export async function buildSet(ctx: Context, setName: string): Promise<SetBuild> {
  const { root, recipeRoot, desiredStateSource, manifest } = await collectManifest(ctx, setName);
  return writeArtifact(root, recipeRoot, desiredStateSource, setName, manifest);
}

/** The manifest a build would write, without writing anything. Split out so `validate` asks
 *  exactly the question `build` answers, rather than risking two collectors drifting apart. */
export async function collectManifest(ctx: Context, setName: string, options: { tolerateUnpinnedImage?: boolean } = {}): Promise<{
  root: string;
  recipeRoot: string;
  desiredStateSource: string;
  manifest: SetManifest;
}> {
  // The name becomes a file name under sets/ before buildSetManifest validates it.
  safeName("set", setName);
  const root = deploymentDir();
  // Recipes may live outside the deployment directory; manifest keys are portable
  // `recipes/...`, so the real source root is kept for the copy phase.
  const recipeRoot = recipesDir();
  const desiredStateSource = desiredStateFile();

  // Required, same refusal apply-config makes: a set without it installs an unconfigured instance.
  let desiredStateRaw: string;
  try {
    desiredStateRaw = await readFile(desiredStateFile(), "utf8");
  } catch {
    die(`${desiredStateFile()} not found — a set without its config declaration would install an unconfigured instance`);
  }
  let desiredState: unknown;
  try {
    desiredState = JSON.parse(desiredStateRaw);
  } catch (error) {
    die(`${desiredStateFile()} is not valid JSON: ${(error as Error).message}`);
  }
  // Valid JSON of the wrong shape must fail here, not surface later when applyConfig chokes on it.
  const shapeError = desiredStateShapeError(desiredState);
  if (shapeError !== undefined) {
    die(`${desiredStateFile()} is not a valid desired-state declaration: ${shapeError}`);
  }

  const framework = await frameworkVersion();
  if (framework === undefined) {
    die("cannot determine the framework version — a set that does not pin one would install on any framework");
  }

  // Every recipe: served content (mirror, everything except agent/), agent bundle recorded
  // separately (a prompt edit shouldn't touch served content), and acceptance checks
  // exactly as `accept` reads them.
  const files: Record<string, string> = { [DESIRED_STATE_PATH]: checksumOf(desiredStateRaw) };
  const recipes: Record<string, SetRecipe> = {};
  const acceptance: Record<string, readonly AcceptanceCheck[]> = {};
  for (const recipe of await recipeNames()) {
    const dir = resolve(recipesDir(), recipe);
    const served = await recipeFileChecksums(dir);
    const agentFiles = await agentBundleChecksums(dir);
    for (const [rel, sum] of Object.entries(served)) files[`recipes/${recipe}/${rel}`] = sum;
    for (const [rel, sum] of Object.entries(agentFiles)) files[`recipes/${recipe}/agent/${rel}`] = sum;
    recipes[recipe] = {
      checksum: checksumOfFileMap(served),
      files: served,
      ...(Object.keys(agentFiles).length === 0
        ? {}
        : { agentChecksum: checksumOfFileMap(agentFiles), agentFiles, agent: await agentDeclaration(recipe) }),
    };
    const checks = await loadChecks(recipe);
    if (checks !== undefined) acceptance[recipe] = checks;
  }

  const manifest = buildSetManifest({
    name: setName,
    requires: { framework, image: await requiredImage(ctx.settings.image, options.tolerateUnpinnedImage === true) },
    files,
    recipes,
    // Names only; buildSetManifest sorts and deduplicates, so readdir order cannot reach the id.
    secrets: await desiredSecretNames(desiredState),
    acceptance,
  });

  assertNoSecretValues(manifest, await localSecretValues());

  return { root, recipeRoot, desiredStateSource, manifest };
}

/** What executes the archiver. A seam so checks can make tar fail mid-write on demand;
 *  spawnLocal spawns without a shell, so a PATH shim can't intercept it. */
type TarRunner = typeof spawnLocal;

let tarRunner: TarRunner = spawnLocal;

/** Runs `body` with the archiver answered by `substitute` instead of executed. */
export async function withTarRunner<T>(substitute: TarRunner, body: () => Promise<T>): Promise<T> {
  const previous = tarRunner;
  tarRunner = substitute;
  try {
    return await body();
  } finally {
    tarRunner = previous;
  }
}

/** Writes the artifact: the manifest as set.json plus every file it inventories, archived
 *  with tar into sets/<name>-<id>.tar.gz.
 *
 *  No exclude list on purpose: the archive contains exactly what the manifest lists, built
 *  from an explicit set of sources (recipes + declaration), so .env/secrets/data/backups
 *  can't leak via a forgotten exclusion.
 *
 *  The id is over the manifest, never over these bytes (tar embeds mtimes/ownership/order,
 *  so byte-identical archives aren't the goal) — two builds of an unchanged tree get the
 *  same id, and the id is the identity. */
async function writeArtifact(
  root: string,
  recipeRoot: string,
  desiredStateSource: string,
  setName: string,
  manifest: SetManifest,
): Promise<SetBuild> {
  const id = setManifestId(manifest);
  const secretValues = await localSecretValues();
  const staging = await mkdtemp(join(tmpdir(), "clawforge-set-"));
  try {
    // Pretty-printed on purpose: setManifestId computes over the canonical form, so
    // formatting here doesn't change what the set is.
    await writeFile(resolve(staging, "set.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    for (const [rel, sum] of Object.entries(manifest.files)) {
      const source = rel === DESIRED_STATE_PATH
        ? desiredStateSource
        : rel.startsWith("recipes/")
          ? resolve(recipeRoot, ...rel.slice("recipes/".length).split("/"))
          : resolve(root, ...rel.split("/"));
      const bytes = await readFile(source);
      for (const { name, value } of secretValues) {
        if (value.length >= MIN_VALUE_LENGTH && bytes.includes(value)) {
          die(`refusing to write the set: ${rel} contains the value of ${name}`);
        }
      }
      // Re-verified at copy time so a file edited mid-build can't disagree with the id.
      if (checksumOf(bytes) !== sum) die(`${rel} changed while the set was being built — run the build again`);
      const target = resolve(staging, ...rel.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }

    const setsDir = resolve(root, "sets");
    await mkdir(setsDir, { recursive: true });
    const artifact = resolve(setsDir, `${setName}-${id}.tar.gz`);
    // Written to a temp file in the same directory first, so publishing is a same-filesystem
    // rename and a mid-write failure never truncates the artifact already at that path.
    const temporary = resolve(setsDir, `.clawforge-build-${randomBytes(8).toString("hex")}.tmp`);
    try {
      // spawnLocal, not the transport: a set is assembled from files on THIS machine, and
      // must not depend on a reachable target. Windows: GNU tar reads a drive letter in an
      // absolute `-f` path as a remote host spec; `--force-local` stops that, but stock
      // bsdtar doesn't know the flag, so retry without it.
      const forceLocal = process.platform === "win32" ? ["--force-local"] : [];
      let result = await tarRunner("tar", [...forceLocal, "-czf", temporary, "-C", staging, "."], { allowFailure: true });
      if (result.code !== 0) {
        // Drop whatever the failed attempt left so the retry starts clean.
        await rm(temporary, { force: true });
        await tarRunner("tar", ["-czf", temporary, "-C", staging, "."]);
      }
      await renameOverPrivateFile(temporary, artifact);
    } finally {
      await rm(temporary, { force: true });
    }
    return { name: setName, id, artifact, manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
