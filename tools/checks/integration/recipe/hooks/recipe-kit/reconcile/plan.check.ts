// Requirement 1: pure planner table tests, including adversarial desired sets, currents and
// provenance lists. Everything here is synchronous and touches no transport. Assertions are
// structural only: reasons, parsed fields, counts and fingerprints — no framework prose.
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { canonical, isReconcileValue, reconcilePlanView } from "#framework/recipe-kit/index.ts";
// Deep import: the internal full-fidelity planner is deliberately absent from the entry.
import { reconcilePlan } from "#framework/recipe-kit/reconcile/plan.ts";
import type { ReconcileEntry, ReconcilePlanInput, ReconcileValue } from "#framework/recipe-kit/index.ts";
import { RecipeKitRefusal } from "#framework/recipe-kit/index.ts";
import { registerSecret } from "#framework/core/io/log.ts";
import { withReconcile } from "./fixture.ts";

function planOf(desired: unknown, current?: unknown, provenance?: readonly string[]) {
  return reconcilePlan({
    desired: desired as readonly ReconcileEntry[], current,
    ...(provenance === undefined ? {} : { provenance }),
  });
}

function refusalReason(body: () => unknown): string {
  try { body(); return "no-refusal"; }
  catch (error) { return error instanceof RecipeKitRefusal ? error.reason : "other-error"; }
}

function holey(): unknown[] { const array = Array.from({ length: 2 }); array[1] = 1; return array; }

// --- adversarial desired sets ---------------------------------------------------------------
const BAD_DESIRED: Array<[string, unknown]> = [
  ["null desired", null],
  ["string desired", "keys"],
  ["number desired", 5],
  ["object desired", { key: "a", value: 1 }],
  ["entry null", [null]],
  ["entry array", [[]]],
  ["entry missing value", [{ key: "a" }]],
  ["entry extra key", [{ key: "a", value: 1, note: "x" }]],
  ["entry non-string key", [{ key: 5, value: 1 }]],
  ["entry empty key", [{ key: "", value: 1 }]],
  ["entry dotted key", [{ key: "a.b", value: 1 }]],
  ["entry __proto__ key", [{ key: "__proto__", value: 1 }]],
  ["entry constructor key", [{ key: "constructor", value: 1 }]],
  ["entry prototype key", [{ key: "prototype", value: 1 }]],
  ["duplicate keys", [{ key: "a", value: 1 }, { key: "a", value: 2 }]],
  ["undefined value", [{ key: "a", value: undefined }]],
  ["function value", [{ key: "a", value: () => 1 }]],
  ["bigint value", [{ key: "a", value: 10n }]],
  ["NaN value", [{ key: "a", value: Number.NaN }]],
  ["Infinity value", [{ key: "a", value: Number.POSITIVE_INFINITY }]],
  ["date value", [{ key: "a", value: new Date(0) }]],
  ["class instance value", [{ key: "a", value: new (class X {})() }]],
  ["value with constructor key", [{ key: "a", value: JSON.parse('{"constructor":1}') }]],
  ["value with prototype key", [{ key: "a", value: JSON.parse('{"prototype":1}') }]],
  ["holey array value", [{ key: "a", value: holey() }]],
  ["array with extra own key", [{ key: "a", value: Object.assign([1], { extra: true }) }]],
  ["exotic object value", [{ key: "a", value: new Map() }]],
];
for (const [name, desired] of BAD_DESIRED) {
  checkTrue(`desired refused ${name}`, refusalReason(() => planOf(desired, {}, [])) === "invalid-request");
}
checkTrue("current null refused", refusalReason(() => planOf([], null)) === "invalid-request");
checkTrue("current array refused", refusalReason(() => planOf([], [])) === "invalid-request");
checkTrue("current number refused", refusalReason(() => planOf([], 5)) === "invalid-request");
checkTrue("current unsafe key refused", refusalReason(() => planOf([], JSON.parse('{"__proto__":1}'))) === "invalid-request");
checkTrue("current function refused", refusalReason(() => planOf([], () => 1)) === "invalid-request");
// The bad rows above are all DESIRED-set rows; the provenance list is a separate input and
// gets its own bad rows — passed as provenance, refused as provenance.
checkTrue("provenance not array refused", refusalReason(() => planOf([], {}, "ghost" as unknown as readonly string[])) === "invalid-request");
checkTrue("provenance non-string refused", refusalReason(() => planOf([], {}, [5] as unknown as readonly string[])) === "invalid-request");
checkTrue("provenance empty key refused", refusalReason(() => planOf([], {}, [""] as unknown as readonly string[])) === "invalid-request");
// Stored provenance may be pseudonym tokens: dotted strings pass the key-list bound.
checkTrue("provenance pseudonym tokens accepted", planOf([], {}, ["v1.abc_DEF-0"]).removed.length === 0);

