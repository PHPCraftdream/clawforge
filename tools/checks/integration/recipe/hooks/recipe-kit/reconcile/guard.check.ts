// Requirements 4 and 8: fail-closed guards — protected path segments (target paths, plan
// keys and nested value keys), ownership resolution, large-removal consent (the dedicated
// symbol only, never any "confirm" string form), with structured count-only refusals.
// Assertions are structural: reason codes, the refusal's `detail`/`info` fields, booleans,
// numbers and symbol identity — never framework message prose.
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import {
  GUARD_NO_OWNERSHIP_SOURCE, GUARD_PATH_FOREIGN_OWNER, GUARD_PATH_PROTECTED, GUARD_PATH_UNOWNED,
  RECONCILE_LARGE_REMOVAL_CONSENT, reconcileApply,
} from "#framework/recipe-kit/index.ts";
import { checkOwnership, checkProtectedPath, checkProtectedPlan, checkRemovalBounds } from "#framework/recipe-kit/reconcile/guard.ts";
// Deep import: the internal full-fidelity planner is deliberately absent from the entry.
import { reconcilePlan } from "#framework/recipe-kit/reconcile/plan.ts";
import type { ReconcileApplyOptions, ReconcilePathOwner } from "#framework/recipe-kit/index.ts";
import { RECONCILE_PROTECTED_SEGMENTS, RecipeKitRefusal } from "#framework/recipe-kit/index.ts";
import { fakeAccessor, journalFor, withReconcile } from "./fixture.ts";

interface Caught { refused: boolean; reason: string; detail: string; info: Record<string, number> | undefined }
function caught(body: () => unknown): Caught {
  try { body(); return { refused: false, reason: "", detail: "", info: undefined }; }
  catch (error) {
    if (!(error instanceof RecipeKitRefusal)) return { refused: false, reason: "other", detail: "", info: undefined };
    return { refused: true, reason: error.reason, detail: error.detail ?? "", info: error.info };
  }
}
function guardRefusal(name: string, body: () => unknown, detail: string): void {
  check(name, caught(body).detail, detail);
}
function guardRefused(name: string, body: () => unknown): void {
  const result = caught(body);
  check(name, { refused: result.refused, reason: result.reason }, { refused: true, reason: "guard" });
}
/** Count-only refusal: the detail is exactly the count sentence, the info field structured. */
function guardCountRefusal(name: string, result: Caught, removed: number, current: number): void {
  check(name, { refused: result.refused, reason: result.reason, info: result.info, countsInDetail: result.detail.includes(String(removed)) && result.detail.includes(String(current)) },
    { refused: true, reason: "guard", info: { removed, current }, countsInDetail: true });
}

// --- requirement 8: protected paths -----------------------------------------------------------
const owner = (path: string): ReconcilePathOwner => ({ recipe: "r", path, mode: "value", prefix: false });
checkProtectedPath("a.b");
checkProtectedPath("a.rooms.b");
check("checkProtectedPath returns the safe path", checkProtectedPath("x.y_z-9.A"), "x.y_z-9.A");
for (const path of ["owners", "a.approvers", "credentials.x", "deep.owners.list", "a.custom.b"]) {
  const extra = path.includes("custom") ? ["custom"] : undefined;
  guardRefusal(`protected path ${path}`, () => checkProtectedPath(path, extra), GUARD_PATH_PROTECTED);
}
// Built-ins cannot be shrunk: an empty extension list still protects owners/approvers/credentials.
for (const path of ["owners", "a.approvers", "credentials.x"]) {
  guardRefusal(`protected path survives empty extension ${path}`, () => checkProtectedPath(path, []), GUARD_PATH_PROTECTED);
}
// A dotted extension matches as a segment sequence from the path root (the
// underReconcilePrefix rule, equality included); embedded-but-unrooted sequences do not match.
for (const [path, extra] of [["a.custom.b", ["custom"]], ["custom.b", ["custom.b"]], ["a.custom.b.c", ["a.custom"]], ["custom.b.c", ["custom.b"]], ["a.b.custom", ["a.b"]]] as const) {
  guardRefused(`dotted extension matches ${path} via ${extra[0]}`, () => checkProtectedPath(path, [...extra]));
}
for (const path of ["a.customs.b", "a.customization.b", "a.custom.b"]) {
  checkProtectedPath(path, ["custom.b"]);
}
// Invalid paths refuse as invalid-request, not guard.
check("invalid path refuses", caught(() => checkProtectedPath("a..b")).reason, "invalid-request");

