// The recipe portable-content policy: what may LEAVE the recipe's own directory, in one
// module, for every carrier of recipe bytes (audit 2026-09-22 XA round 2, P1-03).
//
// Four commands move recipe content around, and until now only `recipe import` consulted
// the privateFiles declaration — the other three each had their own answer, which is how a
// declared private file can walk into a set manifest, an agent workspace mirror or a
// deployed tree without anybody having decided that it should. Each consumer gets its own
// verb from this one policy:
//
//   - `recipe import` EXCLUDES — it is the copy that establishes the repository's recipe,
//     so this is where content is kept out in the first place;
//   - set build EXCLUDES — the manifest's checksums define what an artifact carries, so a
//     file left out here is a file that never ships (service/checksums.ts reads this
//     walker for exactly that reason);
//   - the provision-agent workspace mirror EXCLUDES and WARNS — it copies onto a live
//     target, so holding a file back must be visible at the time, not discoverable later;
//   - deploy REFUSES while ANY file the policy holds private currently exists — declared
//     or sensitive-named — in the recipes tree and in the synced config/ directory: it
//     lands bytes on another host, where nothing can review them afterwards (see
//     deploy.ts for why it refuses rather than excluding).
//
// Two exclusion rules, one boundary matcher. The sensitive-NAME regex is a generic
// heuristic over the framework's own credential conventions; privateFiles is the
// application naming its own files the way only it can. Entries match LITERALLY —
// `vault[1]` is a file name, never a glob (P1-02 was two readers disagreeing about globs,
// and the same mistake must not be rebuilt here). A declaration is read strictly
// (declaredPrivateFiles): a manifest that exists but cannot be read, parsed or validated
// stops the carrier instead of reading as "nothing declared" — the quiet-empty failure
// that once walked a private file into a share archive (audit 2026-09-21, P1-01). An
// ABSENT manifest is honest, not a failure: agent/MCP bundles and plain directories carry
// no recipe.json and no declaration, and the generic name policy still applies to them.
//
// Symlink containment: a link inside the recipe tree is resolved before anything is read
// through it, and one that resolves OUTSIDE the recipe directory is refused — never
// silently followed. Excluding a path by name means nothing if the name is a door to
// elsewhere; the audit's recommendation verbatim is to refuse or verify the resolved
// target stays inside the source root before reading through.
//
// Staying inside is necessary but not sufficient, and that gap was the round-3 P1-01: an
// INTERNAL link whose own name is public and whose target is a declared private file or
// directory read through the alias as if the target had never been declared — by checksums,
// by the set manifest, by the workspace mirror. So the policy is applied twice over: to the
// logical path (the name the walk sees) and to the resolved path (where the bytes actually
// live), and privacy of either one holds the content back. Directory links are walked in
// their CANONICAL context — declarations are matched against the real recipe-relative path,
// never against the alias name a private target happens to be reachable by — and a link that
// resolves to a directory the walk is already inside is refused instead of recursed into.

