// P2-05 of docs/review-2026-09-22-xa-round-2.md: the verifier applied a bare string prefix
// test to every forbidden rule, literal declarations and generated-file prefixes alike — so
// the declaration `vault` also forbade the public sibling `vault-public/`, and the exact
// file `config/private.env` its `.example` neighbor. The archiver (component-boundary tar
// --exclude) correctly keeps such neighbors, so a valid layout made verify refuse and pull
// delete the backup it had just taken.
//
// Two tiers: the rule table and the boundary matcher are checked directly, and the REAL
// verifier judges REAL GNU tar archives of a real file tree holding both shapes of neighbor
// — the same comparison pull's migrate publish path runs (forbiddenViolations, state.ts)
// is driven over those same real listings. The lesson of the 2026-09-21 audit: a simulated
// tar cannot contradict the code it was modelled on.
//
// The archive/verify group needs a real POSIX filesystem — local off Windows, a WSL
// distribution on it — and is skipped cleanly without one.

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { forbiddenRules, forbiddenViolations, verifySnapshot } from "#framework/commands/lifecycle/verify.ts";
import { parseWslDistroListing } from "#framework/commands/interface/host/contexts.ts";
import type { Context } from "#framework/core/context.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { deploymentDir, useDeployment } from "#framework/runtime/deployment.ts";
import { LocalTransport, spawnLocal, WslTransport, type Transport } from "#framework/runtime/transport.ts";
import { archiveRoot, createArchive, listArchive } from "#framework/service/archive.ts";
import { clearRecipesDir, installedRecipePrivatePaths, recipesDirectory, useRecipesDir } from "#framework/service/recipe.ts";

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

/** A real POSIX filesystem with real GNU tar: this machine off Windows, a WSL distribution
 *  on it. Where neither exists the archive group is skipped, loudly. */
async function realPosixTransport(): Promise<Transport | undefined> {
  if (process.platform !== "win32") return new LocalTransport();
  try {
    const listing = await spawnLocal("wsl.exe", ["--list", "--quiet"], { allowFailure: true, timeoutMs: 30_000 });
    for (const distro of parseWslDistroListing(listing.stdout).slice(0, 2)) {
      const candidate = new WslTransport(distro);
      const shell = await candidate
        .exec("sh", ["-c", "true"], { allowFailure: true, timeoutMs: 30_000 })
        .then((result) => result.code === 0, () => false);
      if (shell) return candidate;
    }
  } catch {
    // wsl.exe missing or unlaunchable — reported as the skip below.
  }
  return undefined;
}

const previousRecipes = (() => {
  try { return recipesDirectory(); } catch { return undefined; }
})();
const previousDeployment = (() => {
  try { return deploymentDir(); } catch { return undefined; }
})();

// Checks share one process, so the deployment and recipes roots this file selects are
// restored in the finally — the same discipline private-declaration-lifetime.check.ts
// applies. The recipes root declares both shapes the bug confounded: a private DIRECTORY
// with a public sibling, and a private FILE with a public `.example` neighbor.
const tag = randomBytes(4).toString("hex");
const tempDeployment = await mkdtemp(join(tmpdir(), `clawforge-pp-prefix-deployment-${tag}-`));
await mkdir(resolve(tempDeployment, "config"), { recursive: true });
const tempRecipes = await mkdtemp(join(tmpdir(), `clawforge-pp-prefix-recipes-${tag}-`));
await mkdir(join(tempRecipes, "prefix-boundary"), { recursive: true });
await writeFile(
  join(tempRecipes, "prefix-boundary", "recipe.json"),
  `${JSON.stringify({ description: "prefix boundary fixture", privatePaths: ["vault", "config/private.env"] }, null, 2)}\n`,
  "utf8",
);

const sorted = (paths: readonly string[]): string => JSON.stringify([...paths].sort());

