// Recipe lifecycle participation (audit 2026-09-23, XXA round 6, P2-12): the hook-calling
// contract by which a recipe takes part in the framework's data-tree operations.
//
// A recipe participates by shipping app-owned hook files in its own recipe directory,
// declared the same way prepare.ts/verify.ts/onboard.ts are — the file's presence is the
// declaration, no recipe.json field:
//
//   quiesce.ts   export function quiesce(ctx, recipe) — bring this recipe's own writes to
//                a stop before the operation's data work (backup's tar now; restore's tree
//                swap is the next caller of this contract).
//   resume.ts    export function resume(ctx, recipe) — undo the quiesce once the
//                operation's data work is done and the framework's own service is back.
//
// The division of knowledge is the point: the framework owns WHEN the hooks run (for
// backup, exactly the window the gateway itself is paused for), the deadline each call
// gets, and what a failure means; the hook owns HOW this particular application stops and
// starts. A hook receives the same (ctx, recipe) prepare.ts gets — it drives its own
// compose project through ctx.runtime, the transport, whatever the app needs. Nothing
// here knows any recipe's business.
//
// Backups fail closed when a running recipe cannot quiesce. Quiesce hooks must pair with a
// resume hook so every attempted stop has an explicit compensation path.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { info, warn } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import type { Recipe } from "#src/service/recipe.ts";
import { importHookModule } from "./index.ts";

/** The two hook phases, named for their files. */
type RecipeLifecyclePhase = "quiesce" | "resume";

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/** The deadline is a backstop against a hook that never settles: the operation holds the
 *  instance lock and must not hang on one sidecar's stopped-forever loop. The environment
 *  override exists so a check can exercise the timeout path in seconds instead of half a
 *  minute (the hookImportTimeoutMs pattern in ./index.ts). */
function hookTimeoutMs(): number {
  const override = Number(process.env.CLAWFORGE_RECIPE_HOOK_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_HOOK_TIMEOUT_MS;
}

/** Bounds one awaited hook call. The losing promise keeps running — there is no way to
 *  cancel inside someone else's module — but this caller stops waiting on it, and the
 *  .then subscription below means its eventual rejection is handled even after the
 *  deadline has won, so a late failure cannot surface as an unhandled rejection. */
function withDeadline<T>(operation: Promise<T>, budgetMs: number, label: string): Promise<T> {
  return new Promise<T>((settle, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${budgetMs}ms`)), budgetMs);
    operation.then(
      (value) => { clearTimeout(timer); settle(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** The phase's hook path, when the recipe declares one — the same access() probe
 *  service/recipe.ts runs for preparePath/verifyPath/onboardPath. */
async function declaredHook(spec: Recipe, phase: RecipeLifecyclePhase): Promise<string | undefined> {
  const path = resolve(spec.directory, `${phase}.ts`);
  return (await access(path).then(() => true, () => false)) ? path : undefined;
}

/** Loads and runs one hook through the same checksum-versioned loader prepare/verify/onboard
 *  use, so a hook edited between two operations is re-read rather than served from the
 *  first load. */
async function runHook(ctx: Context, spec: Recipe, phase: RecipeLifecyclePhase, path: string): Promise<void> {
  const loaded = await importHookModule(path);
  const hook = loaded[phase] ?? loaded.default;
  if (typeof hook !== "function") {
    throw new Error(`recipe "${spec.name}" ${phase}.ts must export ${phase}(ctx, recipe)`);
  }
  // Promise.resolve().then normalizes a synchronous throw into a rejection the deadline
  // wrapper (or the caller's catch) sees like any other failure.
  await withDeadline(Promise.resolve().then(() => hook(ctx, spec)), hookTimeoutMs(), `recipe ${spec.name} ${phase} hook`);
}

/** Recipes that declared quiesce.ts and completed it, and the running ones this operation
 *  could not cover: no hook declared, or the hook failed or timed out. The caller names
 *  exactly the second set in its existing warning. */
export interface QuiesceOutcome {
  readonly quiesced: Recipe[];
  readonly unquiesced: Recipe[];
}

/** Quiesces every running stack that declares a paired hook. A failed or timed out hook is
 *  both uncovered and scheduled for resume because it may have partially stopped services. */
export async function quiesceRecipeStacks(ctx: Context, stacks: readonly Recipe[]): Promise<QuiesceOutcome> {
  const quiesced: Recipe[] = [];
  const unquiesced: Recipe[] = [];
  const hooks = await Promise.all(stacks.map(async (spec) => ({
    spec,
    quiesce: await declaredHook(spec, "quiesce"),
    resume: await declaredHook(spec, "resume"),
  })));
  for (const { spec, quiesce, resume } of hooks) {
    if (quiesce !== undefined && resume === undefined) {
      unquiesced.push(spec);
      warn(`recipe ${spec.name} declares quiesce.ts without resume.ts; backup cannot safely quiesce it`);
    } else if (quiesce === undefined) {
      unquiesced.push(spec);
    }
  }

  const unavailable = new Set(unquiesced);
  for (const spec of stacks) {
    if (unavailable.has(spec)) continue;
    const path = await declaredHook(spec, "quiesce");
    if (path === undefined) continue;
    try {
      await runHook(ctx, spec, "quiesce", path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`recipe ${spec.name} quiesce hook failed or timed out; resume compensation will run: ${message}`);
      unquiesced.push(spec);
      quiesced.push(spec);
      continue;
    }
    info(`${spec.name}: quiesced for the snapshot`);
    quiesced.push(spec);
  }
  return { quiesced, unquiesced };
}

/** Attempts every resume hook and returns failures so the caller can report an incomplete
 *  compensation without skipping the remaining recipes. */
export async function resumeRecipeStacks(ctx: Context, quiesced: readonly Recipe[]): Promise<Error[]> {
  const failures: Error[] = [];
  for (const spec of quiesced) {
    const path = await declaredHook(spec, "resume");
    if (path === undefined) {
      const message = `recipe ${spec.name} may remain quiesced: its resume.ts disappeared before compensation`;
      warn(message);
      failures.push(new Error(message));
      continue;
    }
    try {
      await runHook(ctx, spec, "resume", path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = new Error(`recipe ${spec.name} resume hook failed; its service may still be quiesced: ${message}`, { cause: error });
      warn(failure.message);
      failures.push(failure);
      continue;
    }
    info(`${spec.name}: resumed`);
  }
  return failures;
}
