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

import { readFile } from "node:fs/promises";
import JSON5 from "json5";
import { log, info, warn, die } from "../../core/log.ts";
import type { Context } from "../../core/context.ts";
import { createBackup } from "./backup.ts";
import { verifySnapshot } from "./verify.ts";
import { applyConfig } from "../orchestration/config.ts";
import { desiredStateFile } from "../../runtime/deployment.ts";
import { pull, push } from "./state.ts";
import { sudoFor } from "../../runtime/datadir.ts";

interface Check {
  readonly name: string;
  readonly run: (ctx: Context) => Promise<void>;
}

/** Throws with a readable message when the condition does not hold. */
function expect(condition: boolean, detail: string): void {
  if (!condition) throw new Error(detail);
}

/** A check that cannot apply to this deployment. Reported as skipped rather than passed:
 *  a suite that counts what it did not run is how coverage quietly disappears. */
class Skipped extends Error {
  name = "Skipped";
}

const checks: Check[] = [
  {
    name: "gateway answers all HTTP probes",
    run: async (ctx) => {
      for (const endpoint of ["healthz", "startupz", "readyz"]) {
        const code = await ctx.runtime.probe(endpoint);
        expect(code === 200, `${endpoint} returned ${code}`);
      }
    },
  },
  {
    name: "runtime reports the container healthy",
    run: async (ctx) => {
      const health = await ctx.runtime.health();
      expect(health === "healthy", `container health is "${health}"`);
    },
  },
  {
    name: "agent answers end to end",
    run: async (ctx) => {
      const result = await ctx.runtime.runOneOff("cli", ["agent", "--agent", "main", "-m", "Reply with exactly: SMOKE-OK"], {
        profile: "cli",
        input: "",
      });
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
        throw new Skipped("desired-state.json declares no drift-safe string setting");
      }

      const wanted = subject.value as string;
      const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;

      try {
        await ctx.runtime.runOneOff(
          "gateway",
          ["dist/index.js", "config", "set", subject.path, JSON.stringify(`${wanted}-drifted`), "--strict-json"],
          { noDeps: true, entrypoint: "node", input: "" },
        );
        await applyConfig(ctx, []);

        // JSON5, not JSON: the live config is OpenClaw's own JSON5 gateway format.
        const config = JSON5.parse(await ctx.transport.readFile(configPath)) as Record<string, unknown>;
        const actual = subject.path
          .split(".")
          .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], config);
        expect(actual === wanted, `${subject.path} is ${String(actual)}, expected ${wanted}`);
      } finally {
        // Whatever happened, the declaration is what the instance should be left with.
        await applyConfig(ctx, []);
      }
    },
  },
  {
    name: "verifier rejects an archive with secrets",
    run: async (ctx) => {
      const archive = await createBackup(ctx, { profile: "full" });
      const passed = await verifySnapshot(ctx, archive, "share");
      expect(!passed, "the verifier accepted an archive containing credentials");
    },
  },
  {
    name: "verifier accepts a share snapshot",
    run: async (ctx) => {
      await pull(ctx, ["--share"]);
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
      const result = await ctx.runtime.runOneOff("cli", ["mcp", "serve"], {
        profile: "cli",
        input: `${request}\n`,
      });
      expect(result.stdout.includes('"serverInfo"'), `bridge replied: ${result.stdout.trim().slice(0, 120)}`);
    },
  },
  {
    name: "snapshot round-trip is byte-identical",
    run: async (ctx) => {
      const marker = `${ctx.settings.dataDir}/workspace/SMOKE-MARKER.md`;
      await ctx.transport.writeFile(marker, `smoke-${Date.now()}\n`);

      const checksum = async (): Promise<string> => {
        const result = await ctx.transport.exec("sha256sum", [marker]);
        return result.stdout.split(" ")[0];
      };
      const before = await checksum();

      await pull(ctx, []);
      await ctx.transport.remove(marker);
      await push(ctx, ["--force"]);

      expect(await ctx.transport.exists(marker), "the marker did not come back");
      const after = await checksum();

      const prefix = await sudoFor(ctx, marker);
      const [head, ...rest] = [...prefix, "rm", "-f", marker];
      await ctx.transport.exec(head, rest);

      expect(before === after, "checksum mismatch after the round trip");
    },
  },
];

export async function smoke(ctx: Context, args: string[]): Promise<void> {
  const quick = args.includes("--quick");
  for (const arg of args) {
    if (arg !== "--quick") die(`unknown argument: ${arg}`);
  }
  const selected = quick ? checks.filter((check) => !check.name.includes("round-trip")) : checks;

  log(`smoke run against ${ctx.settings.serviceUrl}`);

  let passed = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const check of selected) {
    try {
      await check.run(ctx);
      info(`PASS ${check.name}`);
      passed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Skipped) {
        info(`SKIP ${check.name}: ${message}`);
        skipped += 1;
        continue;
      }
      warn(`FAIL ${check.name}: ${message}`);
      failures.push(check.name);
    }
  }

  if (quick) info("skipping the round-trip (--quick)");

  if (failures.length > 0) {
    throw new Error(`${failures.length} failed, ${passed} passed: ${failures.join(", ")}`);
  }
  log(`all ${passed} checks passed${skipped > 0 ? `, ${skipped} skipped` : ""}`);
}