// The exported protected-segment list is frozen: mutation throws (strict mode) or is a no-op.
let mutationThrew = false;
try { (RECONCILE_PROTECTED_SEGMENTS as string[]).push("nope"); }
catch { mutationThrew = true; }
check("protected segment list is frozen", { mutationThrew, length: RECONCILE_PROTECTED_SEGMENTS.length }, { mutationThrew: true, length: 3 });
const callerList = ["extra"];
guardRefused("extension protects before copy", () => checkProtectedPath("a.extra.b", callerList));
// A frozen extension list is accepted as-is, and no mutation of a caller list can shrink the built-ins.
checkProtectedPath("a.safe.b", Object.freeze(["frozen"]));
guardRefused("frozen extension protects", () => checkProtectedPath("a.frozen.b", Object.freeze(["frozen"])));
guardRefused("built-ins survive caller list mutation", () => {
  const list = ["harmless"];
  list.length = 0;
  return checkProtectedPath("a.owners.b", list);
});

// --- requirement 8 (plan walking): protected plan keys and nested value keys --------------------
const cleanPath = "vault.projection";
const plan = reconcilePlan({
  desired: [
    { key: "settings", value: { owners: ["x"] } },
    { key: "safe", value: { nested: { approvers: 1 } } },
  ],
  current: { gone: 1 },
  provenance: ["gone"],
});
// Entry keys are single segments; dotted keys arise as stored pseudonym tokens, so the
// dotted-key case is expressed with a literal plan.
const emptySummary = { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 0 };
const dottedKeyPlan = { added: [], changed: [], removed: [{ key: "credentials.token" }], unchanged: [], overlap: [], summary: emptySummary };
// The target path itself is clean; the protected keys are nested members under it.
checkProtectedPath(cleanPath);
for (const [name, body] of [
  ["protected key nested under owned ancestor", () => checkProtectedPlan(cleanPath, plan, { gone: 1 })],
  ["dotted key segment protected", () => checkProtectedPlan(cleanPath, dottedKeyPlan, {})],
  ["nested value key protected", () => checkProtectedPlan(cleanPath, reconcilePlan({ desired: [{ key: "safe", value: { nested: { approvers: 1 } } }], current: {} }), {})],
  ["removed key protected", () => checkProtectedPlan(cleanPath, reconcilePlan({ desired: [], current: { owners: 1 }, provenance: ["owners"] }), { owners: 1 })],
  ["dotted extension matches plan key", () => checkProtectedPlan(cleanPath, { ...dottedKeyPlan, removed: [{ key: "billing.custom.plan" }] }, {}, ["vault.projection.billing"])],
] as const) {
  guardRefused(name, body);
}
checkProtectedPlan(cleanPath, reconcilePlan({ desired: [{ key: "safe", value: { nested: { total: 1 } } }], current: {} }), {});
// The CURRENT value of a removed member is inspected too: a protected nested key present
// only in the old shape refuses, matched by a multi-level dotted extension over the full
// accumulated path.
const deepExtension = ["vault.projection.member.nested.secret"];
guardRefused("removed member's current nested value protected", () =>
  checkProtectedPlan(cleanPath, reconcilePlan({ desired: [], current: { member: { nested: { secret: 1 } } }, provenance: ["member"] }), { member: { nested: { secret: 1 } } }, deepExtension));
// Changed members: the CURRENT value is inspected alongside the new one — replacing a
// member whose old shape carries a protected nested key refuses even when the new value is clean.
guardRefused("changed member's current value protected", () =>
  checkProtectedPlan(cleanPath, reconcilePlan({ desired: [{ key: "member", value: 3 }], current: { member: { nested: { secret: 1 } } }, provenance: ["member"] }), { member: { nested: { secret: 1 } } }, deepExtension));
// Multi-level dotted extension matches a nested value path via the full accumulated path.
guardRefused("multi-level dotted extension matches nested value path", () =>
  checkProtectedPlan(cleanPath, reconcilePlan({ desired: [{ key: "safe", value: { nested: { secret: 1 } } }], current: {} }), {}, ["vault.projection.safe.nested.secret"]));
checkProtectedPlan(cleanPath, reconcilePlan({ desired: [{ key: "safe", value: { nested: { total: 1 } } }], current: {} }), {}, deepExtension);