// --- hostile foreign input: throwing getters, hostile maps, Proxy traps ----------------------
const HOSTILE_SECRET = "plan-hostile-secret-4c2";
registerSecret(HOSTILE_SECRET);
interface RefusalProbe { refused: boolean; reason: string; contentFree: boolean }
function probe(body: () => unknown): RefusalProbe {
  try { body(); return { refused: false, reason: "no-refusal", contentFree: false }; }
  catch (error) {
    if (!(error instanceof RecipeKitRefusal)) return { refused: false, reason: "other-error", contentFree: false };
    const text = `${error.message}\u0000${error.detail ?? ""}\u0000${JSON.stringify(error.info ?? {})}`;
    return {
      refused: true, reason: error.reason,
      contentFree: !text.includes(HOSTILE_SECRET) && !Object.hasOwn(error, "cause"),
    };
  }
}
const CONTENT_FREE = { refused: true, reason: "invalid-request", contentFree: true };
const throwingInput = { get desired() { throw new Error(`leak ${HOSTILE_SECRET}`); }, current: {} };
check("throwing desired getter is content-free", probe(() => reconcilePlan(throwingInput as unknown as ReconcilePlanInput)), CONTENT_FREE);
const hostileMapDesired = [{ key: "a", value: 1 }] as unknown[];
(hostileMapDesired as { map?: unknown }).map = () => { throw new Error(`map leak ${HOSTILE_SECRET}`); };
check("throwing map on desired", probe(() => planOf(hostileMapDesired, {}, [])), CONTENT_FREE);
const nonFunctionMap = [{ key: "a", value: 1 }] as unknown[];
(nonFunctionMap as { map?: unknown }).map = 5;
check("non-function map on desired", probe(() => planOf(nonFunctionMap, {}, [])), CONTENT_FREE);
const hostileProvenance = ["k"] as unknown[];
(hostileProvenance as { map?: unknown }).map = 5;
check("non-function map on provenance", probe(() => reconcilePlan({ desired: [], current: {}, provenance: hostileProvenance as unknown as readonly string[] })), CONTENT_FREE);
const throwingProxyDesired = new Proxy([{ key: "a", value: 1 }], { get() { throw new Error(`proxy leak ${HOSTILE_SECRET}`); } });
check("proxy desired get trap", probe(() => reconcilePlan({ desired: throwingProxyDesired as unknown as readonly ReconcileEntry[], current: {} })), CONTENT_FREE);
const throwingProxyCurrent = new Proxy({ a: 1 }, { get() { throw new Error(`current leak ${HOSTILE_SECRET}`); } });
check("proxy current get trap", probe(() => reconcilePlan({ desired: [], current: throwingProxyCurrent })), CONTENT_FREE);
const getterEntry = [{ key: "a", get value(): number { throw new Error(`value leak ${HOSTILE_SECRET}`); } }];
check("entry getter is content-free", probe(() => reconcilePlan({ desired: getterEntry as unknown as readonly ReconcileEntry[], current: {} })), CONTENT_FREE);

// --- redacted view hardening: foreign plan shapes and pseudonymizer failures must refuse
// content-free — the underlying error, and any secret it carries, never leaks. ----------------
const VIEW_SECRET = "view-hostile-secret-77e";
registerSecret(VIEW_SECRET);
async function probeView(body: () => Promise<unknown>): Promise<RefusalProbe> {
  try { await body(); return { refused: false, reason: "no-refusal", contentFree: false }; }
  catch (error) {
    if (!(error instanceof RecipeKitRefusal)) return { refused: false, reason: "other-error", contentFree: false };
    const text = `${error.message}\u0000${error.detail ?? ""}\u0000${JSON.stringify(error.info ?? {})}`;
    return {
      refused: true, reason: error.reason,
      contentFree: !text.includes(VIEW_SECRET) && !text.includes(HOSTILE_SECRET) && !Object.hasOwn(error, "cause"),
    };
  }
}

