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
import { collectRecipeFiles } from "../commands/management/provision-agent.ts";

export function checksumOf(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A checksum per file of a recipe's runtime content, keyed by the same relative paths
 *  provision-agent mirrors them under — so a checksum map can be compared directly with
 *  what the target reports for the mirror.
 *
 *  `agent/` is excluded, exactly as the mirror excludes it: those files are the agent's
 *  prompt, not part of what the recipe serves. See agentBundleChecksums for why that
 *  exclusion must not extend past this function. */
export async function recipeFileChecksums(recipeDir: string): Promise<Record<string, string>> {
  const relPaths = await collectRecipeFiles(recipeDir, "agent");
  const checksums: Record<string, string> = {};
  for (const rel of relPaths.sort()) {
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
 *  re-provisioning; only the first means the mirror is stale. */
export async function agentBundleChecksums(recipeDir: string): Promise<Record<string, string>> {
  const agentDir = resolve(recipeDir, "agent");
  let relPaths: string[];
  try {
    relPaths = await collectRecipeFiles(agentDir, "");
  } catch {
    // A recipe can be a plain service with no agent at all.
    return {};
  }

  const checksums: Record<string, string> = {};
  for (const rel of relPaths.sort()) {
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
