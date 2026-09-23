// P1-02 of docs/review-2026-09-22-xa-round-3.md: the privacy ledger lives operator-side at
// <deployment>/config/private-paths.json, but a full backup publishes a copy into the data
// root at <dataDir>/config/clawforge-private-paths.json (createArchive, profile "full"), and
// restoreArchive imports it back into the deployment ledger after verifyRestoredLayout.
//
// The ledger describes the target while living on the operator side, so recording a private
// write used to help only while the backup was restored through the very deployment directory
// the write was recorded in. A restore through a different one — a new folder, a lost one,
// another machine managing the same target — arrived with the data and none of its history,
// and the next migrate/share built its exclusions from an empty record: fail-closed for a
// ledger that exists but cannot be read is still fail-open for one that is simply not there.
//
// Part A drives the ledger/history contract itself — the publish unit, the empty-ledger
// removal, the import's merge and its two refusals. It needs no target and runs everywhere.
// Part B is the whole scenario over real GNU tar and a real POSIX filesystem (LocalTransport
// off Windows, a WSL distribution on it): a real private write through the fixture recipe's
// prepare hook, a full backup, then a restore through a DIFFERENT, fresh operator-side
// deployment with NO recipes — the written file is still classified private (excluded from
// share, refused by verify) — a corrupt history copy fails the restore with the previous data
// put back, and a repeated restore changes nothing. The lesson of the 2026-09-21 audit
// stands: a simulated tar cannot contradict the code it was modelled on.

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { restoreArchive } from "#framework/commands/lifecycle/restore.ts";
import { verifySnapshot } from "#framework/commands/lifecycle/verify.ts";
import { parseWslDistroListing } from "#framework/commands/interface/host/contexts.ts";
import type { Context } from "#framework/core/context.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { deploymentDir, useDeployment } from "#framework/runtime/deployment.ts";
import { LocalTransport, spawnLocal, WslTransport, type Transport } from "#framework/runtime/transport.ts";
import { createArchive, listArchive } from "#framework/service/archive.ts";
import { sudoFor } from "#framework/runtime/datadir.ts";
import {
  clearRecipesDir,
  installedRecipePrivatePaths,
  loadRecipe,
  recipesDirectory,
  useRecipesDir,
  type Recipe,
} from "#framework/service/recipe.ts";
import {
  importRestoredPrivatePathsHistory,
  persistedPrivatePaths,
  privatePathsHistoryFile,
  privatePathsLedgerFile,
  publishPrivatePathsHistory,
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
// root. Both deployments are real temporary directories WITH config/ (scaffold.ts creates
// that for every real deployment; recording and importing are live only then): A is the
// operator side the private write is really recorded in, B the fresh one the restore runs
// through. The recipe roots are the set that declares the write (A) and an empty one (B).
const tag = randomBytes(4).toString("hex");
const deploymentA = await mkdtemp(join(tmpdir(), `clawforge-pp-history-deployment-a-${tag}-`));
await mkdir(resolve(deploymentA, "config"), { recursive: true });
const deploymentB = await mkdtemp(join(tmpdir(), `clawforge-pp-history-deployment-b-${tag}-`));
await mkdir(resolve(deploymentB, "config"), { recursive: true });
const recipesA = await mkdtemp(join(tmpdir(), `clawforge-pp-history-recipes-a-${tag}-`));
const recipesB = await mkdtemp(join(tmpdir(), `clawforge-pp-history-recipes-b-${tag}-`));
await mkdir(join(recipesA, "history-sidecar"), { recursive: true });
await writeFile(
  join(recipesA, "history-sidecar", "recipe.json"),
  `${JSON.stringify({ description: "history fixture sidecar", privatePaths: ["sidecar-private"] }, null, 2)}\n`,
  "utf8",
);

const sorted = (paths: readonly string[]): string => JSON.stringify([...paths].sort());
// What the ledger holds after the fixture's two writes: the file and the private directory
// it was written through, plus their shared private ancestor — the same shape the
// declaration had, so exclusion and refusal outlive both it and the deployment change.
const RECORDED = ["sidecar-private", "sidecar-private/credentials.env", "sidecar-private/state"];

let transport: Transport | undefined;
let PARENT: string | undefined;

try {
  useDeployment(deploymentA);

  // === PART A — the ledger/history contract, no target needed =====================================

  check(
    "the history copy lives in the data root's config/",
    privatePathsHistoryFile("/srv/x/data"),
    "/srv/x/data/config/clawforge-private-paths.json",
  );
  check(
    "a trailing slash on the data directory is tolerated",
    privatePathsHistoryFile("/srv/x/data/"),
    "/srv/x/data/config/clawforge-private-paths.json",
  );

  // A real recorded write (the ledger itself, no target), then the publish unit: the copy is
  // written through the transport's private write into the data root, and names exactly what
  // was recorded — sorted, as writeLedger writes it. The declared boundary is passed
  // explicitly (round 3, P2-01): recordPrivateWrite no longer infers ancestors from the path
  // alone, so a synthetic "vault" directory declaration is named here the way a real caller
  // (assertDeclaredPrivatePath) would.
  await recordPrivateWrite("vault/credentials.env", "vault");
  const privateWrites: { path: string; body?: string; mode?: string }[] = [];
  const plainWrites: { path: string; body?: string; mode?: string }[] = [];
  const publishCtx = {
    settings: { dataDir: "/tgt/data", env: {} },
    transport: {
      async exists(): Promise<boolean> { return false; },
      async mkdirp(): Promise<void> {},
      async writePrivateFile(path: string, body: string): Promise<void> { privateWrites.push({ path, body }); },
      async writeFile(path: string, body: string, mode?: string): Promise<void> { plainWrites.push({ path, body, mode }); },
    },
  } as unknown as Context;
  await publishPrivatePathsHistory(publishCtx);
  check("the copy is written exactly once", privateWrites.length + plainWrites.length, 1);
  check("it went into the data root's config/", privateWrites[0]?.path, "/tgt/data/config/clawforge-private-paths.json");
  check("and it was written as a private file", privateWrites.length === 1 && plainWrites.length === 0, true);
  const published = JSON.parse(privateWrites[0]?.body ?? "null") as { privatePaths?: string[] } | null;
  check(
    "it names the recorded paths",
    sorted(published?.privatePaths ?? []),
    sorted(["vault", "vault/credentials.env"]),
  );
  // The entry was only publish's vehicle: Part B records the fixture's writes into this same
  // ledger and expects exactly RECORDED there.
  await rm(privatePathsLedgerFile(), { force: true });

  // An empty ledger publishes nothing and REMOVES a stale copy instead: forget is
  // deliberate, and a copy left behind would resurrect forgotten entries at the next restore.
  useDeployment(deploymentB);
  check("the fresh deployment B starts with no ledger of its own", sorted(await persistedPrivatePaths()), "[]");
  const removals: string[] = [];
  const emptyLedgerWrites: { path: string; body?: string; mode?: string }[] = [];
  const removeCtx = {
    settings: { dataDir: "/tgt/data", env: {} },
    transport: {
      async exists(): Promise<boolean> { return true; },
      async remove(path: string): Promise<void> { removals.push(path); },
      async mkdirp(): Promise<void> {},
      async writePrivateFile(path: string, body: string): Promise<void> { emptyLedgerWrites.push({ path, body }); },
      async writeFile(path: string, body: string, mode?: string): Promise<void> { emptyLedgerWrites.push({ path, body, mode }); },
    },
  } as unknown as Context;
  await publishPrivatePathsHistory(removeCtx);
  check("an empty ledger removes a stale copy instead of publishing nothing", removals.length, 1);
  check("the removal names the published copy's path", removals[0], "/tgt/data/config/clawforge-private-paths.json");
  check("and nothing was written for an empty ledger", emptyLedgerWrites.length, 0);

  // The import, against deployment B's real ledger: sudoFor probes first (`test -w` answers
  // "writable" for everything here), and only `cat` carries the restored copy's bytes.
  const HISTORY = privatePathsHistoryFile("/tgt/data");
  const importCtxFor = (payload: string): Context =>
    ({
      settings: { dataDir: "/tgt/data", env: {} },
      transport: {
        async exists(): Promise<boolean> { return true; },
        async exec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
          if (command === "cat") return { code: 0, stdout: payload, stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    }) as unknown as Context;

  const MERGED = ["ledger-a", "ledger-a/secret.env"];
  const addedFirst = await importRestoredPrivatePathsHistory(importCtxFor(JSON.stringify({ privatePaths: MERGED })), HISTORY);
  check("the import merges the restored history into a fresh ledger", sorted(await persistedPrivatePaths()), sorted(MERGED));
  check("both entries are reported as added", sorted(addedFirst), sorted(MERGED));

  const addedSecond = await importRestoredPrivatePathsHistory(
    importCtxFor(JSON.stringify({ privatePaths: ["other"] })),
    HISTORY,
  );
  check("a second import unions with what is already there", sorted(await persistedPrivatePaths()), sorted([...MERGED, "other"]));
  check("and reports only the entries it added", sorted(addedSecond), JSON.stringify(["other"]));

  // Fail closed: a copy that exists but cannot be read or validated must never read as "no
  // history" — and the refusal happens before anything is written.
  const parseRejection = await rejectionOf(() => importRestoredPrivatePathsHistory(importCtxFor("{ not json"), HISTORY));
  check("a history copy that cannot be parsed fails the import", /could not parse/.test(parseRejection ?? ""), true);
  check("and the failed parse wrote nothing", sorted(await persistedPrivatePaths()), sorted([...MERGED, "other"]));

  const escapeRejection = await rejectionOf(() =>
    importRestoredPrivatePathsHistory(importCtxFor(JSON.stringify({ privatePaths: ["../escape"] })), HISTORY),
  );
  check(
    "a history entry that climbs out of the data directory is refused",
    /stay inside the data directory/.test(escapeRejection ?? ""),
    true,
  );

  // Part B restores into deployment B and expects its ledger to start genuinely fresh.
  await rm(privatePathsLedgerFile(), { force: true });

  // === PART B — the real end-to-end scenario (real POSIX filesystem + real GNU tar) ===============

  transport = await realPosixTransport();
  if (transport === undefined) {
    skip("the private-history restore checks (no local POSIX filesystem and no WSL distribution with a shell)");
  } else {
    PARENT = `/tmp/clawforge-pp-history-${tag}`;
    const DATA_NAME = "data";
    const DATA = `${PARENT}/${DATA_NAME}`;
    const ARCHIVES = `${PARENT}/archives`;

    await transport.mkdirp(`${DATA}/config`);
    await transport.mkdirp(`${DATA}/workspace`);
    await transport.mkdirp(ARCHIVES);
    await transport.writeFile(`${DATA}/config/openclaw.json`, JSON.stringify({ models: { providers: {} } }));
    await transport.writeFile(`${DATA}/workspace/SOUL.md`, "# fixture\n");
    // Ordinary instance content only: the content scan then has nothing to search for and
    // stays out of the path-based assertions' way.
    const ctx = { settings: { dataDir: DATA, env: {} }, transport } as unknown as Context;

    // The operator side the private write is REALLY recorded in, and the recipe that declares
    // it — the deployment the audit's scenario starts from.
    useDeployment(deploymentA);
    useRecipesDir(recipesA);

    // The real private-write helpers, driven the way `recipe install` drives a prepare hook.
    const fixture = (await import(
      new URL("../security/credentials/recipe-private-snapshot/fixture-recipe/fixture-sidecar/prepare.ts", import.meta.url).href
    )) as { prepare: (ctx: Context, recipe: Recipe) => Promise<void> };
    await fixture.prepare(ctx, await loadRecipe("history-sidecar"));
    check(
      "the fixture's private write really happened on the target",
      await transport.exists(`${DATA}/sidecar-private/credentials.env`),
      true,
    );
    check("the private write was recorded with its private ancestors", sorted(await persistedPrivatePaths()), sorted(RECORDED));

    // The backup carries the history physically: publish runs before tar, and full keeps it.
    const fullBackup = `${ARCHIVES}/full.tar.gz`;
    await createArchive(ctx, { archive: fullBackup, profile: "full" });
    const fullEntries = await listArchive(ctx, fullBackup);
    check("the full backup keeps the private file", fullEntries.includes("data/sidecar-private/credentials.env"), true);
    check(
      "the full backup carries the privacy history physically",
      fullEntries.includes("data/config/clawforge-private-paths.json"),
      true,
    );

    // The fresh operator-side deployment: a different directory, and a recipe set that holds
    // nothing that declares the write. The audit's precondition, verbatim.
    useDeployment(deploymentB);
    useRecipesDir(recipesB);
    check(
      "the fresh deployment starts with no declarations and no record",
      sorted(await installedRecipePrivatePaths()),
      "[]",
    );
    const runtimeStub = {
      async stop(): Promise<void> {},
      async start(): Promise<void> {},
      async waitForHealth(): Promise<void> {},
    };
    const restoreCtx = { settings: { dataDir: DATA, env: {} }, transport, runtime: runtimeStub } as unknown as Context;
    let restoreOutput = "";
    let restoreThrew = false;
    try {
      await withOutputSink((chunk) => { restoreOutput += chunk; }, () => restoreArchive(restoreCtx, fullBackup, { force: true }));
    } catch {
      restoreThrew = true;
    }
    check("the restore through the fresh deployment succeeds", restoreThrew, false);
    check("its ledger now holds the restored history", sorted(await persistedPrivatePaths()), sorted(RECORDED));
    check(
      "the whole policy is the history, with no declaration anywhere",
      sorted(await installedRecipePrivatePaths()),
      sorted(RECORDED),
    );
    check("the restore says the history was restored", restoreOutput.includes("privacy history"), true);

    // The acceptance criterion: what the next migrate/share does with the restored data.
    // createArchive runs under deployment B, whose policy now comes entirely from the
    // restored history.
    const shareAfterRestore = `${ARCHIVES}/share-after-restore.tar.gz`;
    await createArchive(ctx, { archive: shareAfterRestore, profile: "share" });
    const shareEntries = await listArchive(ctx, shareAfterRestore);
    check(
      "a share archive taken after the restore leaves the private file out",
      shareEntries.includes("data/sidecar-private/credentials.env"),
      false,
    );
    check(
      "and the history copy itself does not travel in share",
      shareEntries.includes("data/config/clawforge-private-paths.json"),
      false,
    );

    // Symmetrically for migrate — and it is not a duplicate of the share assert: the copy is
    // published into the LIVE data root by every full backup and stays on disk afterwards,
    // so once one full backup exists, an explicit exclusion is the only thing keeping it out
    // of every profile-limited archive taken later. The first assert re-pins the restored
    // policy (the union under deployment B); the second is the exclusion this file exists
    // to hold in place.
    const migrateAfterRestore = `${ARCHIVES}/migrate-after-restore.tar.gz`;
    await createArchive(ctx, { archive: migrateAfterRestore, profile: "migrate" });
    const migrateEntries = await listArchive(ctx, migrateAfterRestore);
    check(
      "a migrate archive taken after the restore leaves the private file out",
      migrateEntries.includes("data/sidecar-private/credentials.env"),
      false,
    );
    check(
      "and the history copy itself does not travel in migrate",
      migrateEntries.includes("data/config/clawforge-private-paths.json"),
      false,
    );

    // Defense in depth, the snapshot.check shape: an archive with no exclusions at all — so,
    // unlike createArchive, this deliberately walks straight into sidecar-private too. Real
    // read access to it needs the same escalation createArchive now asks for on its own
    // restricted subpath (XS round 4 CI fallout): a CI identity that owns this tree's other
    // files outright still cannot open a directory ensurePrivateTargetDirectory locked to
    // 1000:1000 mode 700.
    const rawPrefix = await sudoFor(ctx, `${DATA}/sidecar-private`);
    const [rawHead, ...rawRest] = [...rawPrefix, "tar", "--numeric-owner", "-czf", `${ARCHIVES}/raw.tar.gz`, "-C", PARENT, DATA_NAME];
    await transport.exec(rawHead, rawRest);
    check(
      "verify refuses the raw archive as share",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, `${ARCHIVES}/raw.tar.gz`, "share")),
      false,
    );
    check(
      "verify refuses the same archive as migrate",
      await withOutputSink(() => {}, () => verifySnapshot(ctx, `${ARCHIVES}/raw.tar.gz`, "migrate")),
      false,
    );

    // A corrupt history copy must fail the restore — with the previous data put back and the
    // ledger untouched.
    await transport.writeFile(`${DATA}/workspace/live-marker.md`, "previous data\n");
    // A separate archive tree, so its markers differ from the live ones.
    await transport.mkdirp(`${PARENT}/corrupt-src/data/config`);
    await transport.mkdirp(`${PARENT}/corrupt-src/data/workspace`);
    await transport.writeFile(`${PARENT}/corrupt-src/data/config/openclaw.json`, JSON.stringify({ models: { providers: {} } }));
    await transport.writeFile(`${PARENT}/corrupt-src/data/workspace/from-archive.md`, "archive data\n");
    await transport.writeFile(`${PARENT}/corrupt-src/data/config/clawforge-private-paths.json`, "{ not json");
    await transport.exec("tar", [
      "--numeric-owner",
      "-czf",
      `${ARCHIVES}/corrupt.tar.gz`,
      "-C",
      `${PARENT}/corrupt-src`,
      DATA_NAME,
    ]);
    // The successful restores above each keep their previous tree at data.replaced-<stamp>;
    // that is earlier history, not this restore's. Removed so the rollback assertions below
    // are about the failed restore alone.
    await transport.exec("sh", ["-c", "rm -rf -- \"$1\"/data.replaced-*", "sh", PARENT], { allowFailure: true });

    let corruptThrew = false;
    let corruptMessage = "";
    try {
      await withOutputSink(() => {}, () => restoreArchive(restoreCtx, `${ARCHIVES}/corrupt.tar.gz`, { force: true }));
    } catch (error) {
      corruptThrew = true;
      corruptMessage = (error as Error).message;
    }
    check("the restore with a corrupt history copy fails", corruptThrew, true);
    check("it fails closed on the parse", /could not parse/.test(corruptMessage), true);
    check("the previous live data was put back", await transport.exists(`${DATA}/workspace/live-marker.md`), true);
    check("the archive's own marker never landed", await transport.exists(`${DATA}/workspace/from-archive.md`), false);
    const replacedLeft = await transport.exec(
      "sh",
      ["-c", "ls -1d \"$1\"/data.replaced-* 2>/dev/null", "sh", PARENT],
      { allowFailure: true },
    );
    check("no replaced-aside directory is left behind", replacedLeft.stdout.trim(), "");
    check("the failed restore never touched the ledger", sorted(await persistedPrivatePaths()), sorted(RECORDED));

    // Restoring the same full backup again must change nothing: the import is a union.
    let idempotentThrew = false;
    try {
      await withOutputSink(() => {}, () => restoreArchive(restoreCtx, fullBackup, { force: true }));
    } catch {
      idempotentThrew = true;
    }
    check("a second restore of the same backup succeeds", idempotentThrew, false);
    check(
      "and the ledger still holds exactly the recorded paths",
      sorted(await persistedPrivatePaths()),
      sorted(RECORDED),
    );
  }
} finally {
  await rm(deploymentA, { recursive: true, force: true }).catch(() => {});
  await rm(deploymentB, { recursive: true, force: true }).catch(() => {});
  await rm(recipesA, { recursive: true, force: true }).catch(() => {});
  await rm(recipesB, { recursive: true, force: true }).catch(() => {});
  if (transport !== undefined && PARENT !== undefined) await transport.remove(PARENT).catch(() => {});
  if (previousRecipes === undefined) clearRecipesDir();
  else useRecipesDir(previousRecipes);
  if (previousDeployment !== undefined) useDeployment(previousDeployment);
}

process.stderr.write(
  failed === 0 ? "all private-history-restore checks passed\n" : `${failed} private-history-restore check(s) failed\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
