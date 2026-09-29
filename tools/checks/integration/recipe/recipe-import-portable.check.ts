// `recipe import`'s U4 fixes: every excluded name (`.env*` templates included) is reported,
// never dropped silently; import copies through the shared portable-content walk
// (collectPortableRecipeFiles) instead of a bare `cp`, so symlink resolution and containment
// match set build and the provision-agent mirror; anything excluded is named in a capped
// summary; and a recipe carrying a hook earns an operator-rights warning before it can run on
// this machine. Split from agent/recipe.check.ts (same source layout limit) rather than grown
// there — see CONTRIBUTING.md, "Source layout".

import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

/** Runs `fn`, returns the thrown message. Records a failure (and returns "") if it did not throw. */
async function messageOf<T>(name: string, fn: () => Promise<T>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  check(name, "did not throw", "threw");
  return "";
}

// `runImportAction` never reaches transport or runtime — import only touches the repository's
// recipes/ directory — so an empty stub is enough here, unlike the fuller one install/remove
// need in agent/recipe.check.ts.
const ctx = { settings: { env: {} } } as unknown as Context;

const scratch = resolve(tmpdir(), `clawforge-recipe-import-portable-check-${Date.now()}`);

try {
  useDeployment(resolve(scratch, "example-deployment"));

  // --- .env.example ships, .env and secrets/ are skipped and named, hooks are warned about ---
  {
    const hookRoot = resolve(scratch, "hooks");
    const source = resolve(hookRoot, "source-recipe");
    await mkdir(resolve(source, "secrets"), { recursive: true });
    await writeFile(resolve(source, "recipe.json"), JSON.stringify({ description: "Hooked" }), "utf8");
    await writeFile(resolve(source, ".env"), "SECRET=must-not-copy\n", "utf8");
    await writeFile(resolve(source, ".env.example"), "TOKEN=set-me\n", "utf8");
    await writeFile(resolve(source, "secrets", "local.env"), "SECRET=must-not-copy\n", "utf8");
    await writeFile(resolve(source, "prepare.ts"), "export async function prepare() {}\n", "utf8");
    await writeFile(resolve(source, "verify.ts"), "export async function verify() { return { ok: true }; }\n", "utf8");
    useRecipesDir(resolve(hookRoot, "recipes"));
    await mkdir(resolve(hookRoot, "recipes"), { recursive: true });
    let out = "";
    await withOutputSink((chunk) => { out += chunk; }, () => recipe(ctx, ["import", source, "hooked"]));
    check(
      "the .env.example template stays excluded (a filled template must not travel)",
      await access(resolve(hookRoot, "recipes", "hooked", ".env.example")).then(() => true, () => false),
      false,
    );
    check("the skipped summary names .env.example", out.includes(".env.example (sensitive-name policy)"), true);
    check("import still excludes .env", await access(resolve(hookRoot, "recipes", "hooked", ".env")).then(() => true, () => false), false);
    check("import still excludes secrets/", await access(resolve(hookRoot, "recipes", "hooked", "secrets")).then(() => true, () => false), false);
    check("the skipped summary names .env", out.includes(".env (sensitive-name policy)"), true);
    // secrets/ itself matches the sensitive-name shape, so the walk excludes the whole
    // directory without recursing into it — local.env inside is never reached, let alone
    // separately named.
    check("the skipped summary names the whole secrets/ directory", out.includes("secrets (sensitive-name policy)"), true);
    check("the skipped summary states the count", out.includes("skipped: 3 file(s)"), true);
    check(
      "a hooks warning names prepare.ts and verify.ts",
      out.includes("prepare.ts, verify.ts") && out.includes("operator's rights"),
      true,
    );
  }

  // --- a hookless recipe with nothing excluded prints neither line ---------------------------
  {
    const plainRoot = resolve(scratch, "plain-source");
    const source = resolve(plainRoot, "source-recipe");
    await mkdir(source, { recursive: true });
    await writeFile(resolve(source, "recipe.json"), JSON.stringify({ description: "Plain" }), "utf8");
    await writeFile(resolve(source, "compose.yml"), "services: {}\n", "utf8");
    useRecipesDir(resolve(plainRoot, "recipes"));
    await mkdir(resolve(plainRoot, "recipes"), { recursive: true });
    let out = "";
    await withOutputSink((chunk) => { out += chunk; }, () => recipe(ctx, ["import", source, "plain"]));
    check("no hooks means no warning", out.includes("operator's rights"), false);
    check("nothing excluded means no skipped summary", out.includes("skipped:"), false);
  }

  // --- a symlink inside the source is followed like set build and the mirror follow it, under
  // its own name, byte-identical; one resolving outside the source is refused the same way.
  // Windows without developer mode (or privileges) cannot create a symlink; that case is
  // skipped honestly rather than pretended. ---------------------------------------------------
  {
    const linkRoot = resolve(scratch, "symlink");
    const source = resolve(linkRoot, "source-recipe");
    await mkdir(source, { recursive: true });
    await writeFile(resolve(source, "recipe.json"), JSON.stringify({ description: "Linked" }), "utf8");
    await writeFile(resolve(source, "page.md"), "# page\n", "utf8");
    let linked = true;
    try {
      await symlink(resolve(source, "page.md"), resolve(source, "linked-page.md"));
    } catch {
      linked = false;
    }
    if (!linked) {
      process.stderr.write("  skip import follows an inside-pointing symlink (symlinks unavailable on this machine)\n");
      process.stderr.write("  skip import refuses a symlink escaping the source (symlinks unavailable on this machine)\n");
    } else {
      useRecipesDir(resolve(linkRoot, "recipes"));
      await mkdir(resolve(linkRoot, "recipes"), { recursive: true });
      await withOutputSink(() => {}, () => recipe(ctx, ["import", source, "linked"]));
      check(
        "import follows an inside-pointing symlink, byte-identical",
        await access(resolve(linkRoot, "recipes", "linked", "linked-page.md")).then(() => true, () => false),
        true,
      );

      await mkdir(resolve(linkRoot, "outside"), { recursive: true });
      await writeFile(resolve(linkRoot, "outside", "secret.env"), "SECRET\n", "utf8");
      const escapeSource = resolve(linkRoot, "escaping-source");
      await mkdir(escapeSource, { recursive: true });
      await writeFile(resolve(escapeSource, "recipe.json"), JSON.stringify({ description: "Escaping" }), "utf8");
      await symlink(resolve(linkRoot, "outside", "secret.env"), resolve(escapeSource, "escape-link"));
      const escapeMessage = await messageOf("import refuses a symlink escaping the source", () =>
        withOutputSink(() => {}, () => recipe(ctx, ["import", escapeSource, "escaped"])),
      );
      check("the refusal names the escape", escapeMessage.includes("outside the recipe directory"), true);
      check(
        "nothing was copied for the escaping source",
        await access(resolve(linkRoot, "recipes", "escaped")).then(() => true, () => false),
        false,
      );
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

finish("recipe import portable-content");
