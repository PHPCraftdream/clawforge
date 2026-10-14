// Requirements 2, 3 and 9: one batch patch per apply against a recording accessor, verified
// re-read; failed/unknown desired sources apply nothing with sanitized refusals; a second
// identical apply is an empty plan with no patch and no journal record.
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { GUARD_VERIFY_MISMATCH, appConfigAccessor, reconcileApply } from "#framework/recipe-kit/index.ts";
import type { ReconcileEntry } from "#framework/recipe-kit/index.ts";
// Deep import: the internal full-fidelity plan type is deliberately absent from the entry.
import type { ReconcilePlan } from "#framework/recipe-kit/reconcile/types.ts";
import { registerSecret } from "#framework/core/io/log.ts";
import type { Context } from "#framework/core/context.ts";
import { fakeAccessor, journalFor, journalRecords, refusal, withReconcile } from "./fixture.ts";

await withReconcile(async (r) => {
  await r.owning(async () => {
    const journal = journalFor(r.ctx, "apply", false);
    const accessor = fakeAccessor();
const owners = [{ recipe: "fixture", path: "vault.projection", mode: "value" as const, prefix: false }];
    const journalStateAfter = { a: 1, b: "x" };

    // Requirement 2: exactly one batch patch, correct projection, journaled done.
    const desired: readonly ReconcileEntry[] = [{ key: "a", value: 1 }, { key: "b", value: "x" }];
    const result = await reconcileApply(desired, { path: "vault.projection", recipe: "fixture", owners, journal, accessor });
    check("apply result", { ok: result.ok, applied: result.applied, dryRun: result.dryRun, summary: result.summary, pendingIntents: result.pendingIntents },
      { ok: true, applied: true, dryRun: undefined, summary: { added: 2, changed: 0, removed: 0, unchanged: 0, overlap: 0 }, pendingIntents: 0 });
    // The applied result carries a redacted view: index markers (non-identifying journal),
    // keyed bounded fingerprints, and no raw member content.
    check("applied result carries a redacted view", {
      present: result.view !== undefined,
      summary: result.view?.summary,
      keys: result.view?.added.map((entry) => entry.key),
      fingerprintsHex: result.view?.added.every((entry) => /^[0-9a-f]{16}$/.test(entry.fingerprint ?? "")),
      keyed: result.view?.keyed,
    }, { present: true, summary: { added: 2, changed: 0, removed: 0, unchanged: 0, overlap: 0 }, keys: ["#0", "#1"], fingerprintsHex: true, keyed: true });
    check("one patch call per apply", accessor.patches.length, 1);
    check("patch is the full intended projection", accessor.patches[0], { a: 1, b: "x" });
    const records = journalRecords(r, journal.journalPath);
    check("journal has intent and result", records.map((record) => "intent" in record ? "intent" : "result" in record ? "result" : "?"), ["intent", "result"]);
    check("result outcome done", records.map((record) => (record.result as { outcome?: string } | undefined)?.outcome), [undefined, "done"]);
    check("provenance records the touched members", JSON.parse(r.files.get(journal.statePath)!), { version: 2, value: { keys: ["a", "b"], pending: [] } });

    // Requirement 2b: re-read mismatch is a FAILED result (not a throw), journaled as
    // failed, carrying the already-computed redacted view. A new key forces a real patch;
    // the accessor's skipWrite keeps the projection unchanged.
    const mismatch = fakeAccessor();
    mismatch.projection = { ...journalStateAfter };
    mismatch.skipWrite = true;
    const mismatchResult = await reconcileApply([{ key: "a", value: 1 }, { key: "b", value: "x" }, { key: "c", value: "raw-c-value-9" }] as const, { path: "vault.projection", recipe: "fixture", owners, journal, accessor: mismatch });
    check("verify mismatch is a failed result", {
      status: mismatchResult.status, ok: mismatchResult.ok, applied: mismatchResult.applied,
      reason: mismatchResult.reason, detail: mismatchResult.detail,
    }, { status: "failed", ok: false, applied: false, reason: "guard", detail: GUARD_VERIFY_MISMATCH });
    check("verify mismatch result shows the redacted view", {
      present: mismatchResult.view !== undefined,
      summary: mismatchResult.view?.summary,
      keyed: mismatchResult.view?.keyed,
      rawFree: !JSON.stringify(mismatchResult.view).includes("raw-c-value-9"),
    }, { present: true, summary: { added: 1, changed: 0, removed: 0, unchanged: 2, overlap: 0 }, keyed: true, rawFree: true });
    check("verify mismatch patch attempted once", mismatch.patches.length, 1);
    check("verify mismatch journaled failed", journalRecords(r, journal.journalPath).map((record) => (record.result as { outcome?: string } | undefined)?.outcome).includes("failed"), true);

    // Requirement 3: source failures return FAILED results (zero patch calls), sanitized
    // reason codes — never throws.
    const before = accessor.patches.length;
    const failRead = fakeAccessor();
    await r.owning(async () => {
      const sourceFailed = async (name: string, extra: Record<string, unknown>, reason: string) => {
        const result = await reconcileApply([{ key: "a", value: 1 }] as const, {
          path: "vault.projection", recipe: "fixture", owners, journal, accessor: failRead, ...extra,
        } as never);
        check(`source failure ${name}`, { status: result.status, ok: result.ok, reason: result.reason }, { status: "failed", ok: false, reason });
      };
      await sourceFailed("throwing desired source", { readDesired: () => { throw new Error("raw-private-source-body"); } }, "guard");
      await sourceFailed("validator-rejecting source", { validateDesired: () => false }, "guard");
      await sourceFailed("throwing validator source", { validateDesired: () => { throw new Error("validator internals"); } }, "guard");
      // An undefined desired set fails (fail-closed), applying nothing.
      await sourceFailed("unknown desired source", { readDesired: () => Promise.resolve(undefined) }, "guard");
      await sourceFailed("invalid desired entries from source", {
        readDesired: () => Promise.resolve([{ key: "bad.key", value: 1 }]),
      }, "guard");
      // A transport read failure returns a failed result WITHOUT a view (no plan existed).
      const readResult = await reconcileApply([{ key: "a", value: 1 }] as const, {
        path: "vault.projection", recipe: "fixture", owners, journal,
        accessor: { read: () => { throw new Error("credentials in flight"); }, patch: () => Promise.resolve() },
      });
      check("transport read failure carries no view", { status: readResult.status, reason: readResult.reason, view: readResult.view },
        { status: "failed", reason: "transport", view: undefined });
    });
    check("source failures patch nothing", failRead.patches.length, 0);
    check("healthy accessor untouched by source failures", accessor.patches.length, before);
    checkTrue("no raw source value leaks into journal", !JSON.stringify(r.files.get(journal.journalPath)).includes("raw-private-source-body"));

    // Adversarial plan source: a hostile `map` on a plan category refuses content-free and
    // patches nothing — the foreign exception never leaks.
    const hostilePlan = {
      added: [], changed: [], removed: [],
      unchanged: { map: 5 },
      overlap: [],
      summary: { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 1 },
    } as unknown as ReconcilePlan;
    await refusal("hostile plan source", () =>
      reconcileApply(hostilePlan, { path: "vault.projection", recipe: "fixture", owners, journal, accessor: failRead }), "invalid-request");
    check("hostile plan source patches nothing", failRead.patches.length, 0);

    // A hostile CALLABLE `map` that would still return a usable array must be REFUSED,
    // never executed — descriptor-only validation, no method invocation.
    const callableTarget: unknown[] = [];
    (callableTarget as { map?: unknown }).map = () => [];
    const callableMapPlan = {
      added: [], changed: [], removed: [], overlap: [],
      unchanged: callableTarget,
      summary: { added: 0, changed: 0, removed: 0, unchanged: 1, overlap: 0 },
    } as unknown as ReconcilePlan;
    await refusal("callable map plan refused", () =>
      reconcileApply(callableMapPlan, { path: "vault.projection", recipe: "fixture", owners, journal, accessor: failRead }), "invalid-request");
    check("callable map plan patches nothing", failRead.patches.length, 0);

    // A getter-based plan field is refused WITHOUT invoking the getter — the getter's
    // message (a registered secret) never runs, never leaks.
    const APPLY_SECRET = "apply-getter-secret-88f";
    registerSecret(APPLY_SECRET);
    let getterInvoked = false;
    const getterPlan = {
      get added() { getterInvoked = true; throw new Error(`apply getter leak ${APPLY_SECRET}`); },
      changed: [], removed: [], unchanged: [], overlap: [],
      summary: { added: 1, changed: 0, removed: 0, unchanged: 0, overlap: 0 },
    } as unknown as ReconcilePlan;
    const getterRefusal = await refusal("getter plan refused", () =>
      reconcileApply(getterPlan, { path: "vault.projection", recipe: "fixture", owners, journal, accessor: failRead }), "invalid-request");
    checkTrue("getter plan never invoked the getter", !getterInvoked);
    checkTrue("getter plan refusal carries no secret",
      !JSON.stringify({ message: getterRefusal.message, detail: getterRefusal.detail, info: getterRefusal.info }).includes(APPLY_SECRET));
    check("getter plan patches nothing", failRead.patches.length, 0);

    // REAL dry run: the plan is produced, nothing is patched, no journal record is written.
    const dryJournal = { ...journalFor({ ...r.ctx, dryRun: true } as Context, "apply-dry", true), pseudonymDir: "/fixture/data/vault/apply-dry-fresh" };
    const dryAccessor = fakeAccessor({ existing: 1 });
    const dry = await reconcileApply([{ key: "fresh", value: 1 }], { path: "vault.projection", recipe: "fixture", owners, journal: dryJournal, accessor: dryAccessor });
    check("dry-run result", { status: dry.status, ok: dry.ok, applied: dry.applied, dryRun: dry.dryRun, summary: dry.summary },
      { status: "dry-run", ok: true, applied: false, dryRun: true, summary: { added: 1, changed: 0, removed: 0, unchanged: 0, overlap: 0 } });
    check("dry run patches nothing", dryAccessor.patches.length, 0);
    check("dry run writes no journal record", r.files.get(dryJournal.journalPath), undefined);
    check("dry-run result carries a redacted view", { present: dry.view !== undefined, keys: dry.view?.added.map((entry) => entry.key), keyed: dry.view?.keyed },
      { present: true, keys: ["#0"], keyed: false });

    // Default-accessor wiring: the read goes to `config get <path> --json`, the patch to
    // `config patch --stdin` with the intended JSON on stdin; registered secrets never
    // reach argv (appCli's contract — light assertion).
    const calls: Array<{ service: string; args: string[]; options?: { input?: string } }> = [];
    const wiredCtx = {
      runtime: { async runOneOff(service: string, args: string[], options?: { input?: string }) {
        calls.push({ service, args, options });
        return { code: 0, stdout: "{}\n", stderr: "" };
      } },
    } as unknown as Context;
    registerSecret("wiring-secret-55a");
    const wiredJournal = journalFor(wiredCtx, "apply-wired", false);
    const wired = appConfigAccessor(wiredJournal.ctx, "vault.projection");
    await wired.read();
    await wired.patch({ member: "wiring-secret-55a" });
    check("accessor read argv", calls[0]?.args, ["config", "get", "vault.projection", "--json"]);
    check("accessor patch argv", calls[1]?.args, ["config", "patch", "--stdin"]);
    checkTrue("secrets never reach argv", calls.every((call) => call.args.every((arg) => !arg.includes("wiring-secret-55a"))));
    check("accessor patch stdin is the intended JSON", calls[1]?.options?.input, '{"vault.projection":{"member":"wiring-secret-55a"}}');

    // A projection holding a registered secret reads back masked; patching it would write the
    // mask over the operator's value, so the default accessor refuses before any write.
    const maskedCalls: string[][] = [];
    const maskedCtx = {
      runtime: { async runOneOff(_service: string, args: string[]) {
        maskedCalls.push(args);
        return { code: 0, stdout: '{"kept":"wiring-secret-55a","other":"plain"}\n', stderr: "" };
      } },
    } as unknown as Context;
    const maskedJournal = journalFor(maskedCtx, "apply-masked", false);
    await refusal("masked projection read", () => appConfigAccessor(maskedJournal.ctx, "vault.projection").read(), "guard");
    const maskedApplyJournal = journalFor(r.ctx, "apply-masked", false);
    const maskedApply = await reconcileApply([{ key: "added", value: "new" }],
      { path: "vault.projection", recipe: "fixture", owners, journal: maskedApplyJournal, accessor: appConfigAccessor(maskedJournal.ctx, "vault.projection") });
    check("apply over a masked projection fails closed", { status: maskedApply.status, applied: maskedApply.applied, reason: maskedApply.reason },
      { status: "failed", applied: false, reason: "guard" });
    check("apply over a masked projection never patches", maskedCalls.map((args) => args[1]), ["get", "get"]);
    check("apply over a masked projection writes no journal record", r.files.get(maskedApplyJournal.journalPath), undefined);

    // Requirement 9: idempotence — same desired set again is an empty plan, no patch, no record.
    const journalBefore = r.files.get(journal.journalPath);
    const again = await reconcileApply(desired, { path: "vault.projection", recipe: "fixture", owners, journal, accessor });
    check("idempotent apply result", { ok: again.ok, applied: again.applied, summary: again.summary },
      { ok: true, applied: false, summary: { added: 0, changed: 0, removed: 0, unchanged: 2, overlap: 0 } });
    check("no-op result carries a redacted view", { present: again.view !== undefined, keys: again.view?.unchanged.map((entry) => entry.key) },
      { present: true, keys: ["#0", "#1"] });
    check("idempotent apply patches nothing", accessor.patches.length, before);
    check("idempotent apply writes no journal record", r.files.get(journal.journalPath), journalBefore);

    // Requirement 9b: idempotence in the DEFAULT identifying namespace — provenance is
    // stored pseudonymized, so the second apply must still be an empty plan (no second
    // patch, no journal record).
    const idJournal = journalFor(r.ctx, "apply-identifying", true);
    const idAccessor = fakeAccessor();
    const idOptions = { path: "vault.projection", recipe: "fixture", owners, journal: idJournal, accessor: idAccessor };
    const first = await reconcileApply(desired, idOptions);
    check("identifying first apply", { applied: first.applied, summary: first.summary },
      { applied: true, summary: { added: 2, changed: 0, removed: 0, unchanged: 0, overlap: 0 } });
    checkTrue("identifying provenance pseudonymized", (JSON.parse(r.files.get(idJournal.statePath)!) as { value: { keys: string[] } }).value.keys.every((key) => key.startsWith("v1.")));
    const idJournalBefore = r.files.get(idJournal.journalPath);
    const second = await reconcileApply(desired, idOptions);
    check("identifying idempotent apply result", { ok: second.ok, applied: second.applied, summary: second.summary },
      { ok: true, applied: false, summary: { added: 0, changed: 0, removed: 0, unchanged: 2, overlap: 0 } });
    check("identifying idempotent apply patches nothing", idAccessor.patches.length, 1);
    check("identifying idempotent apply writes no journal record", r.files.get(idJournal.journalPath), idJournalBefore);
  });
});

finish("recipe-kit reconcile apply");
