// Shared fixture for the reconcile checks: the structured-checks recording context (private
// state lives in an OS temp dir via a declared privatePaths recipe) plus a fake
// ReconcileAccessor with a recording patch log.
import { check } from "#checks/kit/harness.ts";
import { fixture, recording } from "#checks/security/structured/fixture.ts";
import { RecipeKitRefusal } from "#framework/recipe-kit/index.ts";
import type { ReconcileAccessor, ReconcileJournal, ReconcileValue } from "#framework/recipe-kit/index.ts";
import type { Context } from "#framework/core/context.ts";

export interface FakeAccessor extends ReconcileAccessor {
  readonly patches: Array<Record<string, ReconcileValue>>;
  projection: Record<string, ReconcileValue> | undefined;
  /** When set, patch throws this message (transport failure). */
  failPatch: string | undefined;
  /** When true, patch resolves without changing the projection (verify mismatch). */
  skipWrite: boolean;
  /** When set, reads AFTER a patch throw (simulates a crash between the patch and
   *  provenance publication — the verify re-read dies and nothing after it runs). */
  failRead: string | undefined;
}

export function fakeAccessor(initial?: Record<string, ReconcileValue>): FakeAccessor {
  return {
    patches: [],
    projection: initial === undefined ? undefined : { ...initial },
    failPatch: undefined,
    skipWrite: false,
    failRead: undefined,
    async read() {
      if (this.failRead !== undefined && this.patches.length > 0) throw new Error(this.failRead);
      return this.projection === undefined ? undefined : { ...this.projection };
    },
    async patch(projection) {
      this.patches.push({ ...projection });
      if (this.failPatch !== undefined) throw new Error(this.failPatch);
      if (!this.skipWrite) this.projection = { ...projection };
    },
  };
}

/** `identifying` omitted (undefined) means the field is absent from the journal object —
 *  apply's default semantics (pseudonymize) then apply, identical to an explicit true. */
export function journalFor(ctx: Context, suffix: string, identifying?: boolean): ReconcileJournal {
  return {
    ctx,
    journalPath: `/fixture/data/vault/journal-${suffix}.jsonl`,
    statePath: `/fixture/data/vault/prov-${suffix}.json`,
    pseudonymDir: "/fixture/data/vault",
    recipe: "fixture",
    namespace: "reconcile",
    ...(identifying === undefined ? {} : { identifying }),
  };
}

export async function refusal(name: string, body: () => Promise<unknown>, reason: string): Promise<RecipeKitRefusal> {
  let actual: unknown;
  try { await body(); } catch (error) { actual = error; }
  const isRefusal = actual instanceof RecipeKitRefusal;
  check(`refusal ${name}`, isRefusal ? (actual as RecipeKitRefusal).reason : String(actual), reason);
  return actual as RecipeKitRefusal;
}


export async function withReconcile<T>(body: (r: Awaited<ReturnType<typeof recording>>) => Promise<T>): Promise<T> {
  const f = await fixture();
  const r = recording();
  try { return await body(r); } finally { await f.dispose(); }
}

export function journalRecords(r: Awaited<ReturnType<typeof recording>>, journalPath: string): Array<{ [key: string]: unknown }> {
  const text = r.files.get(journalPath);
  if (text === undefined) return [];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { [key: string]: unknown });
}
