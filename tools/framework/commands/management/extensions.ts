// OpenClaw plugins and skills: third-party code this framework does not vendor, discovered
// through OpenClaw's own CLI rather than read from disk — a supply-chain surface `lock`
// does not pin today. `lock` records what is installed, `inspect`/`doctor` report when the
// live set no longer matches, `plan` never installs or removes one on its own: an id and a
// version are not proof of what a reinstall would actually run (see compareExtensions
// below), so the reader always decides.
//
// Bundled entries — shipped inside the pinned image itself (plugins: origin "bundled";
// skills: source "openclaw-bundled" or "openclaw-extra", the latter a plugin's own companion
// skill materialised into the workspace at startup, still the image's content) — are already
// covered by the lock's own image digest: they change only when the image does, never on
// their own. Recording them here too would repeat the image digest 66 times over and call
// it drift the moment someone upgrades OpenClaw. They are filtered out before this framework
// ever writes or compares them.
//
// Probed directly against the pinned image (ghcr.io/openclaw/openclaw:extended-stable,
// OpenClaw 2026.6.34) rather than trusted from docs, which describe newer versions:
// `plugins list --json` reports {id, name, version, origin, enabled, ...} and no
// integrity/hash of any kind; `skills list --json` reports {name, source, bundled, ...} and
// no version at all, for a bundled skill or otherwise. A skill's version, when ClawHub or
// git installed it, lives only in `skills info <name> --json`'s own per-skill `install`
// array — a call per skill, which is not part of the batched read this module shares with
// doctor (openclaw-cli.ts's openclawCliBatch, called from inspect/live.ts's observeLive) — so
// skill drift here is add/remove only, never version.

import type { BatchedCliResult } from "#src/service/openclaw-cli.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem } from "#src/service/inspection.ts";

/** The exact CLI invocations both `lock` and `inspect` read — one place, so the two commands
 *  cannot silently start asking a different question about the same instance. */
export const PLUGINS_LIST_ARGS = ["plugins", "list", "--json"] as const;
export const SKILLS_LIST_ARGS = ["skills", "list", "--json"] as const;

/** One entry from `openclaw plugins list --json`. `origin` is OpenClaw's own provenance tag
 *  ("bundled", "npm", "git", "clawhub", or a handful of local-install variants — see
 *  normalizePluginOrigin) kept raw here rather than re-typed, so a future origin this
 *  framework has never seen still travels instead of being coerced into the wrong bucket. */
export interface PluginListEntry {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly origin: string;
  readonly enabled: boolean;
}

/** One entry from `openclaw skills list --json`. No version field — see this file's header. */
export interface SkillListEntry {
  readonly name: string;
  readonly source: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Parses one `openclawCliBatch` slot's stdout as the plugins list. A failed or malformed
 *  read answers with an empty list — the same "gap, not a verdict" every other batched read
 *  in inspect/live.ts gives: an inventory nobody could read is not evidence that nothing is
 *  installed. */
export function parsePluginsList(result: BatchedCliResult): PluginListEntry[] {
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as { plugins?: unknown[] };
    if (!Array.isArray(parsed.plugins)) return [];
    return parsed.plugins
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => isNonEmptyString(entry.id) && isNonEmptyString(entry.origin))
      .map((entry) => ({
        id: entry.id as string,
        name: isNonEmptyString(entry.name) ? entry.name : undefined,
        version: isNonEmptyString(entry.version) ? entry.version : undefined,
        origin: entry.origin as string,
        enabled: entry.enabled === true,
      }));
  } catch {
    return [];
  }
}

/** Same shape of parse for `skills list --json`'s top-level `skills` array. */
export function parseSkillsList(result: BatchedCliResult): SkillListEntry[] {
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as { skills?: unknown[] };
    if (!Array.isArray(parsed.skills)) return [];
    return parsed.skills
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => isNonEmptyString(entry.name) && isNonEmptyString(entry.source))
      .map((entry) => ({ name: entry.name as string, source: entry.source as string }));
  } catch {
    return [];
  }
}

/** OpenClaw's own provenance tag, normalised to the category this framework's lock records.
 *  Every value below (besides "bundled", filtered out before this runs) was read out of the
 *  pinned image's own install code, not guessed: "git" and "npm" map onto themselves,
 *  "clawhub" likewise, and "local-path"/"managed"/"upload"/"workspace" (all install-target
 *  kinds distinct from a registry fetch) fold to "local". An origin this framework has not
 *  seen yet is kept verbatim rather than mis-filed under "local". */
export function normalizePluginOrigin(origin: string): string {
  if (origin === "clawhub" || origin === "npm" || origin === "git" || origin === "bundled") return origin;
  if (origin === "local-path" || origin === "managed" || origin === "upload" || origin === "workspace") return "local";
  return origin;
}

/** Same normalisation for a skill's `source` field. */
export function normalizeSkillSource(source: string): string {
  return source.startsWith("openclaw-") ? "bundled" : source;
}

