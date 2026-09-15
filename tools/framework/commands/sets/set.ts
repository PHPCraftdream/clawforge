// `./clawforge set build` — collect everything a deployment installs into ONE artifact.
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
//
// The group owns the set lifecycle commands; it fails explicitly on anything else
// rather than pretending it is there.

import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { log, info, warn, die } from "../../core/log.ts";
import { emit, isCaptured } from "../../core/output.ts";
import { parseEnv } from "../../core/env.ts";
import { safeName } from "../../core/names.ts";
import { spawnLocal } from "../../runtime/transport.ts";
import type { Context } from "../../core/context.ts";
import {
  deploymentDir,
  deploymentName,
  desiredStateFile,
  envFile,
  recipesDir,
  secretsDir,
  secretsTemplateFile,
} from "../../runtime/deployment.ts";
import { collectSecretRefs } from "../../service/secrets.ts";
import { validateSet, desiredStateShapeError } from "../../set/ownership/validate.ts";
import { checksumOf, checksumOfFileMap, recipeFileChecksums, agentBundleChecksums } from "../../service/checksums.ts";
import { frameworkVersion, readLock } from "../management/lock.ts";
import { parseAgentConfig, removeOwnedObject } from "../management/provision-agent.ts";
import type { AgentConfig } from "../management/provision-agent.ts";
import { takeLock, lockHeldHere } from "../../runtime/instance-lock.ts";
import { newOperationId } from "../../service/operations.ts";
import { setTry } from "./set-try.ts";
import { setDiff } from "./set-diff.ts";
import { setReceipts } from "./set-receipts.ts";
import { withUnpackedArtifact } from "../../set/artifacts/install.ts";
import { withSetSource } from "../../set/artifacts/source.ts";
import { loadChecks } from "../orchestration/accept.ts";
import type { AcceptanceCheck } from "../orchestration/accept.ts";
import { DESIRED_STATE_PATH, buildSetManifest, canonicalJson, setManifestId } from "../../set/artifacts/model.ts";
import type { SetManifest, SetRecipe } from "../../set/artifacts/model.ts";

/** What one build produced. The id is setManifestId(manifest); the artifact carries it in
 *  its file name, so two builds of unchanged content land on the same path. */
export interface SetBuild {
  readonly name: string;
  readonly id: string;
  readonly artifact: string;
  readonly manifest: SetManifest;
}

/** Every string anywhere in a value, however deep — what the value scan walks. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

// The same floor as log.ts's registerSecret: scanning for anything shorter than eight
// characters matches too much to mean anything — a two-letter "secret" sits inside some
// checksum's hex by chance, and the refusal would fire on every build.
const MIN_VALUE_LENGTH = 8;
const PUBLIC_ENV_SETTINGS = new Set([
  "OPENCLAW_IMAGE", "OPENCLAW_GATEWAY_PORT", "OPENCLAW_TZ", "OPENCLAW_DISABLE_BONJOUR",
  "OC_DATA_DIR", "OC_BACKUP_DIR", "OC_SNAPSHOT_DIR", "OC_BIND_ADDRESS", "OC_BACKUP_KEEP",
  "OC_SNAPSHOT_KEEP", "OC_TARGET_LOCATION", "OC_WSL_DISTRO", "OC_SSH_HOST", "OC_REMOTE_PATH",
  "OC_APP", "COMPOSE_PROJECT_NAME",
]);

/** Refuses to let a secret VALUE through into a manifest.
 *
 *  buildSetManifest cannot carry a value — the shape has no field for one — but a value
 *  could still arrive smuggled inside free text that enters the manifest verbatim: an
 *  acceptance check, an agent id, a file path. The manifest is meant to be committed and
 *  handed to another machine, so the build proves the negative before writing anything
 *  instead of trusting the shape: every value the deployment keeps locally (.env, the
 *  secrets/ stores) is searched for in the manifest. Exported so the check can feed it a
 *  doctored manifest and prove the scan fires — a guard that has never fired is a rubber
 *  stamp. */
