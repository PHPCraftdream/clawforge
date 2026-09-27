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
// The round-trip check is the heaviest: a FULL backup with the gateway held down, restored
// into an isolated scratch root beside the data directory (never over live data) and compared
// byte for byte, private paths included. --quick exists because of it.
//
// It and the two verifier checks each need an archive taken with the gateway down. Run alone
// (as the tests do) each manages its own stop/start; run together by smoke() they used to cost
// three outages, ~70s (UX-14). Only taking an archive needs the window, so runArchiveChecks()
// pauses once, takes both archives independently, restarts, then verifies and restore-diffs
// with the gateway back up.
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
import { collectConfiguredProviders } from "#src/service/secrets.ts";
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

// Archive-check names, one spelling shared with runArchiveChecks()/runSmokeSuite().
const REJECTS_SECRETS_CHECK = "verifier rejects an archive with secrets";
const ACCEPTS_SHARE_CHECK = "verifier accepts a share snapshot";
const ROUND_TRIP_CHECK = "snapshot round-trip is byte-identical";
const ARCHIVE_CHECK_NAMES: ReadonlySet<string> = new Set([REJECTS_SECRETS_CHECK, ACCEPTS_SHARE_CHECK, ROUND_TRIP_CHECK]);

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
      if (result.stdout.includes("SMOKE-OK")) return;

      // A silent agent is most often PROVIDER_MISSING (UX-09): read the same live config
      // inspect does (collectConfiguredProviders), and name that cause instead of just the
      // symptom, when it applies. Best effort — an unreadable or unparseable config here
      // must not replace the check's own real failure with a different, unrelated one.
      let noProvider = false;
      try {
        const config = JSON5.parse(await ctx.transport.readFile(`${ctx.settings.dataDir}/config/openclaw.json`)) as unknown;
        noProvider = collectConfiguredProviders(config).length === 0;
      } catch {
        // Stays the plain symptom below.
      }
      expect(
        false,
        noProvider
          ? `no model provider is configured — run ./clawforge configure-provider (agent replied: ${result.stdout.trim().slice(0, 120)})`
          : `agent replied: ${result.stdout.trim().slice(0, 120)}`,
      );
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
    name: REJECTS_SECRETS_CHECK,
    run: async (ctx) => {
      const archive = await reach("take a backup to verify", () => createBackup(ctx, { profile: "full" }));
      const passed = await verifySnapshot(ctx, archive, "share");
      expect(!passed, "the verifier accepted an archive containing credentials");
    },
  },
  {
    name: ACCEPTS_SHARE_CHECK,
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
    // Self-contained on purpose: called directly (as the tests beside this file do), it
    // manages its own single stop/start cycle. Called together with its two sibling
    // archive-based checks through the real `smoke` command, runArchiveChecks() (below,
    // near runSmokeSuite()) runs the offline half of this same check — roundTripUsingArchive
    // — against an archive the shared window already took, so the whole trio costs one
    // outage instead of three (UX-14).
    name: ROUND_TRIP_CHECK,
    run: async (ctx) => {
      // `smoke` itself declares no --break-lock (only --quick): a refusal from this internal
      // step must not offer a flag the command has nowhere to read it from (UX-04).
      await guarded(ctx, "smoke round-trip", [], () => roundTripCheck(ctx), { breakLockSupported: false });
    },
  },
];

/** Hashes the live witnesses a round-trip restore must reproduce byte-for-byte: the
 *  required config file, plus whatever private paths are declared. Read on the LIVE data
 *  directory, so what gets hashed is what the archive about to be taken will actually
 *  contain — every caller below reads this before the archive that has to match it. */
async function collectRoundTripWitnesses(ctx: Context): Promise<Map<string, string>> {
  const dataDir = ctx.settings.dataDir;
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
  return witnesses;
}

interface RoundTripScratch {
  readonly scratch: string;
  readonly restored: string;
  readonly isolated: Context;
}

/** The scratch root keeps the data directory's own basename — restore refuses an archive
 *  whose root does not match the data directory's name — under a scratch parent of its own.
 *  The restore must not reach the live gateway: restoreArchive stops "the" runtime before
 *  unpacking, but the scratch root has no compose project behind it. Everything else the
 *  restore asks of the runtime (the recipe stacks' state) passes through to the real one —
 *  bound to it, so private state keeps working — and the live service state is the caller's
 *  own compensation to manage, not this function's. */
