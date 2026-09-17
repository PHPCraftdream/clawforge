// `./clawforge set build` — collect everything a deployment installs into ONE artifact.
// Split out of set.ts; see set-secrets-guard.ts for the value scan this calls before
// writing anything, and set.ts for validateAction/forgetAction/the set() dispatcher.
//
// The vocabulary (the manifest, the three entities set/instance/state, the content id)
// lives in set/model.ts; this is the gatherer that feeds it. What comes back is written to
// the deployment's own sets/ directory as <name>-<id>.tar.gz: the manifest (set.json) plus
// every file it inventories.
//
// A set builds with NO running instance, and that constraint decides every source below.
// The target-side readers — secrets.ts's requirements(ctx), runtime.imageReference() —
// answer questions about a live instance on a reachable machine; a set is the thing you
// build BEFORE any of that exists. So ctx.transport and ctx.runtime are never touched: the
// parameter exists because the command surface hands one to every command, and only
// ctx.settings (the deployment's declared image) is read.

import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { die } from "#src/core/log.ts";
import { parseEnv } from "#src/core/env.ts";
import { safeName } from "#src/core/names.ts";
import { spawnLocal } from "#src/runtime/transport.ts";
import type { Context } from "#src/core/context.ts";
import { deploymentDir, desiredStateFile, recipesDir, secretsTemplateFile } from "#src/runtime/deployment.ts";
import { collectSecretRefs } from "#src/service/secrets.ts";
import { desiredStateShapeError } from "#src/set/ownership/validate.ts";
import { checksumOf, checksumOfFileMap, recipeFileChecksums, agentBundleChecksums } from "#src/service/checksums.ts";
import { frameworkVersion, readLock } from "../management/lock.ts";
import { parseAgentConfig } from "../management/provision-agent/index.ts";
import type { AgentConfig } from "../management/provision-agent/index.ts";
import { loadChecks } from "../orchestration/accept.ts";
import type { AcceptanceCheck } from "../orchestration/accept.ts";
import { DESIRED_STATE_PATH, buildSetManifest, setManifestId } from "#src/set/artifacts/model.ts";
import type { SetManifest, SetRecipe } from "#src/set/artifacts/model.ts";
import { assertNoSecretValues, localSecretValues, MIN_VALUE_LENGTH } from "./set-secrets-guard.ts";

/** What one build produced. The id is setManifestId(manifest); the artifact carries it in
 *  its file name, so two builds of unchanged content land on the same path. */
export interface SetBuild {
  readonly name: string;
  readonly id: string;
  readonly artifact: string;
  readonly manifest: SetManifest;
}

/** Secret NAMES, derived from the declaration the set itself carries — never from the live
 *  instance. framework/service/secrets.ts's requirements(ctx) reads openclaw.json ON THE TARGET,
 *  which is exactly what a set must not need: it is the thing you build before any target
 *  exists. The two sources used here both travel with the set:
 *
 *   - SecretRefs inside config/desired-state.json (collectSecretRefs is a pure function
 *     over a config object): the declaration is in the set, so the refs the instance will
 *     have once apply-config has pushed it are visible here.
 *   - config/secrets.template.env, written by `./clawforge secrets --template` as names only: it
 *     catches the conventional provider key that no SecretRef points at.
 *
 *  The app's own secrets hook is deliberately NOT consulted: AppDefinition.secrets is
 *  documented as usually depending on what is configured on the target, so calling it would
 *  reintroduce the live-instance dependency this command exists to avoid. The gateway token
 *  is likewise absent on purpose: each target generates its own (an instance concern), and
 *  naming it here would pin a fact about one machine into content meant for another. */
async function desiredSecretNames(desiredState: unknown): Promise<string[]> {
  const names = collectSecretRefs(desiredState).map((ref) => ref.name);
  try {
    names.push(...Object.keys(parseEnv(await readFile(secretsTemplateFile(), "utf8"))));
  } catch {
    // No template yet — `./clawforge secrets --template` writes one.
  }
  return names;
}

/** The image the set pins, as a digest. A tag moves; the digest is what was proven.
 *
 *  runtime.imageReference() would re-resolve it by asking the target's docker — a machine
 *  query, and one that needs a working setup. The proven digest is already recorded on this
 *  machine: config/deployment.lock.json pins it at `./clawforge lock` time. An OPENCLAW_IMAGE that
 *  is already a digest reference is honoured directly — the operator pinned it by hand.
 *
 *  A recorded digest answers only for the reference it was proven under, and the reference is
 *  the one thing comparable offline: a lock left over from a previous OPENCLAW_IMAGE must not
 *  pin this build with the previous image's digest, and what a different tag means cannot be
 *  resolved without a network this command is defined not to need. */