// --- descriptor-only validation: accessors on array elements are refused, never invoked ------
const HOSTILE_SECRET_2 = "plan-accessor-secret-9d3";
registerSecret(HOSTILE_SECRET_2);
let accessorInvoked = false;
const accessorDesired: unknown[] = [];
Object.defineProperty(accessorDesired, "0", {
  enumerable: true,
  get() { accessorInvoked = true; throw new Error(`accessor leak ${HOSTILE_SECRET_2}`); },
});
check("accessor desired element is content-free", probe(() => planOf(accessorDesired, {}, [])), CONTENT_FREE);
checkTrue("accessor desired element never invoked the getter", !accessorInvoked);
// Same rule on a plan CATEGORY array reaching the public view.
const accessorCategory: unknown[] = [];
Object.defineProperty(accessorCategory, "0", {
  enumerable: true,
  get() { accessorInvoked = true; throw new Error(`category accessor leak ${HOSTILE_SECRET_2}`); },
});
check("accessor plan category is content-free",
  await probeView(() => reconcilePlanView({
    added: accessorCategory, changed: [], removed: [], unchanged: [], overlap: [],
    summary: { added: 1, changed: 0, removed: 0, unchanged: 0, overlap: 0 },
  } as unknown as Parameters<typeof reconcilePlanView>[0])), CONTENT_FREE);
checkTrue("accessor plan category never invoked the getter", !accessorInvoked);
// A value carrying a nested accessor that would reach the fingerprint step refuses
// content-free BEFORE any value read — the getter is never invoked, never leaks.
const nestedHolder: Record<string, unknown> = {};
Object.defineProperty(nestedHolder, "secret", {
  enumerable: true,
  get() { accessorInvoked = true; throw new Error(`nested value leak ${HOSTILE_SECRET_2}`); },
});
const nestedGetterPlan = {
  added: [{ key: "a", value: { nested: nestedHolder } }],
  changed: [], removed: [], unchanged: [], overlap: [],
  summary: { added: 1, changed: 0, removed: 0, unchanged: 0, overlap: 0 },
};
check("nested accessor value is content-free",
  await probeView(() => reconcilePlanView(nestedGetterPlan as unknown as Parameters<typeof reconcilePlanView>[0])), CONTENT_FREE);
checkTrue("nested accessor value never invoked the getter", !accessorInvoked);

// --- happy-path table -------------------------------------------------------------------------
interface Row { name: string; desired: readonly ReconcileEntry[]; current?: unknown; provenance?: readonly string[]; expect: { added: number; changed: number; removed: number; unchanged: number; overlap: number } }
const ROWS: Row[] = [
  { name: "empty everything", desired: [], expect: { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 0 } },
  { name: "undefined current adds", desired: [{ key: "a", value: 1 }], expect: { added: 1, changed: 0, removed: 0, unchanged: 0, overlap: 0 } },
  { name: "array values plan", desired: [{ key: "list", value: [1, { b: "x" }] }], expect: { added: 1, changed: 0, removed: 0, unchanged: 0, overlap: 0 } },
  {
    name: "added changed unchanged removed",
    desired: [{ key: "a", value: 1 }, { key: "b", value: "new" }, { key: "c", value: "same" }],
    current: { b: "old", c: "same", d: "dead" },
    provenance: ["b", "c", "d"],
    expect: { added: 1, changed: 1, removed: 1, unchanged: 1, overlap: 0 },
  },
  {
    name: "key order never fakes a change",
    desired: [{ key: "k", value: { b: 2, a: 1 } as ReconcileValue }],
    current: { k: { a: 1, b: 2 } },
    provenance: ["k"],
    expect: { added: 0, changed: 0, removed: 0, unchanged: 1, overlap: 0 },
  },
  {
    name: "unprovenanced current key is not removed",
    desired: [],
    current: { x: 1 },
    expect: { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 0 },
  },
  {
    name: "provenance key absent from current ignored",
    desired: [{ key: "live", value: 1 }],
    current: { live: 1 },
    provenance: ["ghost", "live"],
    expect: { added: 0, changed: 0, removed: 0, unchanged: 1, overlap: 0 },
  },
  {
    name: "desired key in current without provenance is overlap",
    desired: [{ key: "x", value: 2 }],
    current: { x: 1 },
    expect: { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 1 },
  },
];
for (const row of ROWS) {
  const plan = planOf(row.desired, row.current, row.provenance);
  // Structural check: per-category counts, the disjoint summary, and the member keys each
  // category carries (values are asserted only as counts — never compared as prose).
  const counts = {
    added: plan.added.length, changed: plan.changed.length, removed: plan.removed.length,
    unchanged: plan.unchanged.length, overlap: plan.overlap.length,
  };
  check(`plan ${row.name}`, { counts, summary: plan.summary }, { counts: row.expect, summary: row.expect });
}
// Changed and removed member identity, asserted structurally.
const mixed = planOf(
  [{ key: "a", value: 1 }, { key: "b", value: "new" }, { key: "c", value: "same" }],
  { b: "old", c: "same", d: "dead" }, ["b", "c", "d"],
);
check("mixed plan member keys", {
  added: mixed.added.map((entry) => entry.key),
  changed: mixed.changed.map((entry) => entry.key),
  removed: mixed.removed.map((entry) => entry.key),
  unchanged: mixed.unchanged.map((entry) => entry.key),
  overlap: mixed.overlap.map((entry) => entry.key),
}, { added: ["a"], changed: ["b"], removed: ["d"], unchanged: ["c"], overlap: [] });
checkTrue("changed plan keeps the raw value internally", mixed.changed[0]?.value === "new");
// Overlap is excluded from added/changed/removed/unchanged counts (summary stays disjoint).
const overlapPlan = planOf([{ key: "x", value: 2 }, { key: "y", value: 9 }], { x: 1, y: 2 }, ["y"]);
check("overlap summary disjoint", overlapPlan.summary, { added: 0, changed: 1, removed: 0, unchanged: 0, overlap: 1 });

