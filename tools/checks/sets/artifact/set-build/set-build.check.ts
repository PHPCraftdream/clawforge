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

import { mkdtemp, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSet, assertNoSecretValues } from "#framework/commands/sets/set.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { DESIRED_STATE_PATH, setManifestId, canonicalJson } from "#framework/set/artifacts/model.ts";
import type { SetManifest } from "#framework/set/artifacts/model.ts";
import { checksumOf, checksumOfFileMap } from "#framework/service/checksums.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { ctx, DIGEST, STORE_KEY, TOKEN, createBuildDeployment, removeBuildDeployment, stringsOf, tarList } from "#checks/sets/artifact/set-build/fixture.ts";

const set = (ctx: Parameters<NonNullable<typeof openclawCommands.set.run>>[0], argv: string[]): Promise<void> => openclawCommands.set.run!(ctx, argv);

// The archive checks, the recipe-source scenarios (recipes-source.check.ts) and the refusals
// (refusals.check.ts) each run against a fresh copy of the same deployment.
const deployment = await createBuildDeployment();

try {
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

  // --- the group does not pretend validate exists ----------------------------------------------------

  let unknownActionFails = false;
  try {
    await withOutputSink(() => {}, () => set(ctx, ["frobnicate"]));
  } catch {
    unknownActionFails = true;
  }
  check("an unknown subcommand fails naming what exists", unknownActionFails, true);
} finally {
  await removeBuildDeployment(deployment);
}
finish("set build");
