// A recipe reached through a symlinked path (macOS /var → /private/var, a linked apps/ dir) is
// still one recipe: Node reports the hook's own file realpath'd, and a `#specifier` import must
// resolve against the recipe directory in that same spelling instead of "escaping" it.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePackageImport } from "#framework/commands/management/recipe/hook-graph.ts";
import { check, finish } from "#checks/kit/harness.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "clawforge-hook-link-")));
try {
  const real = join(root, "real");
  const linked = join(root, "linked");
  await mkdir(real);
  await writeFile(join(real, "package.json"), JSON.stringify({ imports: { "#helper": "./helper.ts" } }));
  await writeFile(join(real, "helper.ts"), "export const value = 1;\n");
  await writeFile(join(real, "verify.ts"), "export {};\n");
  await symlink(real, linked, "junction");

  const viaLink = await resolvePackageImport("#helper", join(real, "verify.ts"), linked)
    .then((resolved) => resolved.targetPath, (error: unknown) => (error as Error).message);
  check("a hook file reported by its real path resolves #helper inside the linked recipe directory", viaLink, join(real, "helper.ts"));
} finally {
  await rm(root, { recursive: true, force: true });
}

finish("recipe-hook-symlinked-root");
