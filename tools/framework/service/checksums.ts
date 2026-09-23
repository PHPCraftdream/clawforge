// Content identity for the things a deployment is made of.
//
// Its own module because two commands need the same answer and must not each have their
// own: inspect compares a recipe against what is on the target, and lock records what the
// recipe was when the instance was pinned. If those two computed "the same recipe"
// differently, the lock would disagree with the inspection about a deployment neither had
// touched, and there would be no way to tell which one was wrong.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { collectPortableAgentBundleFiles, collectPortableRecipeFiles } from "../security/recipe-portable-content.ts";

export function checksumOf(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A checksum per file of a recipe's runtime content, keyed by the same relative paths
 *  provision-agent mirrors them under — so a checksum map can be compared directly with
 *  what the target reports for the mirror.
 *
 *  `agent/` is excluded, exactly as the mirror excludes it: those files are the agent's
 *  prompt, not part of what the recipe serves. See agentBundleChecksums for why that
 *  exclusion must not extend past this function.
 *
 *  The walk runs through the shared portable-content policy (audit 2026-09-22, P1-03), so
 *  policy-excluded files — declared privateFiles, sensitive names — are left out of this
 *  map too: every consumer of it (set build's manifest, inspect, the lock) shares one
 *  portable-content notion instead of checksumming bytes no carrier may have moved. */
export async function recipeFileChecksums(recipeDir: string): Promise<Record<string, string>> {
  const { files } = await collectPortableRecipeFiles(recipeDir, { excludeTop: "agent" });
  const checksums: Record<string, string> = {};
  for (const rel of files.sort()) {
    checksums[rel] = checksumOf(await readFile(resolve(recipeDir, ...rel.split("/"))));
  }
  return checksums;
}

/** The same, for the agent bundle: everything under `agent/`.
 *
 *  Excluding it from the mirror is right — the prompts are not content the recipe serves.
 *  Letting that exclusion be the ONLY checksum was wrong, and quietly: the lock, the plan's
 *  declaration checksum and the inspection all read one number, so editing AGENTS.md, SOUL.md
 *  or cron-message.txt changed what the agent does while every one of them reported nothing
 *  had changed. plan then scheduled no work and apply left the old prompts in place.
 *
 *  Two numbers instead, because they answer two different questions: has the served content
 *  changed, and has the agent's own definition changed. Both mean the recipe needs
 *  re-provisioning; only the first means the mirror is stale.
 *
 *  Walked through collectPortableAgentBundleFiles (audit 2026-09-23, P1-03) — the same
 *  agent-bundle walk loadRecipeAgentBundle uses to actually read the bundle, so a declared
 *  private or sensitive-named prompt/cron file is held out of this checksum map for exactly
 *  the reason direct provisioning holds it out of the workspace, not two independent guesses
 *  that could drift apart. */
export async function agentBundleChecksums(recipeDir: string): Promise<Record<string, string>> {
  const agentDir = resolve(recipeDir, "agent");
  const walked = await collectPortableAgentBundleFiles(recipeDir);
  // A recipe can be a plain service with no agent at all — collectPortableAgentBundleFiles
  // answers that with undefined rather than a thrown ENOENT. Any other failure — an escaping
  // symlink, an unreadable tree — still throws and must stop the caller.
  if (walked === undefined) return {};

  const checksums: Record<string, string> = {};
  for (const rel of walked.files.sort()) {
    checksums[rel] = checksumOf(await readFile(resolve(agentDir, ...rel.split("/"))));
  }
  return checksums;
}

/** One checksum standing for a whole file map, so two recipes can be compared with a single
 *  equality rather than by walking both. Order-independent by construction: the map is
 *  serialised from sorted keys, so the same content always produces the same digest
 *  whichever order the files were read in. */
export function checksumOfFileMap(files: Record<string, string>): string {
  const canonical = Object.keys(files)
    .sort()
    .map((rel) => `${rel}:${files[rel]}`)
    .join("\n");
  return checksumOf(canonical);
}
