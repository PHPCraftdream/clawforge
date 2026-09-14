import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, access, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSet } from "../../../framework/commands/sets/set.ts";
import { setTry } from "../../../framework/commands/sets/set-try.ts";
import { apply } from "../../../framework/commands/orchestration/apply.ts";
import { rollback } from "../../../framework/commands/orchestration/rollback.ts";
import { useDeployment, deploymentDir, envFile } from "../../../framework/runtime/deployment.ts";
import { setSourceDir } from "../../../framework/set/artifacts/source.ts";
import { readInstalledSet } from "../../../framework/set/artifacts/install.ts";
import { listReceipts } from "../../../framework/set/artifacts/receipt.ts";
import { parseEnv, toSettings } from "../../../framework/core/env.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import type { Context } from "../../../framework/core/context.ts";
import type { ExecOptions } from "../../../framework/runtime/transport.ts";

const root = await mkdtemp(join(tmpdir(), "clawforge-set-lifecycle-"));
const previousDeployment = (() => { try { return deploymentDir(); } catch { return undefined; } })();
const sourceData = "/tmp/set-lifecycle-real/data";
const files = new Map<string, string>([[`${sourceData}/config/openclaw.json`, "{}"], [`${sourceData}/workspace/MEMORY.md`, "keep me"]]);
const dirs = new Set<string>(["/", "/tmp", "/tmp/set-lifecycle-real", sourceData, `${sourceData}/config`]);
let running = false;
let failPull = false;
let failStop = false;
let stopped = 0;
let lastTryDir = "";

function mkdirp(path: string): void {
  const parts = path.split("/").filter(Boolean);
  for (let end = 1; end <= parts.length; end += 1) dirs.add(`/${parts.slice(0, end).join("/")}`);
}
const transport = {
  description: "fixture",
  exists: async (path: string) => files.has(path) || dirs.has(path),
  readFile: async (path: string) => {
    if (!files.has(path)) throw new Error("ENOENT");
    return files.get(path)!;
  },
  writeFile: async (path: string, content: string) => { files.set(path, content); },
  mkdirp: async (path: string) => { mkdirp(path); },
  listFiles: async (path: string) => [...files.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1)),
  remove: async (path: string) => {
    for (const file of files.keys()) if (file === path || file.startsWith(`${path}/`)) files.delete(file);
    for (const dir of dirs) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
  },
  exec: async (command: string, args: string[], options: ExecOptions = {}) => {
    let code = 0;
    let stdout = "";
    if (command === "mkdir") {
      const path = args.at(-1)!;
      if (!args.includes("-p") && dirs.has(path)) code = 1;
      else mkdirp(path);
    } else if (command === "test" && args[0] === "-d") code = dirs.has(args[1]) ? 0 : 1;
    else if (command === "stat") stdout = args.includes("%Y") ? "0" : args.includes("%a") ? "700" : "1000:1000";
    else if (command === "rm") await transport.remove(args.at(-1)!);
    if (code !== 0 && !options.allowFailure) throw new Error(`${command} failed`);
    return { code, stdout, stderr: "" };
  },
};

function context(env: Record<string, string>): Context {
  const settings = toSettings(env);
  const configFile = `${settings.dataDir}/config/openclaw.json`;
  return {
    settings, transport,
    paths: { toTarget: async (path: string) => path, toContainer: (path: string) => path },
    runtime: {
      isRunning: async () => running,
      portConflict: async () => undefined,
      pullImage: async () => { if (failPull) throw new Error("fixture pull failed"); },
      start: async () => { running = true; },
      restart: async () => { running = true; },
      stop: async () => { stopped += 1; if (failStop) throw new Error("fixture teardown failed"); running = false; },
      waitForHealth: async () => {},
      health: async () => "healthy", probe: async () => 200, startedAt: async () => 1,
      imageReference: async () => settings.image,
      runningImageIdentity: async () => (running ? { imageId: "img-1", digests: [settings.image], containerId: "container-1" } : undefined),
      runOneOff: async (_service: string, args: string[]) => {
        let stdout = "{}";
        if (args.includes("onboard")) files.set(configFile, "{}");
        if (args.includes("--batch-file")) {
          const entries = JSON.parse(files.get(args[args.indexOf("--batch-file") + 1])!);
          const config = JSON.parse(files.get(configFile) ?? "{}");
          for (const { path, value } of entries) {
            const parts = path.split("."); let node = config;
            for (const key of parts.slice(0, -1)) node = node[key] ??= {};
            node[parts.at(-1)!] = value;
          }
          files.set(configFile, JSON.stringify(config));
        }
        if (args[0] === "agents") stdout = "[]";
        if (args[0] === "cron") stdout = '{"jobs":[]}';
        return { code: 0, stdout, stderr: "" };
      },
    },
  } as unknown as Context;
}

