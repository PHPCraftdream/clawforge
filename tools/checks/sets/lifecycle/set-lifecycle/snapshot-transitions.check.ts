// Two self-contained set-transition regression tests (unlike apply-rollback.check.ts's
// sequential story, each block here builds its OWN A/B sets from scratch and does not
// depend on state any other block — or any other file — left behind). Split out of
// set-lifecycle.check.ts; see fixture.ts for the shared transport/context.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSet } from "#framework/commands/sets/set.ts";
import { apply } from "#framework/commands/orchestration/apply.ts";
import { rollback } from "#framework/commands/orchestration/rollback.ts";
import { readInstalledSet } from "#framework/set/artifacts/install.ts";
import { createFixture } from "./fixture.ts";
import type { Context } from "#framework/core/context.ts";

const fixture = await createFixture();
const { root, sourceData, files, ctx } = fixture;

try {
  // --- rollback --set must succeed after a NO-OP set transition (a renamed set whose
  // declared config is byte-identical to what is already live) — applyFromSource's own
  // "nothing to apply" fast path never opens a Journal or takes a config snapshot for its
  // operationId, but recordInstalledSet() still records that operationId as the one that
  // installed the set. Before the fix, rollback --set later found no operation record for
  // it and refused with "no configuration snapshot is available", even though nothing about
  // the config actually needed restoring. ---------------------------------------------------
  {
    fixture.state.running = true;
    // A clean, known state: live config forced to something neither set below declares, so
    // installing A first is guaranteed to find real drift and take a real snapshot.
    files.set(`${sourceData}/config/openclaw.json`, JSON.stringify({ gateway: { mode: "remote" } }));
    await writeFile(join(root, "config", "desired-state.json"), '[{"path":"gateway.mode","value":"local"}]');
    const setA = await buildSet(ctx, "lifecycle-noop-a");
    const installA = await fixture.captured(() => apply(ctx, ["--set", setA.artifact, "--json"]));
    assert.equal(installA.error, undefined, installA.error?.message);
    assert.equal((await readInstalledSet(ctx))?.id, setA.id);

    // setB: a different set (a different name, so a different content-addressed id) that
    // declares the EXACT SAME desired-state.json content as setA — the file on disk has not
    // changed since setA was built, and the live config now already matches it (from the
    // install just above). Installing setB is therefore a genuine no-op: 0 executable
    // actions, applyFromSource's fast path, no Journal ever opened for this run's operationId.
    const setB = await buildSet(ctx, "lifecycle-noop-b");
    assert.notEqual(setB.id, setA.id, "a renamed set with the same declared config still gets a different id");
    const installB = await fixture.captured(() => apply(ctx, ["--set", setB.artifact, "--json"]));
    assert.equal(installB.error, undefined, installB.error?.message);
    const installedB = await readInstalledSet(ctx);
    assert.equal(installedB?.id, setB.id);
    assert.equal(installedB?.previous?.id, setA.id, "the fixture for this test needs A on record as previous");

    const rolledBack = await fixture.captured(() => rollback(ctx, ["--set", "--json"]));
    assert.equal(
      rolledBack.error,
      undefined,
      `rollback --set must succeed after a no-op set transition, not refuse for lack of a snapshot: ${rolledBack.error?.message}`,
    );
    assert.equal((await readInstalledSet(ctx))?.id, setA.id, "rollback restores the previous set");
  }

  // --- apply --set must not corrupt the rollback snapshot when a single TRANSIENT read
  // error strikes right after a REAL apply (task #193, P1). Before the fix, apply.ts probed
  // readOperation(ctx, operationId) after applyFromSource returned, to decide whether the
  // no-op fast path had skipped taking a snapshot. readOperation() also returns undefined
  // for a genuine, unrelated read failure on a record that DOES exist — a real apply run
  // (executable steps, Journal opened, correct pre-change snapshot already taken). Mistaking
  // that failure for "nothing ran" made the old code open a FRESH journal and take a NEW
  // snapshot right then — of the config AFTER the real steps already changed it — silently
  // overwriting the correct pre-change snapshot. rollback --set then restored to a config
  // that already included B's own setting, i.e. undid nothing. --------------------------------
  {
    fixture.state.running = true;
    files.set(`${sourceData}/config/openclaw.json`, JSON.stringify({ gateway: { mode: "remote" } }));
    await writeFile(join(root, "config", "desired-state.json"), '[{"path":"gateway.mode","value":"local"}]');
    const setA2 = await buildSet(ctx, "lifecycle-transient-a");
    const installA2 = await fixture.captured(() => apply(ctx, ["--set", setA2.artifact, "--json"]));
    assert.equal(installA2.error, undefined, installA2.error?.message);

    // setB2 declares a real, additional setting A never did — a genuine drift, so this
    // install runs executable steps for real (not the no-op fast path task #189 covers).
    await writeFile(
      join(root, "config", "desired-state.json"),
      '[{"path":"gateway.mode","value":"local"},{"path":"agents.defaults.name","value":"transient-b"}]',
    );
    const setB2 = await buildSet(ctx, "lifecycle-transient-b");

    // A single, one-shot fault: the FIRST read of an operation RECORD file (not a
    // ".openclaw.json" config snapshot copy) throws once, then behaves normally forever
    // after. Scoped to this one apply call only — rollback --set below uses the plain,
    // unfaulted ctx.
    const isOperationRecord = (path: string): boolean =>
      /\/clawforge-operations\/[^/]+\.json$/.test(path) && !path.endsWith(".openclaw.json");
    let faulted = false;
    const faultyCtx = {
      ...ctx,
      transport: {
        ...ctx.transport,
        readFile: async (path: string) => {
          if (!faulted && isOperationRecord(path)) {
            faulted = true;
            throw new Error("simulated transient read error");
          }
          return ctx.transport.readFile(path);
        },
      },
    } as unknown as Context;

    const installB2 = await fixture.captured(() => apply(faultyCtx, ["--set", setB2.artifact, "--json"]));
    assert.equal(installB2.error, undefined, installB2.error?.message);

    const rolledBack2 = await fixture.captured(() => rollback(ctx, ["--set", "--json"]));
    assert.equal(rolledBack2.error, undefined, rolledBack2.error?.message);
    const configAfter2 = JSON.parse(files.get(`${sourceData}/config/openclaw.json`) ?? "{}");
    assert.equal(
      configAfter2?.agents?.defaults?.name,
      undefined,
      "a single transient read error right after a real apply must not corrupt the rollback snapshot — B's setting must still be undone",
    );
  }

  process.stderr.write("all set snapshot-transition checks passed\n");
} finally {
  await fixture.teardown();
}