try {
  useDeployment(tempDeployment);
  useRecipesDir(tempRecipes);

  // --- the rule table and the boundary matcher (no target needed) ---------------------------------

  check(
    "the migrate rule table is the declarations then its secrets file, in order",
    JSON.stringify(forbiddenRules("migrate", ["x"]).literals),
    JSON.stringify(["x", "config/.env"]),
  );
  check(
    "migrate keeps the staging family a prefix rule",
    JSON.stringify(forbiddenRules("migrate", ["x"]).prefixes),
    JSON.stringify(["config/.env.clawforge-"]),
  );
  check(
    "the share rule table adds its identity/state directories as literals",
    JSON.stringify([...forbiddenRules("share", []).literals].sort()),
    JSON.stringify(["config/.env", "config/agents/", "config/devices/", "config/identity/", "config/state/"]),
  );
  check(
    "share keeps the staging family a prefix rule too",
    JSON.stringify(forbiddenRules("share", []).prefixes),
    JSON.stringify(["config/.env.clawforge-"]),
  );
  check(
    "full forbids nothing structurally",
    JSON.stringify([forbiddenRules("full", ["anything"]).literals, forbiddenRules("full", ["anything"]).prefixes]),
    JSON.stringify([[], []]),
  );

  const declarations = ["vault", "config/private.env"];
  check(
    "an exact directory entry is forbidden",
    JSON.stringify(forbiddenViolations("migrate", declarations, ["vault"])),
    JSON.stringify(["vault"]),
  );
  check(
    "a directory entry keeps its trailing slash in real listings and still matches",
    JSON.stringify(forbiddenViolations("migrate", declarations, ["vault/"])),
    JSON.stringify(["vault"]),
  );
  check(
    "a genuinely nested entry is still forbidden",
    JSON.stringify(forbiddenViolations("migrate", declarations, ["vault/secret.env"])),
    JSON.stringify(["vault"]),
  );
  check(
    "the public sibling vault-public must NOT be forbidden",
    JSON.stringify(forbiddenViolations("migrate", declarations, ["vault-public", "vault-public/notes.txt"])),
    "[]",
  );
  check(
    "the exact declared file is still forbidden",
    JSON.stringify(forbiddenViolations("migrate", declarations, ["config/private.env"])),
    JSON.stringify(["config/private.env"]),
  );
  check(
    "the declared file's .example neighbor must NOT be forbidden",
    JSON.stringify(forbiddenViolations("migrate", declarations, ["config/private.env.example"])),
    "[]",
  );
  check(
    "a sibling whose name merely extends the declared file name is not forbidden either",
    JSON.stringify(forbiddenViolations("migrate", declarations, ["config/private.env.d/creds"])),
    "[]",
  );
  check(
    "the staging family is caught by its explicit prefix rule",
    JSON.stringify(forbiddenViolations("migrate", [], ["config/.env.clawforge-deadbeef"])),
    JSON.stringify(["config/.env.clawforge-"]),
  );
  check(
    "the declaration config/.env no longer swallows the staging name by prefix",
    JSON.stringify(forbiddenViolations("migrate", ["config/.env"], ["config/.env.clawforge-deadbeef"])),
    JSON.stringify(["config/.env.clawforge-"]),
  );
  check(
    "a trailing-slash share rule covers its contents",
    JSON.stringify(forbiddenViolations("share", [], ["config/identity/device-auth.json"])),
    JSON.stringify(["config/identity/"]),
  );
  check(
    "a trailing-slash share rule stops at the '/' boundary",
    JSON.stringify(forbiddenViolations("share", [], ["config/identity-archived/x"])),
    "[]",
  );

  // --- the REAL archiver and verifier over REAL tar (needs a POSIX filesystem) ---------------------

  const transport = await realPosixTransport();
  if (transport === undefined) {
    skip("archive/verify prefix-boundary checks (no local POSIX filesystem and no WSL distribution with a shell)");
  } else {
    const PARENT = `/tmp/clawforge-pp-prefix-${tag}`;
    const DATA = `${PARENT}/data`;
    const ARCHIVES = `${PARENT}/archives`;
    await transport.mkdirp(`${DATA}/config`);
    await transport.mkdirp(`${DATA}/vault`);
    await transport.mkdirp(`${DATA}/vault-public`);
    await transport.mkdirp(`${DATA}/workspace`);
    await transport.mkdirp(ARCHIVES);
    await transport.writeFile(`${DATA}/config/openclaw.json`, JSON.stringify({ models: { providers: {} } }));
    await transport.writeFile(`${DATA}/vault/secret.env`, "PRIVATE=vault-content\n");
    await transport.writeFile(`${DATA}/vault-public/notes.txt`, "public notes\n");
    await transport.writeFile(`${DATA}/config/private.env`, "PRIVATE=exact-file\n");
    await transport.writeFile(`${DATA}/config/private.env.example`, "EXAMPLE=not-a-secret\n");
    await transport.writeFile(`${DATA}/workspace/SOUL.md`, "# fixture\n");
    const ctx = { settings: { dataDir: DATA, env: {} }, transport } as unknown as Context;

    check(
      "the installed policy is exactly the fixture's two declarations",
      sorted(await installedRecipePrivatePaths()),
      sorted(["config/private.env", "vault"]),
    );

    // The exact expression pull's migrate publish path runs over a listing (state.ts).
    const relativeOf = (entries: string[]): string[] =>
      entries.map((entry) => entry.replace(/^\.\//, "").slice(archiveRoot(entries).length + 1));

    const migrateArchive = `${ARCHIVES}/migrate.tar.gz`;
    await createArchive(ctx, { archive: migrateArchive, profile: "migrate" });
    const migrateListing = await listArchive(ctx, migrateArchive);
    check("the archiver keeps the public sibling vault-public", migrateListing.includes("data/vault-public/notes.txt"), true);
    check("the archiver keeps the .example neighbor", migrateListing.includes("data/config/private.env.example"), true);
    check("the archiver still leaves the declared vault out", migrateListing.includes("data/vault/secret.env"), false);
    check("the archiver still leaves the declared exact file out", migrateListing.includes("data/config/private.env"), false);
    check(
      "the migrate publish gate sees no violation in a neighbors archive",
      JSON.stringify(forbiddenViolations("migrate", await installedRecipePrivatePaths(), relativeOf(migrateListing))),
      "[]",
    );
    check(
      "verify passes the neighbors archive as migrate — the old code refused it here",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, migrateArchive, "migrate")),
      true,
    );

    const shareArchive = `${ARCHIVES}/share.tar.gz`;
    await createArchive(ctx, { archive: shareArchive, profile: "share" });
    const shareListing = await listArchive(ctx, shareArchive);
    check("the share archive keeps both neighbors too", shareListing.includes("data/vault-public/notes.txt") && shareListing.includes("data/config/private.env.example"), true);
    check(
      "the share gate sees no violation in a neighbors archive",
      JSON.stringify(forbiddenViolations("share", await installedRecipePrivatePaths(), relativeOf(shareListing))),
      "[]",
    );
    // Share is judged by a second, deliberate mechanism on top of the forbidden rules: its
    // allowed set is stated positively (SHARE_ALLOWED), so unknown top-level content — these
    // neighbors included — is reported as not allowed BY DESIGN. The P2-05 claim is that the
    // forbidden rules must not be the reason: the refusal must carry no "must exclude"
    // finding, only the allowlist one.
    const shareOutput: string[] = [];
    check(
      "share still refuses unknown top-level content through its own allowlist",
      await withOutputSink((chunk) => shareOutput.push(chunk), () => verifySnapshot(ctx, shareArchive, "share")),
      false,
    );
    check(
      "the share refusal is the allowlist finding, never a forbidden-path refusal",
      shareOutput.join("").includes("does not allow") && !shareOutput.join("").includes("must exclude"),
      true,
    );

    // Defense in depth, the sibling's shape: an archive with no exclusions at all — taken
    // before the exclusion existed. Both genuinely-nested declarations must still be seen,
    // and nothing else.
    const raw = `${ARCHIVES}/raw.tar.gz`;
    await transport.exec("tar", ["--numeric-owner", "-czf", raw, "-C", PARENT, "data"]);
    const rawListing = await listArchive(ctx, raw);
    check(
      "the raw archive violates exactly the two genuinely-nested declarations",
      sorted(forbiddenViolations("migrate", declarations, relativeOf(rawListing))),
      sorted(["config/private.env", "vault"]),
    );
    check(
      "verify refuses the raw archive as migrate",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, raw, "migrate")),
      false,
    );
    const rawOutput: string[] = [];
    check(
      "verify refuses the raw archive as share",
      await withOutputSink((chunk) => rawOutput.push(chunk), () => verifySnapshot(ctx, raw, "share")),
      false,
    );
    check("the share refusal names the declared vault", rawOutput.join("").includes("vault"), true);
    check("the share refusal names the declared exact file", rawOutput.join("").includes("config/private.env"), true);

    await transport.remove(PARENT).catch(() => {});
  }
} finally {
  await rm(tempDeployment, { recursive: true, force: true }).catch(() => {});
  await rm(tempRecipes, { recursive: true, force: true }).catch(() => {});
  if (previousRecipes === undefined) clearRecipesDir();
  else useRecipesDir(previousRecipes);
  if (previousDeployment !== undefined) useDeployment(previousDeployment);
}

process.stderr.write(
  failed === 0
    ? "all private-paths-prefix-boundary checks passed\n"
    : `${failed} private-paths-prefix-boundary check(s) failed\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