export function assertNoSecretValues(manifest: SetManifest, values: { name: string; value: string }[]): void {
  const canonical = canonicalJson(manifest);
  const strings = stringsOf(manifest);
  for (const { name, value } of values) {
    if (value.length < MIN_VALUE_LENGTH) continue;
    if (!canonical.includes(value) && !strings.some((text) => text.includes(value))) continue;
    // The variable is named, never its value: this message goes to logs and transcripts.
    die(
      `refusing to write the set: the manifest carries the value of ${name} — ` +
        "a secret has leaked into recipe content, acceptance checks or agent declarations",
    );
  }
}

/** The values the scan searches for — and the ONLY thing .env and the secret stores are
 *  read for. They are input to a refusal check, never to the manifest: this result reaches
 *  assertNoSecretValues and nothing else. */
export async function localSecretValues(): Promise<{ name: string; value: string }[]> {
  const found: { name: string; value: string }[] = [];
  const collect = (source: string, env: Record<string, string>): void => {
    for (const [key, value] of Object.entries(env)) {
      if (source === ".env" && PUBLIC_ENV_SETTINGS.has(key)) continue;
      if (value !== "") found.push({ name: `${key} (${source})`, value });
    }
  };
  try {
    collect(".env", parseEnv(await readFile(envFile(), "utf8")));
  } catch {
    // A deployment before its first bootstrap has no .env yet — and no values to guard with.
  }
  try {
    for (const entry of await readdir(secretsDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".env")) continue;
      collect(`secrets/${entry.name}`, parseEnv(await readFile(resolve(secretsDir(), entry.name), "utf8")));
    }
  } catch {
    // No secret stores yet either.
  }
  return found;
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
 *  is already a digest reference is honoured directly — the operator pinned it by hand. */