// Canonical form is literal JSON with sorted keys: assert against literal text, not the
// function's own output, so the expectation is independent of the code under test.
check("canonical key order equal", canonical(JSON.parse('{"b":2,"a":1}') as ReconcileValue), '{"a":1,"b":2}');
check("canonical distinguishes values", [canonical(1 as ReconcileValue), canonical("1" as ReconcileValue)], ["1", '"1"']);

checkTrue("isReconcileValue accepts safe", isReconcileValue({ a: [1, "x", null, true, { b: 1.5 }] }));
checkTrue("isReconcileValue accepts plain arrays", isReconcileValue([1, [2, { c: null }]]));
checkTrue("isReconcileValue refuses holey arrays", !isReconcileValue(holey()));
checkTrue("isReconcileValue refuses array with extra own key", !isReconcileValue(Object.assign([1], { extra: 1 })));
checkTrue("isReconcileValue refuses exotic prototype", !isReconcileValue(new Map()));
checkTrue("isReconcileValue refuses unsafe segment key", !isReconcileValue(JSON.parse('{"a-b":1,"__proto__":2}')));
checkTrue("isReconcileValue accepts null-prototype object", isReconcileValue(Object.assign(Object.create(null), { a: 1 })));

// --- public redacted view ----------------------------------------------------------------------
const viewPlan = planOf(
  [{ key: "user-email", value: "secret-value" }, { key: "keep", value: 1 }],
  { keep: 1, gone: 2 }, ["keep", "gone"],
);
// Unkeyed view (no key, no context): `#index` keys, NO fingerprints at all, keyed: false.
const plainView = await reconcilePlanView(viewPlan);
check("view without pseudonyms uses per-plan indices", {
  added: plainView.added.map((entry) => entry.key), changed: plainView.changed.length,
  removed: plainView.removed.map((entry) => entry.key), unchanged: plainView.unchanged.map((entry) => entry.key),
  overlap: plainView.overlap.length, summary: plainView.summary, keyed: plainView.keyed,
}, {
  added: ["#0"], changed: 0, removed: ["#1"], unchanged: ["#2"], overlap: 0,
  summary: { added: 1, changed: 0, removed: 1, unchanged: 1, overlap: 0 }, keyed: false,
});
check("unkeyed view entries carry only the key", Object.keys(plainView.added[0] ?? {}).sort(), ["key"]);
checkTrue("unkeyed view carries no digest-looking field", !/"[0-9a-f]{16}"/.test(JSON.stringify(plainView)) && !JSON.stringify(plainView).includes("fingerprint"));
checkTrue("view never carries raw keys or values", !JSON.stringify(plainView).includes("user-email") && !JSON.stringify(plainView).includes("secret-value"));
// Options are read descriptor-only: a getter on the options object is never invoked, so a
// registered secret it carries can never leak.
check("getter-based pseudonymize option is content-free",
  await probeView(() => reconcilePlanView(viewPlan, {
    get pseudonymize(): (key: string) => Promise<string> { throw new Error(`options leak ${VIEW_SECRET}`); },
  })), CONTENT_FREE);
