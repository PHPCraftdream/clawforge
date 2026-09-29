// The recipe portable-content policy: what may LEAVE the recipe's own directory, in one
// module, for every carrier of recipe bytes.
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
// `vault[1]` is a file name, never a glob (two readers once disagreed about globs,
// and the same mistake must not be rebuilt here). A declaration is read strictly
// (declaredPrivateFiles): a manifest that exists but cannot be read, parsed or validated
// stops the carrier instead of reading as "nothing declared" — the quiet-empty failure
// that once walked a private file into a share archive. An
// ABSENT manifest is honest, not a failure: agent/MCP bundles and plain directories carry
// no recipe.json and no declaration, and the generic name policy still applies to them.
//
// Symlink containment: a link inside the recipe tree is resolved before anything is read
// through it, and one that resolves OUTSIDE the recipe directory is refused — never
// silently followed. Excluding a path by name means nothing if the name is a door to
// elsewhere.
//
// The walk ROOT is contained too: an `agent/` that is itself a link to a directory outside
// the recipe would otherwise let that directory's files walk in as ordinary children. The
// root is resolved and containment-vetted before the first readdir, every resolved path is
// contained whatever the Dirent claims, and a root that exists but does not resolve fails
// loudly instead of reading as an absent bundle.
//
// Staying inside is necessary but not sufficient: an
// INTERNAL link whose own name is public and whose target is a declared private file or
// directory read through the alias as if the target had never been declared — by checksums,
// by the set manifest, by the workspace mirror. So the policy is applied twice over: to the
// logical path (the name the walk sees) and to the resolved path (where the bytes actually
// live), and privacy of either one holds the content back. Directory links are walked in
// their CANONICAL context — declarations are matched against the real recipe-relative path,
// never against the alias name a private target happens to be reachable by — and a link that
// resolves to a directory the walk is already inside is refused instead of recursed into.

import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { warn } from "../../core/io/log.ts";
import { declaredPrivateFiles } from "../../service/recipe.ts";

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
 *  inside is walked, anything else verified-inside is carried as a file. The WALK ROOT is
 *  held to the same rule before anything is listed: it is resolved and contained
 *  first, because when the root itself is the escape — an `agent/` that is really a link
 *  to elsewhere — no child Dirent can ever report it; and containment is decided on the
 *  resolved path of every entry, whatever type the Dirent reports. INSIDE is not the
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
  const realRoot = await realpath(recipeDirectory);
  const realWalkRoot = await resolveContainedWalkRoot(walkRoot, realRoot);

  const state: PortableWalkState = {
    recipeDirectory,
    realRoot,
    declared: await declaredPortablePrivateFiles(recipeDirectory),
    excludeTop: options.excludeTop,
    files: [],
    excluded: [],
  };
  await walkPortableDirectory(state, walkRoot, "", realWalkRoot, new Set([realRoot, realWalkRoot]));

  reportExcluded(state.excluded);
  return { files: state.files, excluded: state.excluded };
}

/** The root itself is vetted before the first readdir: a walk root that resolves outside
 *  the recipe would have every file under it arrive as an ordinary child — no Dirent can
 *  report an escape that IS the root. Fails the whole walk, identically for every carrier. */
async function resolveContainedWalkRoot(walkRoot: string, realRoot: string): Promise<string> {
  let realWalkRoot: string;
  try {
    realWalkRoot = await realpath(walkRoot);
  } catch (error) {
    // A root that is genuinely not there rethrows for the caller to interpret (the agent
    // bundle reads a plain missing agent/ as an honest undefined); a root that EXISTS but
    // does not resolve — a dangling link — is untrusted, not absent, and must fail
    // the walk instead of reading as "no files".
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT"
      && (await lstat(walkRoot).catch(() => undefined))?.isSymbolicLink()
    ) {
      throw new Error(`walk root ${walkRoot} is a symlink that does not resolve — refusing to walk it`);
    }
    throw error;
  }
  if (realWalkRoot !== realRoot && !realWalkRoot.startsWith(realRoot + sep)) {
    throw new Error(
      `walk root ${walkRoot} resolves outside the recipe directory — refusing to walk it to ${realWalkRoot}`,
    );
  }
  return realWalkRoot;
}

function reportExcluded(excluded: readonly { path: string; reason: string }[]): void {
  if (excluded.length === 0) return;
  warn(
    `recipe portable-content policy held back: ${excluded.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}`,
  );
}

/** State threaded through one collectPortableRecipeFiles walk — a plain object rather than
 *  closures over local variables, so each step of the walk is its own checkable function. */
interface PortableWalkState {
  readonly recipeDirectory: string;
  readonly realRoot: string;
  readonly declared: readonly string[];
  readonly excludeTop: string | undefined;
  readonly files: string[];
  readonly excluded: { path: string; reason: string }[];
}

async function walkPortableDirectory(
  state: PortableWalkState,
  current: string,
  base: string,
  realCurrent: string,
  activeDirs: Set<string>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (base === "" && state.excludeTop !== undefined && entry.name === state.excludeTop) continue;
    await visitPortableEntry(state, entry, current, base, realCurrent, activeDirs);
  }
}

/** Declared privateFiles or the sensitive-name heuristic, matched against one path — used
 *  both for the entry's own (logical) path and, separately, for a symlink's real target. */
