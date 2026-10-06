// One loading pipeline for a set, tree or artifact alike (refactor plan stage 1, I8).
//
// `loadSet(source)` answers "what does this set declare" the same way for both sources: a
// tree is collected into a manifest, an artifact is verified (archive against its own
// manifest) and unpacked, then handed the same file access the tree uses. `validateLoadedSet`
// runs the checks — purely local, no Context — so `set validate`, `set build`'s collection and
// the artifact paths cannot drift.
//
// Errors are typed by phase: only loading an ARTIFACT can throw ArtifactIntegrityError (the
// archive disagrees with its own manifest, or the manifest is malformed); findings the tree
// validator would make about the same content are Problems, never integrity errors.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { die } from "#src/core/io/log.ts";
import { renderAdvice } from "#src/core/io/invocation/render.ts";
import { parseEnv } from "#src/core/env.ts";
import { safeName } from "#src/core/values/names.ts";
import { deploymentDir, desiredStateFile, recipesDir, secretsTemplateFile } from "#src/runtime/deployment.ts";
import { spawnLocal, tarFlagRejected, tarLocalFlags, tarLocalPath } from "#src/runtime/transport/transport.ts";
import { collectSecretRefs } from "#src/service/secrets.ts";
import { recipeNames } from "#src/service/recipe.ts";
import { desiredStateShapeError, validateSet } from "#src/set/ownership/validate.ts";
import { checksumOf, checksumOfFileMap, recipeFileChecksums, agentBundleChecksums } from "#src/service/checksums.ts";
import { frameworkVersion, readLock } from "#src/commands/management/lock.ts";
import type { AgentConfig } from "#src/commands/management/provision-agent/declaration.ts";
import type { AcceptanceCheck } from "#src/commands/orchestration/accept.ts";
import { DESIRED_STATE_PATH, SET_MANIFEST_VERSION, buildSetManifest, canonicalJson, setManifestId } from "./artifacts/model.ts";
import type { SetManifest, SetRecipe } from "./artifacts/model.ts";
import { assertNoSecretValues, localSecretValues } from "#src/commands/sets/set-secrets-guard.ts";
import { hasDigest, invalidImageReference, tryParse } from "#src/runtime/docker/image-ref.ts";
import { imagePinAdvice } from "./advice.ts";
import { acceptanceLabel, agentConfigLabel, readAcceptanceFile, readAgentFile } from "./recipe-files.ts";
import { withSetSource } from "./artifacts/source.ts";
import type { Problem } from "#src/service/inspection.ts";

/** Where a set is loaded from: the working tree, or a packed artifact. */
export type SetSource = { readonly kind: "tree" } | { readonly kind: "artifact"; readonly path: string };

/** Fixed parts of the set refusals, exported so checks assert the same text the product
 *  prints instead of restating it. */
export const INVALID_ARTIFACT = "is not a valid set artifact";
export const FOREIGN_DIGEST = "does not belong to";

/** Thrown only while proving an artifact IS a set: the archive cannot be read, disagrees with
 *  its own manifest, or the manifest is malformed. Carries the artifact's path; the message is
 *  the bare cause so callers composing `"<path> is not a valid set artifact: …"` keep one path
 *  mention. A set whose content would not validate is a body Problem, never this. */
export class ArtifactIntegrityError extends Error {
  readonly artifact: string;
  constructor(artifact: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ArtifactIntegrityError";
    this.artifact = artifact;
  }
}

/** Body finding, not integrity: the archive is self-consistent, but the set it declares has
 *  blocking findings. Strict loaders refuse; read-only ones collect the findings instead. */
export class ArtifactCoherenceError extends Error {
  constructor(summary: string) {
    super(`artifact set is not coherent: ${summary}`);
    this.name = "ArtifactCoherenceError";
  }
}

export interface LoadedSet {
  readonly source: SetSource;
  readonly manifest: SetManifest;
  readonly id: string;
  /** Artifact only: where it was unpacked. The caller removes it when done. */
  readonly staging?: string;
  /** Tree only: where the tree's sources live, for the packer. */
  readonly tree?: { readonly root: string; readonly recipeRoot: string; readonly desiredStateSource: string };
}

