// `./clawforge smoke` — acceptance run for an instance.
//
// which was the "behaviour does not change" boundary for the
// TypeScript migration. It checks the properties that actually cost debugging time:
//   - the gateway is healthy by BOTH criteria (HTTP probe and the runtime's own verdict),
//     because their disagreement is what uncovered a broken healthcheck
//   - the agent answers end to end, i.e. the provider key really resolved
//   - the declaration in the repository wins over manual drift
//   - a snapshot restores byte-for-byte
//   - the verifier accepts a shareable archive AND rejects one with secrets
//   - the MCP bridge speaks JSON-RPC on a clean stdout
//
// The two negative checks matter most: a suite that only confirms success degrades
// silently.
//
// Every check lands on the shared check-outcome vocabulary (commands/check-outcome.ts):
// passed, failed, not-checked (this deployment makes the check inapplicable) or
// could-not-check (the check could not obtain a verdict). The last never reads as passing
// and fails the run exactly as a failed check does: a suite that could not ask its
// question has not earned a green light.

import { readFile } from "node:fs/promises";
import JSON5 from "json5";
import { log, info, warn, die, UserError } from "#src/core/log.ts";
import type { Context } from "#src/core/context.ts";
import { CouldNotCheck, NotChecked } from "../check-outcome.ts";
import type { CheckOutcome } from "../check-outcome.ts";
import { createBackup } from "./backup.ts";
import { verifySnapshot } from "./verify.ts";
import { applyConfig } from "../orchestration/config.ts";
import { desiredStateFile } from "#src/runtime/deployment.ts";
import { pull, push } from "./state.ts";
import { sudoFor } from "#src/runtime/datadir.ts";
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
    name: "snapshot round-trip is byte-identical",
    run: async (ctx) => {
      const marker = `${ctx.settings.dataDir}/workspace/SMOKE-MARKER.md`;
      await reach("write the marker", () => ctx.transport.writeFile(marker, `smoke-${Date.now()}\n`));

      const checksum = async (): Promise<string> => {
        const result = await reach("checksum the marker", () => ctx.transport.exec("sha256sum", [marker]));
        return result.stdout.split(" ")[0];
      };
      const before = await checksum();

      await reach("pull the snapshot", () => pull(ctx, []));
      await reach("remove the marker", () => ctx.transport.remove(marker));
      await reach("push the snapshot back", () => push(ctx, ["--force"]));

      expect(await reach("look for the marker", () => ctx.transport.exists(marker)), "the marker did not come back");
      const after = await checksum();

      // Post-verdict cleanup: a failure here leaves a stray marker behind — a real
      // failure, not a missing verdict, so it deliberately does not go through reach().
      const prefix = await sudoFor(ctx, marker);
      const [head, ...rest] = [...prefix, "rm", "-f", marker];
      await ctx.transport.exec(head, rest);

      expect(before === after, "checksum mismatch after the round trip");
    },
  },
];

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
