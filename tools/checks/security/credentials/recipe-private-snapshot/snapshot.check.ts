// P1-01/P1-02: a recipe's declared private paths must really stay out of migrate and share
// snapshots, and a broken recipe manifest must stop archiving and verification instead of
// reading as "nothing declared".
//
// The previous version of this check simulated tar with a stub that shared the
// implementation's own assumptions — it treated the brackets of an --exclude pattern as
// literals, exactly as the escaping code does. That is precisely why P1-02 shipped green: a
// stub cannot contradict the code it was modelled on, and only real GNU tar shows the two
// failure directions of tar's old glob reading (a declaration `vault[1]` excluded the
// undeclared sibling vault1 while the literal directory vault[1] shipped). The assertions
// below therefore run against real GNU tar, reached through a real POSIX transport — the
// machine's own filesystem off Windows, a WSL distribution on it — onto a one-shot scratch
// directory, over the exact command line createArchive builds. Only a machine with neither
// a local POSIX filesystem nor a WSL distribution skips that group; the pure declaration
// and malformed-manifest groups run unconditionally, so the file stays meaningful
// everywhere.
//
// The two fixture recipes (fixture-recipe/fixture-sidecar, fixture-recipe/fixture-bracket)
// declare their private paths and write into them through the real helpers, their prepare.ts
// driven the way `recipe install` drives it. The share round-trip is the enforcement half of
// the contract: verifySnapshot refuses an archive that already carries a declared private
// file, so exclusion (createArchive) and refusal (verify) must agree — a pre-fix archive
// built without any --exclude is refused by migrate and share and accepted by full.
// `full` is credential-complete by design: the recipes' credentials must be IN a full
// archive (restoring one restores the recipes' working state) and in no other profile.

import { verifySnapshot } from "#framework/commands/lifecycle/verify.ts";
import { parseWslDistroListing } from "#framework/commands/interface/host/contexts.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import { LocalTransport, spawnLocal, WslTransport, type Transport } from "#framework/runtime/transport.ts";
import { createArchive, listArchive } from "#framework/service/archive.ts";
import {
  installedRecipePrivatePaths,
  listRecipes,
  loadRecipe,
  recipesDirectory,
  useRecipesDir,
  clearRecipesDir,
  type Recipe,
} from "#framework/service/recipe.ts";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

function skip(name: string): void {
  process.stderr.write(`  skip ${name}\n`);
}

/** The message a rejected promise failed with, or undefined when it did not reject. */
async function rejectionOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

/** A real POSIX filesystem with real GNU tar: this machine off Windows, a WSL distribution
 *  with GNU tar on it. Where neither exists the group is skipped, loudly. */
async function realPosixTransport(): Promise<Transport | undefined> {
  if (process.platform !== "win32") return new LocalTransport();
  try {
    const listing = await spawnLocal("wsl.exe", ["--list", "--quiet"], { allowFailure: true, timeoutMs: 30_000 });
    for (const distro of parseWslDistroListing(listing.stdout).slice(0, 3)) {
      const candidate = new WslTransport(distro);
      const gnuTar = await candidate
        .exec("sh", ["-c", "tar --version"], { allowFailure: true, timeoutMs: 30_000 })
        .then((result) => result.stdout.includes("GNU tar"), () => false);
      if (gnuTar) return candidate;
    }
  } catch {
    // wsl.exe missing or unlaunchable — reported as the skip below.
  }
  return undefined;
}

const fixtureDir = fileURLToPath(new URL("./fixture-recipe", import.meta.url));
const previousRecipes = (() => {
  try { return recipesDirectory(); } catch { return undefined; }
})();

const DECLARED = ["sidecar-private", "vault[1]"] as const;
// Recipes are enumerated directory by directory and the order of that enumeration is not
// contractual (it differs between filesystems), so the declaration SET is compared sorted.
const sortedDeclarations = JSON.stringify([...DECLARED].sort());

// One-shot copy of the fixture recipes: the real-tar group breaks and restores a manifest
// inside it, so nothing ever touches the repository's own fixture directory.
const tempRecipes = await mkdtemp(join(tmpdir(), "clawforge-pp-recipes-"));
await cp(fixtureDir, tempRecipes, { recursive: true });

// Scratch directory on the POSIX target; set only when the real-tar group runs.
let parent: string | undefined;
let transport: Transport | undefined;

