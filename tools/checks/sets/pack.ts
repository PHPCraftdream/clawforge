// Shared test-only artifact assembler: packs a manifest plus the files it inventories into
// an artifact with the same layout the packer writes, for checks where `set build` refuses
// to pack the tree (production code exports no unchecked packer). No top-level executable
// code — check files import this without side effects.

import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { DESIRED_STATE_PATH } from "#framework/set/artifacts/model.ts";
import type { SetManifest } from "#framework/set/artifacts/model.ts";

/** Test-only assembler: packs `manifest` plus the files it inventories (read from `tree`)
 *  into an artifact with the same layout the packer writes. Used where build refuses to
 *  pack, so the artifact side of a variant can still be asked the same question. The caller
 *  owns `out` (a path inside the deployment keeps its lifetime simple). */
export async function packArtifact(tree: string, manifest: SetManifest, out: string): Promise<void> {
  const contents = await mkdtemp(join(tmpdir(), "clawforge-set-parity-contents-"));
  try {
    await writeFile(resolve(contents, "set.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    for (const rel of Object.keys(manifest.files)) {
      const source = rel === DESIRED_STATE_PATH ? resolve(tree, "config", "desired-state.json") : resolve(tree, ...rel.split("/"));
      const target = resolve(contents, ...rel.split("/"));
      await mkdir(resolve(target, ".."), { recursive: true });
      // A tree with no declaration at all packs as an empty one — an artifact cannot carry
      // a missing file, and the validator words both the same.
      if (rel === DESIRED_STATE_PATH && !(await access(source).then(() => true, () => false))) await writeFile(target, "");
      else await copyFile(source, target);
    }
    const forceLocal = process.platform === "win32" ? ["--force-local"] : [];
    let result = await spawnLocal("tar", [...forceLocal, "-czf", out, "-C", contents, "."], { allowFailure: true });
    if (result.code !== 0) result = await spawnLocal("tar", ["-czf", out, "-C", contents, "."]);
    if (result.code !== 0) throw new Error(`test assembler could not pack: ${(result.stderr || result.stdout).trim()}`);
  } finally {
    await rm(contents, { recursive: true, force: true });
  }
}
