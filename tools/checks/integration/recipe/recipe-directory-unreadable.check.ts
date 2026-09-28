// `./clawforge recipe` (list) is service/recipe.ts's listRecipes/listBrokenRecipes/
// listAgentBundleRecipes, all three built on listRecipeDirectories(). A recipes root that
// exists but is not a directory (a file, ENOTDIR) used to be caught by each function's own
// `catch { return []; }` and read as "no recipes yet" — indistinguishable from a genuinely
// empty deployment. It must fail loudly instead, naming the path.

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listRecipes, listBrokenRecipes, listAgentBundleRecipes, useRecipesDir, clearRecipesDir } from "#framework/service/recipe.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function messageOf<T>(name: string, fn: () => Promise<T>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  check(name, "did not throw", "threw");
  return "";
}

const root = await mkdtemp(join(tmpdir(), "clawforge-recipe-list-check-"));
const notADirectory = resolve(root, "recipes");
await writeFile(notADirectory, "not a directory");
useRecipesDir(notADirectory);
try {
  const listMessage = await messageOf("listRecipes dies on an unreadable root, not an empty catalog", () => listRecipes());
  check("naming the path", listMessage.includes(notADirectory), true);

  const brokenMessage = await messageOf("listBrokenRecipes dies the same way", () => listBrokenRecipes());
  check("naming the path", brokenMessage.includes(notADirectory), true);

  const bundleMessage = await messageOf("listAgentBundleRecipes dies the same way", () => listAgentBundleRecipes());
  check("naming the path", bundleMessage.includes(notADirectory), true);
} finally {
  clearRecipesDir();
  await rm(root, { recursive: true, force: true });
}

finish("recipe-directory-unreadable");