check("getter-based fingerprintKey option is content-free",
  await probeView(() => reconcilePlanView(viewPlan, {
    get fingerprintKey(): string { throw new Error(`options key leak ${VIEW_SECRET}`); },
  })), CONTENT_FREE);
check("getter-based pseudonym option is content-free",
  await probeView(() => reconcilePlanView(viewPlan, {
    get pseudonym(): unknown { throw new Error(`options ctx leak ${VIEW_SECRET}`); },
  } as unknown as Parameters<typeof reconcilePlanView>[1])), CONTENT_FREE);
const keyedView = await reconcilePlanView(viewPlan, { pseudonymize: (key) => Promise.resolve(`token.${key.length}`), fingerprintKey: "view-fingerprint-key" });
check("view pseudonymizes keys", keyedView.added.map((entry) => entry.key), ["token.10"]);
checkTrue("keyed view reports keyed", keyedView.keyed === true);
checkTrue("keyed fingerprints are bounded hex", [keyedView.added, keyedView.removed, keyedView.unchanged].every((list) => list.every((entry) => /^[0-9a-f]{16}$/.test(entry.fingerprint ?? ""))));
// Determinism is keyed-only: the same key reproduces the same fingerprints.
const again = await reconcilePlanView(viewPlan, { pseudonymize: (key) => Promise.resolve(`token.${key.length}`), fingerprintKey: "view-fingerprint-key" });
check("keyed fingerprints are deterministic", again.added[0]?.fingerprint, keyedView.added[0]?.fingerprint);
// Read-only view with an absent key over a REAL recording context: nothing is created and
// the view reports the documented unkeyed shape.
await withReconcile(async (ro) => {
  await ro.owning(async () => {
    const readOnlyView = await reconcilePlanView(viewPlan, {
      readOnlyKey: true,
      pseudonym: { ctx: ro.ctx, pseudonymDir: "/fixture/data/vault/ro-view-fresh" },
    });
    check("read-only unkeyed view", {
      keys: readOnlyView.added.map((entry) => entry.key), fingerprints: readOnlyView.added.map((entry) => entry.fingerprint), keyed: readOnlyView.keyed,
    }, { keys: ["#0"], fingerprints: ["unavailable"], keyed: false });
    checkTrue("read-only view created no key file", !ro.files.has("/fixture/data/vault/ro-view-fresh"));
  });
});

// A throwing value getter on a plan entry is refused content-free, never invoked into the view.
const getterEntryPlan = {
  added: [{ key: "a", get value(): number { throw new Error(`view entry leak ${VIEW_SECRET}`); } }],
  changed: [], removed: [], unchanged: [], overlap: [],
  summary: { added: 1, changed: 0, removed: 0, unchanged: 0, overlap: 0 },
};
check("view throwing entry getter is content-free",
  await probeView(() => reconcilePlanView(getterEntryPlan as unknown as Parameters<typeof reconcilePlanView>[0])), CONTENT_FREE);
// A hostile CALLABLE `map` on a category that would still return a usable array must be
// REFUSED, never executed.
const hostileMapTarget: unknown[] = [];
(hostileMapTarget as { map?: unknown }).map = () => [{ key: "hostile" }];
const hostileMapViewPlan = {
  added: [], changed: [], removed: [], unchanged: [], overlap: hostileMapTarget,
  summary: { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 1 },
};
check("view hostile callable map is refused, not executed",
  await probeView(() => reconcilePlanView(hostileMapViewPlan as unknown as Parameters<typeof reconcilePlanView>[0])), CONTENT_FREE);
// A pseudonymizer that REJECTS with a registered secret in its message must not leak it.
check("view rejecting pseudonymizer is content-free",
  await probeView(() => reconcilePlanView(viewPlan, {
    pseudonymize: () => Promise.reject(new Error(`pseudonym leak ${VIEW_SECRET}`)),
  })), CONTENT_FREE);

finish("recipe-kit reconcile plan");
