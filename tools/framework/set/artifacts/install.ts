// Installing from an artifact rather than from the working tree's current files.
//
// One engine, two sources: plan/apply keep their existing rules (ordering, journal,
// instance lock, confirming inspection) and only "what does this deployment declare"
// changes — from an unpacked artifact instead of disk. Records the installed set's id on
// the target afterwards, so later questions (has it drifted, what would rollback mean)
// have somewhere to start.

import { copyFile, lstat, mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { die, log } from "#src/core/io/log.ts";
import { spawnLocal } from "#src/runtime/transport/transport.ts";
import { deploymentDir } from "#src/runtime/deployment.ts";
import { checksumOf, checksumOfFileMap } from "#src/service/checksums.ts";
import { parseAgentConfig } from "#src/commands/management/provision-agent/index.ts";
import { acceptanceSpecError } from "#src/commands/orchestration/accept.ts";
import { safeName } from "#src/core/values/names.ts";
import { problem } from "#src/service/inspection.ts";
import { writeFileAtomic } from "#src/set/ownership/ledger.ts";
import { validateSet } from "#src/set/ownership/validate.ts";
import { readFileCandidate } from "#src/set/ownership/candidate-file.ts";
import { withSetSource } from "./source.ts";
import type { Problem } from "#src/service/inspection.ts";
import type { Context } from "#src/core/context.ts";
import { DESIRED_STATE_PATH, SET_MANIFEST_VERSION, setManifestId, canonicalJson } from "./model.ts";
import type { SetManifest } from "./model.ts";
import { renameOverPrivateFile } from "#src/security/privacy/private-file.ts";

/** What was installed immediately before the current set — one level, not a stack, same
 *  depth `rollback`'s single-file path already works at. */
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
   *  the artifact present — the machine that installed it may be long gone. */
  readonly requires: SetManifest["requires"];
  /** The apply operation that installed this set. Its configSnapshot (operations.ts), when
   *  taken, is the configuration exactly as the PREVIOUS set left it — what `rollback
   *  --previous-set` needs. Absent for a pre-existing record or when no operation id was available. */
  readonly operationId?: string;
  /** The set this one replaced, so a rollback has somewhere to go back to. Absent for the
   *  first set ever installed on this instance. */
  readonly previous?: PreviousSet;
}

export function installedSetFile(ctx: Context): string {
  return `${ctx.settings.dataDir}/clawforge-installed-set.json`;
}

function legacyInstalledSetFile(ctx: Context): string {
  return `${ctx.settings.dataDir}/cf-installed-set.json`;
}

function legacyInstalledSetFiles(ctx: Context): string[] {
  return [
    `${ctx.settings.dataDir}/oc-installed-set.json`,
    legacyInstalledSetFile(ctx),
  ];
}

type InstalledSetParseResult = { readonly ok: true; readonly set: InstalledSet } | { readonly ok: false };

/** Pure parse+validate, shared by the tolerant reader (readInstalledSet) and the strict one
 *  (readInstalledSetStrict): only difference is what each does with `ok: false` — tolerant
 *  treats it as "nothing installed", strict refuses. */
function parseInstalledSetResult(text: string): InstalledSetParseResult {
  try {
    const parsed = JSON.parse(text) as InstalledSet;
    if (!isSetId(parsed.id) || typeof parsed.name !== "string") return { ok: false };
    safeName("set", parsed.name);
    if (parsed.previous !== undefined && (!isSetId(parsed.previous.id) || typeof parsed.previous.name !== "string")) return { ok: false };
    if (parsed.previous !== undefined) safeName("set", parsed.previous.name);
    return { ok: true, set: parsed };
  } catch {
    return { ok: false };
  }
}

function parseInstalledSet(text: string | undefined): InstalledSet | undefined {
  if (text === undefined) return undefined;
  const result = parseInstalledSetResult(text);
  return result.ok ? result.set : undefined;
}

export async function readInstalledSet(ctx: Context): Promise<InstalledSet | undefined> {
  const primary = await readFileCandidate(ctx, installedSetFile(ctx));
  if (primary.present) return parseInstalledSet(primary.text);
  for (const path of legacyInstalledSetFiles(ctx)) {
    const candidate = await readFileCandidate(ctx, path);
    if (candidate.present) return parseInstalledSet(candidate.text);
  }
  return undefined;
}

/** Thrown by readInstalledSetStrict() when the installed-set marker is PRESENT but unreadable
 *  or fails validation — bytes exist that this process cannot prove are safe to discard. */