function excludedByPolicy(state: PortableWalkState, path: string, reasonSuffix: string): string | undefined {
  if (excludesPortablePath(path, state.declared)) return `declared privateFiles${reasonSuffix}`;
  if (SENSITIVE_RECIPE_NAME.test(path)) return `sensitive-name policy${reasonSuffix}`;
  return undefined;
}

async function visitPortableEntry(
  state: PortableWalkState,
  entry: Dirent,
  current: string,
  base: string,
  realCurrent: string,
  activeDirs: Set<string>,
): Promise<void> {
  const full = resolve(current, entry.name);
  const relativePath = base === "" ? entry.name : `${base}/${entry.name}`;
  const recipeRelative = relative(state.recipeDirectory, full).replaceAll("\\", "/");

  const nameReason = excludedByPolicy(state, recipeRelative, "");
  if (nameReason !== undefined) {
    state.excluded.push({ path: recipeRelative, reason: nameReason });
    return;
  }

  // Where the bytes of this entry actually live: a link resolves fully, anything else is
  // its parent's real path plus its own name. Resolution only changes the answer when it
  // MOVES the path — the entry is a link, or is reached through one — and then the two
  // checks above must hold for the real path too. A public name pointing at a private
  // target is still the private target, and a declaration written against the real path
  // must not be dodgeable by reaching the same directory under an alias.
  const real = await resolvePortableEntryTarget(entry, full, realCurrent, recipeRelative);
  const realRecipeRelative = relative(state.realRoot, real).replaceAll("\\", "/");
  if (realRecipeRelative !== recipeRelative) {
    const targetReason = excludedByPolicy(state, realRecipeRelative, " (symlink target)");
    if (targetReason !== undefined) {
      state.excluded.push({ path: recipeRelative, reason: targetReason });
      return;
    }
  }

  // Containment is decided on the RESOLVED path of every entry, whatever the Dirent
  // reports: the type bit is the walk's own bookkeeping, not evidence of where
  // the bytes live. Inside a contained walk a plain entry is contained by
  // construction, so this only fires once the walk itself has already escaped — the
  // same refusal a symlink earns, without first asking the Dirent's opinion.
  if (real !== state.realRoot && !real.startsWith(state.realRoot + sep)) {
    throw new Error(
      `${recipeRelative} resolves outside the recipe directory — refusing to follow it to ${real}`,
    );
  }

  if (entry.isSymbolicLink()) {
    const stats = await stat(real);
    if (stats.isDirectory()) await walkPortableSubdirectory(state, full, relativePath, real, recipeRelative, realRecipeRelative, activeDirs);
    else state.files.push(relativePath);
    return;
  }
  if (entry.isDirectory()) await walkPortableSubdirectory(state, full, relativePath, real, recipeRelative, realRecipeRelative, activeDirs);
  else state.files.push(relativePath);
}

async function resolvePortableEntryTarget(
  entry: Dirent,
  full: string,
  realCurrent: string,
  recipeRelative: string,
): Promise<string> {
  if (!entry.isSymbolicLink()) return resolve(realCurrent, entry.name);
  return realpath(full).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      // A child link that resolves nowhere is a broken bundle, not an absent one:
      // fail the walk under the link's own name rather than a bare ENOENT a caller
      // could misread as "nothing here".
      throw new Error(`${recipeRelative} is a symlink that does not resolve`);
    }
    throw error;
  });
}

// Stack-scoped on purpose, never a memo of every directory seen: the same directory may be
// reached through two unrelated aliases and both walks are legitimate. What must never
// happen is following a link into a directory the walk is ALREADY inside — that recursion
// has no bottom, so the entry whose resolution is on the current path is refused by name.
async function walkPortableSubdirectory(
  state: PortableWalkState,
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
    await walkPortableDirectory(state, full, relativePath, real, activeDirs);
  } finally {
    activeDirs.delete(real);
  }
}

/** The one walk of a recipe's `agent/` bundle, shared by every reader that needs it:
 *  agentBundleChecksums (service/checksums.ts) and loadRecipeAgentBundle
 *  (commands/management/provision-agent/declaration.ts) both call this rather than walking
 *  separately, so a declared-private prompt file can't stay out of the checksum map while
 *  direct provisioning copies it anyway. Same walkRoot trick as collectPortableRecipeFiles
 *  (declarations stay recipe-relative even though the walk is rooted at `agent/`), and the same answer to
 *  "no agent bundle at all" — undefined, not a thrown ENOENT, since a plain service recipe
 *  with no agent/ directory is a normal shape, not a failure — and that verdict is the
 *  walk root's OWN absence and nothing else: the wrapper probes agent/ directly
 *  and nets no ENOENT around the walk, so a dangling link named agent/, a child link that
 *  does not resolve, or an entry that vanishes mid-walk stops the caller instead of
 *  reading as an honestly-empty bundle. Any other error (an escaping or unresolvable
 *  link, an escaped walk root, an unreadable tree) still throws: that is the policy
 *  actually firing, and must stop the caller exactly as collectPortableRecipeFiles
 *  already does for served content. */
export async function collectPortableAgentBundleFiles(
  recipeDirectory: string,
): Promise<{ files: string[]; excluded: { path: string; reason: string }[] } | undefined> {
  const agentDir = resolve(recipeDirectory, "agent");
  try {
    await lstat(agentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return collectPortableRecipeFiles(recipeDirectory, { walkRoot: agentDir });
}