try {
  useRecipesDir(tempRecipes);

  // --- the declarations (pure group: no WSL needed) --------------------------------------------

  const sidecar = await loadRecipe("fixture-sidecar");
  check("loadRecipe carries the sidecar's declared privatePaths", JSON.stringify(sidecar.privatePaths), JSON.stringify(["sidecar-private"]));
  const bracket = await loadRecipe("fixture-bracket");
  check("loadRecipe carries the bracket's literal declared privatePaths", JSON.stringify(bracket.privatePaths), JSON.stringify(["vault[1]"]));
  check("installedRecipePrivatePaths collects both declarations", JSON.stringify([...(await installedRecipePrivatePaths())].sort()), sortedDeclarations);

  useRecipesDir(join(tempRecipes, "absent"));
  const quiet = await installedRecipePrivatePaths().catch((error: Error) => `threw: ${error.message}`);
  check("an absent recipes root stays quiet — an empty list, not an error", JSON.stringify(quiet), "[]");
  useRecipesDir(tempRecipes);

  // --- a malformed manifest stops the policy readers (pure: no target needed) -------------------
  //
  // P1-01's other half: a recipe.json that exists but cannot be parsed must never read as
  // "nothing declared" — that is exactly how a private file once walked into a share
  // archive. Reading the declaration is strictly local, so these run unconditionally, on
  // every platform; the archiving and verification halves of this scenario drive the real
  // transport and stay inside the real-POSIX group below.

  const manifestPath = join(tempRecipes, "fixture-sidecar", "recipe.json");
  const originalManifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, '{ "description": broken', "utf8");

  const policyError = await rejectionOf(() => installedRecipePrivatePaths());
  check("installedRecipePrivatePaths refuses a malformed manifest", /could not parse/.test(policyError ?? ""), true);

  check(
    "listRecipes still resolves the working recipe beside a broken manifest",
    JSON.stringify((await listRecipes()).map((recipe) => recipe.name).sort()),
    JSON.stringify(["fixture-bracket"]),
  );

  await writeFile(manifestPath, originalManifest, "utf8");
  check("a restored manifest reads whole again", JSON.stringify([...(await installedRecipePrivatePaths())].sort()), sortedDeclarations);

  // --- the real tar ----------------------------------------------------------------------------

  const probed = await realPosixTransport();

  if (probed === undefined) {
    skip("real-GNU-tar snapshot checks (skipped: no local POSIX filesystem and no WSL distribution with GNU tar)");
  } else {
    transport = probed;
    const tag = randomBytes(4).toString("hex");
    const PARENT = `/tmp/clawforge-pp-${tag}`;
    const DATA_NAME = "data";
    const DATA = `${PARENT}/${DATA_NAME}`;
    const ARCHIVES = `${PARENT}/archives`;
    parent = PARENT;

    await transport.mkdirp(`${DATA}/config`);
    await transport.mkdirp(`${DATA}/workspace`);
    await transport.mkdirp(ARCHIVES);
    // Ordinary instance content the share profile is allowed to carry. No config/.env: the
    // content scan then has nothing to search for and stays out of the assertions' way.
    await transport.writeFile(`${DATA}/config/openclaw.json`, JSON.stringify({ models: { providers: {} } }));
    await transport.writeFile(`${DATA}/workspace/SOUL.md`, "# fixture\n");

    const ctx = { settings: { dataDir: DATA, env: {} }, transport } as unknown as Context;

    // --- both fixture hooks drive the real private-write helpers on the POSIX target --------------

    const sidecarHooks = (await import(new URL("./fixture-recipe/fixture-sidecar/prepare.ts", import.meta.url).href)) as {
      prepare: (ctx: Context, recipe: Recipe) => Promise<void>;
    };
    await sidecarHooks.prepare(ctx, sidecar);
    check("the sidecar's private file is written under its declared path", await transport.exists(`${DATA}/sidecar-private/credentials.env`), true);

    const bracketHooks = (await import(new URL("./fixture-recipe/fixture-bracket/prepare.ts", import.meta.url).href)) as {
      prepare: (ctx: Context, recipe: Recipe) => Promise<void>;
    };
    await bracketHooks.prepare(ctx, bracket);
    // The write itself also proves the private helpers accept a literal-bracket declared path.
    check("the bracket recipe's private file is written under its literal-bracket declared path", await transport.exists(`${DATA}/vault[1]/credentials.env`), true);

    // Control sibling: the name tar's old glob reading of `vault1` caught instead of the real
    // one — declared by nobody, so every profile may carry it. Written raw (not through the
    // private helpers): an undeclared path is exactly what they must refuse.
    await transport.mkdirp(`${DATA}/vault1`);
    await transport.writeFile(`${DATA}/vault1/credentials.env`, "FIXTURE_CREDENTIAL=review-p1-02-control-sibling recipe=none\n");

    // The base exclusions keep their wildcards — only the declaration's rules are escaped.
    // config/.env.clawforge-* is provider-key staging: credential material a process that
    // died between staging and rename leaves behind, catchable only by the glob. Escaping
    // every pattern would quietly disable exactly this rule, so it is pinned like the rest.
    await transport.writeFile(`${DATA}/config/.env.clawforge-staging-${tag}`, "PROVIDER_KEY=fixture-marker-not-a-key\n");

    // --- what each profile's archive really contains (real GNU tar) ------------------------------

    const full = `${ARCHIVES}/full.tar.gz`;
    await createArchive(ctx, { archive: full, profile: "full" });
    const fullListing = await listArchive(ctx, full);
    check("a full archive keeps the sidecar's private file", fullListing.includes("data/sidecar-private/credentials.env"), true);
    check("a full archive keeps the literal vault[1] private file", fullListing.includes("data/vault[1]/credentials.env"), true);

    const migrate = `${ARCHIVES}/migrate.tar.gz`;
    await createArchive(ctx, { archive: migrate, profile: "migrate" });
    const migrateListing = await listArchive(ctx, migrate);
    check("a migrate archive keeps the undeclared sibling vault1 — no over-exclusion", migrateListing.includes("data/vault1/credentials.env"), true);
    check("a migrate archive leaves out the sidecar's private file", migrateListing.includes("data/sidecar-private/credentials.env"), false);
    check("a migrate archive leaves out the literal vault[1] — the escape, not the old glob", migrateListing.includes("data/vault[1]/credentials.env"), false);
    check("a wildcard base exclusion (provider-key staging) stays out of a migrate archive", migrateListing.includes(`data/config/.env.clawforge-staging-${tag}`), false);

    // The control has served: gone before any share verdict, so the allow-list below judges a
    // clean tree.
    await transport.remove(`${DATA}/vault1`);

    const share = `${ARCHIVES}/share.tar.gz`;
    await createArchive(ctx, { archive: share, profile: "share" });
    // The positive round-trip. If the literal escaping ever broke, vault[1] would re-enter this
    // archive and this check would fail on both the forbidden-path and allow-list rules.
    check(
      "a share archive with every declared private path excluded passes verify",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, share, "share")),
      true,
    );

    // --- defense in depth: an archive taken before the exclusion existed -------------------------
    //
    // Built directly with no --exclude patterns, the way createArchive built every archive
    // before the fix. verify alone must refuse it: exclusion lists are a promise, the check
    // is the enforcement.

    const preFix = `${ARCHIVES}/pre-fix.tar.gz`;
    await transport.exec("tar", ["--numeric-owner", "-czf", preFix, "-C", PARENT, DATA_NAME]);
    for (const profile of ["migrate", "share"] as const) {
      const output: string[] = [];
      const passed = await withOutputSink((chunk) => output.push(chunk), () => verifySnapshot(ctx, preFix, profile));
      check(`verify refuses an already-taken ${profile} archive containing the recipes' private paths`, passed, false);
      check(`the ${profile} refusal names the offending path`, output.join("").includes("sidecar-private"), true);
    }
    check(
      "a full archive containing the recipes' private paths still passes verify",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, preFix, "full")),
      true,
    );

    // --- a malformed manifest stops the real archivers and verifiers too --------------------------
    //
    // The pure half of this scenario ran unconditionally above; these halves drive real tar
    // and verify over the scratch tree, so they belong to the real-POSIX group.

    await writeFile(manifestPath, '{ "description": broken', "utf8");

    const createError = await rejectionOf(() => createArchive(ctx, { archive: `${ARCHIVES}/broken.tar.gz`, profile: "migrate" }));
    check("createArchive refuses to archive while a manifest is broken", /could not parse/.test(createError ?? ""), true);

    const verifyError = await rejectionOf(() => withOutputSink(() => {}, () => verifySnapshot(ctx, share, "share")));
    check("verifySnapshot stops while a manifest is broken (the strict read)", /could not parse/.test(verifyError ?? ""), true);

    await writeFile(manifestPath, originalManifest, "utf8");
    const healed = `${ARCHIVES}/migrate-after-restore.tar.gz`;
    // The control sibling was removed before the share verdicts so the allow-list judged a
    // clean tree; it returns here, or "sibling in" below would assert a deleted file.
    await transport.mkdirp(`${DATA}/vault1`);
    await transport.writeFile(`${DATA}/vault1/credentials.env`, "FIXTURE_CREDENTIAL=review-p1-02-control-sibling recipe=none\n");
    await createArchive(ctx, { archive: healed, profile: "migrate" });
    const healedListing = await listArchive(ctx, healed);
    check(
      "a fresh migrate archive succeeds after the restore — private paths out, sibling in",
      healedListing.includes("data/vault1/credentials.env") && !healedListing.includes("data/sidecar-private/credentials.env"),
      true,
    );

    // --- absent recipes root (integration half) --------------------------------------------------
    //
    // Quiet ([]) is the honest answer for "nothing declared": the archive then simply has no
    // recipe exclusions, and the declared files land in it — there is nothing to hide them.

    useRecipesDir(join(tempRecipes, "absent"));
    const absentArchive = `${ARCHIVES}/migrate-absent-root.tar.gz`;
    await createArchive(ctx, { archive: absentArchive, profile: "migrate" });
    check(
      "with an absent recipes root the migrate archive keeps the declared files",
      (await listArchive(ctx, absentArchive)).includes("data/sidecar-private/credentials.env"),
      true,
    );
    useRecipesDir(tempRecipes);
  }
} finally {
  if (transport !== undefined && parent !== undefined) await transport.remove(parent).catch(() => {});
  await rm(tempRecipes, { recursive: true, force: true });
  if (previousRecipes === undefined) clearRecipesDir();
  else useRecipesDir(previousRecipes);
}

process.stderr.write(failed === 0 ? "all recipe-private-snapshot checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
