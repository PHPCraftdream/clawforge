// `apply --set` / `rollback --set` — the core, deliberately SEQUENTIAL story: install A,
// install B, roll back to A, then a series of refusal/edge-case scenarios that all build on
// that same installed-set chain (a corrupt rollback artifact, an intervening ordinary
// apply's snapshot, a no-op re-apply preserving operationId, runtime/image mismatches, a
// race under the lock, a missing snapshot). Split out of set-lifecycle.check.ts; see
// fixture.ts for the shared transport/context, and snapshot-transitions.check.ts /
// set-try-flow.check.ts for the self-contained scenarios that do not need this chain.
//
// Deliberately NOT split further: every block below depends on installed-set state
// (`built`/`next`, and what's currently recorded as installed/previous) that the block
// immediately before it left behind — re-deriving that from scratch per block would risk
// silently testing something subtly different from what the original, single sequential
// story proved.

import assert from "node:assert/strict";
import { writeFile, rm, rename, access, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSet } from "#framework/commands/sets/set.ts";
import { apply } from "#framework/commands/orchestration/apply.ts";
import { rollback } from "#framework/commands/orchestration/rollback.ts";
import { readInstalledSet } from "#framework/set/artifacts/install.ts";
import { createFixture } from "./fixture.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecOptions } from "#framework/runtime/transport.ts";

const fixture = await createFixture();
const { root, sourceData, files, ctx, baseEnv } = fixture;

