// Archive profiles: what goes in, and what a given profile deliberately leaves out.
//
// The exclusion lists are the outcome of inspecting a real
// data directory, not guesswork:
//   - the provider key exists only in config/.env
//   - config/identity/device-auth.json holds an operator token with read/write scopes
//   - state/openclaw.sqlite has a multi-megabyte -wal sibling, so a copy taken while the
//     gateway writes is not restorable — hence the stop before snapshotting
//   - workspace/.git matters: the agent versions its own memory there

import { DATA_DIR_MARKER } from "../../runtime/datadir.ts";
import { PUBLISH_STAGING_MARKER, PRIVATE_STAGING_MARKER } from "../../runtime/transport/transport.ts";

const LEGACY_PREFIXES = ["oc", "cf"] as const;

/** How much of the instance travels with an archive. */
export type Profile = "full" | "migrate" | "share";

export const PROFILES: Profile[] = ["full", "migrate", "share"];

export function isProfile(value: string): value is Profile {
  return (PROFILES as string[]).includes(value);
}

/** Shorthand flags for `backup` and `pull`, one map so both parsers agree. */
export const PROFILE_SHORTHAND_FLAGS: ReadonlyMap<string, Profile> = new Map([
  ["--share", "share"],
  ["--with-secrets", "full"],
  ["--migrate", "migrate"],
]);

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

/** Builds the name restore moves the previous data directory aside under, one generator so
 *  parseReplacedCopyName's shape can never drift from what this actually writes. */
export function replacedCopyName(dataDir: string): string {
  return `${dataDir}.replaced-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

const REPLACED_COPY_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** The stamp of a `.replaced-*` sibling's base name, or undefined when it is not exactly
 *  one — strict for the same reason parseBackupArchive is: `backup prune-replaced` deletes
 *  through this, and a loose match would accept a hand-made or unrelated directory that
 *  merely starts with the right prefix. */
export function parseReplacedCopyName(baseName: string, dataDirName: string): { stamp: string } | undefined {
  const escaped = dataDirName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const match = new RegExp(`^${escaped}\\.replaced-(.+)$`).exec(baseName);
  if (match === null) return undefined;
  return REPLACED_COPY_STAMP.test(match[1]) ? { stamp: match[1] } : undefined;
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
  const root = escapeTarGlob(dataName);
  return [
    `${root}/config/logs`,
    `${root}/config/openclaw.json.bak*`,
    `${root}/config/openclaw.json.last-good`,
    `${root}/config/clawforge-desired.json`,
    // Provider-key staging is private from creation and normally removed after rename, but a
    // process can die between those steps. It is credential material, never instance state.
    `${root}/config/.env.clawforge-*`,
    // A native backup's in-flight full archive; a crash must not nest it into a later backup.
    `${root}/config/.clawforge-native-*`,
    // The tooling's own temp-sibling staging families (transport.ts) are the same story one
    // layer out: the real bytes sit in the sibling from the first byte written, and a process
    // that dies before the rename — or a cleanup that fails — leaves them beside the target
    // under a name no declared path matches. An exact-file privatePaths entry in a public
    // subtree is the exposed case: under workspace/ the leftover passes the share allow-list
    // entirely. The markers are written only by the writers themselves, so the globs cannot
    // reach an unrelated public file that merely sits nearby (GNU tar exclusion globs match
    // slashes, verified against GNU tar 1.35+).
    `${root}/*${PRIVATE_STAGING_MARKER}*`,
    `${root}/*${PUBLISH_STAGING_MARKER}*`,
    `${root}/clawforge-operation.lock`,
    ...LEGACY_PREFIXES.flatMap((prefix) => [
      `${root}/config/${prefix}-desired.json`,
      `${root}/${prefix}-operation.lock`,
    ]),
  ];
}

/** GNU tar reads --exclude patterns as globs. Escape literal root and recipe paths while
 *  keeping the deliberate wildcards in the base exclusion suffixes. */
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
  const root = escapeTarGlob(dataName);
  const excludes = baseExcludes(dataName);

  if (profile !== "full" && recipePrivatePaths.length > 0) {
    excludes.push(...recipePrivatePaths.map((path) => escapeTarGlob(`${dataName}/${path}`)));
  }

  if (profile === "migrate") {
    // Same instance, different host: keep identity, hand the keys over separately.
    excludes.push(
      `${root}/config/.env`,
      // The privacy history is published for full backups;
      // a profile-limited snapshot does not carry it, and this profile's readers do not
      // expect it — verify's SHARE_ALLOWED would refuse a share archive holding it.
      `${root}/config/clawforge-private-paths.json`,
      `${root}/clawforge-operations`,
      ...LEGACY_PREFIXES.map((prefix) => `${root}/${prefix}-operations`),
      `${root}/${DATA_DIR_MARKER}`, // names the OLD host; restore's trustExisting writes a fresh one
    );
  }

  if (profile === "share") {
    // Handing the agent to someone else: only its personality travels.
    excludes.push(
      `${root}/config/.env`,
      `${root}/config/clawforge-private-paths.json`, // published for full backups only
      `${root}/config/identity`,
      `${root}/config/devices`,
      `${root}/config/state`,
      `${root}/config/agents`,
      `${root}/auth-secrets`,
      // Host-local history: what this machine's operations did, and copies of THIS host's
      // configuration. The receiving side has its own, and a snapshot of someone else's
      // configuration is not something a shared agent should carry.
      `${root}/clawforge-operations`,
      `${root}/clawforge-managed.json`,
      `${root}/clawforge-installed-set.json`,
      `${root}/${DATA_DIR_MARKER}`, // same reasoning as migrate above
      ...LEGACY_PREFIXES.flatMap((prefix) => [
        `${root}/${prefix}-operations`,
        `${root}/${prefix}-managed.json`,
        `${root}/${prefix}-installed-set.json`,
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
