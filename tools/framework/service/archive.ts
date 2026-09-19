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
    `${dataName}/clawforge-operation.lock`,
    ...LEGACY_PREFIXES.flatMap((prefix) => [
      `${dataName}/config/${prefix}-desired.json`,
      `${dataName}/${prefix}-operation.lock`,
    ]),
  ];
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
      `${dataName}/clawforge-operations`,
      ...LEGACY_PREFIXES.map((prefix) => `${dataName}/${prefix}-operations`),
    );
  }

  if (profile === "share") {
    // Handing the agent to someone else: only its personality travels.
    excludes.push(
      `${dataName}/config/.env`,
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

export interface ArchiveProblem {
  readonly message: string;
  /** Unpacking would write outside the destination. Anything else is worth reporting but
   *  not worth refusing an otherwise valid archive. */
  readonly fatal: boolean;
}

/** Whether a symlink target, resolved against its own directory, stays inside the root. */
function symlinkEscapes(source: string, target: string): boolean {
  if (target.startsWith("/")) return true;
  let depth = source.split("/").length - 1;
  for (const segment of target.split("/")) {
    if (segment === "..") depth -= 1;
    else if (segment !== "." && segment !== "") depth += 1;
    if (depth < 1) return true;
  }
  return false;
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

  for (const [rawSource, link] of links) {
    // Same normalization as `paths` above, and for the same reason: a real archive's
    // `tar -tv` listing carries the same "./" prefix on every entry, links included (GNU
    // tar always does when the archive was made by tarring "." rather than a named
    // subdirectory) — left un-normalized here, it broke both symlinkEscapes()'s own depth
    // arithmetic (source.split("/").length counts one segment too many) and the
    // writesThrough prefix match below, in the same direction: a real escaping symlink
    // read as safe.
    const source = rawSource.replace(/^\.\//, "");
    if (link.kind === "hardlink") {
      if (!hardlinkEscapes(link.target, root)) continue;
      problems.push({
        message: `hard link points outside the archive: ${source} -> ${link.target}`,
        fatal: true,
      });
      continue;
    }

    if (!symlinkEscapes(source, link.target)) continue;
    const writesThrough = paths.some((path) => path.startsWith(`${source}/`));
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

/** Lists an archive's entries. Read in full on purpose: the shell version piped tar into
 *  `head`, which killed tar with SIGPIPE and — under `set -o pipefail` — turned a healthy
 *  archive into a failure. */
export async function listArchive(ctx: Context, archive: string): Promise<string[]> {
  const prefix = await sudoFor(ctx, archive);
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
  const prefix = await sudoFor(ctx, archive);
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

/** Creates the archive. The caller is responsible for stopping the gateway first. */
export async function createArchive(
  ctx: Context,
  options: { archive: string; profile: Profile },
): Promise<void> {
  const { dataDir } = ctx.settings;
  const name = dataDirName(dataDir);
  const parent = dataDirParent(dataDir);

  // Read from the recipes' own privatePaths declaration before the command is built: the
  // recipes live on this side, the archive on the target.
  const excludeArgs = excludesFor(options.profile, name, await installedRecipePrivatePaths()).map((pattern) => `--exclude=${pattern}`);
  const prefix = await sudoFor(ctx, options.archive);

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
  const prefix = await sudoFor(ctx, destination);
  const [head, ...rest] = [...prefix, "tar", "--numeric-owner", "-xzf", archive, "-C", destination];
  await ctx.transport.exec(head, rest);
}

export async function fileSize(ctx: Context, path: string): Promise<string> {
  const prefix = await sudoFor(ctx, path);
  const [head, ...rest] = [...prefix, "du", "-h", path];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  return result.stdout.split("\t")[0]?.trim() ?? "?";
}
