// `./clawforge restore --dry-run`'s report: built from index.ts's prepareRestore() —
// the same archive selection and validation a real restore runs — never a second, looser
// pass. Split out purely to keep index.ts under the source-layout line cap; nothing here
// runs on its own.

import { log, info } from "#src/core/io/log.ts";
import { archiveIncludesIdentity, fileStat } from "#src/service/archive/index.ts";
import { humanSize } from "#src/commands/lifecycle/backup/list.ts";
import type { Context } from "#src/core/context.ts";
import type { PreparedRestore, RestoreOptions } from "./index.ts";

/** What --dry-run reports: computed from prepareRestore()'s already-validated inputs plus
 *  one read-only stat of the archive file — nothing here mutates the target. */
export interface RestorePlan {
  archive: string;
  archiveName: string;
  archiveSizeBytes: number | undefined;
  archiveModifiedAt: string | undefined;
  dataDir: string;
  /** The stamp pattern only — the real one is time-of-run, decided inside performRestore. */
  movedTo: string;
  includesIdentity: boolean;
  nativeManifestVerified: boolean;
  steps: string[];
}

/** The ordered steps a real restore runs, described rather than executed — kept in sync
 *  with index.ts's performRestore()/reportRestoreOutcome() by hand. */
function restorePlanSteps(options: RestoreOptions): string[] {
  const steps = [
    "stop the gateway, if it is running",
    "move the current data directory aside",
    "unpack the archive into place",
    "verify the restored layout, then create/own the standard subdirectories",
  ];
  if (options.freshIdentity === true) steps.push("drop identity and paired devices (--fresh-identity)");
  steps.push(
    options.noStart === true
      ? "leave the gateway stopped (--no-start)"
      : "start the gateway, after checking its secrets are available",
  );
  return steps;
}

export async function buildRestorePlan(ctx: Context, prepared: PreparedRestore, options: RestoreOptions): Promise<RestorePlan> {
  const { archive, entries, name, dataDir, nativeManifestVerified } = prepared;
  const stat = await fileStat(ctx, archive);
  return {
    archive,
    archiveName: archive.slice(archive.lastIndexOf("/") + 1),
    archiveSizeBytes: stat.sizeBytes,
    archiveModifiedAt: stat.modifiedAt,
    dataDir,
    movedTo: `${dataDir}.replaced-<timestamp>`,
    includesIdentity: archiveIncludesIdentity(entries, name),
    nativeManifestVerified,
    steps: restorePlanSteps(options),
  };
}

export function printRestorePlan(plan: RestorePlan): void {
  log(`restore --dry-run: would restore ${plan.dataDir} from ${plan.archiveName}`);
  info(`archive: ${plan.archive} — ${humanSize(plan.archiveSizeBytes)}, ${plan.archiveModifiedAt ?? "modification time unknown"}`);
  info(
    plan.nativeManifestVerified
      ? "verified: structure and links checked, embedded native manifest re-verified"
      : "verified: structure and links checked",
  );
  info(`identity: ${plan.includesIdentity ? "included in the archive" : "not included in the archive"}`);
  info(`would move aside: ${plan.dataDir} -> ${plan.movedTo}`);
  log(`${plan.steps.length} step(s) a real restore would run, in order:`);
  plan.steps.forEach((step, index) => info(`${index + 1}. ${step}`));
}