export interface SetLoadOptions {
  /** Tree only: the set's name (default: derived per the caller's convention). */
  readonly name?: string;
  /** Tree only: the declared image (OPENCLAW_IMAGE), which a set must not re-resolve. */
  readonly declaredImage?: string;
  /** Tree only: validate tolerates an unpinned image as a finding; build refuses. */
  readonly tolerateUnpinnedImage?: boolean;
  /** Tree only: a declaration that cannot be read/parsed becomes a finding instead of a
   *  refusal. Build leaves this off — it cannot pack a set without its declaration. */
  readonly reportInvalidDeclaration?: boolean;
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
    // No template yet — `secrets --template` writes one.
  }
  return names;
}

/** The image the set pins, as a digest — a tag moves, the digest is what was proven.
 *
 *  Read from config/deployment.lock.json (recorded at `lock` time) rather than
 *  re-resolved via runtime.imageReference(), which needs a reachable target this command
 *  must not depend on. An already-digest OPENCLAW_IMAGE is honoured directly.
 *
 *  A recorded digest answers only for the reference it was proven under: a lock left over
 *  from a previous OPENCLAW_IMAGE must not pin this build to the wrong digest. */
async function requiredImage(image: string, tolerateUnpinned: boolean): Promise<string> {
  // The image module's grammar, not a digest-suffix test: a garbage value with a digest
  // shape must not pass as pinned. Validate (tolerateUnpinned) lets it through so the
  // validator reports SET_IMAGE_INVALID — the same finding the artifact path answers for
  // the same bytes; only build, which cannot pack it, keeps the die.
  if (tryParse(image) === undefined) {
    if (tolerateUnpinned) return image;
    die(invalidImageReference(image));
  }
  if (hasDigest(image)) return image;
  const lock = await readLock();
  if (lock?.image.digest !== undefined) {
    if (lock.image.reference !== image) {
      if (tolerateUnpinned) return image;
      // Same decision set validate reports — one advice, not two commands guessing.
      const advice = imagePinAdvice(image, lock);
      die(
        `the lock's digest ${FOREIGN_DIGEST} ${image} — it was recorded for ${lock.image.reference}, ` +
          "and pinning it here would put the previous image's runtime under a declaration that no longer names it.\n" +
          `${renderAdvice(advice.next)}. Or set OPENCLAW_IMAGE to a @sha256 reference.`,
      );
    }
    return lock.image.digest;
  }
  // validate keeps going with the tag in requires.image, so checkImagePinned can report
  // SET_IMAGE_UNPINNED alongside everything else; only build refuses outright.
  if (tolerateUnpinned) return image;
  const advice = imagePinAdvice(image, lock);
  die(
    `no image digest to pin the set to — ${advice.detail}\n${renderAdvice(advice.next)}. ` +
      "Or set OPENCLAW_IMAGE to a @sha256 reference.",
  );
}

/** The recipe's parsed agent declaration, read with provision-agent's own parser, so a set
 *  and provisioning can't disagree on defaults. A malformed file is the validator's finding
 *  (undefined here) when the caller reports, a refusal naming file and recipe otherwise. */
async function agentDeclaration(recipe: string, report: boolean): Promise<AgentConfig | undefined> {
  const declared = await readAgentFile(resolve(recipesDir(), recipe, "agent", "config.json"), recipe);
  if (declared === undefined) {
    die(`recipe "${recipe}" has an agent/ bundle without agent/config.json — provision-agent requires it`);
  }
  if (declared.ok) return declared.value;
  if (!report) die(declared.reason);
  return undefined;
}

/** The recipe's acceptance checks; a malformed file follows the same rule as agentDeclaration. */
async function acceptanceChecks(recipe: string, report: boolean): Promise<AcceptanceCheck[] | undefined> {
  const declared = await readAcceptanceFile(resolve(recipesDir(), recipe, "acceptance.json"), recipe);
  if (declared === undefined) return undefined;
  if (declared.ok) return declared.value;
  if (!report) die(declared.reason);
  return undefined;
}