import { access, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { warn } from "../core/log.ts";
import { declaredPrivateFiles } from "../service/recipe.ts";

/** Name-shape heuristic over the framework's own credential conventions — byte-identical
 *  to the regex `recipe import` has always applied, because import's observable behavior
 *  must not move while its implementation becomes shared. */
export const SENSITIVE_RECIPE_NAME = /(^|[\\/])(?:\.env(?:\..*)?|secrets(?:[\\/]|$)|.*\.token$|.*\.secrets\.env$)/i;

/** The declared privateFiles of one recipe directory, and an honest empty list when there
 *  is no manifest at all. Everything else stays exactly as strict as declaredPrivateFiles:
 *  an unreadable, unparseable or invalid manifest throws — a broken declaration read as
 *  "nothing declared" is precisely the failure this policy exists to prevent. */
export async function declaredPortablePrivateFiles(recipeDirectory: string): Promise<string[]> {
  try {
    await access(resolve(recipeDirectory, "recipe.json"));
  } catch (error) {
    // No manifest, no declaration: agent/MCP bundles and plain directories carry no
    // recipe.json, so "nothing declared" is the true answer, not a swallowed error.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return declaredPrivateFiles(recipeDirectory);
}

/** The ONE path-boundary matcher over a privateFiles declaration. Literal matching only —
 *  an entry matches itself and everything under it, and never behaves like a glob. */
export function excludesPortablePath(relativePath: string, declared: readonly string[]): boolean {
  return declared.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
}

/** Walks a recipe tree for carrying elsewhere, applying the portable-content policy to
 *  every entry: declared privateFiles and sensitive names are held back and REPORTED (one
 *  warning line, names and reasons only — loud exclusion, never silent), and symlinks are
 *  resolved and contained before anything is read through them.
 *
 *  Paths in `files` are POSIX-style and relative to `walkRoot` (which defaults to the
 *  recipe directory itself) — the exact shape the provision-agent mirror and the
 *  checksum maps have always exchanged. The POLICY, though, is applied to recipe-relative
 *  paths: declarations are written relative to the recipe, so a walk rooted at
 *  `<recipe>/agent` still matches a declaration like `agent/foo`. `excludeTop` skips one
 *  top-level directory of the walk root (the mirror's `agent` carve-out).
 *
 *  A symlink resolving outside the recipe directory throws — a link is followed only once
 *  its target is proven to stay inside the recipe's own tree; a directory that points
 *  inside is walked, anything else verified-inside is carried as a file. INSIDE is not the
 *  whole rule, though: privacy is decided on the resolved path as well as the logical one,
 *  so a link whose own name is public but whose target is a declared private file, a
 *  private directory or a sensitive-named target is held back exactly as the target itself
 *  would be — reported against the logical path with a "(symlink target)" reason, because
 *  that is the name the reader asked about. For the same reason a directory link is walked
 *  in its canonical context: entries reached through it are policy-checked against their
 *  REAL recipe-relative path, so a declaration cannot be dodged by reaching the same
 *  directory under an alias. A directory already on the walk path — a link resolving to its
 *  own ancestor, e.g. `loop -> .` — is refused rather than followed forever. Non-symlink
 *  entries keep the walker's usual permissiveness: regular files and unusual types alike
 *  are collected, exactly as before. */
export async function collectPortableRecipeFiles(
  recipeDirectory: string,
  options: { walkRoot?: string; excludeTop?: string } = {},
): Promise<{ files: string[]; excluded: { path: string; reason: string }[] }> {
  const walkRoot = options.walkRoot ?? recipeDirectory;
  const excludeTop = options.excludeTop;
  const declared = await declaredPortablePrivateFiles(recipeDirectory);
  const realRoot = await realpath(recipeDirectory);

  const files: string[] = [];
  const excluded: { path: string; reason: string }[] = [];

  async function walk(current: string, base: string, realCurrent: string, activeDirs: Set<string>): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (base === "" && excludeTop !== undefined && entry.name === excludeTop) continue;
      const full = resolve(current, entry.name);
      const relativePath = base === "" ? entry.name : `${base}/${entry.name}`;
      const recipeRelative = relative(recipeDirectory, full).replaceAll("\\", "/");
      if (excludesPortablePath(recipeRelative, declared)) {
        excluded.push({ path: recipeRelative, reason: "declared privateFiles" });
        continue;
      }
      if (SENSITIVE_RECIPE_NAME.test(recipeRelative)) {
        excluded.push({ path: recipeRelative, reason: "sensitive-name policy" });
        continue;
      }
      // Where the bytes of this entry actually live: a link resolves fully, anything else is
      // its parent's real path plus its own name. Resolution only changes the answer when it
      // MOVES the path — the entry is a link, or is reached through one — and then the two
      // checks above must hold for the real path too. A public name pointing at a private
      // target is still the private target, and a declaration written against the real path
      // must not be dodgeable by reaching the same directory under an alias (round 3, P1-01).
      const real = entry.isSymbolicLink() ? await realpath(full) : resolve(realCurrent, entry.name);
      const realRecipeRelative = relative(realRoot, real).replaceAll("\\", "/");
      if (realRecipeRelative !== recipeRelative) {
        if (excludesPortablePath(realRecipeRelative, declared)) {
          excluded.push({ path: recipeRelative, reason: "declared privateFiles (symlink target)" });
          continue;
        }
        if (SENSITIVE_RECIPE_NAME.test(realRecipeRelative)) {
          excluded.push({ path: recipeRelative, reason: "sensitive-name policy (symlink target)" });
          continue;
        }
      }
      if (entry.isSymbolicLink()) {
        // A link is read through only once its target is proven to stay inside the recipe:
        // excluding a path by name means nothing if the name leads somewhere else.
        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
          throw new Error(
            `${recipeRelative} is a symlink resolving outside the recipe directory — refusing to follow it to ${real}`,
          );
        }
        const stats = await stat(real);
        if (stats.isDirectory()) await walkInto(full, relativePath, real, recipeRelative, realRecipeRelative, activeDirs);
        else files.push(relativePath);
        continue;
      }
      if (entry.isDirectory()) await walkInto(full, relativePath, real, recipeRelative, realRecipeRelative, activeDirs);
      else files.push(relativePath);
    }
  }

  // Stack-scoped on purpose, never a memo of every directory seen: the same directory may be
  // reached through two unrelated aliases and both walks are legitimate. What must never
  // happen is following a link into a directory the walk is ALREADY inside — that recursion
  // has no bottom, so the entry whose resolution is on the current path is refused by name.
  async function walkInto(
    full: string,
    relativePath: string,
    real: string,
    recipeRelative: string,
    realRecipeRelative: string,
    activeDirs: Set<string>,
  ): Promise<void> {
    if (activeDirs.has(real)) {
      throw new Error(
        `${recipeRelative} resolves to ${realRecipeRelative || "."}, which the walk is already inside — following it would loop`,
      );
    }
    activeDirs.add(real);
    try {
      await walk(full, relativePath, real, activeDirs);
    } finally {
      activeDirs.delete(real);
    }
  }

  const realWalkRoot = await realpath(walkRoot);
  await walk(walkRoot, "", realWalkRoot, new Set([realRoot, realWalkRoot]));

  if (excluded.length > 0) {
    warn(
      `recipe portable-content policy held back: ${excluded.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}`,
    );
  }
  return { files, excluded };
}