async function captured(body: () => Promise<void>): Promise<{ output: string; error?: Error }> {
  let output = ""; let error: Error | undefined;
  let machine = "";
  try { await withOutputSink((chunk) => { output += chunk; }, body, (chunk) => { machine += chunk; }); } catch (failure) { error = failure as Error; }
  return { output: machine || output, error };
}
function report(output: string): { healthy: boolean; torndown: boolean } {
  return JSON.parse(output.slice(output.lastIndexOf('{\n  "name"')));
}

try {
  await mkdir(join(root, "config"));
  const baseEnv = { OC_DATA_DIR: sourceData, OC_BIND_ADDRESS: "127.0.0.1", OC_TARGET_LOCATION: process.platform === "win32" ? "wsl" : "local", OPENCLAW_IMAGE: "fixture@sha256:abc", OPENCLAW_GATEWAY_TOKEN: "fixture-token-12345" };
  await writeFile(join(root, ".env"), Object.entries(baseEnv).map(([key, value]) => `${key}=${value}`).join("\n"));
  await writeFile(join(root, "config", "desired-state.json"), '[{"path":"gateway.mode","value":"local"},{"path":"gateway.controlUi.allowedOrigins","value":["http://127.0.0.1:18789"]}]');
  useDeployment(root);
  const ctx = context(baseEnv);
  const built = await buildSet(ctx, "lifecycle");
  const external = join(root, "incoming.tar.gz");
  await rename(built.artifact, external);

  const before = JSON.stringify([...files]);
  const dryRun = await captured(() => apply(ctx, ["--set", external, "--dry-run", "--json"]));
  assert.equal(dryRun.error, undefined);
  assert.equal(JSON.stringify([...files]), before, "dry-run must not record an installed id or mutate target files");
  assert.equal(await access(built.artifact).then(() => true, () => false), false, "dry-run must not cache an artifact");

  const first = await captured(() => apply(ctx, ["--set", external, "--json"]));
  assert.equal(first.error, undefined, first.error?.message);
  assert.equal((await readInstalledSet(ctx))?.id, built.id);
  await access(built.artifact);
  await rm(external);
  await writeFile(join(root, "config", "desired-state.json"), '[{"path":"gateway.mode","value":"local"},{"path":"agents.defaults.name","value":"second"}]');
  const next = await buildSet(ctx, "lifecycle");
  const second = await captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
  assert.equal(second.error, undefined, second.error?.message);
  assert.equal((await readInstalledSet(ctx))?.previous?.id, built.id);
  const rolledBack = await captured(() => rollback(ctx, ["--set", "--json"]));
  assert.equal(rolledBack.error, undefined, rolledBack.error?.message);
  assert.equal((await readInstalledSet(ctx))?.id, built.id);
  assert.equal(files.get(`${sourceData}/workspace/MEMORY.md`), "keep me");

  // The "second" set just rolled back from declared agents.defaults.name, which "lifecycle"
  // (the one just reinstalled) never did — apply-config is additive only (a batch config
  // set, never an unset), so reinstalling "lifecycle" alone would leave that key in place.
  const restoredConfig = JSON.parse(files.get(`${sourceData}/config/openclaw.json`) ?? "{}");
  assert.equal(
    restoredConfig?.agents?.defaults?.name,
    undefined,
    "rollback --set must undo a setting the newer set added but the older one never declared",
  );
  assert.equal(restoredConfig?.gateway?.mode, "local", "the previous set's own declared settings are still in force after rollback");

  // --- rollback --set must use the snapshot from the operation that installed the CURRENT
  // set, not "whatever snapshot is newest" — an ordinary apply run after that install also
  // takes one, and restoring THAT one would restore to a config that already includes
  // whatever the current set added. install B again, run an unrelated ordinary apply (which
  // takes its own, LATER snapshot — already including B's agents.defaults.name), then roll
  // back: agents.defaults.name must still be gone. -------------------------------------------
  {
    const reinstalled = await captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
    assert.equal(reinstalled.error, undefined, reinstalled.error?.message);
    assert.equal((await readInstalledSet(ctx))?.id, next.id);
    assert.equal((await readInstalledSet(ctx))?.previous?.id, built.id);

    // An unrelated working-tree edit, applied the ordinary way (no --set) — this takes ITS
    // OWN snapshot, of the config as B left it (agents.defaults.name already present).
    await writeFile(
      join(root, "config", "desired-state.json"),
      '[{"path":"gateway.mode","value":"local"},{"path":"agents.defaults.name","value":"second"},{"path":"agents.defaults.temperature","value":0.5}]',
    );
    const ordinary = await captured(() => apply(ctx, ["--json"]));
    assert.equal(ordinary.error, undefined, ordinary.error?.message);

    const rolledBackAgain = await captured(() => rollback(ctx, ["--set", "--json"]));
    assert.equal(rolledBackAgain.error, undefined, rolledBackAgain.error?.message);
    assert.equal((await readInstalledSet(ctx))?.id, built.id, "the set id still reverts to the previous one");

    const configAfter = JSON.parse(files.get(`${sourceData}/config/openclaw.json`) ?? "{}");
    assert.equal(
      configAfter?.agents?.defaults?.name,
      undefined,
      "an intervening ordinary apply's later snapshot must not be the one restored — B's own setting must still be undone",
    );
    assert.equal(configAfter?.agents?.defaults?.temperature, undefined, "the ordinary apply's own addition is undone too");
  }

  // --- rollback --set must verify the artifact BEFORE touching the live configuration -----
  //
  // Before the fix, the config-snapshot restore ran before withUnpackedArtifact() ever
  // verified the artifact — a corrupt archive was refused only after the config was already
  // overwritten. installed.previous is "next" (B) at this point (left there by the rollback
  // just above); its stored copy under <deployment>/sets/ is corrupted directly on disk.
  {
    const installedBefore = await readInstalledSet(ctx);
    assert.equal(installedBefore?.previous?.id, next.id, "the fixture for this test needs a previous set on record");
    const configBefore = files.get(`${sourceData}/config/openclaw.json`);

    const storedArtifact = join(root, "sets", `lifecycle-${next.id}.tar.gz`);
    await access(storedArtifact);
    // Backed up and restored rather than corrupted in place: this file (or one identical to
    // it) is also `next.artifact`, which later setTry() calls in this same file still need.
    const backup = join(root, "sets", `lifecycle-${next.id}.tar.gz.backup`);
    await copyFile(storedArtifact, backup);
    try {
      await writeFile(storedArtifact, "not a real gzip archive at all");

      const corrupted = await captured(() => rollback(ctx, ["--set", "--json"]));
      assert.notEqual(corrupted.error, undefined, "a corrupt rollback artifact must be refused");
      assert.equal(files.get(`${sourceData}/config/openclaw.json`), configBefore, "a refused rollback must leave the live configuration untouched");
      assert.equal((await readInstalledSet(ctx))?.id, installedBefore?.id, "and must not change which set is recorded as installed");
    } finally {
      await copyFile(backup, storedArtifact);
      await rm(backup, { force: true });
    }
  }

  // --- a no-op re-apply of the currently-installed set must not lose track of which
  // operation actually installed it — recordInstalledSet() must preserve operationId the
  // same way it already preserves `previous` when the id does not change. ------------------
  {
    running = true;
    const reinstalled = await captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
    assert.equal(reinstalled.error, undefined, reinstalled.error?.message);
    const afterFirstInstall = await readInstalledSet(ctx);
    assert.equal(afterFirstInstall?.id, next.id);

    // Nothing changed: this run takes applyFromSource()'s "nothing to apply" early return
    // and never opens a Journal for its own fresh operationId.
    const noop = await captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
    assert.equal(noop.error, undefined, noop.error?.message);
    const afterNoop = await readInstalledSet(ctx);
    assert.equal(
      afterNoop?.operationId,
      afterFirstInstall?.operationId,
      "a no-op re-apply must not overwrite the operationId that actually installed this set",
    );

    const rolledBackThird = await captured(() => rollback(ctx, ["--set", "--json"]));
    assert.equal(rolledBackThird.error, undefined, rolledBackThird.error?.message);
    assert.equal((await readInstalledSet(ctx))?.id, built.id);
    const configAfterThird = JSON.parse(files.get(`${sourceData}/config/openclaw.json`) ?? "{}");
    assert.equal(
      configAfterThird?.agents?.defaults?.name,
      undefined,
      "rollback --set must still undo the setting the set added, even after an intervening no-op re-apply",
    );
  }

  // --- rollback --set must check runtime/framework compatibility BEFORE the config-snapshot
  // restore, not only inside the nested apply() call that runs after it. --------------------
  {
    running = true;
    const beforeIncompatible = await readInstalledSet(ctx);
    const configBeforeIncompatible = files.get(`${sourceData}/config/openclaw.json`);
    const base = context(baseEnv);
    const incompatibleCtx = {
      ...base,
      runtime: {
        ...base.runtime,
        runningImageIdentity: async () => ({ imageId: "wrong-img", digests: ["fixture@sha256:not-what-is-required"], containerId: "container-1" }),
      },
    } as unknown as Context;
    const incompatible = await captured(() => rollback(incompatibleCtx, ["--set", "--json"]));
    assert.match(incompatible.error?.message ?? "", /cannot be reinstalled here/);
    assert.equal(
      files.get(`${sourceData}/config/openclaw.json`),
      configBeforeIncompatible,
      "a refused rollback must leave the live configuration untouched — checked before the snapshot restore, not after it inside the nested apply",
    );
    assert.equal((await readInstalledSet(ctx))?.id, beforeIncompatible?.id, "and must not change which set is recorded as installed");
  }

  const dependencies = {
    findFreePort: async () => 24567,
    createContext: async () => { lastTryDir = deploymentDir(); return context(parseEnv(await readFile(envFile(), "utf8"))); },
  };
  running = false;
  const tried = await captured(() => setTry(ctx, ["--set", next.artifact, "--json"], dependencies));
  assert.equal(tried.error, undefined, tried.error?.message);
  assert.equal(report(tried.output).torndown, true);
  assert.equal(report(tried.output).healthy, false, "no acceptance checks is not a verified deployment");
  assert.equal(await access(lastTryDir).then(() => true, () => false), false);
  assert.equal(deploymentDir(), root);
  assert.equal(setSourceDir(), undefined);

  failPull = true;
  const failedTry = await captured(() => setTry(ctx, ["--set", next.artifact, "--json"], dependencies));
  assert.match(failedTry.error?.message ?? "", /pull failed/);
  assert.equal(report(failedTry.output).torndown, true);
  assert.equal(report(failedTry.output).healthy, false);
  assert.equal(deploymentDir(), root);
  failPull = false;
  failStop = true;
  const incomplete = await captured(() => setTry(ctx, ["--set", next.artifact, "--json"], dependencies));
  assert.match(incomplete.error?.message ?? "", /cleanup failed/);
  assert.equal(report(incomplete.output).torndown, false);
  await access(lastTryDir);
  assert.ok(stopped >= 3, "even a failed bootstrap must attempt teardown");
  assert.equal(files.get(`${sourceData}/workspace/MEMORY.md`), "keep me");
  assert.equal(setSourceDir(), undefined);
  failStop = false;
  const kept = await captured(() => setTry(ctx, ["--set", next.artifact, "--json", "--keep"], dependencies));
  assert.equal(kept.error, undefined, kept.error?.message);
  assert.equal(report(kept.output).torndown, false);
  await access(join(lastTryDir, "config", "desired-state.json"));
  const keptApp = await import(pathToFileURL(join(lastTryDir, "app.ts")).href);
  assert.equal(keptApp.default.service.name, "gateway");
  assert.equal(deploymentDir(), root);
  assert.equal(setSourceDir(), undefined);
  const evidence = await listReceipts(next.id);
  assert.equal(evidence.length, 4, "success, startup failure, teardown failure and kept trials each leave evidence");
  assert.ok(evidence.every((receipt) => receipt.verdict === "not-verified"), "empty acceptance never certifies a set");

  // --- apply --set must refuse before recording a set whose required image the runtime
  // does not run, not record it as installed with nothing said about the mismatch. -------
  {
    running = true;
    const beforeMismatch = await readInstalledSet(ctx);
    const mismatchedCtx = context({ ...baseEnv, OPENCLAW_IMAGE: "fixture@sha256:def" });
    const mismatched = await captured(() => apply(mismatchedCtx, ["--set", next.artifact, "--json"]));
    assert.match(mismatched.error?.message ?? "", /cannot be installed here/);
    assert.match(mismatched.error?.message ?? "", /fixture@sha256:def/);
    assert.equal(
      (await readInstalledSet(ctx))?.id,
      beforeMismatch?.id,
      "a refused apply --set must not overwrite the previously-installed set",
    );
  }

  // --- a stale local tag must not fool the check — the running CONTAINER is what has to
  // match, not whatever a re-pulled tag now points to locally. -----------------------------
  {
    running = true;
    const beforeStaleTag = await readInstalledSet(ctx);
    const base = context(baseEnv);
    const staleTagCtx = {
      ...base,
      runtime: {
        ...base.runtime,
        // The locally re-pulled tag already matches — imageReference() alone would have
        // passed this. The running container is still on a different image, exactly the
        // "docker pull without recreating the container" scenario imageReference() cannot
        // see, and runningImageIdentity() (what the fix now uses) can.
        imageReference: async () => next.manifest.requires.image,
        runningImageIdentity: async () => ({ imageId: "stale-img", digests: ["fixture@sha256:stale-not-required"], containerId: "container-1" }),
      },
    } as unknown as Context;
    const staleTag = await captured(() => apply(staleTagCtx, ["--set", next.artifact, "--json"]));
    assert.match(
      staleTag.error?.message ?? "",
      /cannot be installed here/,
      "a stale local tag must not fool the check — the running container is what matters",
    );
    assert.equal((await readInstalledSet(ctx))?.id, beforeStaleTag?.id);
  }

  // --- a running container whose image cannot be resolved to any digest at all must not be
  // recorded as installed — absence of a proven mismatch is not proof of a match. -----------
  {
    running = true;
    const beforeUnconfirmed = await readInstalledSet(ctx);
    const base = context(baseEnv);
    const unconfirmedCtx = {
      ...base,
      runtime: {
        ...base.runtime,
        // Running, but docker could not report any RepoDigests for it at all.
        runningImageIdentity: async () => ({ imageId: "unresolvable-img", digests: [], containerId: "container-1" }),
      },
    } as unknown as Context;
    const unconfirmed = await captured(() => apply(unconfirmedCtx, ["--set", next.artifact, "--json"]));
    assert.match(
      unconfirmed.error?.message ?? "",
      /could not be resolved to any digest/,
      "no resolvable digest at all must refuse recording, not be treated as 'nothing to compare'",
    );
    assert.equal((await readInstalledSet(ctx))?.id, beforeUnconfirmed?.id);
  }

  // --- a running container with NO image identity at all (not merely empty digests) must
  // also refuse recording — no container found by containerId, or a runtime backend that
  // does not implement runningImageIdentity(), is exactly as unproven as an empty digests
  // array. -------------------------------------------------------------------------------
  {
    running = true;
    const beforeNoIdentity = await readInstalledSet(ctx);
    const base = context(baseEnv);
    const noIdentityCtx = {
      ...base,
      runtime: {
        ...base.runtime,
        runningImageIdentity: async () => undefined,
      },
    } as unknown as Context;
    const noIdentity = await captured(() => apply(noIdentityCtx, ["--set", next.artifact, "--json"]));
    assert.match(
      noIdentity.error?.message ?? "",
      /could not be resolved to any digest/,
      "no image identity at all must refuse recording, not be treated as confirmed",
    );
    assert.equal((await readInstalledSet(ctx))?.id, beforeNoIdentity?.id);
  }

  // --- rollback --set must re-verify the installed set under the lock, not act on a stale
  // pre-lock read — another apply --set can complete installing a newer set (C) in the
  // window between rollbackSet's initial readInstalledSet() and takeLock(). --------------
  {
    running = true;
    const setup = await captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
    assert.equal(setup.error, undefined, setup.error?.message);
    const beforeRace = await readInstalledSet(ctx);
    assert.equal(beforeRace?.id, next.id, "the fixture for this test needs B installed with a previous (A) on record");

    let raced = false;
    const raceRecord = {
      id: "c".repeat(64),
      name: next.manifest.name,
      installedAt: new Date().toISOString(),
      requires: next.manifest.requires,
      previous: { id: beforeRace!.id, name: beforeRace!.name, installedAt: beforeRace!.installedAt },
    };
    const raceCtx = {
      ...ctx,
      transport: {
        ...ctx.transport,
        exec: async (command: string, args: string[], options?: ExecOptions) => {
          if (!raced && command === "mkdir" && !args.includes("-p")) {
            raced = true;
            // Simulates apply --set installing "C" completing in the window just before
            // this rollback's own lock claim actually lands.
            files.set(`${sourceData}/clawforge-installed-set.json`, `${JSON.stringify(raceRecord, null, 2)}\n`);
          }
          return transport.exec(command, args, options);
        },
      },
    } as unknown as Context;

    const rolledBackRaced = await captured(() => rollback(raceCtx, ["--set", "--json"]));
    assert.match(rolledBackRaced.error?.message ?? "", /installed set changed while this rollback was preparing/);
    assert.equal(
      (await readInstalledSet(ctx))?.id,
      raceRecord.id,
      "the race winner's install must survive — a stale rollback must not silently overwrite it",
    );
  }

  // --- rollback --set must refuse when the snapshot it needs is missing/gone, not silently
  // skip the restore and report the reinstall a success. -----------------------------------
  {
    running = true;
    // Reset to a clean, valid A -> B chain: the previous test left a fabricated "C" record
    // on file with no real stored artifact, which would refuse for an unrelated reason
    // (missing artifact) before ever reaching the snapshot check this test is about. The
    // live config is also forced to a value neither A nor B declares, so reinstalling each
    // one below is guaranteed to find real CONFIG_DRIFT and actually take a snapshot — with
    // nothing forcing drift, a config that happened to already match produces a genuine
    // no-op apply, which (correctly) takes no snapshot at all, leaving nothing to delete.
    files.set(`${sourceData}/config/openclaw.json`, JSON.stringify({ gateway: { mode: "remote" } }));
    const resetToA = await captured(() => apply(ctx, ["--set", built.artifact, "--json"]));
    assert.equal(resetToA.error, undefined, resetToA.error?.message);
    const reinstallB = await captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
    assert.equal(reinstallB.error, undefined, reinstallB.error?.message);
    const installedB = await readInstalledSet(ctx);
    assert.equal(installedB?.previous?.id, built.id, "the fixture for this test needs a valid previous (A) on record");
    assert.ok(installedB?.operationId !== undefined, "the fixture for this test needs a recorded operationId");

    const snapshotPath = `${sourceData}/clawforge-operations/${installedB!.operationId}.openclaw.json`;
    assert.ok(files.has(snapshotPath), "the fixture for this test needs the operation's own snapshot to exist first");
    const configBeforeMissingSnapshot = files.get(`${sourceData}/config/openclaw.json`);
    files.delete(snapshotPath);

    const missingSnapshot = await captured(() => rollback(ctx, ["--set", "--json"]));
    assert.match(missingSnapshot.error?.message ?? "", /no configuration snapshot is available/);
    assert.equal(
      files.get(`${sourceData}/config/openclaw.json`),
      configBeforeMissingSnapshot,
      "a refused rollback must leave the live configuration untouched",
    );
    assert.equal((await readInstalledSet(ctx))?.id, installedB?.id, "and must not change which set is recorded as installed");
  }

  process.stderr.write("all set lifecycle checks passed\n");
} finally {
  if (previousDeployment !== undefined) useDeployment(previousDeployment);
  await rm(root, { recursive: true, force: true });
}