// --- requirement 8: ownership ------------------------------------------------------------------
const owners: readonly ReconcilePathOwner[] = [owner("app.settings"), { recipe: "other", path: "app.prefix", mode: "list-member", prefix: true }, owner("app.prefix.deep.exact")];
check("exact owner resolved", checkOwnership({ path: "app.settings", recipe: "r", owners }).path, "app.settings");
check("prefix owner resolved", checkOwnership({ path: "app.prefix.member", recipe: "other", owners }).mode, "list-member");
check("exact beats prefix", checkOwnership({ path: "app.prefix.deep.exact", recipe: "r", owners }).recipe, "r");
check("ownerOf lookup used", checkOwnership({ path: "p", recipe: "r", ownerOf: (path) => (path === "p" ? owner("p") : undefined) }).path, "p");
guardRefusal("no ownership source", () => checkOwnership({ path: "a.b", recipe: "r" }), GUARD_NO_OWNERSHIP_SOURCE);
guardRefusal("path unowned", () => checkOwnership({ path: "nobody.path", recipe: "r", owners }), GUARD_PATH_UNOWNED);
guardRefusal("path owned by another recipe", () => checkOwnership({ path: "app.settings", recipe: "other", owners }), GUARD_PATH_FOREIGN_OWNER);

// --- requirement 4: removal bounds, counts-only refusal, consent token --------------------------
const bounds = (removed: number, currentCount: number, options: Partial<ReconcileApplyOptions> = {}): Caught =>
  caught(() => checkRemovalBounds(removed, currentCount, options as ReconcileApplyOptions));
check("zero removal passes", bounds(0, 0).refused, false);
check("small removal passes", bounds(1, 4).refused, false);
check("at-default count bound passes", bounds(100, 200).refused, false);
check("fraction bound refusal info", bounds(3, 4).info, { removed: 3, current: 4 });
checkTrue("count refusals name counts only", bounds(3, 4).detail.includes("3") && bounds(3, 4).detail.includes("4"));
guardCountRefusal("count bound refusal", bounds(101, 1000), 101, 1000);
// The bounds are NOT caller-raisable: raising without the token refuses.
checkTrue("raised fraction bound refuses without token", bounds(3, 4, { maxRemovedFraction: 1 }).refused);
checkTrue("raised count bound refuses without token", bounds(150, 1000, { maxRemovedCount: 150 }).refused);
check("raised bounds refusal info", bounds(3, 4, { maxRemovedFraction: 1 }).info, { removed: 3, current: 4 });
// Lowering still tightens.
guardCountRefusal("tightened count bound still enforced", bounds(3, 10, { maxRemovedCount: 2 }), 3, 10);
check("token alone lifts the default bounds", bounds(3, 4, { largeRemovalConsent: RECONCILE_LARGE_REMOVAL_CONSENT }).refused, false);
check("token lifts the count bound", bounds(150, 1000, { largeRemovalConsent: RECONCILE_LARGE_REMOVAL_CONSENT }).refused, false);
// The consent token is a distinct symbol: no string "confirm" form and no other symbol lifts the bounds.
check("consent token is a symbol", typeof RECONCILE_LARGE_REMOVAL_CONSENT, "symbol");
for (const impostor of ["confirm", "--confirm", "yes"] as unknown as symbol[]) {
  checkTrue(`string consent form refused: ${String(impostor)}`, bounds(3, 4, { largeRemovalConsent: impostor }).refused);
}
for (const symbol of [Symbol("confirm"), Symbol.for("confirm"), Symbol("clawforge.reconcile.large-removal-consent.v1")]) {
  checkTrue(`impostor symbol refused: ${String(symbol)}`, bounds(3, 4, { largeRemovalConsent: symbol }).refused);
}