export class InstalledSetUnreadableError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `${path} exists but could not be read as a valid installed-set marker. Recording a newly installed ` +
        "set here would silently overwrite it, discarding the rollback chain (the \"previous\" set) it " +
        `carries — the bytes at ${path} have not been touched. Repair or restore this file, or import a ` +
        "known-good marker, before installing.",
    );
    this.name = "InstalledSetUnreadableError";
    this.path = path;
  }
}

/** Like readInstalledSet(), but for recordInstalledSet() below, about to WRITE a
 *  replacement marker: a marker PRESENT but unreadable/invalid must stop the caller rather
 *  than read as "nothing installed" — that would permanently lose the rollback chain the
 *  moment the write lands. A legitimately absent file still reads as "nothing installed". */
export async function readInstalledSetStrict(ctx: Context): Promise<InstalledSet | undefined> {
  const primary = await readFileCandidate(ctx, installedSetFile(ctx));
  if (primary.present) {
    const result = primary.text === undefined ? { ok: false as const } : parseInstalledSetResult(primary.text);
    if (!result.ok) throw new InstalledSetUnreadableError(installedSetFile(ctx));
    return result.set;
  }
  for (const path of legacyInstalledSetFiles(ctx)) {
    const candidate = await readFileCandidate(ctx, path);
    if (candidate.present) {
      const result = candidate.text === undefined ? { ok: false as const } : parseInstalledSetResult(candidate.text);
      if (!result.ok) throw new InstalledSetUnreadableError(path);
      return result.set;
    }
  }
  return undefined;
}

function isSetId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Records the set just installed, carrying the one it replaced forward as `previous`.
 *  Re-recording the SAME id (apply re-run against a set already in force) must not
 *  overwrite `previous` with the set itself — that would make rollback undo nothing. An
 *  existing `previous` also survives a no-op apply for the same reason. */
