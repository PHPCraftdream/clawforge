import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, finish } from "#checks/kit/harness.ts";
import { stubContext } from "#checks/runtime/convergence/instance-lock/fixture.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { useDeployment, clearDeployment } from "#framework/runtime/deployment.ts";
import { readName } from "#framework/core/values/names.ts";
import { takeLock } from "#framework/runtime/lock/instance-lock.ts";
import { runRecipePin } from "#framework/commands/management/recipe/run/pin/invocation.ts";

const root = await mkdtemp(join(tmpdir(), "recipe-pin-lock-check-"));
const originalFetch = globalThis.fetch;
let fetchCount = 0;
try {
  const recipes = join(root, "recipes");
  const recipe = join(recipes, "locked");
  await mkdir(recipe, { recursive: true });
  const dockerfile = join(recipe, "Dockerfile");
  const source = `FROM alpine\nARG VERSION=1\nARG SHA256=${"0".repeat(64)}\nADD --checksum=sha256:$SHA256 https://github.com/acme/releases/download/v1/tool-${"${VERSION}"}.tgz /tool\n`;
  await writeFile(join(recipe, "recipe.json"), JSON.stringify({ description: "fixture" }));
  await writeFile(dockerfile, source);
  const before = await readFile(dockerfile);
  useDeployment(root);
  globalThis.fetch = async () => {
    fetchCount++;
    return new Response(`${"a".repeat(64)} tool-2.tgz\n`, { status: 200 });
  };
  const { ctx } = stubContext();
  const held = await takeLock(ctx, "unrelated", "op-holder");
  let refusal = "";
  try {
    await withOutputSink(() => {}, () => runRecipePin(ctx, {
      name: readName("recipe", "locked"), version: "2", apply: true, takeover: { breakLock: false },
    }));
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  } finally {
    await held.release();
  }
  check("applying pin refuses while another operation holds lock", refusal.includes("op-holder"), true);
  check("held-lock refusal precedes checksum fetch", fetchCount, 0);
  check("held-lock refusal leaves Dockerfile bytes unchanged", (await readFile(dockerfile)).equals(before), true);
} finally {
  globalThis.fetch = originalFetch;
  clearDeployment();
  await rm(root, { recursive: true, force: true });
}
finish("recipe pin held lock");
