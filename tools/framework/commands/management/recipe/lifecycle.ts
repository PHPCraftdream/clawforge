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
// Calls are best-effort in both directions: a missing, failing or hung hook never fails
// the operation that is snapshotting the instance — it only leaves the recipe among the
// uncovered stacks the caller warns about by name. The strict counterpart (refuse the
// whole backup when a recipe that should participate cannot be quiesced) is deliberately
// not built yet. A quiesce whose resume does not run — not declared, failed, or its
// quiesce never completed — is warned about: a hook that stopped its service must not
// leave it stopped silently.

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

/** Quiesces every running stack that declares quiesce.ts, in the order given. Best-effort
 *  by contract: a failing or hung hook is a warning-grade event here, never a refusal —
 *  an uncovered stack degrades the snapshot exactly as it did before this mechanism
 *  existed, and is returned for the caller to name. */
export async function quiesceRecipeStacks(ctx: Context, stacks: readonly Recipe[]): Promise<QuiesceOutcome> {
  const quiesced: Recipe[] = [];
  const unquiesced: Recipe[] = [];
  for (const spec of stacks) {
    const path = await declaredHook(spec, "quiesce");
    if (path === undefined) {
      unquiesced.push(spec);
      continue;
    }
    try {
      await runHook(ctx, spec, "quiesce", path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`recipe ${spec.name} quiesce hook failed, its data stays uncovered by this snapshot: ${message}`);
      unquiesced.push(spec);
      continue;
    }
    info(`${spec.name}: quiesced for the snapshot`);
    quiesced.push(spec);
  }
  return { quiesced, unquiesced };
}

/** Resumes exactly what quiesceRecipeStacks() quiesced — never the recipes whose quiesce
 *  failed: this framework has not observed their services stop, and a resume that
 *  restarts containers is not ours to call blind. Never throws: the operation's own
 *  outcome must not be overwritten by a compensation failure, and one recipe's failed
 *  resume must not skip the others'. A quiesce with no resume.ts is named — a hook that
 *  stopped its service would otherwise leave it stopped with nothing in the output
 *  explaining why. */
export async function resumeRecipeStacks(ctx: Context, quiesced: readonly Recipe[]): Promise<void> {
  for (const spec of quiesced) {
    const path = await declaredHook(spec, "resume");
    if (path === undefined) {
      warn(
        `recipe ${spec.name} stays quiesced: it declares no resume.ts — ` +
          `if its quiesce hook stopped the service, bring it back with: ./clawforge recipe install ${spec.name}`,
      );
      continue;
    }
    try {
      await runHook(ctx, spec, "resume", path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`recipe ${spec.name} resume hook failed, it may still be quiesced: ${message}`);
      continue;
    }
    info(`${spec.name}: resumed`);
  }
}