async function requiredImage(image: string): Promise<string> {
  if (image.includes("@sha256:")) return image;
  const lock = await readLock();
  if (lock?.image.digest !== undefined) {
    if (lock.image.reference !== image) {
      die(
        `the lock's digest does not belong to ${image} — it was recorded for ${lock.image.reference}, ` +
          "and pinning it here would put the previous image's runtime under a declaration that no longer names it.\n" +
          "Run ./clawforge lock to record the digest for the image now declared, or set OPENCLAW_IMAGE to a @sha256 reference.",
      );
    }
    return lock.image.digest;
  }
  die(
    `no image digest to pin the set to — ${image} is a tag, and a set that names a tag ` +
      "would install whatever that tag means on the day it is installed.\n" +
      "Run ./clawforge lock to record the digest that was proven, or set OPENCLAW_IMAGE to a @sha256 reference.",
  );
}

/** The recipe's parsed agent declaration, read with provision-agent's own parser: two
 *  readers of one agent/config.json applying different defaults is how a set and
 *  provisioning end up disagreeing about what the agent is. */
async function agentDeclaration(recipe: string): Promise<AgentConfig> {
  let raw: string;
  try {
    raw = await readFile(resolve(recipesDir(), recipe, "agent", "config.json"), "utf8");
  } catch {
    die(`recipe "${recipe}" has an agent/ bundle without agent/config.json — provision-agent requires it`);
  }
  return parseAgentConfig(JSON.parse(raw));
}

/** Recipe directory names, sorted: readdir order differs between machines and the id must
 *  not notice. Same rule as the lock's recipeNames. */
async function recipeNames(): Promise<string[]> {
  const dir = recipesDir();
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    // ENOENT is a deployment with no recipes at all; anything else is a source that exists
    // and cannot be read, and calling that an empty inventory would publish a read failure
    // as the removal of every recipe — which plan and the ownership ledger would then act
    // on as real removals.
    if (absentRecipesSource(error)) return [];
    const code = (error as NodeJS.ErrnoException).code;
    die(`cannot read the recipes source at ${dir}: ${code ?? (error as Error).message}`);
  }
}

/** True when a readdir error says only that there is no recipes directory at all — how a
 *  deployment with no recipes legitimately reads. Every other errno (ENOTDIR, EACCES, EIO,
 *  ...) means a source that exists and cannot be read, which must never pass for an empty
 *  inventory. */
export function absentRecipesSource(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** A set name derived from the deployment's, because that is the sensible default and the
 *  two do not share an alphabet: a deployment in installed mode is named after whatever its
 *  directory is called (`clawforge` here), while a set name becomes a file under sets/ and
 *  goes through safeName's narrow rule. Loosening that rule would weaken a guard that exists
 *  to stop `../..` reaching a path; deriving is the smaller change.
 *
 *  Deterministic, because the name is part of the manifest and therefore part of the id. If
 *  nothing valid survives the derivation the caller is asked for a name rather than handed a
 *  set called something arbitrary. */
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

/** The manifest a build would write, without writing anything.
 *
 *  Split out so `validate` asks exactly the question `build` answers: a set that validates
 *  and a set that builds must be the same set, and two collectors would eventually make them
 *  different ones. */
export async function collectManifest(ctx: Context, setName: string): Promise<{
  root: string;
  recipeRoot: string;
  desiredStateSource: string;
  manifest: SetManifest;
}> {
  // The name becomes a file name under sets/ before buildSetManifest validates it.
  safeName("set", setName);
  const root = deploymentDir();
  // The application may keep recipes outside the deployment directory. The manifest uses
  // portable `recipes/...` keys, so retain the actual source root for the copy phase.
  const recipeRoot = recipesDir();
  const desiredStateSource = desiredStateFile();

  // The declaration is required, same refusal apply-config makes: a set without it would
  // install recipes against an unconfigured instance — a kit missing its centrepiece.
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
  // Syntactically valid JSON of the wrong shape (an object, say, instead of a list of
  // {path,value} operations) passed this far unnoticed — set build/validate reported
  // success, and the mistake only surfaced later when OpenClaw's own `config set
  // --batch-file` (config.ts's applyConfig) choked on it during an actual apply.
  const shapeError = desiredStateShapeError(desiredState);
  if (shapeError !== undefined) {
    die(`${desiredStateFile()} is not a valid desired-state declaration: ${shapeError}`);
  }

  const framework = await frameworkVersion();
  if (framework === undefined) {
    die("cannot determine the framework version — a set that does not pin one would install on any framework");
  }

  // Every recipe: served content (the mirror — everything except agent/), the agent bundle
  // recorded separately (a prompt edit changes the agent without touching served content),
  // and the acceptance checks exactly as `./clawforge accept` reads them.
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
    requires: { framework, image: await requiredImage(ctx.settings.image) },
    files,
    recipes,
    // Names only; buildSetManifest sorts and deduplicates, so readdir order cannot reach the id.
    secrets: await desiredSecretNames(desiredState),
    acceptance,
  });

  assertNoSecretValues(manifest, await localSecretValues());

  return { root, recipeRoot, desiredStateSource, manifest };
}

