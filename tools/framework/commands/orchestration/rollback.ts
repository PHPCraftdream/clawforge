// `./clawforge rollback` — put back the configuration an operation replaced.
//
// NOT `./clawforge restore`, and the distinction is the point rather than a detail. restore
// replaces the whole data directory from a snapshot: the configuration, but also every
// workspace, every agent's memory, every transcript — everything written since that
// snapshot is gone. It is the right tool when the data is what went wrong.
//
// What `apply` can break is the configuration, and only that. Undoing it should not cost an
// agent a week of accumulated notes. So the copy taken before a run is one file, and this
// command puts back one file, and the two operations stay separate on purpose.
//
// It restarts afterwards, because a configuration the instance has not read is not in force
// — the same reason `apply` plans a restart after `apply-config`.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, die } from "../../core/log.ts";
import { emit, isCaptured } from "../../core/output.ts";
import { deploymentName, deploymentDir } from "../../runtime/deployment.ts";
import { Journal, readOperation, latestRollbackable } from "../../service/operations.ts";
import { restart } from "../lifecycle/lifecycle.ts";
import { takeLock } from "../../runtime/instance-lock.ts";
import { readInstalledSet, withUnpackedArtifact } from "../../set/artifacts/install.ts";
import { apply } from "./apply.ts";
import type { OperationRecord } from "../../service/operations.ts";
import type { Context } from "../../core/context.ts";

/** The operation to undo, and why that one. Exported for the checks: choosing the wrong
 *  operation is the failure that matters here, and it is worth asserting without a target. */
export async function operationToRollback(ctx: Context, wanted?: string): Promise<OperationRecord> {
  if (wanted !== undefined) {
    const record = await readOperation(ctx, wanted);
    if (record === undefined) die(`no operation "${wanted}" was recorded — ./clawforge operations lists what there is`);
    if (record.configSnapshot === undefined) {
      die(
        `operation "${wanted}" took no configuration snapshot, so there is nothing to put back.\n` +
          "Only runs that were about to change the configuration take one.",
      );
    }
    return record;
  }

  const latest = await latestRollbackable(ctx);
  if (latest === undefined) {
    die(
      "no operation with a configuration snapshot has been recorded, so there is nothing to roll back to.\n" +
        "If it is the instance's DATA you need back, that is a different operation: ./clawforge push (from a snapshot).",
    );
  }
  return latest;
}

/** `./clawforge rollback --set` — reinstall the set that was in force before the current one, through
 *  the exact same path `./clawforge apply --set <artifact>` already uses.
 *
 *  Sets are immutable, content-addressed artifacts kept in the deployment's own sets/
 *  directory, so going back to one is a reinstall, not a new mechanism — what had to be
 *  built was knowing which one, and keeping its artifact reachable. What this does NOT do is
 *  the single-file path above's job: an agent's own memory, and anything else written to the
 *  data directory since, is state, not configuration, and reinstalling an older set neither
 *  touches it nor is allowed to. Wanting that gone too is a separate, more destructive step —
 *  a data restore (./clawforge push), never implied by a rollback. */
