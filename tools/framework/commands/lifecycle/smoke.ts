// `./clawforge smoke` — acceptance run for an instance.
//
// which was the "behaviour does not change" boundary for the
// TypeScript migration. It checks the properties that actually cost debugging time:
//   - the gateway is healthy by BOTH criteria (HTTP probe and the runtime's own verdict),
//     because their disagreement is what uncovered a broken healthcheck
//   - the agent answers end to end, i.e. the provider key really resolved
//   - the declaration in the repository wins over manual drift
//   - a full backup restores byte-for-byte (into an isolated root, never over the live data)
//   - the verifier accepts a shareable archive AND rejects one with secrets
//   - the MCP bridge speaks JSON-RPC on a clean stdout
//
// The two negative checks matter most: a suite that only confirms success degrades
// silently.
//
// The round-trip check is the heaviest one: it takes a FULL backup with the gateway held
// down and restores it into an isolated scratch root beside the data directory, proving
// the archive — private paths included — comes back byte-identical, without ever writing
// over the live data. It runs the whole backup -> restore transaction under one outer
// instance lock, and whatever happens, the gateway is left in the state the check found it
// in — see the check's own comment for why. --quick exists because of this one check.
//
// Every check lands on the shared check-outcome vocabulary (commands/check-outcome.ts):
// passed, failed, not-checked (this deployment makes the check inapplicable) or
// could-not-check (the check could not obtain a verdict). The last never reads as passing
// and fails the run exactly as a failed check does: a suite that could not ask its
// question has not earned a green light.

import { randomBytes } from "node:crypto";
import { basename, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import JSON5 from "json5";
import { log, info, warn, die, UserError } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { CouldNotCheck, NotChecked } from "../check-outcome.ts";
import type { CheckOutcome } from "../check-outcome.ts";
import { createBackup } from "./backup.ts";
import { pull } from "./state.ts";
import { restoreArchive } from "./restore.ts";
import { verifySnapshot } from "./verify.ts";
import { applyConfig } from "../orchestration/config.ts";
import { desiredStateFile } from "#src/runtime/deployment.ts";
import { dataDirName, dataDirParent } from "#src/service/archive.ts";
import { installedRecipePrivatePaths } from "#src/service/recipe.ts";
import { runMaybePrivileged, sudoFor } from "#src/runtime/datadir.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { valueAt } from "../orchestration/inspect/helpers.ts";

export interface Check {
  readonly name: string;
  readonly run: (ctx: Context) => Promise<void>;
}

/** Throws with a readable message when the condition does not hold. */
function expect(condition: boolean, detail: string): void {
  if (!condition) throw new Error(detail);
}

/** Runs one of the calls a check makes to reach the instance. A throw from these is not a
 *  verdict about the deployment — Docker, the transport or the container itself did not
 *  answer, so the property under check was never evaluated. That is could-not-check's
 *  meaning, and before this wrapper such a failure could only land as a lie: FAIL (which
 *  reads as "the provider key is broken") or swallowed into a pass. Assertions made on
 *  what a call RETURNS stay outside it: those are verdicts. */
async function reach<T>(doing: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CouldNotCheck(`could not ${doing}: ${message}`);
  }
}

/** reach() for a call into a command that can refuse on its own: die() is a verdict about
 *  the deployment — a backup that refuses a symlinked data root, or a restore that rejects
 *  an archive, failed the check; it did not go unanswered. Only the transport-level
 *  failures underneath the command are could-not-check. */
async function reachVerdict<T>(doing: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof UserError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CouldNotCheck(`could not ${doing}: ${message}`);
  }
}

/** Hashes a file or tree as a normalized tar stream on the target. Output remains a digest,
 *  so private bytes never cross the transport or enter an error message. */
async function sha256Of(ctx: Context, path: string): Promise<string> {
  const prefix = await sudoFor(ctx, path);
  const parent = dirname(path);
  const name = basename(path);
  const script = "set -o pipefail; tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu -cf - -C \"$1\" -- \"$2\" | sha256sum";
  const [head, ...rest] = [...prefix, "bash", "-o", "pipefail", "-c", script, "bash", parent, name];
  const result = await reach(`read ${path}`, () => ctx.transport.exec(head, rest));
  if (result.code !== 0) {
    throw new CouldNotCheck(`could not hash ${path}: ${result.stderr.trim() || `tar exited ${result.code}`}`);
  }
  const digest = /^([a-f\d]{64})\s/.exec(result.stdout)?.[1];
  if (digest === undefined) throw new CouldNotCheck(`could not hash ${path}: target returned no sha256 digest`);
  return digest;
}

