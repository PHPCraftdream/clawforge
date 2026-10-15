// Requirements 6 and 7: provenance protection and overlap adoption. An operator entry that
// reconcile never recorded survives apply untouched; provenance-recorded keys are removable;
// overlap keys change nothing unless adoptOverlaps records them — and adoption keeps the
// operator's value.
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { reconcileApply } from "#framework/recipe-kit/index.ts";
import type { ReconcileEntry, ReconcilePathOwner } from "#framework/recipe-kit/index.ts";
import { fakeAccessor, journalFor, withReconcile } from "./fixture.ts";

await withReconcile(async (r) => {
  await r.owning(async () => {
    const journal = journalFor(r.ctx, "provenance", false);
    const owners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];
    const accessor = fakeAccessor();
    const options = { path: "vault.projection", recipe: "fixture", owners, journal, accessor };
    const desired = (entries: readonly ReconcileEntry[]) => entries;

    // Requirement 6: reconcile-owned member recorded via a first apply.
    const seeded = await reconcileApply(desired([{ key: "mine", value: "reconcile-value" }]), options);
    check("seed added the owned member", seeded.summary, { added: 1, changed: 0, removed: 0, unchanged: 0, overlap: 0 });

    // An operator adds their own entry directly in the config; it has no recorded provenance.
    accessor.projection = { mine: "reconcile-value", operator: "operator-value" };
    // A patch actually happens here (the owned member changes), so survival is observable.
    const second = await reconcileApply(desired([{ key: "mine", value: "changed" }]), options);
    check("operator entry is not a removal", second.summary.removed, 0);
    check("owned member changed", second.summary.changed, 1);
    check("operator entry survives apply", accessor.patches[1], { mine: "changed", operator: "operator-value" });
    // Provenance stays limited to the recorded member, pseudonymized — no silent adoption,
    // no raw key on disk.
    const state = r.files.get(journal.statePath)!;
    check("provenance records only the owned member", JSON.parse(state), { version: 2, value: { keys: ["mine"], pending: [] } });

    // Requirement 6b: a provenance-recorded key IS removable.
    const removed = await reconcileApply(desired([]), options);
    check("recorded key removed", removed.summary, { added: 0, changed: 0, removed: 1, unchanged: 0, overlap: 0 });
    check("removal patch drops only the recorded key", accessor.patches[2], { operator: "operator-value" });

    // Requirement 7: overlap adoption — the operator's key is also in the desired set.
    const overlapDesired = desired([{ key: "operator", value: "desired-value" }]);
    const untouched = await reconcileApply(overlapDesired, options);
    check("overlap without adoption applies nothing", { ok: untouched.ok, applied: untouched.applied, summary: untouched.summary },
      { ok: true, applied: false, summary: { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 1 } });
    check("no adoption, no patch", accessor.patches.length, 3);
    const adopted = await reconcileApply(overlapDesired, { ...options, adoptOverlaps: true });
    check("adoption applies", { ok: adopted.ok, applied: adopted.applied, summary: adopted.summary },
      { ok: true, applied: true, summary: { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 1 } });
    check("adoption keeps the operator value", accessor.patches[3]?.operator, "operator-value");
    checkTrue("adoption records provenance", JSON.parse(r.files.get(journal.statePath)!).value.keys.length === 1);
    // Now that provenance exists, a desired set matching the kept operator value is unchanged.
    const after = await reconcileApply(desired([{ key: "operator", value: "operator-value" }]), { ...options, adoptOverlaps: true });
    check("adopted key becomes unchanged", after.summary, { added: 0, changed: 0, removed: 0, unchanged: 1, overlap: 0 });

    // Same semantics in the DEFAULT identifying namespace: provenance is stored
    // pseudonymized, yet the operator entry still survives, provenance-recorded keys are
    // still removable, and unprovenanced desired keys still surface as overlap.
    const idJournal = journalFor(r.ctx, "provenance-identifying", true);
    const idAccessor = fakeAccessor();
    const idOptions = { path: "vault.projection", recipe: "fixture", owners, journal: idJournal, accessor: idAccessor };
    const idSeed = await reconcileApply(desired([{ key: "mine", value: "reconcile-value" }]), idOptions);
    check("identifying seed added", idSeed.summary, { added: 1, changed: 0, removed: 0, unchanged: 0, overlap: 0 });
    idAccessor.projection = { mine: "reconcile-value", operator: "operator-value" };
    await reconcileApply(desired([{ key: "mine", value: "changed" }]), idOptions);
    check("identifying operator entry survives", idAccessor.patches[1], { mine: "changed", operator: "operator-value" });
    const idState = JSON.parse(r.files.get(idJournal.statePath)!) as { value: { keys: string[] } };
    checkTrue("identifying provenance pseudonymized, only owned member", idState.value.keys.length === 1 && idState.value.keys[0].startsWith("v1."));
    const idRemoved = await reconcileApply(desired([]), idOptions);
    check("identifying recorded key removed", idRemoved.summary, { added: 0, changed: 0, removed: 1, unchanged: 0, overlap: 0 });
    check("identifying removal drops only the recorded key", idAccessor.patches[2], { operator: "operator-value" });
    const idOverlap = await reconcileApply(desired([{ key: "operator", value: "desired-value" }]), idOptions);
    check("identifying unprovenanced key is overlap", idOverlap.summary, { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 1 });
    check("identifying overlap applies nothing", idAccessor.patches.length, 3);
  });

  // Crash-pending resolution edge cases: a pending key ABSENT from the current projection
  // is dropped without promotion (the desired member is re-added as new provenance), and a
  // pending key whose value DIVERGED from the recorded fingerprint is never promoted — it
  // surfaces as unprovenanced overlap and the pending entry is cleared.
  await r.owning(async () => {
    const owners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];

    const journal = journalFor(r.ctx, "prov-pending-absent", false);
    const accessor = fakeAccessor();
    const options = { path: "vault.projection", recipe: "fixture", owners, journal, accessor };
    accessor.failRead = "crash before publication";
    const absentCrash = await reconcileApply([{ key: "member", value: "member-value" }], options);
    check("absent-seed crash is a failed result", { status: absentCrash.status, reason: absentCrash.reason }, { status: "failed", reason: "transport" });
    accessor.projection = {};
    accessor.failRead = undefined;
    const absent = await reconcileApply([{ key: "member", value: "member-value" }], options);
    check("absent pending is dropped, member re-added", { summary: absent.summary, recovery: absent.recovery, patch: accessor.patches[1] },
      { summary: { added: 1, changed: 0, removed: 0, unchanged: 0, overlap: 0 }, recovery: { promoted: 0, dropped: 1 }, patch: { member: "member-value" } });
    check("absent pending cleared, key provenanced", JSON.parse(r.files.get(journal.statePath)!),
      { version: 2, value: { keys: ["member"], pending: [] } });

    const dJournal = journalFor(r.ctx, "prov-pending-diverged", false);
    const dAccessor = fakeAccessor();
    const dOptions = { path: "vault.projection", recipe: "fixture", owners, journal: dJournal, accessor: dAccessor };
    dAccessor.failRead = "crash before publication";
    const divergedCrash = await reconcileApply([{ key: "member", value: "member-value" }], dOptions);
    check("diverged-seed crash is a failed result", { status: divergedCrash.status, reason: divergedCrash.reason }, { status: "failed", reason: "transport" });
    dAccessor.projection = { member: "operator-diverged" };
    dAccessor.failRead = undefined;
    const diverged = await reconcileApply([{ key: "member", value: "member-value" }], dOptions);
    check("diverged pending not promoted, stays overlap", { summary: diverged.summary, recovery: diverged.recovery, projection: dAccessor.projection },
      { summary: { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 1 }, recovery: { promoted: 0, dropped: 1 }, projection: { member: "operator-diverged" } });
    check("diverged pending cleared, operator value untouched", {
      state: JSON.parse(r.files.get(dJournal.statePath)!),
      patches: dAccessor.patches.length,
    }, { state: { version: 2, value: { keys: [], pending: [] } }, patches: 1 });
  });
});

finish("recipe-kit reconcile provenance");
