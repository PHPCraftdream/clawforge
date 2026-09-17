// `./clawforge set build`, driven against a real temporary deployment.
//
// The set's whole value is that its id means something and its contents are safe to hand to
// another machine, so this proves exactly that: an unchanged tree builds to the same id, one
// changed byte moves the id, no secret value from the deployment appears anywhere in the
// manifest — and the scan that enforces that is provably able to fire — and the artifact on
// disk is a real archive carrying exactly the files the manifest lists.
//
// The collection runs for real against real files. The one thing stubbed is the context's
// transport and runtime, which THROW on any use: a set must build with no running instance
// and no reachable target, and a stub that politely answers would let that rule erode
// silently.

import { mkdtemp, mkdir, readdir, writeFile, rm, rmdir, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { absentRecipesSource, buildSet, set, assertNoSecretValues, withTarRunner } from "#framework/commands/sets/set.ts";
import { unpackArtifactVerified } from "#framework/set/artifacts/install.ts";
import { withSetSource } from "#framework/set/artifacts/source.ts";
import { DESIRED_STATE_PATH, setManifestId, canonicalJson } from "#framework/set/artifacts/model.ts";
import type { SetManifest } from "#framework/set/artifacts/model.ts";
import { checksumOf, checksumOfFileMap } from "#framework/service/checksums.ts";
import { useApplicationRecipesDir, useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { spawnLocal } from "#framework/runtime/transport.ts";
import type { ExecOptions, ExecResult } from "#framework/runtime/transport.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

/** Every string anywhere in a value, however deep. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

function refuse(what: string): () => never {
  return () => {
    throw new Error(`set build used the target ${what} — a set must build with no instance and no reachable target`);
  };
}

const ctx = {
  settings: { image: "ghcr.io/openclaw/openclaw:extended-stable" },
  transport: new Proxy({}, { get: (_target, property) => refuse(`transport.${String(property)}`) }),
  runtime: new Proxy({}, { get: (_target, property) => refuse(`runtime.${String(property)}`) }),
} as unknown as Context;

// Values that exist only on this fake machine. They must never appear in a manifest — and
// the assertions below also prove the guard itself can fire when one does.
const TOKEN = "tok-live-example-1234567890";
const STORE_KEY = "sk-demo-9999-not-a-real-key";
const DIGEST = `ghcr.io/openclaw/openclaw@sha256:${"3".repeat(64)}`;

const deployment = await mkdtemp(join(tmpdir(), "clawforge-set-build-check-"));

try {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  await mkdir(resolve(deployment, "recipes", "demo", "agent"), { recursive: true });
  await mkdir(resolve(deployment, "recipes", "demo", "data"), { recursive: true });
  await mkdir(resolve(deployment, "recipes", "plain"), { recursive: true });
  await mkdir(resolve(deployment, "secrets"), { recursive: true });

  await writeFile(
    resolve(deployment, "config", "desired-state.json"),
    JSON.stringify([
      { path: "gateway.mode", value: "local" },
      // The SecretRef the set's secret names are derived from: it travels in the set,
      // unlike the live openclaw.json on a target.
      { path: "gateway.auth.token", value: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } },
    ]),
  );
  await writeFile(resolve(deployment, ".env"), `OPENCLAW_GATEWAY_TOKEN=${TOKEN}\nOTHER_SETTING=some-value\n`);
  await writeFile(resolve(deployment, "secrets", "prod.env"), `ZAI_API_KEY=${STORE_KEY}\n`);
  // The digest the build pins, written through the same file `./clawforge lock` writes, so the
  // fixture and the command cannot disagree about where the digest lives.
  await writeFile(
    resolve(deployment, "config", "deployment.lock.json"),
    JSON.stringify({
      version: 1,
      deployment: "set-build-check",
      generatedAt: "2026-01-01T00:00:00.000Z",
      image: { reference: "ghcr.io/openclaw/openclaw:extended-stable", digest: DIGEST },
      recipes: {},
      secrets: [],
    }),
  );

  // demo: a full recipe — served content, an agent bundle with a cron schedule, acceptance checks.
  await writeFile(resolve(deployment, "recipes", "demo", "recipe.json"), JSON.stringify({ description: "example recipe" }));
  await writeFile(resolve(deployment, "recipes", "demo", "compose.yml"), "services: {}\n");
  await writeFile(resolve(deployment, "recipes", "demo", "server.ts"), "// example mcp server\n");
  await writeFile(resolve(deployment, "recipes", "demo", "data", "page.md"), "# example page\n");
  await writeFile(
    resolve(deployment, "recipes", "demo", "agent", "config.json"),
    JSON.stringify({ agentId: "demo-agent", mcpServerName: "demo-mcp", cronJobName: "demo-refresh", cronSchedule: "17 3 * * *" }),
  );
  await writeFile(resolve(deployment, "recipes", "demo", "agent", "AGENTS.md"), "# the agent's instructions\n");
  await writeFile(
    resolve(deployment, "recipes", "demo", "acceptance.json"),
    JSON.stringify({
      checks: [{ kind: "mcp_responds" }, { kind: "agent_answers", usesModel: true, agent: "demo-agent", message: "hello" }],
    }),
  );
  // plain: a service with no agent bundle and no acceptance checks.
  await writeFile(resolve(deployment, "recipes", "plain", "recipe.json"), JSON.stringify({ description: "plain service" }));
  await writeFile(resolve(deployment, "recipes", "plain", "compose.yml"), "services: {}\n");

  useDeployment(deployment);

  // --- ids: stable when the tree is, moved by one byte --------------------------------------

  const first = await buildSet(ctx, "demo-set");
  const second = await buildSet(ctx, "demo-set");
  check("building twice from an unchanged tree gives the same id", second.id, first.id);
  check("the id is a sha256 digest", /^[0-9a-f]{64}$/.test(first.id), true);
  check("the id is the manifest's own content id", first.id, setManifestId(first.manifest));
  check(
    "the artifact lands in the deployment's sets/ directory, named by set and id",
    first.artifact,
    resolve(deployment, "sets", `demo-set-${first.id}.tar.gz`),
  );
  check("the required image is the lock's digest, not the tag", first.manifest.requires.image, DIGEST);
  check(
    "the required framework version is pinned",
    typeof first.manifest.requires.framework === "string" && first.manifest.requires.framework !== "",
    true,
  );

  // --- the manifest inventories every file, with a checksum ----------------------------------

  const expectedFiles = [
    DESIRED_STATE_PATH,
    "recipes/demo/recipe.json",
    "recipes/demo/compose.yml",
    "recipes/demo/server.ts",
    "recipes/demo/data/page.md",
    "recipes/demo/agent/config.json",
    "recipes/demo/agent/AGENTS.md",
    "recipes/demo/acceptance.json",
    "recipes/plain/recipe.json",
    "recipes/plain/compose.yml",
  ];
  check("every file the deployment installs is listed", expectedFiles.every((rel) => rel in first.manifest.files), true);
  let allChecksumsMatch = true;
  for (const [rel, sum] of Object.entries(first.manifest.files)) {
    if (checksumOf(await readFile(resolve(deployment, ...rel.split("/")))) !== sum) allChecksumsMatch = false;
  }
  check("every listed checksum matches the file on disk", allChecksumsMatch, true);
  check(
    "config/desired-state.json is checksummed into the manifest",
    first.manifest.files[DESIRED_STATE_PATH],
    checksumOf(await readFile(resolve(deployment, "config", "desired-state.json"), "utf8")),
  );

  // --- the agent bundle is its own record ------------------------------------------------------

  check("the served side excludes agent/", "recipes/demo/agent/AGENTS.md" in first.manifest.recipes.demo.files, false);
  check(
    "the agent bundle carries its own files and its own checksum",
    first.manifest.recipes.demo.agentFiles !== undefined &&
      Object.keys(first.manifest.recipes.demo.agentFiles).length === 2 &&
      first.manifest.recipes.demo.agentChecksum === checksumOfFileMap(first.manifest.recipes.demo.agentFiles ?? {}),
    true,
  );
  check("the agent declaration is carried with defaults applied", first.manifest.recipes.demo.agent?.agentId, "demo-agent");
  check("a plain recipe records no agent bundle", first.manifest.recipes.plain.agentChecksum, undefined);
  check("the acceptance checks travel as declared", (first.manifest.acceptance.demo ?? []).length, 2);
  check("a recipe without checks is absent from acceptance", "plain" in first.manifest.acceptance, false);

  // --- secrets: names travel, values never ------------------------------------------------------

  check("secret names come from the declaration, not a live instance", first.manifest.secrets.includes("OPENCLAW_GATEWAY_TOKEN"), true);
  const canonical = canonicalJson(first.manifest);
  check("the .env value appears nowhere in the manifest", canonical.includes(TOKEN), false);
  check("the secret-store value appears nowhere in the manifest", canonical.includes(STORE_KEY), false);
  check(
    "nor in any string of the manifest",
    stringsOf(first.manifest).some((text) => text.includes(TOKEN) || text.includes(STORE_KEY)),
    false,
  );

  // The scan must be able to fire, or every green result above is a rubber stamp.
  let scanFires = false;
  try {
    assertNoSecretValues(
      { ...first.manifest, secrets: [...first.manifest.secrets, TOKEN] },
      [{ name: "OPENCLAW_GATEWAY_TOKEN", value: TOKEN }],
    );
  } catch {
    scanFires = true;
  }
  check("the value scan refuses a manifest that carries a secret value", scanFires, true);
  let scanReachesFreeText = false;
  try {
    assertNoSecretValues(
      { ...first.manifest, acceptance: { demo: [{ kind: "mcp_responds", token: STORE_KEY }] } },
      [{ name: "ZAI_API_KEY", value: STORE_KEY }],
    );
  } catch {
    scanReachesFreeText = true;
  }
  check("the scan reaches free text like acceptance checks", scanReachesFreeText, true);

  // --- --json: the machine-readable answer --------------------------------------------------------

  let captured = "";
  await withOutputSink(
    (chunk) => {
      captured += chunk;
    },
    () => set(ctx, ["build", "--name", "demo-set", "--json"]),
  );
  const emitted = JSON.parse(captured) as { id: string; artifact: string; manifest: SetManifest };
  check("--json emits the id", emitted.id, first.id);
  check("--json emits the whole manifest", emitted.manifest, first.manifest);

  // --- one changed byte moves the id, and both versions stay in the store ------------------------

  await writeFile(resolve(deployment, "recipes", "demo", "data", "page.md"), "# example page?\n");
  const changed = await buildSet(ctx, "demo-set");
  check("changing one byte of one recipe file changes the id", changed.id !== first.id, true);
  check("the changed build lands beside the old one, not over it", changed.artifact !== first.artifact, true);
  const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);
  check("both versions are kept in the store", (await exists(first.artifact)) && (await exists(changed.artifact)), true);

  // --- the artifact is a real archive ---------------------------------------------------------------

  // On Windows some tars (GNU tar from Git) read the drive letter in an absolute path as a
  // remote host spec; --force-local stops that, but tars that know drive letters reject the
  // flag, so try the flagged form and fall back to the plain one.
  const tarList = async (path: string): Promise<string> => {
    let result = await spawnLocal("tar", process.platform === "win32" ? ["--force-local", "-tzf", path] : ["-tzf", path], { allowFailure: true });
    if (result.code !== 0) result = await spawnLocal("tar", ["-tzf", path]);
    return result.stdout;
  };
  const listing = await tarList(first.artifact);
  const entries = listing
    .split("\n")
    .map((line) => line.replace(/^\.\//, "").trim())
    .filter((line) => line !== "");
  const lists = (rel: string): boolean => entries.includes(rel);
  check("the archive lists the manifest", lists("set.json"), true);
  check("the archive carries the declaration", lists(DESIRED_STATE_PATH), true);
  check("the archive carries served content", lists("recipes/demo/server.ts") && lists("recipes/plain/compose.yml"), true);
  check("the archive carries the agent bundle", lists("recipes/demo/agent/AGENTS.md"), true);
  check("no .env and no secret store travels", entries.some((entry) => entry.includes(".env") || entry.startsWith("secrets/")), false);

  const unpacked = await mkdtemp(join(tmpdir(), "clawforge-set-unpack-"));
  try {
    let extract = await spawnLocal("tar", process.platform === "win32" ? ["--force-local", "-xzf", first.artifact, "-C", unpacked] : ["-xzf", first.artifact, "-C", unpacked], { allowFailure: true });
    if (extract.code !== 0) await spawnLocal("tar", ["-xzf", first.artifact, "-C", unpacked]);
    const fromArchive = JSON.parse(await readFile(resolve(unpacked, "set.json"), "utf8")) as SetManifest;
    check("the manifest inside the archive yields the same id", setManifestId(fromArchive), first.id);
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }

  // An application can keep recipes outside its deployment. The archive keys stay portable,
  // while the builder must read bytes from that configured source rather than a stale local
  // recipes/ directory.
  const externalRecipes = await mkdtemp(join(tmpdir(), "clawforge-set-external-recipes-"));
  const binaryAsset = Uint8Array.from([0, 255, 1, 254, 128, 13, 10]);
  try {
    await mkdir(resolve(externalRecipes, "demo"), { recursive: true });
    await writeFile(resolve(externalRecipes, "demo", "recipe.json"), JSON.stringify({ description: "external demo recipe" }));
    await writeFile(resolve(externalRecipes, "demo", "compose.yml"), "services: {}\n");
    await writeFile(resolve(externalRecipes, "demo", "server.ts"), "// external source\n");
    await writeFile(resolve(externalRecipes, "demo", "asset.bin"), binaryAsset);
    useApplicationRecipesDir(externalRecipes);
    const external = await buildSet(ctx, "external-set");
    check("custom recipesDir inventories the configured recipe", "recipes/demo/asset.bin" in external.manifest.files, true);
    await rm(externalRecipes, { recursive: true, force: true });
    const { staging: externalUnpacked, verified: externalVerified } = await unpackArtifactVerified(external.artifact);
    try {
      check("custom artifact passes full verification", externalVerified.id, external.id);
      check("custom artifact contains the configured binary bytes", [...(await readFile(resolve(externalUnpacked, "recipes", "demo", "asset.bin")))], [...binaryAsset]);
      check("custom artifact uses the configured source over stale deployment files", await readFile(resolve(externalUnpacked, "recipes", "demo", "server.ts"), "utf8"), "// external source\n");
    } finally {
      await rm(externalUnpacked, { recursive: true, force: true });
    }
  } finally {
    useApplicationRecipesDir(undefined);
    await rm(externalRecipes, { recursive: true, force: true });
  }

  // A relative application root is resolved against the deployment, while the archive keeps
  // the same portable recipe paths.
  const relativeRecipes = "relative-recipes";
  await mkdir(resolve(deployment, relativeRecipes, "relative"), { recursive: true });
  await writeFile(resolve(deployment, relativeRecipes, "relative", "recipe.json"), JSON.stringify({ description: "relative recipe" }));
  await writeFile(resolve(deployment, relativeRecipes, "relative", "compose.yml"), "services: {}\n");
  useApplicationRecipesDir(relativeRecipes);
  try {
    const relative = await buildSet(ctx, "relative-set");
    check("relative custom recipesDir is resolved from deployment", "recipes/relative/compose.yml" in relative.manifest.files, true);
  } finally {
    useApplicationRecipesDir(undefined);
  }

  // With an artifact source active, both the declaration and recipes come from that source,
  // while the resulting archive is still stored in the deployment's sets/ directory.
  const sourceRoot = await mkdtemp(join(tmpdir(), "clawforge-set-source-"));
  try {
    const sourceDeclaration = JSON.stringify([{ path: "gateway.mode", value: "remote" }]);
    await mkdir(resolve(sourceRoot, "config"), { recursive: true });
    await mkdir(resolve(sourceRoot, "recipes", "source"), { recursive: true });
    await writeFile(resolve(sourceRoot, "config", "desired-state.json"), sourceDeclaration);
    await writeFile(resolve(sourceRoot, "recipes", "source", "recipe.json"), JSON.stringify({ description: "set source recipe" }));
    await writeFile(resolve(sourceRoot, "recipes", "source", "compose.yml"), "services: {}\n");
    const fromSource = await withSetSource(sourceRoot, () => buildSet(ctx, "source-set"));
    check("set source declaration is copied from the active source", fromSource.manifest.files[DESIRED_STATE_PATH], checksumOf(sourceDeclaration));
    check("set source recipes are copied from the active source", "recipes/source/compose.yml" in fromSource.manifest.files, true);
    await rm(sourceRoot, { recursive: true, force: true });
    const sourceUnpacked = await unpackArtifactVerified(fromSource.artifact);
    try {
      check("set source artifact verifies after its source is removed", sourceUnpacked.verified.id, fromSource.id);
      check("set source artifact carries its source declaration", await readFile(resolve(sourceUnpacked.staging, DESIRED_STATE_PATH), "utf8"), sourceDeclaration);
    } finally {
      await rm(sourceUnpacked.staging, { recursive: true, force: true });
    }
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }

  // A recipe root can coincide with the deployment root. Select sources by logical key so the
  // deployment declaration remains `config/...` instead of being sliced as a recipe path.
  const sameRoot = await mkdtemp(join(tmpdir(), "clawforge-set-same-root-"));
  const previousDeployment = deployment;
  try {
    await mkdir(resolve(sameRoot, "config"), { recursive: true });
    await mkdir(resolve(sameRoot, "demo"), { recursive: true });
    await writeFile(resolve(sameRoot, "config", "desired-state.json"), JSON.stringify([{ path: "gateway.mode", value: "local" }]));
    await writeFile(resolve(sameRoot, "demo", "recipe.json"), JSON.stringify({ description: "same-root recipe" }));
    await writeFile(resolve(sameRoot, "demo", "compose.yml"), "services: {}\n");
    await writeFile(resolve(sameRoot, "config", "deployment.lock.json"), JSON.stringify({
      version: 1,
      deployment: "same-root",
      generatedAt: "2026-01-01T00:00:00.000Z",
      image: { reference: "ghcr.io/openclaw/openclaw:extended-stable", digest: DIGEST },
      recipes: {},
      secrets: [],
    }));
    useDeployment(sameRoot);
    useApplicationRecipesDir(sameRoot);
    const same = await buildSet(ctx, "same-root-set");
    check("equal deployment and recipe roots retain the declaration source", same.manifest.files[DESIRED_STATE_PATH], checksumOf(await readFile(resolve(sameRoot, "config", "desired-state.json"))));
    check("equal deployment and recipe roots copy recipe files", "recipes/demo/compose.yml" in same.manifest.files, true);
  } finally {
    useApplicationRecipesDir(undefined);
    useDeployment(previousDeployment);
    await rm(sameRoot, { recursive: true, force: true });
  }

  // --- a desired-state.json that is syntactically valid JSON but not a list of {path,value}
  // operations must refuse, not build silently -------------------------------------------------
  //
  // config/desired-state.json is a batch-file payload — OpenClaw's own `config set
  // --batch-file` (config.ts's applyConfig) consumes it as an array of operations. Before the
  // fix, only "is this valid JSON" was checked; an object like {"gateway":{"mode":"local"}}
  // passed JSON.parse and built into a real artifact, failing only later, inside the
  // container, when config set --batch-file itself choked on it.
  {
    const desiredStatePath = resolve(deployment, "config", "desired-state.json");
    const validDesiredState = await readFile(desiredStatePath, "utf8");
    await writeFile(desiredStatePath, JSON.stringify({ gateway: { mode: "local" } }));
    try {
      let refused = "";
      try {
        await buildSet(ctx, "demo-set");
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      check("set build refuses a desired-state.json that is an object, not an operations list", refused !== "", true);
      check("the refusal names desired-state.json", refused.includes("desired-state.json"), true);
    } finally {
      await writeFile(desiredStatePath, validDesiredState);
    }
  }

  // --- the lock's digest is used only when the lock is about this image ----------------------
  //
  // requiredImage used to return the lock's digest without asking whether the lock was
  // written for the reference now declared: after OPENCLAW_IMAGE moved to another repository
  // or tag, a stale lock still answered, and the set was pinned to the previous image's
  // digest — the artifact named a runtime the operator's declaration does not, and `set try`
  // installs from the manifest. What a tag means cannot be checked offline, so the reference
  // itself is the comparison: only the identical string lets a recorded digest answer.
  {
    const lockPath = resolve(deployment, "config", "deployment.lock.json");
    const originalLock = await readFile(lockPath, "utf8");
    const writeLock = async (reference: string, digest: string): Promise<void> => {
      await writeFile(
        lockPath,
        JSON.stringify({
          version: 1,
          deployment: "set-build-check",
          generatedAt: "2026-01-01T00:00:00.000Z",
          image: { reference, digest },
          recipes: {},
          secrets: [],
        }),
      );
    };
    const buildRefusal = async (): Promise<string> => {
      try {
        await buildSet(ctx, "demo-set");
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const declared = "ghcr.io/openclaw/openclaw:extended-stable";
    try {
      const otherRepo = "old.example/old-image:stable";
      await writeLock(otherRepo, `old.example/old-image@sha256:${"a".repeat(64)}`);
      let refusal = await buildRefusal();
      check(
        "a lock for another repository does not answer for the declared image",
        refusal.includes(otherRepo) && refusal.includes(declared),
        true,
      );
      check("that refusal says how to record the right digest", refusal.includes("./clawforge lock") && refusal.includes("@sha256"), true);
      const otherTag = "ghcr.io/openclaw/openclaw:older-stable";
      await writeLock(otherTag, `ghcr.io/openclaw/openclaw@sha256:${"b".repeat(64)}`);
      refusal = await buildRefusal();
      check("a lock for another tag of the same repository is refused too", refusal.includes(otherTag) && refusal.includes(declared), true);
      // The chosen rule, stated by this case: a digest reference in the lock is the same
      // repository but not the declared tag, and no offline check can tell what the tag
      // means — so the recorded digest is not taken on faith either.
      const digestRef = `ghcr.io/openclaw/openclaw@sha256:${"c".repeat(64)}`;
      await writeLock(digestRef, digestRef);
      refusal = await buildRefusal();
      check("a lock whose reference is a digest does not answer for a tag of that repository", refusal.includes(digestRef) && refusal.includes(declared), true);
    } finally {
      await writeFile(lockPath, originalLock);
    }

    // The legitimate case, re-asserted in place: the declared tag IS the lock's reference,
    // and its recorded digest pins even though the tag may have moved since — exactly what
    // the lock exists to record.
    await writeLock(declared, DIGEST);
    try {
      check("the lock's digest still pins when the lock names the declared reference", (await buildSet(ctx, "demo-set")).manifest.requires.image, DIGEST);
    } finally {
      await writeFile(lockPath, originalLock);
    }

    // An OPENCLAW_IMAGE that is already a digest reference is pinned by hand and never
    // reaches the lock: even with no lock file at all it pins, exactly as given.
    const handPinned = `ghcr.io/openclaw/openclaw@sha256:${"d".repeat(64)}`;
    const digestCtx = { ...ctx, settings: { ...ctx.settings, image: handPinned } } as unknown as Context;
    await rm(lockPath);
    try {
      check("a @sha256 OPENCLAW_IMAGE pins as given, without consulting the lock", (await buildSet(digestCtx, "digest-set")).manifest.requires.image, handPinned);
    } finally {
      await writeFile(lockPath, originalLock);
    }

    // No lock at all keeps the existing refusal: a tag with nothing proven to pin it to.
    await rm(lockPath);
    try {
      const none = await buildRefusal();
      check("no lock at all keeps the no-digest refusal", none.includes("no image digest to pin the set to") && none.includes(declared), true);
    } finally {
      await writeFile(lockPath, originalLock);
    }
  }

  // --- an unreadable secret source aborts the build instead of shrinking the scan ------------
  //
  // localSecretValues used to treat every read error as "no store yet": with a directory
  // sitting where .env belongs, the scan quietly ran over an empty list and the build still
  // reported success. Only a missing source is tolerable — anything else must name the
  // source and stop, so no artifact is written whose value scan was silently incomplete.
  {
    const envPath = resolve(deployment, ".env");
    const originalEnv = await readFile(envPath, "utf8");
    await rm(envPath);
    await mkdir(envPath);
    try {
      let refusal = "";
      try {
        await buildSet(ctx, "demo-set");
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      check("set build refuses when the .env secret source cannot be read", refusal.includes(".env"), true);
      check("the refusal names the source, never a stored value", refusal.includes(TOKEN), false);
    } finally {
      await rmdir(envPath);
      await writeFile(envPath, originalEnv);
    }
  }
  {
    const storePath = resolve(deployment, "secrets", "prod.env");
    const originalStore = await readFile(storePath, "utf8");
    await rm(storePath);
    await mkdir(storePath);
    try {
      let refusal = "";
      try {
        await buildSet(ctx, "demo-set");
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      check("set build refuses when a secret store cannot be read", refusal.includes("prod.env"), true);
      check("the store refusal names no value either", refusal.includes(STORE_KEY), false);
    } finally {
      await rmdir(storePath);
      await writeFile(storePath, originalStore);
    }
  }

  // --- a failed rebuild must not destroy the artifact already there -------------------------
  //
  // writeArtifact used to point tar straight at sets/<name>-<id>.tar.gz. Two builds of
  // unchanged content land on the same path, so a rebuild truncated the completed artifact
  // before tar had produced anything, and the --force-local fallback was a second write to
  // that same path. The substitute below is tar as the reviewer saw it: it writes a few
  // partial bytes to whatever -f names, then fails; the unflagged fallback fails the same
  // way, which is what a real spawnLocal does with a failing tar.
  {
    const setsDir = resolve(deployment, "sets");
    const before = await readFile(changed.artifact);
    const targets: string[] = [];
    let attempts = 0;
    const partialThenFail = async (_command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
      attempts += 1;
      // tar is invoked with the combined short flag -czf; the archive path follows it.
      const target = args[args.indexOf("-czf") + 1]!;
      if (target === undefined || target.startsWith("-")) {
        throw new Error(`substitute found no archive path in: tar ${args.join(" ")}`);
      }
      targets.push(target);
      await writeFile(target, "a truncated archive, not a real one\n");
      if (options?.allowFailure === true) return { code: 1, stdout: "", stderr: "tar: simulated failure mid-write\n" };
      throw new Error("tar: simulated failure mid-write");
    };
    let refusal = "";
    try {
      await withTarRunner(partialThenFail, () => buildSet(ctx, "demo-set"));
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    check("a failed rebuild refuses instead of reporting success", refusal !== "", true);
    check("both tar attempts were made, flagged then plain", attempts, 2);
    check(
      "neither tar attempt writes the final artifact name",
      targets.every((target) => target !== changed.artifact),
      true,
    );
    check(
      "every attempt writes inside sets/, so publishing stays one rename",
      targets.every((target) => target.startsWith(`${setsDir}${sep}`)),
      true,
    );
    check("the failed rebuild leaves the previous artifact byte-for-byte unchanged", (await readFile(changed.artifact)).equals(before), true);
    let stillListable = false;
    try {
      stillListable = (await tarList(changed.artifact)).includes("set.json");
    } catch {
      // A corrupt archive must be caught here, not fatal to the checks: proving the
      // artifact cannot be listed is part of what failure looks like.
      stillListable = false;
    }
    check("the surviving artifact still lists as a real archive", stillListable, true);
    check(
      "the failed rebuild leaves no temporary file behind",
      (await readdir(setsDir)).filter((entry) => !entry.endsWith(".tar.gz")),
      [],
    );

    let firstBuildRefusal = "";
    try {
      await withTarRunner(partialThenFail, () => buildSet(ctx, "fresh-set"));
    } catch (error) {
      firstBuildRefusal = error instanceof Error ? error.message : String(error);
    }
    check("a first build that fails refuses too", firstBuildRefusal !== "", true);
    check(
      "a failed first build leaves nothing at the final path",
      (await readdir(setsDir)).filter((entry) => entry.startsWith("fresh-set-")),
      [],
    );

    // The default path runs the real tar end to end: the same command line as ever, and the
    // completed archive renamed over the artifact that is already there.
    const rebuilt = await buildSet(ctx, "demo-set");
    check("a real rebuild still lands a complete archive", (await tarList(rebuilt.artifact)).includes("set.json"), true);
    check(
      "the real rebuild leaves only archives in sets/",
      (await readdir(setsDir)).filter((entry) => !entry.endsWith(".tar.gz")),
      [],
    );
  }

  // --- an unreadable recipes source must not become a valid empty set -----------------------
  //
  // recipeNames used to swallow every readdir error, so a plain file sitting where the
  // recipes directory belongs came back as an empty inventory and a perfectly valid set —
  // a read failure published as the deliberate removal of every recipe, which plan and the
  // ownership ledger then turn into removals of owned servers and cron jobs. Only ENOENT
  // is absence; validateAction goes through collectManifest, so one refusal covers
  // `set build` and `set validate` alike.
  {
    const notADirectory = await mkdtemp(join(tmpdir(), "clawforge-set-recipes-file-"));
    const recipesFile = resolve(notADirectory, "recipes");
    await writeFile(recipesFile, "a plain file where the recipes directory belongs\n");
    try {
      useApplicationRecipesDir(recipesFile);
      let buildRefusal = "";
      try {
        await buildSet(ctx, "demo-set");
      } catch (error) {
        buildRefusal = error instanceof Error ? error.message : String(error);
      }
      check("set build refuses when the recipes source is a plain file", buildRefusal.includes("ENOTDIR"), true);
      check("the refusal names the recipes path", buildRefusal.includes(recipesFile), true);
      let validateRefusal = "";
      try {
        await withOutputSink(() => {}, () => set(ctx, ["validate", "--name", "demo-set", "--json"]));
      } catch (error) {
        validateRefusal = error instanceof Error ? error.message : String(error);
      }
      check("set validate refuses on the same unreadable source", validateRefusal.includes("ENOTDIR"), true);
      check(
        "nothing new was written into sets/ while refusing",
        (await readdir(resolve(deployment, "sets"))).filter((entry) => !entry.endsWith(".tar.gz")),
        [],
      );
    } finally {
      useApplicationRecipesDir(undefined);
      await rm(notADirectory, { recursive: true, force: true });
    }
  }

  // ENOENT — no recipes directory at all — stays the empty answer it has always been.
  {
    const absent = resolve(deployment, "recipes-absent-elsewhere");
    useApplicationRecipesDir(absent);
    try {
      const empty = await buildSet(ctx, "no-recipes-set");
      check("a missing recipes source still builds an empty set", Object.keys(empty.manifest.recipes), []);
    } finally {
      useApplicationRecipesDir(undefined);
    }
  }

  // The errno dispatch itself, over errnos this machine cannot be made to produce on demand
  // (EACCES is not reliably reproducible on Windows).
  check("the classifier treats ENOENT as a legitimately absent source", absentRecipesSource(Object.assign(new Error("gone"), { code: "ENOENT" })), true);
  for (const code of ["ENOTDIR", "EACCES", "EIO", "EPERM"]) {
    check(`the classifier refuses to bless ${code} as absence`, absentRecipesSource(Object.assign(new Error(code), { code })), false);
  }
  check("a non-errno error is not absence either", absentRecipesSource(new Error("no code at all")), false);

  // --- the group does not pretend validate exists ----------------------------------------------------

  let unknownActionFails = false;
  try {
    await withOutputSink(() => {}, () => set(ctx, ["frobnicate"]));
  } catch {
    unknownActionFails = true;
  }
  check("an unknown subcommand fails naming what exists", unknownActionFails, true);
} finally {
  await rm(deployment, { recursive: true, force: true });
  // The active deployment is process-wide and the checks share one process: leave it where
  // the other check files expect to find it rather than pointing at a directory just deleted.
  useDeployment(resolve(monorepoRoot, "apps", "example app"));
}

process.stderr.write(failed === 0 ? "all set build checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