try {
  const built = await buildSet(ctx, "lifecycle");
  const external = join(root, "incoming.tar.gz");
  await rename(built.artifact, external);

  const before = JSON.stringify([...files]);
  const dryRun = await fixture.captured(() => apply(ctx, ["--set", external, "--dry-run", "--json"]));
  assert.equal(dryRun.error, undefined);
  assert.equal(JSON.stringify([...files]), before, "dry-run must not record an installed id or mutate target files");
  assert.equal(await access(built.artifact).then(() => true, () => false), false, "dry-run must not cache an artifact");

  const first = await fixture.captured(() => apply(ctx, ["--set", external, "--json"]));
  assert.equal(first.error, undefined, first.error?.message);
  assert.equal((await readInstalledSet(ctx))?.id, built.id);
  await access(built.artifact);
  await rm(external);
  await writeFile(join(root, "config", "desired-state.json"), '[{"path":"gateway.mode","value":"local"},{"path":"agents.defaults.name","value":"second"}]');
  const next = await buildSet(ctx, "lifecycle");
  const second = await fixture.captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
  assert.equal(second.error, undefined, second.error?.message);
  assert.equal((await readInstalledSet(ctx))?.previous?.id, built.id);
  const rolledBack = await fixture.captured(() => rollback(ctx, ["--set", "--json"]));
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
    const reinstalled = await fixture.captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
    assert.equal(reinstalled.error, undefined, reinstalled.error?.message);
    assert.equal((await readInstalledSet(ctx))?.id, next.id);
    assert.equal((await readInstalledSet(ctx))?.previous?.id, built.id);

    // An unrelated working-tree edit, applied the ordinary way (no --set) — this takes ITS
    // OWN snapshot, of the config as B left it (agents.defaults.name already present).
    await writeFile(
      join(root, "config", "desired-state.json"),
      '[{"path":"gateway.mode","value":"local"},{"path":"agents.defaults.name","value":"second"},{"path":"agents.defaults.temperature","value":0.5}]',
    );
    const ordinary = await fixture.captured(() => apply(ctx, ["--json"]));
    assert.equal(ordinary.error, undefined, ordinary.error?.message);

    const rolledBackAgain = await fixture.captured(() => rollback(ctx, ["--set", "--json"]));
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
    // it) is also `next.artifact`, which later set-try-flow.check.ts's own setTry() calls
    // still need (a fresh build there, but from the same content, same id).
    const backup = join(root, "sets", `lifecycle-${next.id}.tar.gz.backup`);
    await copyFile(storedArtifact, backup);
    try {
      await writeFile(storedArtifact, "not a real gzip archive at all");

      const corrupted = await fixture.captured(() => rollback(ctx, ["--set", "--json"]));
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
    fixture.state.running = true;
    const reinstalled = await fixture.captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
    assert.equal(reinstalled.error, undefined, reinstalled.error?.message);
    const afterFirstInstall = await readInstalledSet(ctx);
    assert.equal(afterFirstInstall?.id, next.id);

    // Nothing changed: this run takes applyFromSource()'s "nothing to apply" early return
    // and never opens a Journal for its own fresh operationId.
    const noop = await fixture.captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
    assert.equal(noop.error, undefined, noop.error?.message);
    const afterNoop = await readInstalledSet(ctx);
    assert.equal(
      afterNoop?.operationId,
      afterFirstInstall?.operationId,
      "a no-op re-apply must not overwrite the operationId that actually installed this set",
    );

    const rolledBackThird = await fixture.captured(() => rollback(ctx, ["--set", "--json"]));
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
    fixture.state.running = true;
    const beforeIncompatible = await readInstalledSet(ctx);
    const configBeforeIncompatible = files.get(`${sourceData}/config/openclaw.json`);
    const base = fixture.context(baseEnv);
    const incompatibleCtx = {
      ...base,
      runtime: {
        ...base.runtime,
        runningImageIdentity: async () => ({ imageId: "wrong-img", digests: ["fixture@sha256:not-what-is-required"], containerId: "container-1" }),
      },
    } as unknown as Context;
    const incompatible = await fixture.captured(() => rollback(incompatibleCtx, ["--set", "--json"]));
    assert.match(incompatible.error?.message ?? "", /cannot be reinstalled here/);
    assert.equal(
      files.get(`${sourceData}/config/openclaw.json`),
      configBeforeIncompatible,
      "a refused rollback must leave the live configuration untouched — checked before the snapshot restore, not after it inside the nested apply",
    );
    assert.equal((await readInstalledSet(ctx))?.id, beforeIncompatible?.id, "and must not change which set is recorded as installed");
  }

  // --- apply --set must refuse before recording a set whose required image the runtime
  // does not run, not record it as installed with nothing said about the mismatch. -------
  {
    fixture.state.running = true;
    const beforeMismatch = await readInstalledSet(ctx);
    const mismatchedCtx = fixture.context({ ...baseEnv, OPENCLAW_IMAGE: "fixture@sha256:def" });
    const mismatched = await fixture.captured(() => apply(mismatchedCtx, ["--set", next.artifact, "--json"]));
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
    fixture.state.running = true;
    const beforeStaleTag = await readInstalledSet(ctx);
    const base = fixture.context(baseEnv);
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
    const staleTag = await fixture.captured(() => apply(staleTagCtx, ["--set", next.artifact, "--json"]));
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
    fixture.state.running = true;
    const beforeUnconfirmed = await readInstalledSet(ctx);
    const base = fixture.context(baseEnv);
    const unconfirmedCtx = {
      ...base,
      runtime: {
        ...base.runtime,
        // Running, but docker could not report any RepoDigests for it at all.
        runningImageIdentity: async () => ({ imageId: "unresolvable-img", digests: [], containerId: "container-1" }),
      },
    } as unknown as Context;
    const unconfirmed = await fixture.captured(() => apply(unconfirmedCtx, ["--set", next.artifact, "--json"]));
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
    fixture.state.running = true;
    const beforeNoIdentity = await readInstalledSet(ctx);
    const base = fixture.context(baseEnv);
    const noIdentityCtx = {
      ...base,
      runtime: {
        ...base.runtime,
        runningImageIdentity: async () => undefined,
      },
    } as unknown as Context;
    const noIdentity = await fixture.captured(() => apply(noIdentityCtx, ["--set", next.artifact, "--json"]));
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
    fixture.state.running = true;
    const setup = await fixture.captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
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
          return ctx.transport.exec(command, args, options);
        },
      },
    } as unknown as Context;

    const rolledBackRaced = await fixture.captured(() => rollback(raceCtx, ["--set", "--json"]));
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
    fixture.state.running = true;
    // Reset to a clean, valid A -> B chain: the previous test left a fabricated "C" record
    // on file with no real stored artifact, which would refuse for an unrelated reason
    // (missing artifact) before ever reaching the snapshot check this test is about. The
    // live config is also forced to a value neither A nor B declares, so reinstalling each
    // one below is guaranteed to find real CONFIG_DRIFT and actually take a snapshot — with
    // nothing forcing drift, a config that happened to already match produces a genuine
    // no-op apply, which (correctly) takes no snapshot at all, leaving nothing to delete.
    files.set(`${sourceData}/config/openclaw.json`, JSON.stringify({ gateway: { mode: "remote" } }));
    const resetToA = await fixture.captured(() => apply(ctx, ["--set", built.artifact, "--json"]));
    assert.equal(resetToA.error, undefined, resetToA.error?.message);
    const reinstallB = await fixture.captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
    assert.equal(reinstallB.error, undefined, reinstallB.error?.message);
    const installedB = await readInstalledSet(ctx);
    assert.equal(installedB?.previous?.id, built.id, "the fixture for this test needs a valid previous (A) on record");
    assert.ok(installedB?.operationId !== undefined, "the fixture for this test needs a recorded operationId");

    const snapshotPath = `${sourceData}/clawforge-operations/${installedB!.operationId}.openclaw.json`;
    assert.ok(files.has(snapshotPath), "the fixture for this test needs the operation's own snapshot to exist first");
    const configBeforeMissingSnapshot = files.get(`${sourceData}/config/openclaw.json`);
    files.delete(snapshotPath);

    const missingSnapshot = await fixture.captured(() => rollback(ctx, ["--set", "--json"]));
    assert.match(missingSnapshot.error?.message ?? "", /no configuration snapshot is available/);
    assert.equal(
      files.get(`${sourceData}/config/openclaw.json`),
      configBeforeMissingSnapshot,
      "a refused rollback must leave the live configuration untouched",
    );
    assert.equal((await readInstalledSet(ctx))?.id, installedB?.id, "and must not change which set is recorded as installed");
  }

  process.stderr.write("all set apply/rollback lifecycle checks passed\n");
} finally {
  await fixture.teardown();
}
