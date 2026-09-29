// OpenClaw plugins and skills: third-party code this framework does not vendor, discovered
// through OpenClaw's own CLI rather than read from disk. `lock` records what is installed,
// `inspect`/`doctor` report drift, `plan` never installs or removes one on its own — an id
// and a version aren't proof of what a reinstall would run (see compareExtensions), so the
// reader always decides.
//
// Bundled entries (shipped inside the pinned image itself) are already covered by the
// lock's own image digest, so they're filtered out before this framework writes or
// compares them — recording them too would call it drift on every OpenClaw upgrade.
//
// `plugins list --json` reports {id, name, version, origin, enabled, ...}, no integrity
// hash; `skills list --json` reports {name, source, bundled, ...}, no version at all. A
// skill's install version lives only in a per-skill call not part of the batched read this
// module shares with doctor, so skill drift here is add/remove only, never version.

import type { BatchedCliResult } from "#src/service/openclaw-cli.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem } from "#src/service/inspection.ts";

/** The exact CLI invocations both `lock` and `inspect` read — one place, so the two commands
 *  cannot silently start asking a different question about the same instance. */
export const PLUGINS_LIST_ARGS = ["plugins", "list", "--json"] as const;
export const SKILLS_LIST_ARGS = ["skills", "list", "--json"] as const;

/** One entry from `openclaw plugins list --json`. `origin` is OpenClaw's provenance tag
 *  (see normalizePluginOrigin), kept raw here so a future unseen origin still travels
 *  instead of being coerced into the wrong bucket. */
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
 *  read answers with an empty list — gap, not verdict: unreadable is not evidence of "none". */
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
 *  "git"/"npm"/"clawhub" map onto themselves; "local-path"/"managed"/"upload"/"workspace"
 *  fold to "local". An unseen origin is kept verbatim rather than mis-filed under "local". */
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
 *  Built from `name` (falling back to `id`) — the closest approximation to the original
 *  install spec, not proven to be it: an npm-origin plugin's id can differ from its
 *  manifest name, so a reinstall built from either can name the wrong package. Why this is
 *  only ever offered as an advisory step (plan.ts), never run unattended. */
function pluginReinstallCommand(label: string, version: string | undefined): string {
  return `./clawforge cli plugins install ${label}${version === undefined ? "" : `@${version}`} --force`;
}

function skillReinstallCommand(name: string): string {
  return `./clawforge cli skills install ${name} --force`;
}

/** PLUGIN_DRIFT / SKILL_DRIFT: the live third-party set against what the lock pinned, named
 *  per item the way compareLock (lock.ts) names which recipe file changed.
 *
 *  Three shapes per item: locked but no longer installed (restorable), installed but not
 *  locked (never proposed for removal, only a deliberate lock or uninstall), and installed
 *  at a different version than locked (skills have no version — see this file's header). */
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