async function rollbackSet(ctx: Context, args: string[]): Promise<void> {
  const installed = await readInstalledSet(ctx);
  if (installed?.previous === undefined) {
    die(
      "no previous set is recorded on this instance — rollback --set only knows what apply --set " +
        "installed here before the one currently in force, and there is none on record (or this instance " +
        "was never installed from a set at all)",
    );
  }
  const previous = installed.previous;

  const artifact = resolve(deploymentDir(), "sets", `${previous.name}-${previous.id}.tar.gz`);
  await access(artifact).catch(() => {
    die(
      `the artifact for the previous set is gone — expected ${artifact}.\n` +
        `Set "${previous.name}" (${previous.id}), installed ${previous.installedAt}, cannot be reinstalled without it. ` +
        "Rebuild it if the source that produced it is still available: ./clawforge set build.",
    );
  });

  // Said before anything runs, not folded into apply's own report afterwards: which parts
  // move together and which do not is the one thing a coder must know before agreeing to this.
  log(`rolling back from set "${installed.name}" (${installed.id}) to "${previous.name}" (${previous.id})`);
  info("reversed together: prompts, MCP server registrations, schedules, gateway settings — everything the set declares");
  info("left alone: an agent's own memory, and anything else written to the data directory since — this is a set install, not a data restore");

  // Reinstalling the previous set below only ever SETS the paths ITS OWN desired-state.json
  // declares — apply-config is a batch config set, never an unset, and CONFIG_DRIFT is only
  // ever computed over declared paths. A setting the CURRENT set added that the previous one
  // never declared (agents.defaults.thinkingDefault, say) is invisible to both and survives
  // untouched. The apply that installed the current set already took a full snapshot of the
  // live config before its first mutating step (every apply does, via snapshotConfig) — the
  // same mechanism the single-file rollback path above restores from. Putting that back first
  // undoes exactly what that apply changed, additions included, before the previous set's own
  // declaration is reapplied on top. latestRollbackable is the newest operation with such a
  // snapshot — in the ordinary case (nothing else applied since) that is exactly the apply
  // that installed the current set, the same default the single-file path already uses when
  // not told which operation to undo.
  const priorApply = await latestRollbackable(ctx);
  if (priorApply?.configSnapshot !== undefined && (await ctx.transport.exists(priorApply.configSnapshot))) {
    const configJournal = await Journal.open(ctx, "rollback", deploymentName());
    const configHeld = await takeLock(ctx, `rollback of ${priorApply.id}`, configJournal.id, { breakLock: args.includes("--break-lock") });
    try {
      const live = `${ctx.settings.dataDir}/config/openclaw.json`;
      log(`putting back the configuration from before ${priorApply.id}, so nothing the current set added is left behind`);
      await ctx.transport.writeFile(live, await ctx.transport.readFile(priorApply.configSnapshot));
      await configJournal.step("restore-config", "done", `from ${priorApply.configSnapshot}`);
      // No restart here: the reinstall below runs its own plan against this now-stale-on-disk
      // config, which detects RESTART_REQUIRED (config mtime after the container's own start)
      // the same way any other unrestarted write would, and restarts once as part of it.
      await configJournal.close("succeeded", `restored the configuration from before ${priorApply.id} as part of rollback --set`);
    } finally {
      await configHeld.release();
    }
  }

  await withUnpackedArtifact(artifact, async (_staging, verified) => {
    if (verified.id !== previous.id) die("the rollback artifact does not match the recorded previous set");
    await apply(ctx, [...args, "--set", artifact]);
  });
}

export async function rollback(ctx: Context, args: string[]): Promise<void> {
  if (args.includes("--set")) {
    if (args.includes("--operation") || args.includes("--no-restart")) {
      die("--set rolls back the whole set through ./clawforge apply — --operation and --no-restart belong to the single-file path only");
    }
    return rollbackSet(ctx, args.filter((arg) => arg !== "--set"));
  }

  const jsonOnly = args.includes("--json");
  const breakLock = args.includes("--break-lock");
  let wanted: string | undefined;
  let restartAfter = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json" || arg === "--break-lock") continue;
    if (arg === "--no-restart") {
      restartAfter = false;
      continue;
    }
    if (arg === "--operation") {
      wanted = args[index + 1] ?? die("--operation needs an operation id");
      index += 1;
      continue;
    }
    die(`unknown argument: ${arg}`);
  }

  const target = await operationToRollback(ctx, wanted);
  const snapshot = target.configSnapshot!;

  if (!(await ctx.transport.exists(snapshot))) {
    die(`the snapshot for operation "${target.id}" is gone (${snapshot}) — nothing to put back`);
  }

  // Recorded like any other mutating run: rolling back is itself a change to the instance,
  // and the next person asking "what happened here" should see it.
  const journal = await Journal.open(ctx, "rollback", deploymentName());
  const live = `${ctx.settings.dataDir}/config/openclaw.json`;

  const held = await takeLock(ctx, `rollback of ${target.id}`, journal.id, { breakLock });
  try {
    log(`putting back the configuration from before ${target.id}`);
    await ctx.transport.writeFile(live, await ctx.transport.readFile(snapshot));
    await journal.step("restore-config", "done", `from ${snapshot}`);

    if (restartAfter) {
      // A configuration the instance has not read is not in force.
      await restart(ctx, []);
      await journal.step("restart", "done");
    } else {
      await journal.step("restart", "skipped", "--no-restart: the instance is still running the configuration this replaced");
    }

    await journal.close("succeeded", `rolled back ${target.id}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await journal.step("rollback", "failed", detail);
    await journal.close("failed", detail);
    throw error;
  } finally {
    // Released whatever happened: a failed rollback that kept the lock would block the very
    // command someone runs next to fix it.
    await held.release();
  }

  const answer = {
    deployment: deploymentName(),
    operationId: journal.id,
    changed: true,
    rolledBack: target.id,
    restored: snapshot,
    restarted: restartAfter,
  };

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(answer, null, 2)}\n`);
    return;
  }

  log(`rolled back ${target.id}`);
  info(`configuration restored from ${snapshot}`);
  if (!restartAfter) info("not restarted (--no-restart): the instance is still running what this replaced");
  info(`this rollback is itself recorded: ./clawforge operations ${journal.id}`);
}