function roundTripScratch(ctx: Context): RoundTripScratch {
  const dataDir = ctx.settings.dataDir;
  const scratch = `${dataDirParent(dataDir)}/.clawforge-smoke-roundtrip-${randomBytes(4).toString("hex")}`;
  const restored = `${scratch}/${dataDirName(dataDir)}`;
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
  return { scratch, restored, isolated };
}

/** Confirms every witness in `witnesses` came back byte-identical under the isolated root
 *  `restored`. */
async function compareRestoredWitnesses(ctx: Context, restored: string, witnesses: Map<string, string>): Promise<void> {
  for (const [relative, digest] of witnesses) {
    const copy = `${restored}/${relative}`;
    expect(await reach(`look for ${relative} in the isolated root`, () => ctx.transport.exists(copy)), `the restore lost the smoke witness ${relative}`);
    expect((await sha256Of(ctx, copy)) === digest, `the restore changed the smoke witness ${relative}`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Folds compensation failures into whatever the body already decided: never swallowed — a
 *  compensation error always surfaces — and never allowed to replace the body's own verdict
 *  either (P2-06). Shared by the round-trip check's standalone and offline-consolidated
 *  shapes below, since both owe the same discipline to their own scratch-root cleanup. */
function settleWithCompensation(bodyError: unknown, compensationErrors: unknown[]): void {
  if (bodyError !== undefined) {
    if (compensationErrors.length === 0) throw bodyError;
    throw new AggregateError(
      [bodyError, ...compensationErrors],
      `the round-trip check failed and its cleanup also failed: ${describeError(bodyError)}; ${compensationErrors.map(describeError).join("; ")}`,
    );
  }
  if (compensationErrors.length > 0) {
    throw new AggregateError(compensationErrors, `the round-trip check passed but its cleanup failed: ${compensationErrors.map(describeError).join("; ")}`);
  }
}

/** The round-trip check's standalone shape: reads the gateway's own starting state,
 *  collects the witnesses, pauses (via createBackup's own leaveStopped-aware pause) to take
 *  the full backup, restores into an isolated root and compares, then always restarts to the
 *  state it found the gateway in (P2-06) — its own single stop/start cycle, unrelated to any
 *  other check. This is what `checks` above runs, and what the tests beside this file call
 *  directly. */
async function roundTripCheck(ctx: Context): Promise<void> {
  // P2-06: the initial service state is read before anything is touched. This read cannot
  // be compensated if it fails — but it is also the only thing that happens before the
  // first mutation, so a failure here aborts the check with the instance exactly as it
  // was found.
  const initialRunning = await reach("ask whether the gateway is running", () => ctx.runtime.isRunning());
  const { scratch, restored, isolated } = roundTripScratch(ctx);

  let bodyError: unknown;
  try {
    const witnesses = await collectRoundTripWitnesses(ctx);

    // FULL, not migrate: full is the only profile that keeps privatePaths, identity and
    // keys — the only restore that is a round trip.
    const archive = await reachVerdict("take the full backup", () =>
      createBackup(ctx, { profile: "full", leaveStopped: true }),
    );

    await reachVerdict("restore the backup into the isolated root", () =>
      restoreArchive(isolated, archive, { force: true, noStart: true }),
    );

    await compareRestoredWitnesses(ctx, restored, witnesses);
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

  settleWithCompensation(bodyError, compensationErrors);
}

/** The round-trip check's offline shape: everything roundTripCheck() does AFTER an archive
 *  and its witnesses already exist, and none of it touches the gateway — used by
 *  runArchiveChecks() once the shared stop/start window has already produced both. The
 *  scratch root is still this call's own litter and is still cleaned up unconditionally. */
async function roundTripUsingArchive(ctx: Context, archive: string, witnesses: Map<string, string>): Promise<void> {
  const { scratch, restored, isolated } = roundTripScratch(ctx);

  let bodyError: unknown;
  try {
    await reachVerdict("restore the backup into the isolated root", () =>
      restoreArchive(isolated, archive, { force: true, noStart: true }),
    );
    await compareRestoredWitnesses(ctx, restored, witnesses);
  } catch (error) {
    bodyError = error;
  }

  const compensationErrors: unknown[] = [];
  try {
    await runMaybePrivileged(ctx, scratch, "rm", ["-rf", scratch]);
  } catch (cleanupError) {
    compensationErrors.push(cleanupError);
  }

  settleWithCompensation(bodyError, compensationErrors);
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

/** Classifies a thrown error into the shared four-outcome vocabulary. A throw a check did
 *  not classify itself (NotChecked/CouldNotCheck) stays a failure — the reading it has
 *  always had. Shared by runChecks()'s per-check loop and runArchiveChecks()'s consolidated
 *  one, so both classify an outcome exactly the same way. */
function toResult(name: string, error: unknown): SmokeResult {
  const message = describeError(error);
  if (error instanceof NotChecked) return { name, status: "not-checked", detail: message };
  if (error instanceof CouldNotCheck) return { name, status: "could-not-check", detail: message };
  return { name, status: "failed", detail: message };
}

/** Runs one check's body and turns its outcome (return, or a throw) into a SmokeResult. */
async function evaluate(name: string, run: () => Promise<void>): Promise<SmokeResult> {
  try {
    await run();
    return { name, status: "passed" };
  } catch (error) {
    return toResult(name, error);
  }
}

function tally(counts: { passed: number; failed: number; notChecked: number; couldNotCheck: number }, result: SmokeResult): void {
  if (result.status === "passed") counts.passed += 1;
  else if (result.status === "failed") counts.failed += 1;
  else if (result.status === "not-checked") counts.notChecked += 1;
  else counts.couldNotCheck += 1;
}

/** Runs the checks, classifying every outcome into the shared vocabulary. Never throws:
 *  the counts are the answer. A throw a check did not classify itself stays a failure —
 *  the reading it has always had. */
export async function runChecks(ctx: Context, selected: Check[], onResult: (result: SmokeResult) => void = printResult): Promise<SmokeSummary> {
  const results: SmokeResult[] = [];
  const counts = { passed: 0, failed: 0, notChecked: 0, couldNotCheck: 0 };

  for (const check of selected) {
    const result = await evaluate(check.name, () => check.run(ctx));
    results.push(result);
    tally(counts, result);
    onResult(result);
  }

  return { results, ...counts };
}

/** A restart failure never hides behind a check that otherwise looked fine, and never
 *  replaces a verdict the check already reached either — the same never-swallow discipline
 *  settleWithCompensation() applies to the round-trip check's own cleanup, extended here to
 *  the whole shared window: a passed verdict downgrades to failed, anything already failed
 *  or could-not-check just gains the extra detail. */
function foldRestartFailure(result: SmokeResult, restartError: unknown): SmokeResult {
  if (restartError === undefined) return result;
  const note = `gateway restart failed after this check ran: ${describeError(restartError)}`;
  if (result.status === "passed") return { name: result.name, status: "failed", detail: note };
  return { ...result, detail: result.detail === undefined ? note : `${result.detail}; ${note}` };
}

/** UX-14: the three archive checks in ONE stop window (see the header). The full backup
 *  serves both the reject-check and the round-trip restore; it and the share snapshot are
 *  taken independently so one failing does not block the other; verification runs after the
 *  restart. The checks stay in `checks` for standalone use, each managing its own window.
 *  `wanted` is `selected`'s subset (--quick drops the round-trip): unselected = not run. */
async function runArchiveChecks(ctx: Context, wanted: ReadonlySet<string>): Promise<SmokeResult[]> {
  const wantRejects = wanted.has(REJECTS_SECRETS_CHECK);
  const wantAccepts = wanted.has(ACCEPTS_SHARE_CHECK);
  const wantRoundTrip = wanted.has(ROUND_TRIP_CHECK);
  const names = [REJECTS_SECRETS_CHECK, ACCEPTS_SHARE_CHECK, ROUND_TRIP_CHECK].filter((name) => wanted.has(name));
  if (names.length === 0) return [];

  return guarded(ctx, "smoke archives", [], async (): Promise<SmokeResult[]> => {
    let initialRunning: boolean;
    try {
      initialRunning = await reach("ask whether the gateway is running", () => ctx.runtime.isRunning());
    } catch (error) {
      // Nothing has been touched yet — the same boundary the standalone round-trip check's
      // own initial read draws (P2-06): abort every archive check the same unanswered way
      // rather than guess at a starting state to restore later.
      return names.map((name) => toResult(name, error));
    }

    if (initialRunning) {
      log("stopping the gateway once for this run's archive-based checks");
      try {
        await reach("pause the gateway", () => ctx.runtime.pause());
      } catch (error) {
        // Never paused, so nothing to restart either — same as above.
        return names.map((name) => toResult(name, error));
      }
    }

    // From here the gateway is stopped (or was never running). Each artifact is attempted
    // independently so one failing does not block work that does not need it.
    let witnesses: Map<string, string> | undefined;
    let witnessError: unknown;
    if (wantRoundTrip) {
      try {
        witnesses = await collectRoundTripWitnesses(ctx);
      } catch (error) {
        witnessError = error;
      }
    }

    let fullArchive: string | undefined;
    let fullError: unknown;
    if (wantRejects || wantRoundTrip) {
      try {
        // FULL, not migrate: full is the only profile that keeps privatePaths, identity and
        // keys — the only archive the round-trip restore below is a genuine round trip of,
        // and the only one guaranteed to still carry whatever the reject-check needs to see
        // rejected. leaveStopped: true — this shared window restarts the gateway itself,
        // once, below; createBackup would otherwise restart it the moment this call returns.
        fullArchive = await reachVerdict("take the full backup", () => createBackup(ctx, { profile: "full", leaveStopped: true }));
      } catch (error) {
        fullError = error;
      }
    }

    let shareError: unknown;
    if (wantAccepts) {
      try {
        // Same leaveStopped reasoning as the full backup above — and harmless either way
        // here, since createBackup()/pull() already skip re-pausing a gateway they find
        // already stopped (isRunning() is read fresh on every call).
        await pull(ctx, ["--share"], { leaveStopped: true });
      } catch (error) {
        // pull's own die() IS the verdict — a rejected snapshot is a failed check, not an
        // unreachable instance. Anything else never got far enough to judge anything. Same
        // distinction the standalone check draws.
        shareError = error instanceof UserError ? error : new CouldNotCheck(`could not take a share snapshot: ${describeError(error)}`);
      }
    }

    let restartError: unknown;
    if (initialRunning) {
      try {
        log("starting the gateway again");
        await ctx.runtime.start();
        await ctx.runtime.waitForHealth();
        log("gateway is healthy");
      } catch (error) {
        restartError = error;
      }
    }

    // Offline from here: verification and the restore-diff never touch the gateway again.
    const results: SmokeResult[] = [];

    if (wantRejects) {
      const result = fullError !== undefined
        ? toResult(REJECTS_SECRETS_CHECK, fullError)
        : await evaluate(REJECTS_SECRETS_CHECK, async () => {
            const passed = await verifySnapshot(ctx, fullArchive as string, "share");
            expect(!passed, "the verifier accepted an archive containing credentials");
          });
      results.push(foldRestartFailure(result, restartError));
    }

    if (wantAccepts) {
      const result = shareError !== undefined ? toResult(ACCEPTS_SHARE_CHECK, shareError) : { name: ACCEPTS_SHARE_CHECK, status: "passed" as const };
      results.push(foldRestartFailure(result, restartError));
    }

    if (wantRoundTrip) {
      const priorError = witnessError ?? fullError;
      const result = priorError !== undefined
        ? toResult(ROUND_TRIP_CHECK, priorError)
        : await evaluate(ROUND_TRIP_CHECK, () => roundTripUsingArchive(ctx, fullArchive as string, witnesses as Map<string, string>));
      results.push(foldRestartFailure(result, restartError));
    }

    return results;
  });
}

/** The whole selected run: ordinary checks one at a time, exactly as runChecks() does; the
 *  three archive-based checks, wherever they appear in `selected`, consolidated into one
 *  stop/start cycle via runArchiveChecks() (UX-14) — their results are emitted together at
 *  the position the first of them holds. This is what smoke() below runs; runChecks() stays
 *  as it always was for anything that runs a check (or a stand-in one) on its own. */
export async function runSmokeSuite(ctx: Context, selected: Check[], onResult: (result: SmokeResult) => void = printResult): Promise<SmokeSummary> {
  const results: SmokeResult[] = [];
  const counts = { passed: 0, failed: 0, notChecked: 0, couldNotCheck: 0 };
  const record = (result: SmokeResult): void => {
    results.push(result);
    tally(counts, result);
    onResult(result);
  };

  const wanted = new Set(selected.filter((check) => ARCHIVE_CHECK_NAMES.has(check.name)).map((check) => check.name));
  let archiveGroupDone = false;

  for (const check of selected) {
    if (ARCHIVE_CHECK_NAMES.has(check.name)) {
      if (archiveGroupDone) continue;
      archiveGroupDone = true;
      for (const result of await runArchiveChecks(ctx, wanted)) record(result);
      continue;
    }
    record(await evaluate(check.name, () => check.run(ctx)));
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
  const selected = quick ? checks.filter((check) => check.name !== ROUND_TRIP_CHECK) : checks;

  log(`smoke run against ${ctx.settings.serviceUrl}`);

  report(await runSmokeSuite(ctx, selected), quick);
}
