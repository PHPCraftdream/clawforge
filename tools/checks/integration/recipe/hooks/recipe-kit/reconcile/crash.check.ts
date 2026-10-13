// Requirement 5: the crash gap. An intent with no result is reported as pending; a stale
// precomputed plan is refused, and a fresh entry-set apply recomputes from the current
// projection — one patch, never a replay of the pre-crash plan.
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { RECONCILE_LARGE_REMOVAL_CONSENT, reconcileApply, reconcilePendingIntents } from "#framework/recipe-kit/index.ts";
// Deep import: the internal full-fidelity planner is deliberately absent from the entry.
import { reconcilePlan } from "#framework/recipe-kit/reconcile/plan.ts";
import type { ReconcilePathOwner } from "#framework/recipe-kit/index.ts";
import { appendPrivateIntent, appendPrivateResult } from "#framework/security/privacy/structured/intents.ts";
import { fakeAccessor, journalFor, withReconcile } from "./fixture.ts";

await withReconcile(async (r) => {
  await r.owning(async () => {
    const journal = journalFor(r.ctx, "crash", false);
    const owners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];
    const accessor = fakeAccessor({ stale: "before-crash" });
    const emptyAccessor = fakeAccessor();
    const crashOptions = { path: "vault.projection", recipe: "fixture", owners, journal, accessor };

    // Seed provenance with an empty projection (the member is added, so it is recorded),
    // then simulate the crash: an intent was recorded but the process died before the result.
    await reconcileApply([{ key: "stale", value: "before-crash" }], { ...crashOptions, accessor: emptyAccessor });
    accessor.projection = { stale: "before-crash" };
    await appendPrivateIntent(r.ctx, journal.journalPath, { id: "crash-intent-1", kind: "reconcile", detail: { added: 1 } });
    const pending = await reconcilePendingIntents(journal);
    check("pending intent detected", { ids: pending.ids, truncated: pending.truncated, corrupt: pending.corrupt }, { ids: ["crash-intent-1"], truncated: false, corrupt: 0 });

    // A stale precomputed plan must not be applied over the gap: a refused RESULT, no view
    // (no plan was computed for this run).
    const stalePlan = reconcilePlan({ desired: [{ key: "stale", value: "from-old-plan" }], current: { stale: "before-crash" }, provenance: ["stale"] });
    let patchesBefore = accessor.patches.length;
    const stale = await reconcileApply(stalePlan, crashOptions);
    check("stale plan refused over pending intent", {
      status: stale.status, ok: stale.ok, reason: stale.reason, view: stale.view,
    }, { status: "refused", ok: false, reason: "guard", view: undefined });
    check("stale plan patched nothing", accessor.patches.length, patchesBefore);

    // A fresh entry-set source recomputes against the current projection and applies once.
    const fresh = await reconcileApply([{ key: "stale", value: "fresh-value" }], crashOptions);
    check("fresh apply over the gap", { status: fresh.status, ok: fresh.ok, applied: fresh.applied, summary: fresh.summary, pendingIntents: fresh.pendingIntents },
      { status: "applied", ok: true, applied: true, summary: { added: 0, changed: 1, removed: 0, unchanged: 0, overlap: 0 }, pendingIntents: 1 });
    check("fresh plan patched once", accessor.patches.length, 1);
    check("patch is recomputed, not replayed", accessor.patches[0], { stale: "fresh-value" });
    // The simulated crash intent stays pending until a result for it exists; once recorded,
    // the gap is closed.
    const stillPending = await reconcilePendingIntents(journal);
    check("crash intent stays pending without its result", stillPending.ids, ["crash-intent-1"]);
    await appendPrivateResult(r.ctx, journal.journalPath, { id: "crash-intent-1", kind: "reconcile", outcome: "done" });
    const resolved = await reconcilePendingIntents(journal);
    check("result record resolves the gap", resolved.ids, []);
  });

  // Two-phase provenance: a crash AFTER the patch and BEFORE provenance publication leaves
  // a PENDING record (written before the patch); the next run promotes it to confirmed
  // when the exact intended value is present, so ownership is recovered and removal works.
  await r.owning(async () => {
    const journal = journalFor(r.ctx, "crash-recovery", false);
    const owners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];
    const accessor = fakeAccessor();
    accessor.failRead = "process died after the patch";
    const options = { path: "vault.projection", recipe: "fixture", owners, journal, accessor };
    const crashedRun = await reconcileApply([{ key: "member", value: "member-value" }], options);
    check("crash after the patch is a failed result", { status: crashedRun.status, ok: crashedRun.ok, reason: crashedRun.reason },
      { status: "failed", ok: false, reason: "transport" });
    check("member landed in the config before the crash", accessor.projection, { member: "member-value" });
    const crashed = JSON.parse(r.files.get(journal.statePath)!) as { version: number; value: { keys: string[]; pending: Array<{ token: string }> } };
    check("pending provenance was recorded BEFORE the patch", {
      version: crashed.version, keys: crashed.value.keys,
      pending: crashed.value.pending.map((entry) => entry.token),
    }, { version: 2, keys: [], pending: ["member"] });

    // A fresh apply recovers: the pending key's value matches the recorded fingerprint, so
    // it is promoted to confirmed provenance — nothing patched, nothing adopted silently.
    accessor.failRead = undefined;
    const recovered = await reconcileApply([{ key: "member", value: "member-value" }], options);
    check("recovery run result", { ok: recovered.ok, applied: recovered.applied, patches: accessor.patches.length },
      { ok: true, applied: false, patches: 1 });
    // Recovery resolves pending BEFORE planning: the recovered member is provenance for
    // THIS run's plan, so it classifies as unchanged — never as overlap.
    check("recovery run classifies the member as unchanged", recovered.summary,
      { added: 0, changed: 0, removed: 0, unchanged: 1, overlap: 0 });
    const recoveredState = JSON.parse(r.files.get(journal.statePath)!) as { value: { keys: string[]; pending: unknown[] } };
    check("ownership recovered into confirmed provenance", recoveredState.value, { keys: ["member"], pending: [] });

    // With provenance confirmed, the member is removable again.
    const removed = await reconcileApply([], { ...options, largeRemovalConsent: RECONCILE_LARGE_REMOVAL_CONSENT });
    check("recovered member is removable", { applied: removed.applied, removed: removed.summary.removed, patch: accessor.patches[1] },
      { applied: true, removed: 1, patch: {} });
  });

  // Recovery-before-planning also means a removal requested IN the recovery run patches in
  // that same run: the recovered member is provenance for the fresh plan, and with the
  // consent token (single-member removal breaches the fraction bound) it is removed now.
  await r.owning(async () => {
    const journal = journalFor(r.ctx, "crash-same-run", false);
    const owners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];
    const accessor = fakeAccessor();
    accessor.failRead = "process died after the patch";
    const options = { path: "vault.projection", recipe: "fixture", owners, journal, accessor };
    const seedCrash = await reconcileApply([{ key: "member", value: "member-value" }], options);
    check("crash seeds pending for the same-run removal", { status: seedCrash.status, reason: seedCrash.reason },
      { status: "failed", reason: "transport" });
    accessor.failRead = undefined;
    const run = await reconcileApply([], { ...options, largeRemovalConsent: RECONCILE_LARGE_REMOVAL_CONSENT });
    check("same-run removal patches in the recovery run", {
      status: run.status, applied: run.applied, removed: run.summary.removed,
      recovery: run.recovery, patch: accessor.patches[1],
    }, { status: "applied", applied: true, removed: 1, recovery: { promoted: 1, dropped: 0 }, patch: {} });
    // The removed key is NOT re-recorded in the final provenance, even though it was
    // recovered earlier in the same run: the private state has NO member token left.
    const finalState = JSON.parse(r.files.get(journal.statePath)!) as { version: number; value: { keys: string[]; pending: unknown[] } };
    check("removed-and-recovered key leaves no provenance", finalState, { version: 2, value: { keys: [], pending: [] } });
    // An operator re-creates a member with the same key afterwards: without provenance it
    // surfaces as unowned overlap — not removable without adoption.
    accessor.projection = { member: "operator-recreated" };
    const recreated = await reconcileApply([{ key: "member", value: "operator-recreated" }], options);
    check("re-created same key is unowned overlap", {
      status: recreated.status, applied: recreated.applied, summary: recreated.summary,
    }, { status: "no-op", applied: false, summary: { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 1 } });
    const removalAttempt = await reconcileApply([], { ...options, largeRemovalConsent: RECONCILE_LARGE_REMOVAL_CONSENT });
    check("unowned overlap is not removable without adoption", {
      status: removalAttempt.status, applied: removalAttempt.applied, removed: removalAttempt.summary.removed,
      patch: accessor.patches.length,
    }, { status: "no-op", applied: false, removed: 0, patch: 2 });
  });

  // Dry run with stored identifying provenance but an absent key: NOTHING is written.
  // The implementation fails safely because it cannot correlate stored tokens without it.
  await r.owning(async () => {
    const base = journalFor(r.ctx, "crash-dry-no-key", true);
    const journal = { ...base, pseudonymDir: "/fixture/data/vault/dry-no-key" };
    const owners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];
    const accessor = fakeAccessor();
    const options = { path: "vault.projection", recipe: "fixture", owners, journal, accessor };
    const seeded = await reconcileApply([{ key: "member", value: "member-value" }], options);
    check("stored state setup applied", seeded.status, "applied");
    r.files.delete(journal.pseudonymDir);
    const before = new Map([...r.files].filter(([path]) => path.startsWith("/fixture/data/vault")));
    const dry = await reconcileApply([{ key: "member", value: "member-value" }], {
      ...options, journal: { ...journal, ctx: { ...r.ctx, dryRun: true } as typeof r.ctx },
    });
    check("pending state without key fails safely on dry run", { status: dry.status, reason: dry.reason, view: dry.view },
      { status: "failed", reason: "guard", view: undefined });
    const after = new Map([...r.files].filter(([path]) => path.startsWith("/fixture/data/vault")));
    check("missing key and all private bytes unchanged", [...after.entries()].sort(), [...before.entries()].sort());
    check("no extra patch on unsafe dry recovery", accessor.patches.length, 1);
  });

  // Dry run with pending recovery: NOTHING is written — the private state file stays
  // byte-identical, no patch, and the recovery counts are reported in the result.
  await r.owning(async () => {
    const journal = journalFor(r.ctx, "crash-dryrun", false);
    const owners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];
    const accessor = fakeAccessor();
    accessor.failRead = "process died after the patch";
    const options = { path: "vault.projection", recipe: "fixture", owners, journal, accessor };
    const crashed = await reconcileApply([{ key: "member", value: "member-value" }], options);
    check("crash seeds pending for the dry run", { status: crashed.status, reason: crashed.reason }, { status: "failed", reason: "transport" });
    const patchesAfterCrash = accessor.patches.length;
    const before = r.files.get(journal.statePath);
    checkTrue("state exists before the dry run", before !== undefined && before.includes("pending"));
    accessor.failRead = undefined;
    const dryJournal = { ...journal, ctx: { ...journal.ctx, dryRun: true } as typeof journal.ctx };
    const dry = await reconcileApply([{ key: "member", value: "member-value" }], { ...options, journal: dryJournal });
    check("dry run writes nothing and reports recovery counts", {
      ok: dry.ok, applied: dry.applied, dryRun: dry.dryRun,
      patches: accessor.patches.length, recovery: dry.recovery,
    }, { ok: true, applied: false, dryRun: true, patches: patchesAfterCrash, recovery: { promoted: 1, dropped: 0 } });
    check("dry run leaves the private state byte-identical", r.files.get(journal.statePath), before);
    // The non-dry run still promotes: recovery then happens for real.
    const real = await reconcileApply([{ key: "member", value: "member-value" }], options);
    check("non-dry no-op run still promotes", { status: real.status, applied: real.applied, recovery: real.recovery }, { status: "no-op", applied: false, recovery: { promoted: 1, dropped: 0 } });
    const state = JSON.parse(r.files.get(journal.statePath)!) as { value: { keys: string[]; pending: unknown[] } };
    check("ownership recovered after the dry run", state.value, { keys: ["member"], pending: [] });
  });

  // P1: a FRESH deployment (no pseudonym key file anywhere under the vault) dry run must
  // not create ANY private file — the complete private-file map is byte-identical.
  await r.owning(async () => {
    const dryJournal = { ...journalFor({ ...r.ctx, dryRun: true } as typeof r.ctx, "crash-fresh-dry", true), pseudonymDir: "/fixture/data/vault/fresh-key" };
    const realJournal = { ...journalFor(r.ctx, "crash-fresh-dry", true), pseudonymDir: "/fixture/data/vault/fresh-key" };
    const owners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];
    const accessor = fakeAccessor();
    const privateSnapshot = () => new Map([...r.files].filter(([path]) => path.startsWith("/fixture/data/vault")));
    const before = privateSnapshot();
    checkTrue("fresh deployment has no key file", !r.files.has("/fixture/data/vault/fresh-key"));
    const dry = await reconcileApply([{ key: "member", value: "member-value" }], {
      path: "vault.projection", recipe: "fixture", owners, journal: dryJournal, accessor,
    });
    const after = privateSnapshot();
    check("fresh dry run result", { status: dry.status, ok: dry.ok, applied: dry.applied, patches: accessor.patches.length },
      { status: "dry-run", ok: true, applied: false, patches: 0 });
    checkTrue("fresh dry run creates no key file", !r.files.has("/fixture/data/vault/fresh-key"));
    check("private file map identical before and after the dry run", [...before.entries()].sort(), [...after.entries()].sort());
    check("dry run reports the unkeyed view", { keyed: dry.view?.keyed, keys: dry.view?.added.map((entry) => entry.key), fingerprints: dry.view?.added.map((entry) => entry.fingerprint) },
      { keyed: false, keys: ["#0"], fingerprints: ["unavailable"] });
    // The same apply WITHOUT dryRun does create the key and apply for real.
    const real = await reconcileApply([{ key: "member", value: "member-value" }], {
      path: "vault.projection", recipe: "fixture", owners, journal: realJournal, accessor,
    });
    check("non-dry run over the fresh deployment applies", { status: real.status, applied: real.applied, keyed: real.view?.keyed },
      { status: "applied", applied: true, keyed: true });
    checkTrue("non-dry run created the key file", r.files.has("/fixture/data/vault/fresh-key"));
  });

  // An operator-added entry with an identical key that was NEVER pending stays untouched:
  // it surfaces as overlap and is never adopted, never provenanced, never removable.
  await r.owning(async () => {
    const journal = journalFor(r.ctx, "crash-operator", false);
    const owners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];
    const accessor = fakeAccessor({ member: "operator-value" });
    const options = { path: "vault.projection", recipe: "fixture", owners, journal, accessor };
    const result = await reconcileApply([{ key: "member", value: "operator-value" }], options);
    check("operator entry stays overlap", { applied: result.applied, summary: result.summary },
      { applied: false, summary: { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 1 } });
    const stateText = r.files.get(journal.statePath);
    const state = stateText === undefined ? undefined : JSON.parse(stateText) as { value: { keys: string[]; pending: unknown[] } };
    checkTrue("operator key never provenanced", state === undefined || (state.value.keys.length === 0 && state.value.pending.length === 0));
    const removal = await reconcileApply([], options);
    check("never-provenanced key is not removable", { applied: removal.applied, removed: removal.summary.removed },
      { applied: false, removed: 0 });
    check("operator key never patched", accessor.patches.length, 0);
  });
});

finish("recipe-kit reconcile crash gap");
