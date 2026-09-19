// The fixture recipe's own prepare hook: writes its private files through the framework's
// real helpers, exactly the way a deployed recipe does. The credential value is an
// obviously-fake marker — this file exists so the snapshot checks drive the real write
// path, not because the value means anything.
import { ensurePrivateTargetDirectory, replacePrivateTargetFile } from "#framework/security/private-config.ts";
import type { Context } from "#framework/core/context.ts";
import type { Recipe } from "#framework/service/recipe.ts";

export async function prepare(ctx: Context, recipe: Recipe): Promise<void> {
  const dataDir = ctx.settings.dataDir;
  await ensurePrivateTargetDirectory(ctx, `${dataDir}/sidecar-private/state`);
  await replacePrivateTargetFile(ctx, `${dataDir}/sidecar-private/credentials.env`, `FIXTURE_CREDENTIAL=review-p1-01-marker recipe=${recipe.name}\n`);
}