export async function recordInstalledSet(ctx: Context, manifest: SetManifest, id: string, operationId?: string): Promise<void> {
  if (!isSetId(id) || id !== setManifestId(manifest)) {
    throw new Error("refusing to record an installed set whose id does not match its manifest");
  }
  safeName("set", manifest.name);
  const current = await readInstalledSetStrict(ctx);
  const sameSet = current !== undefined && current.id === id;
  const previous: PreviousSet | undefined = current === undefined || sameSet
    ? current?.previous
    : { id: current.id, name: current.name, installedAt: current.installedAt };
  // A no-op re-apply of the SAME set (nothing changed, so applyFromSource() never opened a
  // Journal or took a snapshot for this operationId) must not overwrite the id that
  // actually installed it — rollback --previous-set reads this to find the snapshot to restore from.
  const effectiveOperationId = sameSet ? current.operationId : operationId;

  const record: InstalledSet = {
    id,
    name: manifest.name,
    installedAt: new Date().toISOString(),
    requires: manifest.requires,
    ...(effectiveOperationId === undefined ? {} : { operationId: effectiveOperationId }),
    ...(previous === undefined ? {} : { previous }),
  };
  await writeFileAtomic(ctx, installedSetFile(ctx), `${JSON.stringify(record, null, 2)}\n`);
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

/** Verifies archive structure, extracts only after that verification, then verifies every
 *  byte. With `collectFindings`, blocking semantic findings come back instead of throwing —
 *  the read-only path (validate --set, set diff) reports them; installers stay strict. */
async function verifyArtifact(artifact: string, staging: string, options: { collectFindings?: boolean } = {}): Promise<VerifiedArtifact & { problems?: Problem[] }> {
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
  // The artifact is unpacked into staging and recipesDir() points there, so the same
  // recipe-completeness checks the working-tree validation runs can run here: a tree with
  // blocking findings must not build into an artifact that verifies as coherent.
  const semanticProblems = await withSetSource(staging, () => validateSet(manifest, { checkFiles: true }));
  const blocking = semanticProblems.filter((entry) => entry.severity === "blocking");
  if (blocking.length > 0 && options.collectFindings !== true) {
    throw new Error(`artifact set is not coherent: ${coherenceSummary(blocking)}`);
  }
  return options.collectFindings === true
    ? { manifest, id: setManifestId(manifest), problems: semanticProblems }
    : { manifest, id: setManifestId(manifest) };
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

/** Keeps a validated artifact in the deployment so rollback does not depend on its original
 *  path still existing. The copy is complete before apply is allowed to mutate the target. */
export async function storeArtifactForRollback(artifact: string, verified: VerifiedArtifact): Promise<string> {
  safeName("set", verified.manifest.name);
  if (!isSetId(verified.id)) throw new Error("refusing to store an artifact with an invalid content id");
  const directory = resolve(deploymentDir(), "sets");
  await mkdir(directory, { recursive: true });
  const destination = resolve(directory, `${verified.manifest.name}-${verified.id}.tar.gz`);
  if (await fileExists(destination)) {
    await withUnpackedArtifact(destination, async (_staging, cached) => {
      if (cached.id !== verified.id) throw new Error("cached rollback artifact has a different content id");
    }, `storing a rollback copy of ${destination}`);
    return destination;
  }
  const temporary = resolve(directory, `.clawforge-artifact-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await copyFile(artifact, temporary);
    await withUnpackedArtifact(temporary, async (_staging, copied) => {
      if (copied.id !== verified.id) throw new Error("artifact changed before it could be stored for rollback");
    }, `storing a rollback copy of ${artifact}`);
    await renameOverPrivateFile(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

async function fileExists(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

/** Unpacks an artifact into a temp directory and hands back where it went. `--force-local`
 *  on Windows: GNU tar reads the `D:` of an absolute path as a remote host and tries to
 *  connect — same quirk the writing side handles. */
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

/** Read-only unpack for inspection — validate --set and set diff. Integrity still refuses
 *  (a corrupt archive is not a set), but blocking semantic findings come back instead of
 *  dying inside the gate, so the caller reports them through its own report/JSON path and
 *  an MCP client sees the problems rather than "error, no problems" (R32-05). */
export async function withArtifactInspected<T>(
  artifact: string,
  body: (staging: string, verified: VerifiedArtifact, problems: readonly Problem[]) => Promise<T>,
): Promise<T> {
  const staging = await mkdtemp(join(tmpdir(), "clawforge-set-inspect-"));
  let verified: VerifiedArtifact & { problems?: Problem[] };
  try {
    verified = await verifyArtifact(artifact, staging, { collectFindings: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    die(`${artifact} is not a valid set artifact: ${(error as Error).message}`);
  }
  try {
    // The caller's own failures (a blocking report, a diff that throws) propagate unwrapped:
    // wrapping them blames the artifact being read — in a nested `set diff`, the good one —
    // and turns validate's "N blocking finding(s)" into integrity wording (R33-03).
    return await body(staging, verified, verified.problems ?? []);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The digest of the image the CONTAINER actually runs, not what a tag currently resolves
 *  to — ctx.runtime.imageReference() reports the newly-pulled digest after a `docker pull`
 *  even when the running container was never recreated. Same primitive (matching by hash
 *  suffix, since digests can carry more than one repo/tag form) evidence.ts's
 *  observeRuntime() uses. Exported so gather.ts's two uses (the SET_REQUIREMENT_UNMET match
 *  and observed.imageDigest) fetch the runtime identity once rather than twice. */
export async function runningDigests(ctx: Context): Promise<string[]> {
  const running = await ctx.runtime.runningImageIdentity?.();
  return running?.digests ?? [];
}

/** Pure: which fetched digest matches what the manifest requires, or the first one when
 *  none does. Split out so a caller already holding a runningDigests() result can reuse it. */
export function matchRequiredDigest(digests: string[], manifest: SetManifest): string | undefined {
  const requiredHash = manifest.requires.image.split("@").at(-1);
  return digests.find((digest) => digest.split("@").at(-1) === requiredHash) ?? digests[0];
}

export async function runningImageDigest(ctx: Context, manifest: SetManifest): Promise<string | undefined> {
  return matchRequiredDigest(await runningDigests(ctx), manifest);
}

/** Whether this machine can install what the set requires. Reported, not enforced by
 *  refusal: an older framework may still install correctly, and the reader decides — what
 *  must not happen is the mismatch going unmentioned. */
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
  // By hash suffix, not the full string: matchRequiredDigest() already matches the running
  // digest by SHA-256 hash alone so a mirrored image (different registry) still counts as
  // the same image, per runtimeMatches() (evidence.ts). Comparing the full string undid that.
  if (present.imageDigest !== undefined && present.imageDigest.split("@").at(-1) !== manifest.requires.image.split("@").at(-1)) {
    problems.push(
      problem(
        "SET_REQUIREMENT_UNMET",
        `the set requires image ${manifest.requires.image}, the instance runs ${present.imageDigest}`,
      ),
    );
  }
  return problems;
}

/** Runs `body` with an artifact unpacked, removing the staging directory afterwards
 *  whatever happens — a half-installed set left unpacked invites confusion with the deployment.
 *  The line after verification is the caller's: validate reads an artifact it will not install,
 *  so the default note is "checking" — pass "installing from …" where the caller installs. */
export async function withUnpackedArtifact<T>(
  artifact: string,
  body: (staging: string, verified: VerifiedArtifact) => Promise<T>,
  note = `checking ${artifact}`,
): Promise<T> {
  const { staging, verified } = await unpackArtifactVerified(artifact);
  log(note);
  try {
    return await body(staging, verified);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