/** What `lock` writes and `inspect` compares against — id/name/version plus the normalised
 *  source, nothing this framework cannot read straight off `plugins list --json`. */
export interface LockPlugin {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly source: string;
}

/** No version — see this file's header. */
export interface LockSkill {
  readonly name: string;
  readonly source: string;
}

/** Bundled plugins left out (this file's header), the rest sorted so two reads of the same
 *  instance produce the same file byte for byte. */
export function pluginsForLock(entries: readonly PluginListEntry[]): LockPlugin[] {
  return entries
    .map((entry) => ({ ...entry, source: normalizePluginOrigin(entry.origin) }))
    .filter((entry) => entry.source !== "bundled")
    .map((entry) => ({ id: entry.id, name: entry.name, version: entry.version, source: entry.source }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function skillsForLock(entries: readonly SkillListEntry[]): LockSkill[] {
  return entries
    .map((entry) => ({ name: entry.name, source: normalizeSkillSource(entry.source) }))
    .filter((entry) => entry.source !== "bundled")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The exact command a reader can run to put a plugin back at the version the lock pinned.
 *  Built from the `name` OpenClaw reports (falling back to `id`) — the closest approximation
 *  this framework has to the original install spec, and not proven to be it: the pinned
 *  image's own `plugins list --json` already shows an npm-origin plugin's `id` ("alibaba")
 *  differing from its manifest `name` ("@openclaw/alibaba-provider"), so a reinstall built
 *  from either field can name the wrong package. That is exactly why this is only ever
 *  offered as an advisory step (plan.ts) and never one `apply` runs unattended. */
function pluginReinstallCommand(label: string, version: string | undefined): string {
  return `./clawforge cli plugins install ${label}${version === undefined ? "" : `@${version}`} --force`;
}

function skillReinstallCommand(name: string): string {
  return `./clawforge cli skills install ${name} --force`;
}

/** PLUGIN_DRIFT / SKILL_DRIFT: the live third-party set against what the lock pinned. Named
 *  per item, the same way compareLock (lock.ts) names which recipe file changed — "3 plugins
 *  drifted" sends the reader to find them itself, which is the work this exists to do
 *  instead.
 *
 *  Three shapes per item: locked but no longer installed ("removed" — restorable), installed
 *  but not locked ("added" — never proposed for removal, only for a deliberate ./clawforge
 *  lock or an equally deliberate uninstall), and installed at a different version than
 *  locked (skills have no version to compare — see this file's header). */
export function compareExtensions(
  lockPlugins: readonly LockPlugin[] | undefined,
  currentPlugins: readonly LockPlugin[],
  lockSkills: readonly LockSkill[] | undefined,
  currentSkills: readonly LockSkill[],
): Problem[] {
  const problems: Problem[] = [];

  const lockedPlugins = new Map((lockPlugins ?? []).map((entry) => [entry.id, entry] as const));
  const livePlugins = new Map(currentPlugins.map((entry) => [entry.id, entry] as const));
  for (const [id, locked] of lockedPlugins) {
    const label = locked.name ?? id;
    const live = livePlugins.get(id);
    if (live === undefined) {
      problems.push(
        problem(
          "PLUGIN_DRIFT",
          `plugin "${label}" is locked at version ${locked.version ?? "(unknown)"} but is no longer installed — ` +
            `reinstall it: ${pluginReinstallCommand(label, locked.version)}`,
        ),
      );
    } else if (locked.version !== undefined && live.version !== undefined && locked.version !== live.version) {
      problems.push(
        problem(
          "PLUGIN_DRIFT",
          `plugin "${label}" is version ${live.version}, locked at ${locked.version} — ` +
            `reinstall the pinned version: ${pluginReinstallCommand(label, locked.version)}`,
        ),
      );
    }
  }
  for (const [id, live] of livePlugins) {
    if (lockedPlugins.has(id)) continue;
    problems.push(
      problem(
        "PLUGIN_DRIFT",
        `plugin "${live.name ?? id}" (source ${live.source}) is installed but not in the lock — ` +
          "review it, then either remove it or run ./clawforge lock to pin it deliberately",
      ),
    );
  }

  const lockedSkills = new Map((lockSkills ?? []).map((entry) => [entry.name, entry] as const));
  const liveSkills = new Map(currentSkills.map((entry) => [entry.name, entry] as const));
  for (const [name, locked] of lockedSkills) {
    if (liveSkills.has(name)) continue;
    problems.push(
      problem(
        "SKILL_DRIFT",
        `skill "${name}" (source ${locked.source}) is locked but no longer installed — ` +
          `reinstall it: ${skillReinstallCommand(name)}`,
      ),
    );
  }
  for (const [name, live] of liveSkills) {
    if (lockedSkills.has(name)) continue;
    problems.push(
      problem(
        "SKILL_DRIFT",
        `skill "${name}" (source ${live.source}) is installed but not in the lock — ` +
          "review it, then either remove it or run ./clawforge lock to pin it deliberately",
      ),
    );
  }

  return problems;
}
