// `./clawforge set build` and where it reads recipes from: an application recipesDir outside
// the deployment (absolute and relative), an active set source, a recipe root equal to the
// deployment root, and a recipes source that is unreadable rather than absent — which must
// refuse, not become a valid empty set.

import { mkdtemp, mkdir, readdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { absentRecipesSource, buildSet, set } from "#framework/commands/sets/set.ts";
import { unpackArtifactVerified } from "#framework/set/artifacts/install.ts";
import { withSetSource } from "#framework/set/artifacts/source.ts";
import { DESIRED_STATE_PATH } from "#framework/set/artifacts/model.ts";
import { checksumOf } from "#framework/service/checksums.ts";
import { useApplicationRecipesDir, useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { ctx, DIGEST, createBuildDeployment, removeBuildDeployment } from "#checks/sets/artifact/set-build/fixture.ts";

const deployment = await createBuildDeployment();

try {
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
} finally {
  await removeBuildDeployment(deployment);
}
finish("set build recipes source");