/** The manifest a build would write, without writing anything. `set validate` asks exactly
 *  the question `set build` answers, through the same loader (loadSet), rather than risking
 *  two collectors drifting apart. */
export async function collectManifest(
  declaredImage: string,
  setName: string,
  options: { tolerateUnpinnedImage?: boolean; reportInvalidDeclaration?: boolean } = {},
): Promise<{
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
  // With reportInvalidDeclaration, an unreadable/unparsable declaration is left to the
  // validator's own reporting (declaredConfig, SET_DECLARATION_INVALID) — the same answer an
  // artifact carrying the same bytes gets — instead of a build-only refusal.
  let desiredStateRaw: string;
  let desiredState: unknown;
  try {
    desiredStateRaw = await readFile(desiredStateFile(), "utf8");
  } catch {
    // A missing declaration is reported by the validator (SET_DECLARATION_INVALID: missing or
    // empty), never read as an empty one; build refuses it as before.
    if (options.reportInvalidDeclaration !== true) {
      die(`${desiredStateFile()} not found — a set without its config declaration would install an unconfigured instance`);
    }
    desiredStateRaw = "";
    desiredState = [];
  }
  if (desiredState === undefined) {
    try {
      desiredState = JSON.parse(desiredStateRaw);
    } catch (error) {
      if (options.reportInvalidDeclaration !== true) die(`${desiredStateFile()} is not valid JSON: ${(error as Error).message}`);
      desiredState = [];
    }
  }
  // Valid JSON of the wrong shape must be reported (or refused) here, not surface later when
  // applyConfig chokes on it.
  const shapeError = desiredStateShapeError(desiredState);
  if (shapeError !== undefined) {
    if (options.reportInvalidDeclaration !== true) die(`${desiredStateFile()} is not a valid desired-state declaration: ${shapeError}`);
    desiredState = [];
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
  const report = options.reportInvalidDeclaration === true;
  for (const recipe of await recipeNames()) {
    const dir = resolve(recipesDir(), recipe);
    const served = await recipeFileChecksums(dir);
    const agentFiles = await agentBundleChecksums(dir);
    for (const [rel, sum] of Object.entries(served)) files[`recipes/${recipe}/${rel}`] = sum;
    for (const [rel, sum] of Object.entries(agentFiles)) files[`recipes/${recipe}/agent/${rel}`] = sum;
    // Only files the portable walk carried reach the manifest: a privateFiles entry is
    // excluded there, so its acceptance checks are not collected either.
    const acceptancePath = acceptanceLabel(recipe);
    if (files[acceptancePath] !== undefined) {
      const checks = await acceptanceChecks(recipe, report);
      if (checks !== undefined) acceptance[recipe] = checks;
    }
    const agent = agentFiles["config.json"] === undefined ? undefined : await agentDeclaration(recipe, report);
    recipes[recipe] = {
      checksum: checksumOfFileMap(served),
      files: served,
      ...(Object.keys(agentFiles).length === 0
        ? {}
        : { agentChecksum: checksumOfFileMap(agentFiles), agentFiles, ...(agent === undefined ? {} : { agent }) }),
    };
  }

  const manifest = buildSetManifest({
    name: setName,
    requires: { framework, image: await requiredImage(declaredImage, options.tolerateUnpinnedImage === true) },
    files,
    recipes,
    // Names only; buildSetManifest sorts and deduplicates, so readdir order cannot reach the id.
    secrets: await desiredSecretNames(desiredState),
    acceptance,
  });

  assertNoSecretValues(manifest, await localSecretValues());

  return { root, recipeRoot, desiredStateSource, manifest };
}

/** Loads a set from either source. An artifact goes integrity → unpack → the same file
 *  access the tree uses (verifyArtifact runs the tree validator against the staging); a tree
 *  is collected into its manifest. */
export async function loadSet(source: SetSource, options: SetLoadOptions = {}): Promise<LoadedSet> {
  if (source.kind === "artifact") return loadArtifact(source.path);
  return loadTree(options);
}

async function loadTree(options: SetLoadOptions): Promise<LoadedSet> {
  if (options.declaredImage === undefined) {
    die("loading a set from the working tree needs the declared image — pass declaredImage in the load options");
  }
  const collected = await collectManifest(options.declaredImage, options.name ?? "", {
    tolerateUnpinnedImage: options.tolerateUnpinnedImage,
    reportInvalidDeclaration: options.reportInvalidDeclaration,
  });
  return {
    source: { kind: "tree" },
    manifest: collected.manifest,
    id: setManifestId(collected.manifest),
    tree: { root: collected.root, recipeRoot: collected.recipeRoot, desiredStateSource: collected.desiredStateSource },
  };
}

/** What verification established about an artifact. */
export interface VerifiedArtifact {
  readonly manifest: SetManifest;
  readonly id: string;
}

interface ArchiveEntry {
  readonly path: string;
  readonly type: "file" | "directory";
}

function cleanArchivePath(raw: string): string {
  const path = raw.replace(/^\.\//, "").replace(/\/$/, "");
  if (path === "") return path;
  if (raw.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`artifact contains an unsafe path: ${raw}`);
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checksumMap(value: unknown, where: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${where} must be an object of checksums`);
  for (const [path, checksum] of Object.entries(value)) {
    if (path === "" || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || part === "") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
      throw new Error(`${where} contains an unsafe path: ${path}`);
    }
    if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum)) {
      throw new Error(`${where}/${path} is not a SHA-256 checksum`);
    }
  }
  return value as Record<string, string>;
}

/** Checks the manifest shape and its internal inventory before any artifact file is used.
 *  Content findings — a recipe name or acceptance check the recipe rules reject — are the
 *  validator's (validateSet), the same answer the tree gives; nothing here reaches
 *  accept.ts, which sits downstream of install.ts (module-load check). */
async function validateManifest(value: unknown): Promise<SetManifest> {
  if (!isRecord(value) || value.version !== SET_MANIFEST_VERSION || typeof value.name !== "string" || !isRecord(value.requires)) {
    throw new Error("artifact set.json has an invalid manifest shape");
  }
  safeName("set", value.name);
  if (typeof value.requires.framework !== "string" || typeof value.requires.image !== "string") {
    throw new Error("artifact set.json has invalid requirements");
  }
  const files = checksumMap(value.files, "set files");
  if (files[DESIRED_STATE_PATH] === undefined) throw new Error(`artifact manifest does not contain ${DESIRED_STATE_PATH}`);
  if (!isRecord(value.recipes) || !Array.isArray(value.secrets) || !value.secrets.every((entry) => typeof entry === "string") || !isRecord(value.acceptance)) {
    throw new Error("artifact set.json has invalid recipes, secrets or acceptance");
  }

  const expected: Record<string, string> = { [DESIRED_STATE_PATH]: files[DESIRED_STATE_PATH] };
  for (const [name, rawRecipe] of Object.entries(value.recipes)) {
    // A name the grammar rejects is content, not integrity: the validator reports it
    // (recipeNameProblem), the same finding the tree answers with.
    if (!isRecord(rawRecipe)) throw new Error(`recipe ${name} is not an object`);
    const recipeFiles = checksumMap(rawRecipe.files, `recipe ${name} files`);
    if (rawRecipe.checksum !== checksumOfFileMap(recipeFiles)) throw new Error(`recipe ${name} has an incorrect content checksum`);
    for (const [path, checksum] of Object.entries(recipeFiles)) expected[`recipes/${name}/${path}`] = checksum;
    if (rawRecipe.agentFiles !== undefined) {
      const agentFiles = checksumMap(rawRecipe.agentFiles, `recipe ${name} agent files`);
      if (rawRecipe.agentChecksum !== checksumOfFileMap(agentFiles)) throw new Error(`recipe ${name} has an incorrect agent checksum`);
      for (const [path, checksum] of Object.entries(agentFiles)) expected[`recipes/${name}/agent/${path}`] = checksum;
    }
  }
  // The acceptance RULES are content, not integrity: a check that fails the spec is the
  // validator's SET_RECIPE_INVALID, read from the acceptance.json the archive carries —
  // the same answer the tree gives for the same bytes. Here only the shape is judged;
  // whether these entries agree with that file is verifyArtifact's comparison below.
  for (const [name, checks] of Object.entries(value.acceptance)) {
    if (!Array.isArray(checks)) throw new Error(`recipe ${name} acceptance must be an array`);
  }
  const actualKeys = Object.keys(files).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new Error("artifact manifest file inventory disagrees with its recipe inventories");
  for (const path of actualKeys) if (files[path] !== expected[path]) throw new Error(`artifact manifest checksum disagreement for ${path}`);
  return value as unknown as SetManifest;
}

// Every argument tar itself decodes goes forward-slash (tarLocalPath): a backslashed -C
// staging reads its escapes and every artifact is refused (rf6-fix33).
async function tar(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const forceLocal = tarLocalFlags();
  let result = await spawnLocal("tar", [...forceLocal, ...args.map(tarLocalPath)], { allowFailure: true });
  // Retry without the flag only when the flag itself was the refusal (bsdtar); any other
  // failure keeps its first error — a retry under GNU tar reports the drive letter as a
  // remote host instead of the real cause.
  if (result.code !== 0 && forceLocal.length > 0 && tarFlagRejected(result)) {
    result = await spawnLocal("tar", args, { allowFailure: true });
  }
  return result;
}

/** The integrity half of the artifact path: verifies archive structure, extracts only after
 *  that verification, then verifies every byte against the manifest. Throws on any archive-
 *  vs-manifest disagreement; it deliberately runs NO validation of the set's content —
 *  whether the set is coherent is body knowledge, decided by validateLoadedSet, so the load
 *  mode can never change which findings exist. */
async function verifyArtifact(artifact: string, staging: string): Promise<VerifiedArtifact> {
  const listing = await tar(["-tzf", artifact]);
  if (listing.code !== 0) throw new Error(`could not inspect ${artifact}: ${(listing.stderr || listing.stdout).trim()}`);
  const verbose = await tar(["-tvzf", artifact]);
  if (verbose.code !== 0) throw new Error(`could not inspect links in ${artifact}: ${(verbose.stderr || verbose.stdout).trim()}`);

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  for (const raw of listing.stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "")) {
    const path = cleanArchivePath(raw);
    const directory = raw.endsWith("/") || path === "";
    if (seen.has(path)) throw new Error(`artifact contains duplicate entry: ${raw}`);
    seen.add(path);
    entries.push({ path, type: directory ? "directory" : "file" });
  }
  for (const line of verbose.stdout.split("\n").map((entry) => entry.trimEnd()).filter((entry) => entry !== "")) {
    // GNU tar uses `Sep 10 14:04` or `2026-09-10 14:04` for the date, owner/group may be
    // one or two fields — anchor on the date rather than counting columns.
    const match = /^(\S)\S*\s+.*?\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}|\d{4}-\d{2}-\d{2})\s+\S+\s+(.*)$/u.exec(line);
    if (match === null) throw new Error(`cannot safely parse artifact listing: ${line}`);
    const type = match[1];
    const shown = match[2];
    if (type === "l" || type === "h") throw new Error(`artifact contains a link: ${shown}`);
    if (type !== "-" && type !== "d") throw new Error(`artifact contains unsupported entry type: ${shown}`);
  }

  const extract = await tar(["--no-same-owner", "--no-same-permissions", "-xzf", artifact, "-C", staging]);
  if (extract.code !== 0) throw new Error(`could not unpack ${artifact}: ${(extract.stderr || extract.stdout).trim()}`);

  const rawManifest = await readFile(join(staging, "set.json"), "utf8").catch(() => {
    throw new Error(`${artifact} has no readable set.json`);
  });
  let parsed: unknown;
  try { parsed = JSON.parse(rawManifest); } catch { throw new Error(`${artifact} contains invalid JSON in set.json`); }
  const manifest = await validateManifest(parsed);
  const files = entries.filter((entry) => entry.type === "file").map((entry) => entry.path).filter((path) => path !== "set.json").sort();
  const claimed = Object.keys(manifest.files).sort();
  if (JSON.stringify(files) !== JSON.stringify(claimed)) throw new Error("artifact contents disagree with the manifest file inventory");
  for (const path of claimed) {
    const actual = await readFile(resolve(staging, ...path.split("/")));
    if (checksumOf(actual) !== manifest.files[path]) throw new Error(`artifact content checksum mismatch: ${path}`);
  }
  for (const [name, recipe] of Object.entries(manifest.recipes)) {
    if (recipe.agent !== undefined) {
      // A declared agent whose config.json is absent from the inventory is a completeness
      // finding — the tree validator reports the same about the same content (parity), not
      // an integrity error. The parsed-file comparison below IS archive-vs-manifest.
      // A file that does not parse is not a disagreement the archive can be blamed for: the
      // validator reports it (SET_RECIPE_INVALID), the same as for the tree.
      const configPath = agentConfigLabel(name);
      if (manifest.files[configPath] !== undefined) {
        const declared = await readAgentFile(resolve(staging, configPath), name);
        if (declared?.ok === true && canonicalJson(declared.value) !== canonicalJson(recipe.agent)) {
          throw new Error(`recipe ${name} agent declaration disagrees with its file`);
        }
      }
    } else if (Object.keys(recipe.agentFiles ?? {}).length > 0 && manifest.files[agentConfigLabel(name)] !== undefined) {
      // config.json carried yet no declaration is incoherent; config.json itself held back by
      // policy is the privateFiles case — the validator judges it, not integrity.
      throw new Error(`recipe ${name} has agent files without an agent declaration`);
    }
    // A file policy keeps private (recipe.json privateFiles) is absent from the manifest and
    // the archive alike — nothing to compare, never an integrity error (parity with the tree).
    const acceptancePath = acceptanceLabel(name);
    if (manifest.files[acceptancePath] !== undefined) {
      const fromFile = await readAcceptanceFile(resolve(staging, acceptancePath), name);
      if (fromFile?.ok !== false && canonicalJson(fromFile?.value ?? []) !== canonicalJson(manifest.acceptance[name] ?? [])) {
        throw new Error(`recipe ${name} acceptance disagrees with its file`);
      }
    }
  }
  return { manifest, id: setManifestId(manifest) };
}

/** One line for the install-time refusal: each failing code once with a count when it repeats,
 *  plus the recipes named, so "SET_RECIPE_INCOMPLETE, SET_RECIPE_INCOMPLETE" says which broke. */
export function coherenceSummary(problems: readonly Problem[]): string {
  const counts = new Map<string, number>();
  for (const entry of problems) counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1);
  const codes = [...counts.entries()].map(([code, count]) => (count > 1 ? `${code} ×${count}` : code)).join(", ");
  const recipes = [...new Set(problems.map((entry) => /recipe "([^"]+)"/.exec(entry.detail)?.[1]).filter((name): name is string => name !== undefined))];
  return recipes.length === 0 ? codes : `${codes} (recipes: ${recipes.join(", ")})`;
}

async function loadArtifact(path: string): Promise<LoadedSet> {
  const staging = await mkdtemp(join(tmpdir(), "clawforge-set-load-"));
  let verified: VerifiedArtifact;
  try {
    verified = await verifyArtifact(path, staging);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw new ArtifactIntegrityError(path, error);
  }
  return { source: { kind: "artifact", path }, manifest: verified.manifest, id: verified.id, staging };
}

/** Every finding a loaded set produces, without a Context — computed from the loaded content
 *  whichever way it was loaded: the load mode decides whether integrity problems throw, never
 *  whether body findings exist. For an artifact this runs the tree validator against the
 *  unpacked staging, so both paths answer with the same engine over the same files. The
 *  caller must keep the staging directory of an artifact load alive until this returns. */
export async function validateLoadedSet(loaded: LoadedSet): Promise<Problem[]> {
  if (loaded.source.kind === "tree") return validateSet(loaded.manifest, { checkFiles: true });
  const staging = loaded.staging;
  if (staging === undefined) die("internal: loading an artifact carries no staging directory");
  return withSetSource(staging, () => validateSet(loaded.manifest, { checkFiles: true }));
}
