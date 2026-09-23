// Snapshot archives: what goes in, and how to look inside one.
//
// The exclusion lists are the outcome of inspecting a real
// data directory, not guesswork:
//   - the provider key exists only in config/.env
//   - config/identity/device-auth.json holds an operator token with read/write scopes
//   - state/openclaw.sqlite has a multi-megabyte -wal sibling, so a copy taken while the
//     gateway writes is not restorable — hence the stop before snapshotting
//   - workspace/.git matters: the agent versions its own memory there

import type { Context } from "../core/context.ts";
import { sudoFor } from "../runtime/datadir.ts";
import { PUBLISH_STAGING_MARKER, PRIVATE_STAGING_MARKER } from "../runtime/transport.ts";
import { publishPrivatePathsHistory, reconcilePrivatePathsHistory } from "../security/private-paths-ledger.ts";
import { installedRecipePrivatePaths } from "./recipe.ts";

const LEGACY_PREFIXES = ["oc", "cf"] as const;

/** How much of the instance travels with an archive. */
export type Profile = "full" | "migrate" | "share";

export const PROFILES: Profile[] = ["full", "migrate", "share"];

export function isProfile(value: string): value is Profile {
  return (PROFILES as string[]).includes(value);
}

/** What a backup archive is called, and how to read that name back.
 *
 *  The profile used to be absent from the name, and every consumer of a backup directory
 *  then had to treat "an archive of this deployment" as one kind of thing. It is not: a
 *  `migrate` archive carries no config/.env and a `share` one carries neither identity nor
 *  devices, so restoring either over a live instance replaces it with something that cannot
 *  start. `pull` writes both into the same backup directory that `backup` writes full
 *  archives into, and `./clawforge restore` with no argument took whichever was newest.
 *
 *  A full archive keeps the name it always had, so directories written before this still
 *  read correctly — with the one limitation that a profile which was never recorded cannot
 *  be recovered from the name, and an old migrate/share archive still looks full. */
export function backupArchiveName(deployment: string, stamp: string, profile: Profile): string {
  return profile === "full"
    ? `${deployment}-${stamp}.tar.gz`
    : `${deployment}-${stamp}-${profile}.tar.gz`;
}

/** The stamp and profile of `fileName`, or undefined when it is not this deployment's backup
 *  at all. Deliberately strict: a `ls <name>-*.tar.gz` glob also matches a sibling deployment
 *  ("openclaw" matching "openclaw-staging-20260101-000000.tar.gz") when both share a backup
 *  directory, and rotation that cannot tell them apart deletes the sibling's archives. */
export function parseBackupArchive(fileName: string, deployment: string): { stamp: string; profile: Profile } | undefined {
  const escaped = deployment.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const match = new RegExp(`^${escaped}-(\\d{8}-\\d{6})(?:-(migrate|share))?\\.tar\\.gz$`).exec(fileName);
  if (match === null) return undefined;
  return { stamp: match[1], profile: (match[2] ?? "full") as Profile };
}

/** Parses the exact snapshot name produced by `pull`. */
export function snapshotDeploymentNames(deployment: string): string[] {
  return deployment === "openclaw" ? [deployment, "open_claw"] : [deployment];
}