export const checks: Check[] = [
  {
    name: "gateway answers all HTTP probes",
    run: async (ctx) => {
      for (const endpoint of ["healthz", "startupz", "readyz"]) {
        const code = await reach(`probe ${endpoint}`, () => ctx.runtime.probe(endpoint));
        expect(code === 200, `${endpoint} returned ${code}`);
      }
    },
  },
  {
    name: "runtime reports the container healthy",
    run: async (ctx) => {
      const health = await reach("ask the runtime for container health", () => ctx.runtime.health());
      expect(health === "healthy", `container health is "${health}"`);
    },
  },
  {
    name: "agent answers end to end",
    run: async (ctx) => {
      const result = await reach("ask the agent", () =>
        ctx.runtime.runOneOff("cli", ["agent", "--agent", "main", "-m", "Reply with exactly: SMOKE-OK"], {
          profile: "cli",
          input: "",
        }),
      );
      expect(result.stdout.includes("SMOKE-OK"), `agent replied: ${result.stdout.trim().slice(0, 120)}`);
    },
  },
  {
    name: "desired state overrides manual drift",
    run: async (ctx) => {
      const declared = JSON.parse(await readFile(desiredStateFile(), "utf8")) as {
        path: string;
        value?: unknown;
      }[];

      // Any declared string setting will do, and which one is the deployment's business —
      // this used to insist on agents.defaults.model.primary, which the template for a new
      // deployment does not contain. gateway.* is left alone: drifting it takes the service
      // down for as long as the check runs.
      const subject = declared.find(
        (entry) => typeof entry.value === "string" && !entry.path.startsWith("gateway."),
      );
      if (subject === undefined) {
        throw new NotChecked("desired-state.json declares no drift-safe string setting");
      }

      const wanted = subject.value as string;
      const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;

      try {
        await reach("drift the setting on the instance", () =>
          ctx.runtime.runOneOff(
            "gateway",
            ["dist/index.js", "config", "set", subject.path, JSON.stringify(`${wanted}-drifted`), "--strict-json"],
            { noDeps: true, entrypoint: "node", input: "" },
          ),
        );
        await reach("apply the declaration", () => applyConfig(ctx, []));

        // JSON5, not JSON: the live config is OpenClaw's own JSON5 gateway format.
        const config = JSON5.parse(await reach("read the live configuration", () => ctx.transport.readFile(configPath))) as Record<string, unknown>;
        const actual = valueAt(config, subject.path);
        expect(actual === wanted, `${subject.path} is ${String(actual)}, expected ${wanted}`);
      } finally {
        // Whatever happened, the declaration is what the instance should be left with. The
        // verdict is already in by the time this runs, so a failure here stays a plain
        // failure — reach() must not re-label it as a verdict the check never got. But it
        // must say more than the raw error: this call is what un-drifts the setting, so
        // when it fails the reader needs what the instance may still hold and the repair,
        // not just the symptom.
        await applyConfig(ctx, []).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`restoring the declaration failed — ${subject.path} may still hold the drifted value; repair with ./clawforge apply-config: ${message}`);
        });
      }
    },
  },
  {
    name: "verifier rejects an archive with secrets",
    run: async (ctx) => {
      const archive = await reach("take a backup to verify", () => createBackup(ctx, { profile: "full" }));
      const passed = await verifySnapshot(ctx, archive, "share");
      expect(!passed, "the verifier accepted an archive containing credentials");
    },
  },
  {
    name: "verifier accepts a share snapshot",
    run: async (ctx) => {
      try {
        await pull(ctx, ["--share"]);
      } catch (error) {
        // pull's own die() IS the verdict — a rejected snapshot is a failed check, not an
        // unreachable instance. Anything else never got far enough to judge anything.
        if (error instanceof UserError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new CouldNotCheck(`could not take a share snapshot: ${message}`);
      }
    },
  },
  {
    name: "MCP bridge speaks JSON-RPC",
    run: async (ctx) => {
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
      });
      const result = await reach("speak JSON-RPC to the bridge", () =>
        ctx.runtime.runOneOff("cli", ["mcp", "serve"], {
          profile: "cli",
          input: `${request}\n`,
        }),
      );
      expect(result.stdout.includes('"serverInfo"'), `bridge replied: ${result.stdout.trim().slice(0, 120)}`);
    },
  },
  {
    // Disaster-recovery test in the only shape a smoke run may take: it takes a FULL backup
    // with the gateway held down and restores it into an isolated scratch root beside the
    // data directory, then compares private paths as normalized archive streams. It never
    // writes a witness into the live data root: that used to be a migrate-profile snapshot
    // pushed straight back over the working tree, which
    // dropped every privatePath on the floor while still reporting success (audit
    // 2026-09-23, XA round 6, P1-01). A live overwrite-and-restore drill, if anyone wants
    // one, is an explicit, separately confirmed operation — not a side effect of `smoke`.
    //
    // The whole thing runs under a single outer instance lock (guarded() below) that
    // createBackup() then finds already held on its own async chain and treats as a no-op —
    // see withLockUnlessHeld() in runtime/instance-lock.ts. Without that outer lock, the
    // backup would take and release the lock on its own, and another framework run could
    // slip into the gap while the gateway is held down.
    //
    // The gateway is paused for the consistent snapshot and, with leaveStopped, only comes
    // back at the very end of the transaction: roundTripCheck records the initial
    // running/stopped state before touching anything and restores exactly that state on
    // every exit path, folding any compensation failure into the reported error instead of
    // swallowing either (audit 2026-09-23, XA round 6, P2-06).
    //
    // The full backup itself stays behind and follows the usual retention.
    name: "snapshot round-trip is byte-identical",
    run: async (ctx) => {
      await guarded(ctx, "smoke round-trip", [], () => roundTripCheck(ctx));
    },
  },
];

