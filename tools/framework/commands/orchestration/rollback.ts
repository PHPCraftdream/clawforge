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
import { Journal, readOperation, latestRollbackable, newOperationId } from "../../service/operations.ts";
import { restart } from "../lifecycle/lifecycle.ts";
import { takeLock } from "../../runtime/instance-lock.ts";
import { readInstalledSet, withUnpackedArtifact, requirementProblems } from "../../set/artifacts/install.ts";
import { frameworkVersion } from "../management/lock.ts";
import { apply, runningImageDigest } from "./apply.ts";
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

  // Verified BEFORE anything is touched — a corrupt archive, or one that does not actually
  // match the recorded previous set, must be refused before the live configuration is
  // written, not discovered afterward with the config already changed and the installed
  // marker still naming the set this was trying to leave.
  await withUnpackedArtifact(artifact, async (_staging, verified) => {
    if (verified.id !== previous.id) die("the rollback artifact does not match the recorded previous set");

    // Runtime/framework compatibility, checked here too — not left to the nested apply()
    // call below, which only runs AFTER the config-snapshot restore has already written to
    // the live config. A refusal inside that nested call would leave openclaw.json holding
    // the previous set's config while the installed marker still names the current one: an
    // inconsistent state this framework has spent its rounds removing. Same check apply
    // --set's own pre-check runs, reused rather than duplicated.
    const runtimeIssues = requirementProblems(verified.manifest, {
      framework: await frameworkVersion(),
      imageDigest: await runningImageDigest(ctx, verified.manifest),
    });
    if (runtimeIssues.length > 0) {
      die(
        `the previous set cannot be reinstalled here:\n${runtimeIssues.map((entry) => `  ${entry.detail}`).join("\n")}\n` +
          "Point this deployment's OPENCLAW_IMAGE at the required digest (or update the framework) before rolling back.",
      );
    }

    // Said before anything runs, not folded into apply's own report afterwards: which parts
    // move together and which do not is the one thing a coder must know before agreeing to this.
    log(`rolling back from set "${installed.name}" (${installed.id}) to "${previous.name}" (${previous.id})`);
    info("reversed together: prompts, MCP server registrations, schedules, gateway settings — everything the set declares");
    info("left alone: an agent's own memory, and anything else written to the data directory since — this is a set install, not a data restore");

    // One lock for the whole rollback: putting the configuration back and reinstalling the
    // previous set are one operation, not two separately-locked ones — a gap between them is
    // exactly the window another operation could mutate the instance in, between "config put
    // back" and "recipes/agents/MCP reconciled to match it". apply --set's own lock-taking
    // (apply.ts) is nesting-safe the same way provision-agent's already is: it skips
    // acquiring when this outer one is already held.
    const operationId = newOperationId("rollback");
    const held = await takeLock(ctx, `rollback --set to ${previous.id}`, operationId, { breakLock: args.includes("--break-lock") });
    try {
      const journal = await Journal.open(ctx, "rollback", deploymentName(), operationId);
      try {
        // The EXACT operation that installed the set currently in force — its own
        // configSnapshot is the configuration exactly as the previous set left it, before
        // that apply's config step ever ran. latestRollbackable() (the newest operation with
        // ANY snapshot) is the wrong thing here: an ordinary apply run after the current set
        // was installed takes its own snapshot too, and restoring that one would restore to a
        // config that already includes whatever the current set added — installed.operationId
        // names the one apply that actually matters, regardless of what ran since.
        const installingOperation = installed.operationId === undefined
          ? undefined
          : await readOperation(ctx, installed.operationId);
        if (installingOperation?.configSnapshot !== undefined && (await ctx.transport.exists(installingOperation.configSnapshot))) {
          const live = `${ctx.settings.dataDir}/config/openclaw.json`;
          log(`putting back the configuration from before ${installingOperation.id}, so nothing the current set added is left behind`);
          await ctx.transport.writeFile(live, await ctx.transport.readFile(installingOperation.configSnapshot));
          await journal.step("restore-config", "done", `from ${installingOperation.configSnapshot}`);
        } else {
          await journal.step("restore-config", "skipped", "no recorded snapshot for the operation that installed the current set");
        }

        // Reinstalls recipes/agents/MCP/cron and reapplies the previous set's own declared
        // config on top — a no-op for anything the restore above already put back correctly,
        // a real fix for anything that had drifted independently of the set boundary.
        await apply(ctx, [...args, "--set", artifact]);
        await journal.close("succeeded", `rolled back to "${previous.name}" (${previous.id})`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await journal.close("failed", detail);
        throw error;
      }
    } finally {
      await held.release();
    }
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