export function parseSnapshotArchive(fileName: string, deployment: string): { stamp: string } | undefined {
  // The first release used the repository's historical `open_claw` name while the current
  // deployment identity is `openclaw`. Keep that one explicit compatibility alias; accepting
  // arbitrary spelling variants would let a sibling deployment's snapshots be restored.
  const names = snapshotDeploymentNames(deployment);
  const escaped = names.map((name) => name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join("|");
  const match = new RegExp(`^(?:${escaped})-state-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})\\.tar\\.gz$`).exec(fileName);
  if (match === null) return undefined;
  const stamp = match[1];
  const iso = `${stamp.slice(0, 10)}T${stamp.slice(11).replaceAll("-", ":")}Z`;
  const date = new Date(iso);
  const normalized = Number.isNaN(date.getTime()) ? "" : date.toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
  return normalized === stamp ? { stamp } : undefined;
}

/** Always excluded: host-local noise and artefacts reproducible from the repository.
 *
 *  The instance lock is here rather than in one profile's list, and that is a decision worth
 *  keeping: a full backup restored onto a host would otherwise arrive holding a lock nobody
 *  can release, blocking the very instance the restore was meant to rescue. A lock describes
 *  a running operation on one machine and is meaningless anywhere else. */
function baseExcludes(dataName: string): string[] {
  return [
    `${dataName}/config/logs`,
    `${dataName}/config/openclaw.json.bak*`,
    `${dataName}/config/openclaw.json.last-good`,
    `${dataName}/config/clawforge-desired.json`,
    // Provider-key staging is private from creation and normally removed after rename, but a
    // process can die between those steps. It is credential material, never instance state.
    `${dataName}/config/.env.clawforge-*`,
    // The tooling's own temp-sibling staging families (transport.ts) are the same story one
    // layer out: the real bytes sit in the sibling from the first byte written, and a process
    // that dies before the rename — or a cleanup that fails — leaves them beside the target
    // under a name no declared path matches. An exact-file privatePaths entry in a public
    // subtree is the exposed case: under workspace/ the leftover passes the share allow-list
    // entirely. The markers are written only by the writers themselves, so the globs cannot
    // reach an unrelated public file that merely sits nearby (GNU tar exclusion globs match
    // slashes, verified against GNU tar 1.35+).
    `${dataName}/*${PRIVATE_STAGING_MARKER}*`,
    `${dataName}/*${PUBLISH_STAGING_MARKER}*`,
    `${dataName}/clawforge-operation.lock`,
    ...LEGACY_PREFIXES.flatMap((prefix) => [
      `${dataName}/config/${prefix}-desired.json`,
      `${dataName}/${prefix}-operation.lock`,
    ]),
  ];
}

/** GNU tar matches --exclude patterns as globs: a declaration `vault[1]` was a character
 *  class to tar but a literal name to private-config, so the one real directory named
 *  vault[1] shipped in every migrate/share snapshot while an undeclared sibling `vault1`
 *  vanished from them. privatePaths are literal data-relative paths, so their rules escape
 *  the glob metacharacters; the base exclusions keep their wildcards — --no-wildcards would
 *  break those. Escaping verified against GNU tar 1.35. */
function escapeTarGlob(pattern: string): string {
  return pattern.replace(/[*?[\]\\]/g, "\\$&");
}

/** The tar exclusion list for one profile.
 *
 *  recipePrivatePaths carries the recipes' own declared private paths (installedRecipePrivatePaths,
 *  data-relative). Those files are generated credentials, not instance state: migrate and share
 *  must leave them out, while full — credential-complete by design, so restoring it restores the
 *  sidecar's working state — keeps them. The parameter defaults to empty, so callers without
 *  recipe context get exactly the lists they always got. */
export function excludesFor(profile: Profile, dataName: string, recipePrivatePaths: readonly string[] = []): string[] {
  const excludes = baseExcludes(dataName);

  if (profile !== "full" && recipePrivatePaths.length > 0) {
    excludes.push(...recipePrivatePaths.map((path) => `${dataName}/${path}`));
  }

  if (profile === "migrate") {
    // Same instance, different host: keep identity, hand the keys over separately.
    excludes.push(
      `${dataName}/config/.env`,
      // The privacy history is published for full backups (audit 2026-09-22 round 3, P1-02);
      // a profile-limited snapshot does not carry it, and this profile's readers do not
      // expect it — verify's SHARE_ALLOWED would refuse a share archive holding it.
      `${dataName}/config/clawforge-private-paths.json`,
      `${dataName}/clawforge-operations`,
      ...LEGACY_PREFIXES.map((prefix) => `${dataName}/${prefix}-operations`),
    );
  }

  if (profile === "share") {
    // Handing the agent to someone else: only its personality travels.
    excludes.push(
      `${dataName}/config/.env`,
      `${dataName}/config/clawforge-private-paths.json`, // published for full backups only (round 3, P1-02)
      `${dataName}/config/identity`,
      `${dataName}/config/devices`,
      `${dataName}/config/state`,
      `${dataName}/config/agents`,
      `${dataName}/auth-secrets`,
      // Host-local history: what this machine's operations did, and copies of THIS host's
      // configuration. The receiving side has its own, and a snapshot of someone else's
      // configuration is not something a shared agent should carry.
      `${dataName}/clawforge-operations`,
      `${dataName}/clawforge-managed.json`,
      `${dataName}/clawforge-installed-set.json`,
      ...LEGACY_PREFIXES.flatMap((prefix) => [
        `${dataName}/${prefix}-operations`,
        `${dataName}/${prefix}-managed.json`,
        `${dataName}/${prefix}-installed-set.json`,
      ]),
    );
  }

  return excludes;
}

/** What a `share` archive is allowed to contain, relative to its root directory.
 *
 *  The exclusion list above says what must not travel; this says what may. Both exist on
 *  purpose: a new directory appearing in the data directory is then reported by `verify`
 *  instead of silently shipping. Paths are prefixes — a file or a whole subtree. */
export const SHARE_ALLOWED = [
  "config/openclaw.json",
  "config/plugin-skills",
  "config/npm",
  "config/workspace",
  "config/workspace-attestations",
  "workspace",
];

/** The single top-level directory of an archive, e.g. "data". Also the first structural
 *  check: entries scattered across several roots are not something we produced. */
export function archiveRoot(entries: string[]): string {
  const roots = new Set(entries.map((entry) => entry.replace(/^\.\//, "").split("/")[0]));
  roots.delete("");
  if (roots.size !== 1) {
    throw new Error(`archive has ${roots.size} top-level entries, expected exactly one`);
  }
  return [...roots][0];
}

/** Whether an archive listing holds anything beneath its single root directory.
 *
 *  A successful tar is not evidence of a backup: pointed at a data directory that is
 *  itself a symlink, tar stores one entry — the link — and exits 0, and an archive that
 *  holds nothing beneath its root restores nothing anywhere. createBackup() checks the
 *  staging archive with this before publishing it (audit 2026-09-22 round 2, P2-02). */
export function archiveCarriesContent(entries: string[]): boolean {
  let root: string;
  try {
    root = archiveRoot(entries);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const path = entry.replace(/^\.\//, "");
    return path !== root && path !== `${root}/`;
  });
}

export interface ArchiveProblem {
  readonly message: string;
  /** Unpacking would write outside the destination. Anything else is worth reporting but
   *  not worth refusing an otherwise valid archive. */
  readonly fatal: boolean;
}

/** Whether a hard-link target — given root-relative, the same coordinate space as every
 *  other archive member — names something outside that root. Unlike a symlink, there is no
 *  "dangling but harmless" case: extraction performs `link()` immediately, so an out-of-root
 *  target is read the moment the archive is unpacked, not only if something is written
 *  through it later. */
function hardlinkEscapes(target: string, root: string): boolean {
  if (target.startsWith("/")) return true;
  if (target.split("/").includes("..")) return true;
  return target !== root && !target.startsWith(`${root}/`);
}

/** A link found in the archive listing: where it resolves and how it was declared. Kept
 *  separate from a plain string target because a symlink and a hard link resolve their
 *  target in different coordinate spaces (own directory vs. archive root) and carry
 *  different risk (dangling-but-harmless vs. read-on-extract). */
export interface ArchiveLink {
  readonly target: string;
  readonly kind: "symlink" | "hardlink";
}

type ChainResolution = { readonly kind: "resolved" } | { readonly kind: "escaped" } | { readonly kind: "cycle" };

/** One canonical spelling of an archive-relative path: "./" prefixes (repeated), internal
 *  "./" segments, doubled slashes and a trailing slash all name the same file and must key
 *  and compare as one — a link registered as "./data//a/" and a listing entry "data/a/file"
 *  otherwise disagree about whether content is written through the link. ".." is a real
 *  segment with meaning, not noise, and is preserved; the degenerate spellings of the root
 *  normalize to "". */
function normalizeArchivePath(path: string): string {
  return path.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
}

/** Resolves an archive-relative path segment by segment, in order, through every link
 *  standing in it. `resolved` holds only segments already proven link-free — a link among
 *  them was substituted before any later segment was appended — so a `..` popping from it
 *  is genuinely lexical: there is no unresolved link left to pop across. Substituting a
 *  link splices its target in front of the pending remainder, so the target's own segments
 *  are walked by the same rules: an intermediate target segment that names a link is
 *  resolved (its own target visited) BEFORE a following `..` consumes it, which is what
 *  makes `b/../safe` mean what the kernel means by it rather than the lexically simplified
 *  `safe` (audit 2026-09-23, P2-07: `b` registered as a link to `../../outside` used to be
 *  popped off unread, and a chain written through the first link read as safely inside the
 *  root). A link key visited twice is a cycle; the substitution counter restates the old
 *  loop bound, though `seen` alone already caps substitutions at the number of links. */
function resolveLinkChain(segments: readonly string[], links: ReadonlyMap<string, ArchiveLink>, root: string): ChainResolution {
  const resolved: string[] = [];
  const pending = [...segments];
  const seen = new Set<string>();

  for (let substitutions = 0; pending.length > 0; ) {
    const segment = pending.shift()!;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      if (resolved.length < 1) return { kind: "escaped" };
      continue;
    }
    const key = [...resolved, segment].join("/");
    const link = links.get(key);
    if (link === undefined) {
      resolved.push(segment);
      continue;
    }
    if (seen.has(key)) return { kind: "cycle" };
    seen.add(key);
    if (++substitutions > links.size) return { kind: "cycle" };
    if (link.kind === "hardlink") {
      // Root-relative, the same coordinate space as every archive member: a hard link that
      // fails this literal check is refused before its target is walked.
      if (hardlinkEscapes(link.target, root)) return { kind: "escaped" };
    } else if (link.target.startsWith("/")) {
      return { kind: "escaped" };
    }
    pending.unshift(...link.target.split("/"));
  }
  return { kind: "resolved" };
}

/** Finds what an unpack of this archive could do outside the directory it is aimed at.
 *
 *  tar happily restores an absolute path, one climbing out through .., a symlink pointing
 *  anywhere, or a hard link to anything already on the filesystem. The first two write
 *  outside on their own and are refused. A symlink pointing outside is only dangerous when
 *  the archive also writes *through* it — a plugin's node_modules/openclaw -> /app is an
 *  ordinary artefact of installing inside the image, and refusing it would reject every
 *  real snapshot. A hard link is refused outright: extraction performs `link()` the moment
 *  the archive is unpacked, aliasing whatever the target already names — there is no
 *  dangling case to be lenient about. */
export function inspectArchive(entries: string[], links: Map<string, ArchiveLink>): ArchiveProblem[] {
  const problems: ArchiveProblem[] = [];

  let root: string;
  try {
    root = archiveRoot(entries);
  } catch (error) {
    return [{ message: (error as Error).message, fatal: true }];
  }

  const paths = entries.map((entry) => entry.replace(/^\.\//, ""));
  for (const path of paths) {
    if (path.startsWith("/")) {
      problems.push({ message: `absolute path: ${path}`, fatal: true });
    } else if (path.split("/").includes("..")) {
      problems.push({ message: `path escaping its root: ${path}`, fatal: true });
    } else if (path !== root && !path.startsWith(`${root}/`)) {
      problems.push({ message: `entry outside ${root}/: ${path}`, fatal: true });
    }
  }

  // Full canonicalization, where `paths` above deliberately keeps its raw spelling: the
  // structural checks must still see a leading "/" and every real ".." segment. Here, one
  // name must key one map entry — a real archive's `tar -tv` listing carries the same "./"
  // prefix on every entry, links included (GNU tar always does when the archive was made by
  // tarring "." rather than a named subdirectory), and another producer can spell the same
  // member with an internal "./", a doubled slash or a trailing slash. Left un-normalized,
  // resolveLinkChain's own lookups (which key into this same map while walking a chain) and
  // the writesThrough prefix match below disagree about whether content is written through a
  // link — in the direction that reads a real escaping symlink as safe. A key canonicalizing
  // to "" is a degenerate spelling of the root itself: it holds no name, and the root-as-link
  // check below compares against `root` by name rather than by map key.
  const normalizedLinks = new Map(
    [...links]
      .map(([rawSource, link]) => [normalizeArchivePath(rawSource), link] as const)
      .filter(([source]) => source !== ""),
  );

  const normalizedPaths = paths.map(normalizeArchivePath);

  for (const [source, link] of normalizedLinks) {
    // The root is the one entry every later restore step is relative to — the fresh-identity
    // deletion, the standard subdirectories, the ownership and permission pass. An archive
    // that ships it as a link would put a symlink where an ordinary directory belongs, and
    // those steps would follow it wherever it points. No archive this tooling produces can
    // contain one, so it is refused even when the target happens to stay inside the parent.
    if (source === root) {
      problems.push({
        message: `the archive root is a ${link.kind}, not an ordinary directory: ${source} -> ${link.target}`,
        fatal: true,
      });
      continue;
    }

    if (link.kind === "hardlink") {
      if (hardlinkEscapes(link.target, root)) {
        problems.push({ message: `hard link points outside the archive: ${source} -> ${link.target}`, fatal: true });
        continue;
      }
      // The target names another archive member, not a bare filesystem path — and that
      // member can itself be a link (symlink or a further hard link) whose own chain leaves
      // the root. link() aliases whatever the chain ultimately names the moment extraction
      // runs, so this is refused just as unconditionally as a literal out-of-root target.
      const resolution = resolveLinkChain(link.target.split("/"), normalizedLinks, root);
      if (resolution.kind !== "resolved") {
        problems.push({ message: `hard link points outside the archive: ${source} -> ${link.target}`, fatal: true });
      }
      continue;
    }

    // Walk the symlink's own chain rather than just its first hop: `data/a -> b` alone
    // never leaves the root, but if `data/b` is itself a link that does, content nested
    // under `data/a` in this archive is written through both.
    const resolution = resolveLinkChain(source.split("/"), normalizedLinks, root);
    if (resolution.kind === "resolved") continue;
    const writesThrough = normalizedPaths.some((path) => path.startsWith(`${source}/`));
    problems.push({
      message: writesThrough
        ? `content is written through a link that leaves the archive: ${source} -> ${link.target}`
        : `link points outside the archive: ${source} -> ${link.target}`,
      fatal: writesThrough,
    });
  }

  return problems;
}

export function dataDirName(dataDir: string): string {
  const trimmed = dataDir.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function dataDirParent(dataDir: string): string {
  const trimmed = dataDir.replace(/\/+$/, "");
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/"));
  return parent === "" ? "/" : parent;
}

/** The privilege prefix for one archive command, decided per path the command touches.
 *
 *  Reading and writing are different capabilities: the archive destination being writable
 *  says nothing about whether the identity can read the tree tar is about to read (auth-secrets
 *  is locked to 1000:1000 mode 700 by ensureDataDirs regardless of who may write the archive
 *  file — the shape that made a real migrate archive fail with "tar: data/auth-secrets:
 *  Cannot open: Permission denied" on GitHub Actions), and an archive being readable says
 *  nothing about the destination it is unpacked into. Every path involved is asked
 *  individually — sources first, destination last — and the first path that demands
 *  escalation decides the prefix for the whole invocation; sudoFor itself falls back to the
 *  nearest existing ancestor for paths that do not exist yet. */
async function privilegePrefixFor(ctx: Context, readPaths: readonly string[], writePath?: string): Promise<string[]> {
  for (const path of readPaths) {
    const prefix = await sudoFor(ctx, path);
    if (prefix.length > 0) return prefix;
  }
  return writePath === undefined ? [] : sudoFor(ctx, writePath);
}

/** Lists an archive's entries. Read in full on purpose: the shell version piped tar into
 *  `head`, which killed tar with SIGPIPE and — under `set -o pipefail` — turned a healthy
 *  archive into a failure. */
export async function listArchive(ctx: Context, archive: string): Promise<string[]> {
  const prefix = await privilegePrefixFor(ctx, [archive]);
  const [head, ...rest] = [...prefix, "tar", "-tzf", archive];
  const result = await ctx.transport.exec(head, rest);
  return result.stdout.split("\n").filter((line) => line !== "");
}

// Five fixed-width columns precede the path in `tar -tv` output: mode, owner/group, size,
// date, time. The path itself is free-form and may contain spaces, so it is never reached
// by splitting the line on whitespace — only these five columns are, and everything after
// them is taken whole. The first character of the mode column is the type flag: "l" for a
// symlink, "h" for a hard link (GNU tar's own convention, not a POSIX file type).
const LISTING_ROW = /^(\S)\S*\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/;

/** Symlinks and hard links in the archive. Read from tar's verbose listing, which is the
 *  only place a link's target appears — `-tzf` alone lists names only. */
export async function listArchiveLinks(ctx: Context, archive: string): Promise<Map<string, ArchiveLink>> {
  const prefix = await privilegePrefixFor(ctx, [archive]);
  const [head, ...rest] = [...prefix, "tar", "-tvzf", archive];
  const result = await ctx.transport.exec(head, rest);

  const links = new Map<string, ArchiveLink>();
  for (const line of result.stdout.split("\n")) {
    const row = LISTING_ROW.exec(line);
    if (row === null) continue;
    const [, typeChar, path] = row;

    if (typeChar === "l") {
      // "data/a symlink -> ../orig"
      const arrow = path.indexOf(" -> ");
      if (arrow === -1) continue;
      links.set(path.slice(0, arrow), { kind: "symlink", target: path.slice(arrow + 4) });
    } else if (typeChar === "h") {
      // "data/orig link to data/a hardlink" — GNU tar names the *later* occurrence of a
      // hard-linked file this way; the target is another archive member, not a filesystem
      // path relative to anything.
      const marker = path.indexOf(" link to ");
      if (marker === -1) continue;
      links.set(path.slice(0, marker), { kind: "hardlink", target: path.slice(marker + 9) });
    }
  }
  return links;
}

/** The data directory is a symlink, and where it resolves — undefined when it is not one.
 *
 *  tar is invoked with the data directory's NAME relative to its parent, so a symlinked
 *  data root is archived as the link itself: one entry, none of the data behind it (audit
 *  2026-09-22 round 2, P2-02). createBackup() refuses that layout before stopping the
 *  gateway and createArchive() refuses again at the point of archiving; this is the check
 *  both run. Exit codes other than 0/1 are thrown, not read as "not a link" — a check
 *  that cannot answer must not wave the backup through. */
export async function symlinkedDataRoot(ctx: Context): Promise<string | undefined> {
  const { dataDir } = ctx.settings;
  const check = await ctx.transport.exec("test", ["-L", dataDir], { allowFailure: true });
  if (check.code === 1) return undefined;
  if (check.code !== 0) {
    throw new Error(`could not check whether the data directory is a symlink (exit ${check.code}): ${check.stderr.trim()}`);
  }
  const resolved = await ctx.transport.exec("readlink", ["-f", dataDir], { allowFailure: true });
  const target = resolved.stdout.trim();
  return resolved.code === 0 && target !== "" ? target : dataDir;
}

/** Creates the archive. The caller is responsible for stopping the gateway first. */
export async function createArchive(
  ctx: Context,
  options: { archive: string; profile: Profile },
): Promise<void> {
  const { dataDir } = ctx.settings;
  const linkTarget = await symlinkedDataRoot(ctx);
  if (linkTarget !== undefined) {
    throw new Error(
      `refusing to archive ${dataDir}: it is a symlink to ${linkTarget}, and tar would store the link itself — none of the data behind it`,
    );
  }
  // Taken before the policy read and before a full publish: migrate and share never publish,
  // so this is the one point a deployment folder pointed at already-existing target data —
  // no restore, no full backup yet — learns what the target alone still remembers. A history
  // that exists but cannot be read refuses the backup loudly (audit 2026-09-23 XXA round 6,
  // P1-04).
  await reconcilePrivatePathsHistory(ctx);
  // The privacy history must be inside the tree before tar runs, so a full backup carries
  // it physically and a restore can hand it back to whichever deployment directory manages
  // the target next (audit 2026-09-22 round 3, P1-02). Full only: migrate and share exclude
  // the copy from their archives — instance-local metadata does not travel with the
  // profile-limited snapshots — though they reconcile with it first (above).
  // publishPrivatePathsHistory adopts an existing target copy instead of erasing it when this
  // deployment folder never recorded anything locally (audit 2026-09-23, XS round 4, P2-01).
  if (options.profile === "full") await publishPrivatePathsHistory(ctx);
  const name = dataDirName(dataDir);
  const parent = dataDirParent(dataDir);

  // Read from the recipes' own privatePaths declaration before the command is built: the
  // recipes live on this side, the archive on the target.
  const privatePaths = await installedRecipePrivatePaths();
  // The declaration contributed these exact patterns (dataDirName + declared path); they and
  // only they are escaped, because the declaration is literal — everything else in the list
  // is glob by design.
  const declared = new Set(privatePaths.map((path) => `${name}/${path}`));
  const excludeArgs = excludesFor(options.profile, name, privatePaths).map((pattern) =>
    `--exclude=${declared.has(pattern) ? escapeTarGlob(pattern) : pattern}`,
  );
  const prefix = await privilegePrefixFor(ctx, [`${dataDir}/auth-secrets`, dataDir], options.archive);

  // --numeric-owner keeps uid/gid 1000 meaningful on a host with different user names.
  const [head, ...rest] = [
    ...prefix,
    "tar",
    "--numeric-owner",
    ...excludeArgs,
    "-czf",
    options.archive,
    "-C",
    parent,
    name,
  ];
  await ctx.transport.exec(head, rest);
}

export async function extractArchive(ctx: Context, archive: string, destination: string): Promise<void> {
  const prefix = await privilegePrefixFor(ctx, [archive], destination);
  const [head, ...rest] = [...prefix, "tar", "--numeric-owner", "-xzf", archive, "-C", destination];
  await ctx.transport.exec(head, rest);
}

export async function fileSize(ctx: Context, path: string): Promise<string> {
  const prefix = await sudoFor(ctx, path);
  const [head, ...rest] = [...prefix, "du", "-h", path];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  return result.stdout.split("\t")[0]?.trim() ?? "?";
}
