// P1-02 of docs/review-2026-09-22-xa-round-2.md: a privatePaths declaration lives in the
// recipe's source tree, but the files it covers live on the target. Removing the recipe —
// deleting its directory, or switching to a set that no longer includes it — takes the
// declaration away while the runtime credentials stay put, and the security policy used to
// lose them at exactly that moment: installedRecipePrivatePaths() went empty, a share
// archive picked the file up, and verify passed it.
//
// The fix records every private write the helpers make (private-paths-ledger.ts, on the
// deployment side, next to the desired state) and merges that record with whatever the
// current declarations say. These checks drive the REAL write helpers, the REAL archiver
// and the REAL verifier over real GNU tar — the lesson of the 2026-09-21 audit: a
// simulated tar cannot contradict the code it was modelled on.
//
// The ledger's own contract and the fail-closed reads need no target and run everywhere;
// the archive/verify group needs a real POSIX filesystem — local off Windows, a WSL
// distribution on it — and is skipped cleanly without one.

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifySnapshot } from "#framework/commands/lifecycle/verify.ts";
import { parseWslDistroListing } from "#framework/commands/interface/host/contexts.ts";
import type { Context } from "#framework/core/context.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { deploymentDir, useDeployment } from "#framework/runtime/deployment.ts";
import { LocalTransport, spawnLocal, WslTransport, type Transport } from "#framework/runtime/transport.ts";
import { createArchive, listArchive } from "#framework/service/archive.ts";
import {
  clearRecipesDir,
  installedRecipePrivatePaths,
  loadRecipe,
  recipesDirectory,
  useRecipesDir,
  type Recipe,
} from "#framework/service/recipe.ts";
import { ensurePrivateTargetDirectory, replacePrivateTargetFile } from "#framework/security/private-config.ts";
import {
  forgetPrivatePaths,
  persistedPrivatePaths,
  privatePathsLedgerFile,
  recordPrivateWrite,
} from "#framework/security/private-paths-ledger.ts";

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
// restored in the finally — the same discipline snapshot.check.ts applies to the recipes
// root. The deployment is a real temporary directory WITH config/ (scaffold.ts creates
// that for every real deployment; recording is live only then), and it is deleted after.
const tag = randomBytes(4).toString("hex");
const tempDeployment = await mkdtemp(join(tmpdir(), `clawforge-pp-lifetime-deployment-${tag}-`));
await mkdir(resolve(tempDeployment, "config"), { recursive: true });
const tempRecipesA = await mkdtemp(join(tmpdir(), `clawforge-pp-lifetime-recipes-a-${tag}-`));
const tempRecipesB = await mkdtemp(join(tmpdir(), `clawforge-pp-lifetime-recipes-b-${tag}-`));
await mkdir(join(tempRecipesA, "lifetime-sidecar"), { recursive: true });
await writeFile(
  join(tempRecipesA, "lifetime-sidecar", "recipe.json"),
  `${JSON.stringify({ description: "lifetime fixture sidecar", privatePaths: ["sidecar-private"] }, null, 2)}\n`,
  "utf8",
);
await mkdir(join(tempRecipesB, "set-two"), { recursive: true });
await writeFile(
  join(tempRecipesB, "set-two", "recipe.json"),
  `${JSON.stringify({ description: "the set that replaced it", privatePaths: ["set-two-private"] }, null, 2)}\n`,
  "utf8",
);

const sorted = (paths: readonly string[]): string => JSON.stringify([...paths].sort());
// What the ledger holds after the fixture's two writes: the file and the private directory
// it was written through, plus `sidecar-private` — the declared boundary both writes were
// authorized by, so exclusion and refusal outlive the declaration at its original width.
const RECORDED = ["sidecar-private", "sidecar-private/credentials.env", "sidecar-private/state"];

