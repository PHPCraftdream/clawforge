// Installing from an artifact rather than from whatever the working tree currently holds.
//
// One engine, two sources. `plan` and `apply` keep every rule they already have — the
// ordering, the journal, the instance lock, the confirming inspection, the blocking
// remainder — and only the question "what does this deployment declare" is answered
// differently: from an unpacked artifact instead of from the files on disk. A second command
// family that installed sets its own way would be a second path to changing one instance,
// which is the shape of every defect this framework has spent its rounds removing.
//
// What is recorded afterwards is the set's id, on the target. Without it "which set is
// installed here" has no answer, and every later question — has it drifted, what would
// rolling back mean — has nowhere to start.

import { copyFile, lstat, mkdir, mkdtemp, rm, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { die, log } from "../../core/log.ts";
import { spawnLocal } from "../../runtime/transport.ts";
import { deploymentDir } from "../../runtime/deployment.ts";
import { checksumOf, checksumOfFileMap } from "../../service/checksums.ts";
import { parseAgentConfig } from "../../commands/management/provision-agent.ts";
import { acceptanceSpecError } from "../../commands/orchestration/accept.ts";
import { safeName } from "../../core/names.ts";
import { problem } from "../../service/inspection.ts";
import { validateSet } from "../ownership/validate.ts";
import { withSetSource } from "./source.ts";
import type { Problem } from "../../service/inspection.ts";
import type { Context } from "../../core/context.ts";
import { DESIRED_STATE_PATH, SET_MANIFEST_VERSION, setManifestId, canonicalJson } from "./model.ts";
import type { SetManifest } from "./model.ts";

/** What was installed immediately before the current set — one level, not a stack, the same
 *  depth `./clawforge rollback`'s own single-file path already works at. */
export interface PreviousSet {
  readonly id: string;
  readonly name: string;
  readonly installedAt: string;
}

/** What the target records about the set it is running. */
export interface InstalledSet {
  readonly id: string;
  readonly name: string;
  readonly installedAt: string;
  /** What the set required, kept beside the id so a later mismatch can be described without
   *  the artifact being present — the machine that installed it may be long gone. */
  readonly requires: SetManifest["requires"];
  /** The apply operation that installed this set. Its own configSnapshot (operations.ts),
   *  when it took one, is the configuration exactly as the PREVIOUS set left it — what
   *  `rollback --set` needs to restore precisely. Absent for a record written before this
   *  field existed, or when no operation id was available to record. */
  readonly operationId?: string;
  /** The set this one replaced, so a rollback has somewhere to go back to. Absent for the
   *  first set ever installed on this instance. */
  readonly previous?: PreviousSet;
}

export function installedSetFile(ctx: Context): string {
  return `${ctx.settings.dataDir}/clawforge-installed-set.json`;
}

function legacyInstalledSetFile(ctx: Context): string {
  return `${ctx.settings.dataDir}/${["c", "f"].join("")}-installed-set.json`;
}

export async function readInstalledSet(ctx: Context): Promise<InstalledSet | undefined> {
  let text: string;
  try {
    text = await ctx.transport.readFile(installedSetFile(ctx));
  } catch {
    try { text = await ctx.transport.readFile(legacyInstalledSetFile(ctx)); }
    catch { return undefined; }
  }
  try {
    const parsed = JSON.parse(text) as InstalledSet;
    if (!isSetId(parsed.id) || typeof parsed.name !== "string") return undefined;
    safeName("set", parsed.name);
    if (parsed.previous !== undefined && (!isSetId(parsed.previous.id) || typeof parsed.previous.name !== "string")) return undefined;
    if (parsed.previous !== undefined) safeName("set", parsed.previous.name);
    return parsed;
  } catch {
    return undefined;
  }
}

function isSetId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Records the set just installed, carrying the one it replaced forward as `previous`.
 *
 *  Re-recording the SAME id — apply re-run against a set already in force — must not
 *  overwrite `previous` with the set itself: that would make a rollback undo nothing. And a
 *  `previous` already on record survives an apply that changes nothing about which set is
 *  installed, for the same reason. */
export async function recordInstalledSet(ctx: Context, manifest: SetManifest, id: string, operationId?: string): Promise<void> {
  if (!isSetId(id) || id !== setManifestId(manifest)) {
    throw new Error("refusing to record an installed set whose id does not match its manifest");
  }
  safeName("set", manifest.name);
  const current = await readInstalledSet(ctx);
  const sameSet = current !== undefined && current.id === id;
  const previous: PreviousSet | undefined = current === undefined || sameSet
    ? current?.previous
    : { id: current.id, name: current.name, installedAt: current.installedAt };
  // A no-op re-apply of the SAME set (nothing changed, so applyFromSource() took its
  // "nothing to apply" early return and never opened a Journal or took a snapshot for this
  // fresh operationId) must not overwrite the id that actually installed it — rollback --set
  // reads this field to find the one snapshot that matters, and a clobbered id points at an
  // operation record that was never written, silently losing the snapshot to restore from.
  const effectiveOperationId = sameSet ? current.operationId : operationId;

  const record: InstalledSet = {
    id,
    name: manifest.name,
    installedAt: new Date().toISOString(),
    requires: manifest.requires,
    ...(effectiveOperationId === undefined ? {} : { operationId: effectiveOperationId }),
    ...(previous === undefined ? {} : { previous }),
  };
  await ctx.transport.writeFile(installedSetFile(ctx), `${JSON.stringify(record, null, 2)}\n`);
}

interface ArchiveEntry {
  readonly path: string;
  readonly type: "file" | "directory";
}

export interface VerifiedArtifact {
  readonly manifest: SetManifest;
  readonly id: string;
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

/** Checks the manifest shape and its internal inventory before any artifact file is used. */
function validateManifest(value: unknown): SetManifest {
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
    safeName("recipe", name);
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
  for (const [name, checks] of Object.entries(value.acceptance)) {
    if (!Array.isArray(checks)) throw new Error(`recipe ${name} acceptance must be an array`);
    for (let index = 0; index < checks.length; index += 1) {
      const invalid = acceptanceSpecError(checks[index], index);
      if (invalid !== undefined) throw new Error(`recipe ${name}: ${invalid}`);
    }
  }
  const actualKeys = Object.keys(files).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new Error("artifact manifest file inventory disagrees with its recipe inventories");
  for (const path of actualKeys) if (files[path] !== expected[path]) throw new Error(`artifact manifest checksum disagreement for ${path}`);
  return value as unknown as SetManifest;
}

async function tar(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const forceLocal = process.platform === "win32" ? ["--force-local"] : [];
  let result = await spawnLocal("tar", [...forceLocal, ...args], { allowFailure: true });
  if (result.code !== 0 && forceLocal.length > 0) result = await spawnLocal("tar", args, { allowFailure: true });
  return result;
}

/** Verifies archive structure, extracts only after that verification, then verifies every byte. */
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
    // GNU tar uses either `Sep 10 14:04` or `2026-09-10 14:04` for the date, and
    // owner/group may be one field or two. Anchor on that date instead of counting
    // columns; both forms are emitted by versions used on Windows and Linux.
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
  const manifest = validateManifest(parsed);
  const files = entries.filter((entry) => entry.type === "file").map((entry) => entry.path).filter((path) => path !== "set.json").sort();
  const claimed = Object.keys(manifest.files).sort();
  if (JSON.stringify(files) !== JSON.stringify(claimed)) throw new Error("artifact contents disagree with the manifest file inventory");
  for (const path of claimed) {
    const actual = await readFile(resolve(staging, ...path.split("/")));
    if (checksumOf(actual) !== manifest.files[path]) throw new Error(`artifact content checksum mismatch: ${path}`);
  }
  for (const [name, recipe] of Object.entries(manifest.recipes)) {
    if (recipe.agent !== undefined) {
      const configPath = `recipes/${name}/agent/config.json`;
      if (manifest.files[configPath] === undefined || manifest.files[`recipes/${name}/server.ts`] === undefined) {
        throw new Error(`recipe ${name} has an incomplete agent bundle`);
      }
      const declared = parseAgentConfig(JSON.parse(await readFile(resolve(staging, configPath), "utf8")));
      if (canonicalJson(declared) !== canonicalJson(recipe.agent)) throw new Error(`recipe ${name} agent declaration disagrees with its file`);
    } else if (Object.keys(recipe.agentFiles ?? {}).length > 0) {
      throw new Error(`recipe ${name} has agent files without an agent declaration`);
    }
    const acceptancePath = `recipes/${name}/acceptance.json`;
    const fromFile = manifest.files[acceptancePath] === undefined
      ? undefined
      : JSON.parse(await readFile(resolve(staging, acceptancePath), "utf8")).checks;
    if (canonicalJson(fromFile ?? []) !== canonicalJson(manifest.acceptance[name] ?? [])) {
      throw new Error(`recipe ${name} acceptance disagrees with its file`);
    }
  }
  const semanticProblems = await withSetSource(staging, () => validateSet(manifest, { checkFiles: false }));
  const blocking = semanticProblems.filter((entry) => entry.severity === "blocking");
  if (blocking.length > 0) throw new Error(`artifact set is not coherent: ${blocking.map((entry) => entry.code).join(", ")}`);
  return { manifest, id: setManifestId(manifest) };
}

/** Keeps a validated artifact in the deployment so rollback does not depend on its original
 * path still existing. The copy is complete before apply is allowed to mutate the target. */
export async function storeArtifactForRollback(artifact: string, verified: VerifiedArtifact): Promise<string> {
  safeName("set", verified.manifest.name);
  if (!isSetId(verified.id)) throw new Error("refusing to store an artifact with an invalid content id");
  const directory = resolve(deploymentDir(), "sets");
  await mkdir(directory, { recursive: true });
  const destination = resolve(directory, `${verified.manifest.name}-${verified.id}.tar.gz`);
  if (await fileExists(destination)) {
    await withUnpackedArtifact(destination, async (_staging, cached) => {
      if (cached.id !== verified.id) throw new Error("cached rollback artifact has a different content id");
    });
    return destination;
  }
  const temporary = resolve(directory, `.clawforge-artifact-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await copyFile(artifact, temporary);
    await withUnpackedArtifact(temporary, async (_staging, copied) => {
      if (copied.id !== verified.id) throw new Error("artifact changed before it could be stored for rollback");
    });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

async function fileExists(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

/** Unpacks an artifact into a temporary directory and hands back where it went.
 *
 *  `--force-local` on Windows because GNU tar reads the `D:` of an absolute path as a remote
 *  host and tries to connect — the same quirk the writing side handles, and a reminder that
 *  a platform workaround applied on one side only is a workaround that has not been applied. */
export async function unpackArtifactVerified(artifact: string): Promise<{ staging: string; verified: VerifiedArtifact }> {
  const staging = await mkdtemp(join(tmpdir(), "clawforge-set-install-"));
  try {
    const verified = await verifyArtifact(artifact, staging);
    return { staging, verified };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    die(`${artifact} is not a valid set artifact: ${(error as Error).message}`);
  }
}

export async function unpackArtifact(artifact: string): Promise<string> {
  return (await unpackArtifactVerified(artifact)).staging;
}

/** Whether this machine can install what the set requires.
 *
 *  Reported rather than enforced by refusal, and the distinction matters: a framework older
 *  than the set asked for may still install it correctly, and a reader who can see the
 *  mismatch decides. What must not happen is the mismatch going unmentioned — a set pins its
 *  requirements precisely so that installing it somewhere else is not a silent substitution. */
export function requirementProblems(manifest: SetManifest, present: { framework?: string; imageDigest?: string }): Problem[] {
  const problems: Problem[] = [];

  if (present.framework !== undefined && present.framework !== manifest.requires.framework) {
    problems.push(
      problem(
        "SET_REQUIREMENT_UNMET",
        `the set requires framework ${manifest.requires.framework}, this one is ${present.framework}`,
      ),
    );
  }
  if (present.imageDigest !== undefined && present.imageDigest !== manifest.requires.image) {
    problems.push(
      problem(
        "SET_REQUIREMENT_UNMET",
        `the set requires image ${manifest.requires.image}, the instance runs ${present.imageDigest}`,
      ),
    );
  }
  return problems;
}

/** Runs `body` with an artifact unpacked, and removes the staging directory afterwards
 *  whatever happens — a half-installed set is bad enough without leaving its unpacked copy
 *  behind for someone to mistake for the deployment. */
export async function withUnpackedArtifact<T>(artifact: string, body: (staging: string, verified: VerifiedArtifact) => Promise<T>): Promise<T> {
  const { staging, verified } = await unpackArtifactVerified(artifact);
  log(`installing from ${artifact}`);
  try {
    return await body(staging, verified);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