async function roundTripCheck(ctx: Context): Promise<void> {
  // P2-06: the initial service state is read before anything is touched. This read cannot
  // be compensated if it fails — but it is also the only thing that happens before the
  // first mutation, so a failure here aborts the check with the instance exactly as it
  // was found.
  const initialRunning = await reach("ask whether the gateway is running", () => ctx.runtime.isRunning());

  const dataDir = ctx.settings.dataDir;
  // The scratch root keeps the data directory's own basename — restore refuses an archive
  // whose root does not match the data directory's name — under a scratch parent of its own.
  const scratch = `${dataDirParent(dataDir)}/.clawforge-smoke-roundtrip-${randomBytes(4).toString("hex")}`;
  const restored = `${scratch}/${dataDirName(dataDir)}`;
  // The restore must not reach the live gateway: restoreArchive stops "the" runtime before
  // unpacking, but the scratch root has no compose project behind it. Everything else the
  // restore asks of the runtime (the recipe stacks' state) passes through to the real one —
  // bound to it, so private state keeps working — and the live service state belongs to
  // this transaction's compensation alone (P2-06).
  const isolated: Context = {
    ...ctx,
    settings: { ...ctx.settings, dataDir: restored },
    runtime: new Proxy(ctx.runtime, {
      get(target, property) {
        if (property === "stop") return async () => {};
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  } as unknown as Context;

  let bodyError: unknown;

  try {
    // The live config is always the read-only witness; private paths add coverage when
    // declared. Tar keeps byte streams on the target and supports files and directories.
    const witnesses = new Map<string, string>();
    const paths = new Set(["config/openclaw.json", ...await installedRecipePrivatePaths()]);
    for (const relative of paths) {
      const live = `${dataDir}/${relative}`;
      if (!(await reach(`look for ${relative}`, () => ctx.transport.exists(live)))) {
        if (relative === "config/openclaw.json") throw new CouldNotCheck("required smoke witness config/openclaw.json is missing");
        continue;
      }
      witnesses.set(relative, await sha256Of(ctx, live));
    }

    // FULL, not migrate: full is the only profile that keeps privatePaths, identity and
    // keys — the only restore that is a round trip.
    const archive = await reachVerdict("take the full backup", () =>
      createBackup(ctx, { profile: "full", leaveStopped: true }),
    );

    await reachVerdict("restore the backup into the isolated root", () =>
      restoreArchive(isolated, archive, { force: true, noStart: true }),
    );

    for (const [relative, digest] of witnesses) {
      const copy = `${restored}/${relative}`;
      expect(
        await reach(`look for ${relative} in the isolated root`, () => ctx.transport.exists(copy)),
        `the restore lost the smoke witness ${relative}`,
      );
      expect((await sha256Of(ctx, copy)) === digest, `the restore changed the smoke witness ${relative}`);
    }
  } catch (error) {
    bodyError = error;
  }

  // Compensation, on every exit path (P2-06): the scratch root is this check's own litter;
  // the gateway goes back to the state the check found it in.
  const compensationErrors: unknown[] = [];

  try {
    await runMaybePrivileged(ctx, scratch, "rm", ["-rf", scratch]);
  } catch (cleanupError) {
    compensationErrors.push(cleanupError);
  }

  if (initialRunning) {
    try {
      await ctx.runtime.start();
      await ctx.runtime.waitForHealth();
    } catch (startError) {
      compensationErrors.push(startError);
    }
  }
  // else: nothing between reading initialRunning and here can have started the gateway —
  // the backup only ever pauses it, and the restore runs with noStart against the no-op
  // runtime — so "stopped" already is the initial state.

  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  if (bodyError !== undefined) {
    // Whatever broke the round trip is the headline; a compensation that also failed is
    // folded in, never swallowed — and never allowed to replace the body error either.
    if (compensationErrors.length === 0) throw bodyError;
    throw new AggregateError(
      [bodyError, ...compensationErrors],
      `the round-trip check failed and its cleanup also failed: ${describe(bodyError)}; ${compensationErrors.map(describe).join("; ")}`,
    );
  }
  if (compensationErrors.length > 0) {
    throw new AggregateError(
      compensationErrors,
      `the round-trip check passed but its cleanup failed: ${compensationErrors.map(describe).join("; ")}`,
    );
  }
}

export interface SmokeResult {
  readonly name: string;
  readonly status: CheckOutcome;
  readonly detail?: string;
}

export interface SmokeSummary {
  readonly results: SmokeResult[];
  readonly passed: number;
  readonly failed: number;
  readonly notChecked: number;
  readonly couldNotCheck: number;
}

function printResult(result: SmokeResult): void {
  const line = `${result.status.toUpperCase().padEnd(7)} ${result.name}${result.detail === undefined ? "" : `  ${result.detail}`}`;
  if (result.status === "failed") warn(line);
  else info(line);
}

/** Runs the checks, classifying every outcome into the shared vocabulary. Never throws:
 *  the counts are the answer. A throw a check did not classify itself stays a failure —
 *  the reading it has always had. */
export async function runChecks(ctx: Context, selected: Check[], onResult: (result: SmokeResult) => void = printResult): Promise<SmokeSummary> {
  const results: SmokeResult[] = [];
  const counts = { passed: 0, failed: 0, notChecked: 0, couldNotCheck: 0 };

  for (const check of selected) {
    let result: SmokeResult;
    try {
      await check.run(ctx);
      result = { name: check.name, status: "passed" };
      counts.passed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NotChecked) {
        result = { name: check.name, status: "not-checked", detail: message };
        counts.notChecked += 1;
      } else if (error instanceof CouldNotCheck) {
        result = { name: check.name, status: "could-not-check", detail: message };
        counts.couldNotCheck += 1;
      } else {
        result = { name: check.name, status: "failed", detail: message };
        counts.failed += 1;
      }
    }
    results.push(result);
    onResult(result);
  }

  return { results, ...counts };
}

/** Prints what the run concluded, and refuses to call a run with an unanswered check
 *  successful: could-not-check fails the run exactly as a failed check does. */
export function report(summary: SmokeSummary, quick: boolean): void {
  if (quick) info("skipping the round-trip (--quick)");

  const unanswered = summary.results.filter((result) => result.status === "failed" || result.status === "could-not-check");
  if (unanswered.length > 0) {
    throw new Error(
      `${unanswered.length} smoke check(s) did not pass (${summary.failed} failed, ${summary.couldNotCheck} could not be checked): ${unanswered.map((result) => result.name).join(", ")}`,
    );
  }
  log(`all ${summary.passed} checks passed${summary.notChecked > 0 ? `, ${summary.notChecked} not checked` : ""}`);
}

export async function smoke(ctx: Context, args: string[]): Promise<void> {
  const quick = args.includes("--quick");
  for (const arg of args) {
    if (arg !== "--quick") die(`unknown argument: ${arg}`);
  }
  const selected = quick ? checks.filter((check) => !check.name.includes("round-trip")) : checks;

  log(`smoke run against ${ctx.settings.serviceUrl}`);

  report(await runChecks(ctx, selected), quick);
}
