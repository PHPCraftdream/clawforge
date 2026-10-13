// Requirement 10 + plan-redaction review item: plan results, redacted views, refusals and
// journal records carry pseudonyms, indices, fingerprints and counts — never raw member keys
// or values, and never a REGISTERED secret. Identifying namespaces pseudonymize keys
// everywhere; raw values never reach the journal under any namespace.
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import {
  RECONCILE_LARGE_REMOVAL_CONSENT, reconcileApply, reconcilePlanView,
} from "#framework/recipe-kit/index.ts";
import type { ReconcilePathOwner } from "#framework/recipe-kit/index.ts";
// Deep import: the internal full-fidelity planner is deliberately absent from the entry.
import { reconcilePlan } from "#framework/recipe-kit/reconcile/plan.ts";
import { RecipeKitRefusal } from "#framework/recipe-kit/index.ts";
import { registerSecret } from "#framework/core/io/log.ts";
import { fakeAccessor, journalFor, journalRecords, withReconcile } from "./fixture.ts";

const RAW_KEY = "user-email";
const RAW_VALUE = "raw-secret-value-42";
// Registered secrets must never appear in a view, a refusal message or journal bytes.
registerSecret(RAW_KEY);
registerSecret(RAW_VALUE);

interface RefusalShape { thrown: boolean; reason: string; message: string; detail: string; info: Record<string, number> | undefined }
async function refusalOf(body: () => Promise<unknown>): Promise<RefusalShape> {
  try { await body(); }
  catch (error) {
    if (!(error instanceof RecipeKitRefusal)) return { thrown: false, reason: "other", message: String(error), detail: "", info: undefined };
    return { thrown: true, reason: error.reason, message: error.message, detail: error.detail ?? "", info: error.info };
  }
  return { thrown: false, reason: "", message: "", detail: "", info: undefined };
}

