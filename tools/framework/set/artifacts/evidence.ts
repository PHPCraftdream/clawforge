import { frameworkVersion } from "#src/commands/management/lock.ts";
import { maskSecrets } from "#src/core/log.ts";
import { writeReceipt } from "./receipt.ts";
import type { ReceiptObservations, AcceptanceReceipt, ReceiptCheckInput, ReceiptSource } from "./receipt.ts";
import type { SetManifest } from "./model.ts";
import type { VerifiedArtifact } from "./install.ts";
import type { Context } from "#src/core/context.ts";
import type { AcceptanceResult } from "#src/commands/orchestration/accept.ts";

export interface ObservedRuntime {
  readonly observations: ReceiptObservations;
  readonly containerId?: string;
  readonly digests: readonly string[];
}

/** Read the container's identity, never resolve the configured tag as a substitute. */
export async function observeRuntime(ctx: Context, manifest: SetManifest): Promise<ObservedRuntime> {
  const version = await frameworkVersion();
  let image;
  try { image = await ctx.runtime.runningImageIdentity?.(); } catch { /* Unknown is retained. */ }
  const digests = image?.digests ?? [];
  const requiredHash = manifest.requires.image.split("@").at(-1);
  const imageDigest = digests.find((digest) => digest.split("@").at(-1) === requiredHash) ?? digests[0];
  return {
    observations: {
      frameworkVersion: version ?? "unknown",
      ...(image?.version === undefined ? {} : { openclawVersion: image.version }),
      ...(image?.imageId === undefined ? {} : { imageId: image.imageId }),
      ...(imageDigest === undefined ? {} : { imageDigest }),
    },
    containerId: image?.containerId,
    digests,
  };
}

export function runtimeMatches(manifest: SetManifest, before: ObservedRuntime, after: ObservedRuntime): boolean {
  const hash = manifest.requires.image.split("@").at(-1);
  return before.containerId !== undefined && before.containerId === after.containerId
    && before.observations.imageId !== undefined && before.observations.imageId === after.observations.imageId
    && before.observations.frameworkVersion === manifest.requires.framework
    && after.observations.frameworkVersion === manifest.requires.framework
    && before.digests.some((digest) => digest.split("@").at(-1) === hash)
    && after.digests.some((digest) => digest.split("@").at(-1) === hash);
}

/** A result slot belongs to one declared check, even when that check never completed. */
export async function saveEvidence(input: {
  verified: VerifiedArtifact;
  source: ReceiptSource;
  startedAt: string;
  withModel: boolean;
  selected: readonly string[];
  results: Record<string, readonly AcceptanceResult[]>;
  observed: ObservedRuntime;
  subjectVerified: boolean;
  failure?: string;
  root?: string;
}): Promise<AcceptanceReceipt> {
  const checks: Record<string, ReceiptCheckInput[]> = {};
  for (const recipe of input.selected) {
    const definitions = input.verified.manifest.acceptance[recipe];
    if (definitions === undefined) throw new Error(`recipe ${recipe} has no acceptance declaration in this artifact`);
    checks[recipe] = definitions.map((definition, index) => {
      const result = input.results[recipe]?.[index];
      const detail = result?.detail ?? (result === undefined ? input.failure ?? "check did not complete" : undefined);
      return {
        name: definition.name ?? definition.kind,
        kind: definition.kind,
        status: result?.status ?? "could-not-check",
        ...(detail === undefined ? {} : { detail: maskSecrets(detail) }),
        definition,
      };
    });
  }
  const all = Object.keys(input.verified.manifest.acceptance).sort();
  const selected = [...input.selected].sort();
  return writeReceipt({
    setId: input.verified.id,
    setName: input.verified.manifest.name,
    source: input.source,
    subjectVerified: input.subjectVerified,
    selection: { recipes: input.selected, withModel: input.withModel, allRecipes: JSON.stringify(all) === JSON.stringify(selected) },
    observations: input.observed.observations,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  }, input.root);
}