/** What executes the archiver. A seam, for the same reason private-file.ts's toolRunner is
 *  one: checks must make tar fail mid-write on demand, and spawnLocal spawns without a
 *  shell, so a PATH shim cannot intercept it — on Windows tar resolves to System32's own
 *  bsdtar. Production never enters a substitute; the default is the spawnLocal call this
 *  always was. */
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
 *  There is no exclude list anywhere in this file, on purpose. The archive contains exactly
 *  the files the manifest lists, and the manifest is built from an explicit set of sources —
 *  recipes and the declaration, nothing else. .env, secrets/, the data directory, snapshots,
 *  backups and .mcp.json cannot leak because a new host-local location was forgotten on a
 *  list: there is no list to forget anything on.
 *
 *  The id is over the manifest, never over these bytes. tar embeds mtimes, ownership and
 *  platform ordering, so byte-identical archives are a rabbit hole nobody should enter; two
 *  builds of an unchanged tree give the same id and two archives that mean the same thing.
 *  The id is the identity; the file is only how the content travels. */
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
    // Pretty-printed on purpose: the id is computed by setManifestId over the canonical
    // form, so how this file happens to be formatted does not change what the set is.
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
      // Re-verified against the manifest at copy time, so a file edited mid-build cannot
      // produce an artifact that disagrees with its own id.
      if (checksumOf(bytes) !== sum) die(`${rel} changed while the set was being built — run the build again`);
      const target = resolve(staging, ...rel.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }

    const setsDir = resolve(root, "sets");
    await mkdir(setsDir, { recursive: true });
    const artifact = resolve(setsDir, `${setName}-${id}.tar.gz`);
    // tar writes a unique file in sets/ itself — the same directory, so publishing is a
    // rename on one filesystem — and the final name is only ever replaced by a complete
    // archive: two unchanged builds land on the same path, and a tar that dies mid-write
    // must leave the artifact that was already there byte-for-byte intact, never truncated
    // under its name. Same shape as install.ts's storeArtifactForRollback.
    const temporary = resolve(setsDir, `.clawforge-build-${randomBytes(8).toString("hex")}.tmp`);
    try {
      // spawnLocal rather than the transport, and the distinction is easy backwards: the
      // transport interface reaches the TARGET the instance lives on, while a set is
      // assembled from files on THIS machine. Building a set through the transport would make
      // it depend on a target being reachable — the dependency this command must not have.
      // On Windows some tars (GNU tar from Git) read the drive letter in an absolute `-f`
      // path as a remote host spec; `--force-local` stops that, but the stock bsdtar does
      // not know the flag. Try the flag where it can be needed, and fall back without it.
      const forceLocal = process.platform === "win32" ? ["--force-local"] : [];
      let result = await tarRunner("tar", [...forceLocal, "-czf", temporary, "-C", staging, "."], { allowFailure: true });
      if (result.code !== 0) {
        // Either the flag was unknown to this tar, or the tar failed for real: drop
        // whatever bytes the failed attempt left, so the retry starts from nothing, and
        // let spawnLocal surface any failure the usual way.
        await rm(temporary, { force: true });
        await tarRunner("tar", ["-czf", temporary, "-C", staging, "."]);
      }
      await rename(temporary, artifact);
    } finally {
      await rm(temporary, { force: true });
    }
    return { name: setName, id, artifact, manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