// End-to-end: a large removal refuses before any patch, proceeds with the real token.
await withReconcile(async (r) => {
  await r.owning(async () => {
    const journal = journalFor(r.ctx, "bounds", false);
    const applyOwners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];
    const accessor = fakeAccessor();
    const desired = [...["a", "b", "c", "d"].map((key) => ({ key, value: `raw-${key}-value` })), { key: "standard", value: 1 }];
    const options = { path: "vault.projection", recipe: "fixture", owners: applyOwners, journal, accessor };
    // Expected ownership/path guard failures are returned before planning and therefore
    // have no view. Invalid options/paths remain thrown programmer errors.
    const unowned = await reconcileApply([{ key: "a", value: 1 }], {
      path: "vault.unowned", recipe: "fixture", owners: [], journal, accessor,
    });
    check("unowned path returns refused", { status: unowned.status, reason: unowned.reason, view: unowned.view },
      { status: "refused", reason: "guard", view: undefined });
    const foreign = await reconcileApply([{ key: "a", value: 1 }], {
      path: "vault.projection", recipe: "other", owners, journal, accessor,
    });
    check("foreign owner returns refused", { status: foreign.status, reason: foreign.reason, view: foreign.view },
      { status: "refused", reason: "guard", view: undefined });
    const protectedTarget = await reconcileApply([{ key: "a", value: 1 }], {
      path: "vault.credentials", recipe: "fixture", owners: [{ recipe: "fixture", path: "vault.credentials", mode: "value", prefix: false }], journal, accessor,
    });
    check("protected target returns refused", { status: protectedTarget.status, reason: protectedTarget.reason, view: protectedTarget.view },
      { status: "refused", reason: "guard", view: undefined });
    check("early guard refusals patch nothing", accessor.patches.length, 0);

    // A protected plan key under a clean owned target path refuses as a RESULT before any
    // Non-protected desired keys under the same extension still apply.
    const extension = ["custom"];
    const protectedOptions = { ...options, protectedPaths: extension };
    const applied = await reconcileApply([{ key: "standard", value: 1 }], protectedOptions);
    check("extension leaves other keys appliable", { applied: applied.applied, added: applied.summary.added }, { applied: true, added: 1 });
    const seeded = await reconcileApply(desired, options);
    check("seed apply added four", seeded.summary.added, 4);
    check("seed apply keeps the earlier member", seeded.summary.unchanged, 1);
    const rawKeys = JSON.stringify(r.files.get(journal.journalPath));
    checkTrue("seed journal carries no raw values", rawKeys !== null && !rawKeys.includes("raw-a-value"));
    // Removing all members breaches the fraction bound without consent: a structured,
    // counts-only refused result.
    const refusalResult = await reconcileApply([], options);
    check("large removal refusal is structured", {
      status: refusalResult.status, ok: refusalResult.ok, reason: refusalResult.reason, info: refusalResult.info,
    }, { status: "refused", ok: false, reason: "guard", info: { removed: 5, current: 5 } });
    checkTrue("large removal refusal names no values", !JSON.stringify(refusalResult).includes("raw-a-value"));
    checkTrue("large removal refusal names no values", !JSON.stringify(refusalResult).includes("raw-a-value"));
    check("refused removal patched nothing", accessor.patches.length, 2);
    // The dedicated token lifts the bound; the removal then happens in the batch patch.
    const consented = await reconcileApply([], { ...options, largeRemovalConsent: RECONCILE_LARGE_REMOVAL_CONSENT });
    check("consented removal applied", { ok: consented.ok, applied: consented.applied, summary: consented.summary },
      { ok: true, applied: true, summary: { added: 0, changed: 0, removed: 5, unchanged: 0, overlap: 0 } });
    check("consented removal patched once more", accessor.patches.length, 3);
    check("consented removal empties the projection", accessor.patches[2], {});
  });
});

// End-to-end: removing a member whose CURRENT value carries a protected nested key refuses
// before any patch — zero patches, reason guard.
await withReconcile(async (r) => {
  await r.owning(async () => {
    const journal = journalFor(r.ctx, "protected-current", false);
    const applyOwners: readonly ReconcilePathOwner[] = [{ recipe: "fixture", path: "vault.projection", mode: "value", prefix: false }];
    const accessor = fakeAccessor({ member: { nested: { secret: 1 } }, other: 1 });
    const options = { path: "vault.projection", recipe: "fixture", owners: applyOwners, journal, accessor };
    // Seed provenance for "member" by adopting it explicitly, so the empty desired set
    // makes it a removal candidate.
    const seeded = await reconcileApply([{ key: "member", value: { nested: { secret: 1 } } }, { key: "other", value: 1 }], { ...options, adoptOverlaps: true });
    check("seed adopted both members", { applied: seeded.applied, added: seeded.summary.added }, { applied: true, added: 0 });
    const patchesBefore = accessor.patches.length;
    const removed = await reconcileApply([], { ...options, protectedPaths: ["vault.projection.member.nested.secret"] });
    check("protected current value removal refuses", {
      status: removed.status, ok: removed.ok, reason: removed.reason,
    }, { status: "refused", ok: false, reason: "guard" });
    check("protected removal patched nothing", accessor.patches.length, patchesBefore);
  });
});

finish("recipe-kit reconcile guard");
