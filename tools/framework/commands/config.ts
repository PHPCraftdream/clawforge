// `./clawforge apply-config` — applies config/desired-state.json to the instance.
//
// The declaration in the repository is the source of
// truth: editing openclaw.json on a host makes that host diverge, re-applying brings it
// back. The file is a native `openclaw config set --batch-file` payload.

import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { log, info, die } from "../log.ts";
import { desiredStateFile } from "../deployment.ts";
import type { Context } from "../context.ts";
import { guarded } from "../instance-lock.ts";



/** Name of the copy staged inside the data directory. The CLI runs in the container and
 *  only sees the mounted data directory, so the payload has to travel there.
 *
 *  A real run stages under this shared name, and only ever while holding the instance lock.
 *  A dry run gets a name of its own: it deliberately takes no lock — locking would make
 *  inspecting a busy instance fail for no reason — and writing the shared file without one
 *  meant a dry run could replace the payload a concurrent real apply was about to read. */
const stagedName = "clawforge-desired.json";

export function stagedFileName(dryRun: boolean): string {
  return dryRun ? `clawforge-desired.dry-${randomBytes(4).toString("hex")}.json` : stagedName;
}

export async function applyConfig(ctx: Context, args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  for (const arg of args) {
    if (arg !== "--dry-run" && arg !== "--break-lock") die(`unknown argument: ${arg}`);
  }

  // A dry run writes nothing, so it needs no lock — and taking one would make an inspection
  // of a busy instance fail for no reason.
  if (dryRun) return writeDesiredState(ctx, true);
  return guarded(ctx, "apply-config", args, () => writeDesiredState(ctx, false));
}

async function writeDesiredState(ctx: Context, dryRun: boolean): Promise<void> {

  let payload: string;
  try {
    payload = await readFile(desiredStateFile(), "utf8");
  } catch {
    die(`${desiredStateFile()} not found`);
  }

  // Fail here rather than inside the container with a less helpful message.
  try {
    JSON.parse(payload);
  } catch (error) {
    die(`${desiredStateFile()} is not valid JSON: ${(error as Error).message}`);
  }

  const fileName = stagedFileName(dryRun);
  const stagedOnTarget = `${ctx.settings.dataDir}/config/${fileName}`;
  log(`staging ${fileName} on the target`);
  await ctx.transport.writeFile(stagedOnTarget, payload);

  // The path the CLI sees is the container's, not the target's — asked of the bridge
  // rather than written out by hand.
  const stagedInContainer = ctx.paths.toContainer(stagedOnTarget);

  const runArgs = ["config", "set", "--batch-file", stagedInContainer];
  if (dryRun) runArgs.push("--dry-run");

  log(dryRun ? "applying desired state (dry run)" : "applying desired state");
  try {
    await ctx.runtime.runOneOff("gateway", ["dist/index.js", ...runArgs], {
      noDeps: true,
      entrypoint: "node",
    });
  } finally {
    // Its own file, so its own clean-up — and in a finally, because the run that leaves one
    // behind is the one that failed. Cleaning up only on success meant every rejected
    // payload left an clawforge-desired.dry-<hex>.json in the config directory, which then
    // travelled into an archive and got the snapshot refused by the share allow-list: the
    // same failure the operation journal caused, arriving by a different route.
    if (dryRun) await ctx.transport.remove(stagedOnTarget);
  }

  if (dryRun) {
    log("dry run only — nothing was written");
  } else {
    // Deliberately not ./clawforge up: a healthy container is already what `up` converges on, so
    // it would report success and leave the old settings live.
    log("desired state applied — restart to pick it up: ./clawforge restart");
    info(`source: ${desiredStateFile()}`);
  }
}