await withReconcile(async (r) => {
  await r.owning(async () => {
    const owners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];

    // Identifying namespace: the journal and provenance state carry pseudonyms and counts.
    const journal = journalFor(r.ctx, "masking", true);
    const accessor = fakeAccessor();
    const options = { path: "vault.projection", recipe: "fixture", owners, journal, accessor };
    const result = await reconcileApply([{ key: RAW_KEY, value: RAW_VALUE }], options);
    check("apply succeeded for masking setup", { ok: result.ok, applied: result.applied }, { ok: true, applied: true });
    const journalText = r.files.get(journal.journalPath) ?? "";
    const stateText = r.files.get(journal.statePath) ?? "";
    checkTrue("journal carries no raw value", !journalText.includes(RAW_VALUE));
    checkTrue("journal carries no raw key", !journalText.includes(RAW_KEY));
    const intent = journalRecords(r, journal.journalPath)[0].intent as { detail?: Record<string, unknown> } | undefined;
    checkTrue("journal intent carries pseudonym tokens", intent !== undefined && journalText.includes("v1."));
    check("journal detail is counts plus pseudonyms", intent?.detail && { added: intent.detail.added, changed: intent.detail.changed, removed: intent.detail.removed },
      { added: 1, changed: 0, removed: 0 });
    checkTrue("provenance state pseudonymized", stateText.includes("v1.") && !stateText.includes(RAW_KEY));

    // The DEFAULT (identifying omitted) namespace behaves like the explicit one.
    const defaultJournal = journalFor(r.ctx, "masking-default", true);
    const defaultAccessor = fakeAccessor();
    const defaultResult = await reconcileApply([{ key: RAW_KEY, value: RAW_VALUE }],
      { path: "vault.projection", recipe: "fixture", owners, journal: defaultJournal, accessor: defaultAccessor });
    check("default-namespace apply succeeded", { ok: defaultResult.ok, applied: defaultResult.applied }, { ok: true, applied: true });
    const defaultText = (r.files.get(defaultJournal.journalPath) ?? "") + (r.files.get(defaultJournal.statePath) ?? "");
    checkTrue("default namespace carries no raw key or value", !defaultText.includes(RAW_KEY) && !defaultText.includes(RAW_VALUE));
    checkTrue("default namespace pseudonymized", defaultText.includes("v1."));

    // The OMITTED identifying field behaves exactly like the explicit true case: apply's
    // default is pseudonymize (types.ts), and the fixture omits the field when undefined.
    const omittedJournal = journalFor(r.ctx, "masking-omitted");
    checkTrue("omitted journal has no identifying field", !("identifying" in omittedJournal));
    const omittedAccessor = fakeAccessor();
    const omittedResult = await reconcileApply([{ key: RAW_KEY, value: RAW_VALUE }],
      { path: "vault.projection", recipe: "fixture", owners, journal: omittedJournal, accessor: omittedAccessor });
    check("omitted-field apply identical to explicit true", { ok: omittedResult.ok, applied: omittedResult.applied }, { ok: true, applied: true });
    const omittedText = (r.files.get(omittedJournal.journalPath) ?? "") + (r.files.get(omittedJournal.statePath) ?? "");
    checkTrue("omitted field carries no raw key or value", !omittedText.includes(RAW_KEY) && !omittedText.includes(RAW_VALUE));
    checkTrue("omitted field pseudonymized like explicit true", omittedText.includes("v1."));

    // A failed verify returns a FAILED result journaled with an outcome that has no content.
    const failing = fakeAccessor();
    failing.skipWrite = true;
    const failedResult = await reconcileApply([{ key: "other-key", value: "other-raw-value" }], { ...options, accessor: failing });
    check("verify mismatch is a failed result", { status: failedResult.status, reason: failedResult.reason }, { status: "failed", reason: "guard" });
    checkTrue("failed result carries the redacted view", failedResult.view !== undefined && !JSON.stringify(failedResult.view).includes("other-key"));
    const failedRecords = journalRecords(r, journal.journalPath).filter((record) => (record.result as { outcome?: string } | undefined)?.outcome === "failed");
    check("failed outcome journaled", failedRecords.length, 1);
    checkTrue("failed outcome carries no raw content", !JSON.stringify(failedRecords).includes("other-key") && !JSON.stringify(failedRecords).includes("other-raw-value"));

    // Redacted plan view: a registered secret as key AND value appears in neither the view
    // JSON nor any raw form; the UNKEYED view carries no fingerprint at all.
    const plan = reconcilePlan({ desired: [{ key: RAW_KEY, value: RAW_VALUE }], current: {} });
    const plainView = await reconcilePlanView(plan);
    const viewText = JSON.stringify(plainView);
    check("view summary is counts", plainView.summary, { added: 1, changed: 0, removed: 0, unchanged: 0, overlap: 0 });
    checkTrue("view carries neither the raw key nor the raw value", !viewText.includes(RAW_KEY) && !viewText.includes(RAW_VALUE));
    check("unkeyed view entry is an index marker with no fingerprint", { key: plainView.added[0]?.key, fingerprint: plainView.added[0]?.fingerprint, keyed: plainView.keyed },
      { key: "#0", fingerprint: undefined, keyed: false });
    checkTrue("unkeyed view JSON has no digest-looking field", !/"[0-9a-f]{16}"/.test(viewText));
    const keyedView = await reconcilePlanView(plan, { pseudonymize: (key) => Promise.resolve(`token.${key.length}`), fingerprintKey: "masking-fingerprint-key" });
    checkTrue("keyed view also carries neither raw form", !JSON.stringify(keyedView).includes(RAW_KEY) && !JSON.stringify(keyedView).includes(RAW_VALUE));

    // Non-identifying namespace for the removal bounds: a structured counts-only REFUSED
    // result, never a throw.
    const plain = journalFor(r.ctx, "masking-plain", false);
    const plainAccessor = fakeAccessor();
    const plainOptions = { path: "vault.projection", recipe: "fixture", owners, journal: plain, accessor: plainAccessor };
    await reconcileApply([{ key: "member", value: "member-raw-value" }], plainOptions);
    const removalResult = await reconcileApply([], { ...plainOptions, maxRemovedFraction: 0 });
    check("removal refusal is structured counts", { status: removalResult.status, reason: removalResult.reason, info: removalResult.info },
      { status: "refused", reason: "guard", info: { removed: 1, current: 1 } });
    checkTrue("removal refusal carries no raw values", !JSON.stringify(removalResult).includes("member-raw-value") && !JSON.stringify(removalResult).includes(RAW_VALUE));
    checkTrue("removal refusal detail names counts only", (removalResult.detail ?? "").includes("1") && !JSON.stringify(removalResult).includes("member-raw-value") && !JSON.stringify(removalResult).includes(RAW_VALUE));
    check("refused removal patched nothing", plainAccessor.patches.length, 1);
    checkTrue("refused result still carries the computed view", removalResult.view !== undefined);

    // With the consent token the removal succeeds and the journal still stays value-free.
    const consented = await reconcileApply([], { ...plainOptions, maxRemovedFraction: 0, largeRemovalConsent: RECONCILE_LARGE_REMOVAL_CONSENT });
    check("consented removal applied", { applied: consented.applied, removed: consented.summary.removed }, { applied: true, removed: 1 });
    const plainText = r.files.get(plain.journalPath) ?? "";
    checkTrue("consented removal journals no raw values", !plainText.includes("member-raw-value"));

    // The registered secret key/value pair never reaches any journal file byte.
    for (const file of [journal.journalPath, journal.statePath, plain.journalPath]) {
      const bytes = r.files.get(file) ?? "";
      checkTrue(`registered secret absent from ${file}`, !bytes.includes(RAW_KEY) && !bytes.includes(RAW_VALUE));
    }

    // Every result variant carries the redacted view; here the identifying namespace
    // pseudonymizes entry keys and the fingerprints are keyed by the deployment key.
    check("identifying apply result carries a redacted view", {
      present: result.view !== undefined,
      keyPseudonym: result.view?.added[0]?.key.startsWith("v1."),
      fingerprintHex: /^[0-9a-f]{16}$/.test(result.view?.added[0]?.fingerprint ?? ""),
      keyed: result.view?.keyed,
    }, { present: true, keyPseudonym: true, fingerprintHex: true, keyed: true });
    checkTrue("applied view carries neither raw key nor raw value",
      !JSON.stringify(result.view).includes(RAW_KEY) && !JSON.stringify(result.view).includes(RAW_VALUE));

    // Keyed-by-deployment fingerprints: two DIFFERENT deployments (distinct pseudonym key
    // files) fingerprint the SAME value differently — the unkeyed default would not.
    const deployment = (suffix: string) => ({
      ...journalFor(r.ctx, `masking-fp-${suffix}`, false),
      pseudonymDir: `/fixture/data/vault/fp-key-${suffix}.json`,
    });
    const fingerprintOf = async (deployed: ReturnType<typeof journalFor>) => {
      const fpAccessor = fakeAccessor();
      const fpResult = await reconcileApply([{ key: "fp-member", value: RAW_VALUE }],
        { path: "vault.projection", recipe: "fixture", owners, journal: deployed, accessor: fpAccessor });
      return fpResult.view?.added[0]?.fingerprint ?? "missing";
    };
    const fpA = await fingerprintOf(deployment("a"));
    const fpB = await fingerprintOf(deployment("b"));
    checkTrue("different deployments fingerprint the same value differently", fpA !== fpB && fpA !== "missing" && fpB !== "missing");
    checkTrue("deployment views carry no raw value", !JSON.stringify([fpA, fpB]).includes(RAW_VALUE));

    // A read-only view over a deployment whose key does not exist creates NOTHING:
    // index markers, the literal "unavailable", keyed: false.
    const readOnlyResult = await reconcileApply([{ key: "ro-member", value: 1 }], {
      path: "vault.projection", recipe: "fixture", owners,
      journal: { ...journalFor({ ...r.ctx, dryRun: true } as never, "masking-ro", true), pseudonymDir: "/fixture/data/vault/ro-fresh" },
      accessor: fakeAccessor(),
    });
    check("read-only dry run over an absent key", {
      status: readOnlyResult.status, keyed: readOnlyResult.view?.keyed,
      key: readOnlyResult.view?.added[0]?.key, fingerprint: readOnlyResult.view?.added[0]?.fingerprint,
    }, { status: "dry-run", keyed: false, key: "#0", fingerprint: "unavailable" });

    // A pseudonym context whose key is unavailable STILL refuses in non-read-only view
    // calls — no unkeyed digest fallback.
    const unkeyedPlan = reconcilePlan({ desired: [{ key: "k", value: 1 }], current: {} });
    const unavailable = await refusalOf(() => reconcilePlanView(unkeyedPlan, {
      pseudonym: { ctx: r.ctx, pseudonymDir: "/fixture/outside/key.json" },
    }));
    check("unavailable pseudonym key refuses", { thrown: unavailable.thrown, reason: unavailable.reason },
      { thrown: true, reason: "invalid-request" });
  });
});

finish("recipe-kit reconcile masking");