async function requiredImage(image: string): Promise<string> {
  if (image.includes("@sha256:")) return image;
  const lock = await readLock();
  if (lock?.image.digest !== undefined) return lock.image.digest;
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
  try {
    return (await readdir(recipesDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Gathers the set, proves it carries no secret values, and writes the artifact. Exported so
 *  the checks drive exactly what the command runs. */
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
  const { root, manifest } = await collectManifest(ctx, setName);
  return writeArtifact(root, setName, manifest);
}

/** The manifest a build would write, without writing anything.
 *
 *  Split out so `validate` asks exactly the question `build` answers: a set that validates
 *  and a set that builds must be the same set, and two collectors would eventually make them
 *  different ones. */
export async function collectManifest(ctx: Context, setName: string): Promise<{ root: string; manifest: SetManifest }> {
  // The name becomes a file name under sets/ before buildSetManifest validates it.
  safeName("set", setName);
  const root = deploymentDir();

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

  return { root, manifest };
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
async function writeArtifact(root: string, setName: string, manifest: SetManifest): Promise<SetBuild> {
  const id = setManifestId(manifest);
  const secretValues = await localSecretValues();
  const staging = await mkdtemp(join(tmpdir(), "clawforge-set-"));
  try {
    // Pretty-printed on purpose: the id is computed by setManifestId over the canonical
    // form, so how this file happens to be formatted does not change what the set is.
    await writeFile(resolve(staging, "set.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    for (const [rel, sum] of Object.entries(manifest.files)) {
      const bytes = await readFile(resolve(root, ...rel.split("/")));
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
    // spawnLocal rather than the transport, and the distinction is easy backwards: the
    // transport interface reaches the TARGET the instance lives on, while a set is
    // assembled from files on THIS machine. Building a set through the transport would make
    // it depend on a target being reachable — the dependency this command must not have.
    // On Windows some tars (GNU tar from Git) read the drive letter in an absolute `-f`
    // path as a remote host spec; `--force-local` stops that, but the stock bsdtar does
    // not know the flag. Try the flag where it can be needed, and fall back without it.
    const forceLocal = process.platform === "win32" ? ["--force-local"] : [];
    let result = await spawnLocal("tar", [...forceLocal, "-czf", artifact, "-C", staging, "."], { allowFailure: true });
    if (result.code !== 0) {
      // Either the flag was unknown to this tar, or the tar failed for real: run once more
      // without the flag and let spawnLocal surface any failure the usual way.
      await spawnLocal("tar", ["-czf", artifact, "-C", staging, "."]);
    }
    return { name: setName, id, artifact, manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The manifest inside an artifact, without unpacking the rest of it.
 *
 *  `--force-local` on Windows for the same reason writeArtifact needs it, and it is worth
 *  saying twice: GNU tar reads the `D:` in an absolute path as a remote host and tries to
 *  connect. Writing already handled that; reading is a separate call and would have failed
 *  the same way — which is exactly how a platform quirk gets fixed on one side only. */
export async function readManifestFromArtifact(artifact: string): Promise<SetManifest> {
  const forceLocal = process.platform === "win32" ? ["--force-local"] : [];
  let result = await spawnLocal("tar", [...forceLocal, "-xzOf", artifact, "./set.json"], { allowFailure: true });
  if (result.code !== 0) {
    result = await spawnLocal("tar", ["-xzOf", artifact, "./set.json"], { allowFailure: true });
  }
  if (result.code !== 0) {
    die(`could not read a set manifest from ${artifact}: ${(result.stderr || result.stdout).trim()}`);
  }

  try {
    return JSON.parse(result.stdout) as SetManifest;
  } catch {
    die(`${artifact} contains a set.json that is not JSON — it is not an artifact this framework wrote`);
  }
}

/** `./clawforge set validate` — the same manifest `build` would produce, or one read back out of an
 *  artifact, put through every check that needs no gateway.
 *
 *  Validating the working tree also checks the files are there; validating an artifact does
 *  not, and must not: an artifact carries its content as checksums, and looking for those
 *  paths on whichever machine happens to be reading it would report a perfectly good set as
 *  broken everywhere except where it was built. */
async function validateAction(
  ctx: Context,
  options: { name?: string; artifact?: string; jsonOnly: boolean },
): Promise<void> {
  const fromArtifact = options.artifact !== undefined;
  if (fromArtifact) {
    return withUnpackedArtifact(options.artifact!, (staging, verified) => withSetSource(staging, async () => {
      if (options.jsonOnly || isCaptured()) {
        emit(`${JSON.stringify({set:verified.manifest.name,id:verified.id,source:options.artifact,valid:true,problems:[],nextActions:[]},null,2)}\n`);
      } else {
        log(`set ${verified.manifest.name} (${verified.id}) is coherent and its artifact contents match`);
      }
    }));
  }
  const manifest = fromArtifact
    ? await readManifestFromArtifact(options.artifact!)
    : (await collectManifest(ctx, options.name ?? defaultSetName(deploymentName()))).manifest;

  const problems = await validateSet(manifest, { checkFiles: !fromArtifact });
  const blocking = problems.filter((entry) => entry.severity === "blocking");

  if (options.jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          set: manifest.name,
          source: fromArtifact ? options.artifact : "working tree",
          valid: blocking.length === 0,
          problems,
          nextActions: [...new Set(problems.map((entry) => entry.nextAction))],
        },
        null,
        2,
      )}\n`,
    );
  } else if (problems.length === 0) {
    log(`set ${manifest.name} is coherent`);
    info(`${Object.keys(manifest.recipes).length} recipe(s), ${manifest.secrets.length} secret name(s)`);
    info("checked without a gateway; whether the pinned image supports what the recipes use is settled at install");
  } else {
    log(`set ${manifest.name}: ${blocking.length} blocking, ${problems.length - blocking.length} warning(s)`);
    for (const entry of problems) {
      warn(`${entry.code}  ${entry.detail}`);
      info(`  → ${entry.nextAction}`);
    }
  }

  if (blocking.length > 0) {
    throw new Error(`${blocking.length} blocking finding(s): ${blocking.map((entry) => entry.code).join(", ")}`);
  }
}

/** `./clawforge set forget --kind <kind> --name <name>` — removes an object this framework created
 *  and stops tracking it. The same operation `./clawforge apply` runs on its own for an orphaned MCP
 *  server or cron job; exposed by hand for the case `apply` never performs on its own — an
 *  orphaned agent, whose removal prunes a workspace and its memory, which stays a decision
 *  for whoever runs this rather than something a plan carries out automatically. */
async function forgetAction(ctx: Context, kindRaw: string | undefined, name: string | undefined, breakLock: boolean): Promise<void> {
  if (kindRaw === undefined || name === undefined) die("usage: ./clawforge set forget --kind <agent|mcp-server|cron-job> --name <name>");
  if (kindRaw !== "agent" && kindRaw !== "mcp-server" && kindRaw !== "cron-job") {
    die(`unknown kind "${kindRaw}" (expected agent, mcp-server, or cron-job)`);
  }
  if (!(await ctx.runtime.isRunning())) die("the gateway is not running. Start it with ./clawforge up");

  // `apply` calls this indirectly while already holding the lock; nested, the second acquire
  // would refuse the run its own caller started. Taken only when this is invoked directly.
  const held = lockHeldHere() ? undefined : await takeLock(ctx, `set forget ${kindRaw} ${name}`, newOperationId("set-forget"), { breakLock });
  try {
    await removeOwnedObject(ctx, kindRaw, name);
  } finally {
    await held?.release();
  }
  log(`${kindRaw} "${name}" removed and no longer tracked as owned`);
}

export async function set(ctx: Context, args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "diff") return setDiff(ctx, rest);
  if (action === "receipts") return setReceipts(ctx, rest);

  // No default action, and no pretending: with one subcommand, an unknown one fails naming
  // what exists rather than hinting at a surface that is not there yet.
  if (action === undefined) die("usage: ./clawforge set <build|validate|diff|receipts|try|forget> [options]");
  if (action !== "build" && action !== "validate" && action !== "try" && action !== "forget") {
    die(`unknown action: ${action} (expected build, validate, diff, receipts, try, or forget)`);
  }

  // try has its own argument shape (--with-model, --keep) that the flags shared by the
  // other actions below do not carry — parsed there, not folded into the loop that follows.
  if (action === "try") {
    await setTry(ctx, rest);
    return;
  }

  let name: string | undefined;
  let kind: string | undefined;
  let artifact: string | undefined;
  let jsonOnly = false;
  let breakLock = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--name") {
      name = rest[index + 1] ?? die("--name needs a value");
      index += 1;
    } else if (arg === "--kind") {
      kind = rest[index + 1] ?? die("--kind needs a value");
      index += 1;
    } else if (arg === "--set") {
      artifact = rest[index + 1] ?? die("--set needs an artifact path");
      index += 1;
    } else if (arg === "--break-lock") {
      breakLock = true;
    } else if (arg === "--json") {
      jsonOnly = true;
    } else {
      die(`unknown argument: ${arg}`);
    }
  }

  if (action === "forget") {
    await forgetAction(ctx, kind, name, breakLock);
    return;
  }

  if (action === "validate") {
    await validateAction(ctx, { name, artifact, jsonOnly });
    return;
  }
  if (artifact !== undefined) die("--set validates an existing artifact; it has no meaning for build");

  const built = await buildSet(ctx, name ?? defaultSetName(deploymentName()));

  // Same split as lock: --json or a captured caller gets the machine-readable answer;
  // a terminal gets the inventory, because an artifact whose contents can only be
  // discovered by unpacking it is one nobody will trust.
  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify({ name: built.name, id: built.id, artifact: built.artifact, manifest: built.manifest }, null, 2)}\n`,
    );
    return;
  }

  log(`built set ${built.name} (${Object.keys(built.manifest.files).length} file(s))`);
  info(`id        ${built.id}`);
  info(`artifact  ${built.artifact}`);
  info(`requires  framework ${built.manifest.requires.framework}, image ${built.manifest.requires.image}`);

  const names = Object.keys(built.manifest.recipes);
  info(`recipes   ${names.length === 0 ? "(none)" : names.join(", ")}`);
  for (const [recipe, entry] of Object.entries(built.manifest.recipes)) {
    info(
      `${recipe.padEnd(16)} ${Object.keys(entry.files).length} file(s) served, ` +
        `${Object.keys(entry.agentFiles ?? {}).length} in the agent bundle`,
    );
    const agent = entry.agent;
    if (agent !== undefined) {
      const cron = agent.cronJobName === undefined ? "no cron job" : `cron ${agent.cronJobName} at ${agent.cronSchedule}`;
      info(`${"".padEnd(16)} agent ${agent.agentId} (mcp server ${agent.mcpServerName}), ${cron}`);
    }
    const checks = built.manifest.acceptance[recipe];
    if (checks !== undefined) info(`${"".padEnd(16)} ${checks.length} acceptance check(s)`);
  }

  info(`secrets   ${built.manifest.secrets.length === 0 ? "(none)" : built.manifest.secrets.join(", ")}`);
  info("names only — values stay on the machine that has them");
}