try {
  useDeployment(tempDeployment);
  useRecipesDir(tempRecipesA);

  // --- the ledger's own contract (no target needed) ----------------------------------------------

  check("the ledger starts empty for a fresh deployment", sorted(await persistedPrivatePaths()), "[]");
  check(
    "the ledger lives beside the deployment's desired state",
    privatePathsLedgerFile(),
    resolve(tempDeployment, "config", "private-paths.json"),
  );
  check(
    "before any private write the policy is just the declaration",
    sorted(await installedRecipePrivatePaths()),
    JSON.stringify(["sidecar-private"]),
  );

  // --- the real write, archive and verify group ----------------------------------------------------

  let transportContext: Context | undefined;
  let archives: string | undefined;
  const transport = await realPosixTransport();
  if (transport === undefined) {
    skip("archive/verify lifetime checks (no local POSIX filesystem and no WSL distribution with a shell)");
  } else {
    const PARENT = `/tmp/clawforge-pp-lifetime-${tag}`;
    const DATA_NAME = "data";
    const DATA = `${PARENT}/${DATA_NAME}`;
    const ARCHIVES = `${PARENT}/archives`;
    archives = ARCHIVES;

    await transport.mkdirp(`${DATA}/config`);
    await transport.mkdirp(`${DATA}/workspace`);
    await transport.mkdirp(ARCHIVES);
    await transport.writeFile(`${DATA}/config/openclaw.json`, JSON.stringify({ models: { providers: {} } }));
    await transport.writeFile(`${DATA}/workspace/SOUL.md`, "# fixture\n");
    // Ordinary instance content only: the content scan then has nothing to search for and
    // stays out of the path-based assertions' way.
    transportContext = { settings: { dataDir: DATA, env: {} }, transport } as unknown as Context;
    const ctx = transportContext;

    // The real private-write helpers, driven the way `recipe install` drives a prepare hook.
    const fixture = (await import(
      new URL("../../security/credentials/recipe-private-snapshot/fixture-recipe/fixture-sidecar/prepare.ts", import.meta.url).href
    )) as { prepare: (ctx: Context, recipe: Recipe) => Promise<void> };
    await fixture.prepare(ctx, await loadRecipe("lifetime-sidecar"));
    check(
      "the fixture's private write really happened on the target",
      await transport.exists(`${DATA}/sidecar-private/credentials.env`),
      true,
    );
    check("the private write was recorded with its declared boundary", sorted(await persistedPrivatePaths()), sorted(RECORDED));
    check(
      "the merged reader is the declaration and the record, deduplicated",
      sorted(await installedRecipePrivatePaths()),
      sorted(RECORDED),
    );

    // --- scenario 1: the recipe's source is removed ------------------------------------------------
    //
    // The auditor's repro, verbatim: delete the recipe directory, then ask for the policy.
    // It used to come back empty and the file became shareable.

    await rm(join(tempRecipesA, "lifetime-sidecar"), { recursive: true, force: true });
    check(
      "with the recipe source gone the recorded paths are still the policy",
      sorted(await installedRecipePrivatePaths()),
      sorted(RECORDED),
    );

    const shareAfterRemoval = `${ARCHIVES}/share-after-removal.tar.gz`;
    await createArchive(ctx, { archive: shareAfterRemoval, profile: "share" });
    check(
      "a share archive taken after the removal still leaves the recorded file out",
      (await listArchive(ctx, shareAfterRemoval)).includes("data/sidecar-private/credentials.env"),
      false,
    );
    check(
      "and it still passes verify — the record must not over-refuse",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, shareAfterRemoval, "share")),
      true,
    );

    // Defense in depth, the snapshot.check shape: an archive with no exclusions at all.
    const raw = `${ARCHIVES}/raw.tar.gz`;
    await transport.exec("tar", ["--numeric-owner", "-czf", raw, "-C", PARENT, DATA_NAME]);
    const rawOutput: string[] = [];
    check(
      "verify refuses an archive that carries the recorded file (share)",
      await withOutputSink((chunk) => rawOutput.push(chunk), () => verifySnapshot(ctx, raw, "share")),
      false,
    );
    check("the refusal names the recorded private path", rawOutput.join("").includes("sidecar-private"), true);
    check(
      "verify refuses the same archive as migrate",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, raw, "migrate")),
      false,
    );

    // --- scenario 2: switching to a set without the recipe ------------------------------------------

    useRecipesDir(tempRecipesB);
    check(
      "the record survives a switch to a set that lacks the recipe",
      sorted(await installedRecipePrivatePaths()),
      sorted(["set-two-private", ...RECORDED]),
    );
    const shareAfterSwitch = `${ARCHIVES}/share-after-switch.tar.gz`;
    await createArchive(ctx, { archive: shareAfterSwitch, profile: "share" });
    check(
      "under the new set the recorded file is still excluded",
      (await listArchive(ctx, shareAfterSwitch)).includes("data/sidecar-private/credentials.env"),
      false,
    );
    check(
      "and verify under the new set still refuses the raw archive",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, raw, "share")),
      false,
    );

    // --- explicit cleanup is the only way an entry leaves --------------------------------------------

    await transport.remove(`${DATA}/sidecar-private`);
    await forgetPrivatePaths(RECORDED);
    check("forgetPrivatePaths drops exactly the asked entries", sorted(await persistedPrivatePaths()), "[]");
    check(
      "the policy reader forgets with it",
      sorted(await installedRecipePrivatePaths()),
      JSON.stringify(["set-two-private"]),
    );

    // --- scenario 3 (P2-01 of round 3): a private write under a SHARED directory --------------------
    //
    // The declaration names one FILE inside a shared config root — the shape the old
    // ancestor recording broke: it entered `config` into the ledger, and the policy reader
    // unions the ledger with the declarations immediately, so the whole shared directory
    // was excluded from migrate/share (and open for private writes) from the first write
    // on, taking public sibling data with it. The recorded pair must be the file and its
    // declared boundary — never the undeclared ancestor.
    await mkdir(join(tempRecipesA, "shared-config-sidecar"), { recursive: true });
    await writeFile(
      join(tempRecipesA, "shared-config-sidecar", "recipe.json"),
      `${JSON.stringify({ description: "fixture writing one file of a shared config root", privatePaths: ["config/secret.env"] }, null, 2)}\n`,
      "utf8",
    );
    useRecipesDir(tempRecipesA);
    await transport.writeFile(`${DATA}/config/public-setting.json`, `{"public":true}\n`);
    await replacePrivateTargetFile(ctx, `${DATA}/config/secret.env`, "FIXTURE_SECRET=shared-config-scenario not-a-real-secret\n");
    check(
      "a shared-config write is recorded with its declared boundary, never the undeclared ancestor",
      sorted(await persistedPrivatePaths()),
      sorted(["config/secret.env"]),
    );
    check(
      "the policy names the written file, not the shared directory",
      sorted(await installedRecipePrivatePaths()),
      sorted(["config/secret.env"]),
    );
    check(
      "the public sibling is not covered for private writes either — the record did not widen them",
      /not covered by any recipe's privatePaths/.test(
        (await rejectionOf(() => replacePrivateTargetFile(ctx, `${DATA}/config/public-setting.json`, "x"))) ?? "",
      ),
      true,
    );

    const shareSharedConfig = `${ARCHIVES}/share-shared-config.tar.gz`;
    await createArchive(ctx, { archive: shareSharedConfig, profile: "share" });
    const shareSharedEntries = await listArchive(ctx, shareSharedConfig);
    check(
      "a share archive keeps the shared directory's public content",
      shareSharedEntries.includes("data/config/public-setting.json"),
      true,
    );
    check("the same archive keeps the instance's own config", shareSharedEntries.includes("data/config/openclaw.json"), true);
    check("and still leaves the written file out", shareSharedEntries.includes("data/config/secret.env"), false);

    const migrateSharedConfig = `${ARCHIVES}/migrate-shared-config.tar.gz`;
    await createArchive(ctx, { archive: migrateSharedConfig, profile: "migrate" });
    const migrateSharedEntries = await listArchive(ctx, migrateSharedConfig);
    check(
      "a migrate archive keeps the shared directory's public content too",
      migrateSharedEntries.includes("data/config/public-setting.json"),
      true,
    );
    check("and still leaves the written file out", migrateSharedEntries.includes("data/config/secret.env"), false);
    check(
      "verify passes the shared-config archive as migrate — the narrowing is not a hole",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, migrateSharedConfig, "migrate")),
      true,
    );
    // Share's allowlist deliberately refuses the unknown config/public-setting.json — the
    // P2-01 claim is only that the refusal is never a forbidden-path one.
    const sharedRefusal: string[] = [];
    check(
      "share refuses the archive only through its own allowlist",
      await withOutputSink((chunk) => sharedRefusal.push(chunk), () => verifySnapshot(ctx, shareSharedConfig, "share")),
      false,
    );
    check(
      "the share refusal names no forbidden private path",
      sharedRefusal.join("").includes("does not allow") && !sharedRefusal.join("").includes("must exclude"),
      true,
    );

    // An archive taken without the exclusions, after the write: the protection must have
    // narrowed to the exact file, not disappeared with the ancestors.
    await transport.exec("tar", ["--numeric-owner", "-czf", `${ARCHIVES}/raw-shared-config.tar.gz`, "-C", PARENT, DATA_NAME]);
    check(
      "verify refuses an unfiltered archive that carries the written file (migrate)",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, `${ARCHIVES}/raw-shared-config.tar.gz`, "migrate")),
      false,
    );

    await transport.remove(`${DATA}/config/secret.env`);
    await forgetPrivatePaths(["config/secret.env"]);
    await rm(join(tempRecipesA, "shared-config-sidecar"), { recursive: true, force: true });
  }

  // --- fail-closed reads (no target needed) --------------------------------------------------------

  useRecipesDir(tempRecipesB);
  const ledgerFile = privatePathsLedgerFile();
  await writeFile(ledgerFile, "{ not json", "utf8");
  check(
    "a corrupt ledger stops the policy reader",
    /could not parse/.test((await rejectionOf(() => installedRecipePrivatePaths())) ?? ""),
    true,
  );
  if (transportContext !== undefined && archives !== undefined) {
    check(
      "a corrupt ledger stops createArchive",
      /could not parse/.test(
        (await rejectionOf(() => createArchive(transportContext, { archive: `${archives}/broken-ledger.tar.gz`, profile: "migrate" }))) ?? "",
      ),
      true,
    );
  }
  await writeFile(ledgerFile, `${JSON.stringify({ privatePaths: ["set-two-private", "../escape"] })}\n`, "utf8");
  check(
    "a ledger entry that climbs out stops the policy reader",
    /stay inside the data directory/.test((await rejectionOf(() => installedRecipePrivatePaths())) ?? ""),
    true,
  );
  await rm(ledgerFile, { force: true });

  // --- fail-closed writes: a recording failure must abort the private write ------------------------
  //
  // The mirror of the reads above: private-config.ts records BEFORE it writes, and its own
  // comment promises that a private write which cannot be remembered is refused. The refusal
  // must be the helpers' own throw, never a silently swallowed recording failure — so the
  // stub's target-side methods are counted and must stay at zero. No real target is needed:
  // the ledger lives on this side, and the transport only has to answer the symlink scan —
  // with a side effect that turns the ledger's own path into a directory AFTER the policy
  // read, so the recording genuinely fails against real fs semantics.

  const stubData = `/tmp/clawforge-pp-lifetime-${tag}/stub-data`;
  const calls = { exec: 0, mkdirp: 0, write: 0 };
  const guardTransport = {
    async exec() {
      calls.exec += 1;
      // The policy read has just succeeded; from here the ledger's path is a directory, so
      // recordPrivateWrite's own read-then-write genuinely fails.
      try { mkdirSync(ledgerFile); } catch { /* already sabotaged */ }
      return { code: 0, stdout: "", stderr: "" };
    },
    async mkdirp() { calls.mkdirp += 1; },
    async writeFile() { calls.write += 1; },
  };
  const guardContext = { settings: { dataDir: stubData, env: {} }, transport: guardTransport } as unknown as Context;

  const directoryRejection = await rejectionOf(() =>
    ensurePrivateTargetDirectory(guardContext, `${stubData}/set-two-private/state`),
  );
  check(
    "a recording failure aborts the private directory write",
    /private-paths\.json/.test(directoryRejection ?? ""),
    true,
  );
  check("the refused directory write never reached the target", calls.mkdirp, 0);
  check("the refusal happened after the symlink scan", calls.exec, 1);

  await rm(ledgerFile, { force: true, recursive: true });
  const fileRejection = await rejectionOf(() =>
    replacePrivateTargetFile(guardContext, `${stubData}/set-two-private/credentials.env`, "x"),
  );
  check(
    "a recording failure aborts the private file write",
    /private-paths\.json/.test(fileRejection ?? ""),
    true,
  );
  check("the refused file write never reached the target either", calls.mkdirp, 0);
  check("the second refusal ran its own scan", calls.exec, 2);

  await rm(ledgerFile, { force: true, recursive: true });
  await mkdir(ledgerFile);
  const directRejection = await rejectionOf(() => recordPrivateWrite("some/where"));
  check(
    "recordPrivateWrite itself refuses a sabotaged ledger target",
    /private-paths\.json/.test(directRejection ?? ""),
    true,
  );
  check(
    "no ledger temp file survives the refusal",
    (await readdir(resolve(tempDeployment, "config"))).filter((entry) => entry.endsWith(".tmp")).length,
    0,
  );
  await rm(ledgerFile, { force: true, recursive: true });

  // --- recording without an initialized deployment is quiet, not written ---------------------------

  useDeployment(join(tmpdir(), `clawforge-pp-lifetime-absent-${tag}`));
  await recordPrivateWrite("somewhere/else");
  check(
    "recording into a deployment without config/ writes nothing",
    await access(privatePathsLedgerFile()).then(() => true, () => false),
    false,
  );
  check(
    "an invalid entry is refused even there",
    /stay inside the data directory/.test((await rejectionOf(() => recordPrivateWrite("../escape"))) ?? ""),
    true,
  );
} finally {
  await rm(tempDeployment, { recursive: true, force: true }).catch(() => {});
  await rm(tempRecipesA, { recursive: true, force: true }).catch(() => {});
  await rm(tempRecipesB, { recursive: true, force: true }).catch(() => {});
  if (previousRecipes === undefined) clearRecipesDir();
  else useRecipesDir(previousRecipes);
  if (previousDeployment !== undefined) useDeployment(previousDeployment);
}

process.stderr.write(
  failed === 0 ? "all private-declaration-lifetime checks passed\n" : `${failed} private-declaration-lifetime check(s) failed\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
