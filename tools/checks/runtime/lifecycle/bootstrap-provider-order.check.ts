// `./clawforge bootstrap` — the provider is configured AFTER declared settings are applied,
// never before.
//
// Confirmed against OpenClaw's real config schema (github.com/openclaw/openclaw
// src/config/zod-schema.core.ts): a provider id that is not one of OpenClaw's built-in
// overlays must have baseUrl (and a models array) present, or the write is rejected. For a
// brand-new custom provider those come from config/desired-state.json, applied by
// applyConfig; configureProvider only ever writes models.providers.<id>.apiKey. Configuring
// the provider first leaves that provider's entry with just an apiKey and no baseUrl — an
// incomplete provider object OpenClaw's own `config set` refuses — which stopped bootstrap
// before applyConfig ever ran. Built-in providers are exempt from that rule, which is why
// this defect was invisible against them.
//
// A live OpenClaw instance is what actually proves the schema requirement; this check
// proves the narrower, still real thing that regresses silently otherwise — that bootstrap
// asks for these two steps in the order that requirement demands, recorded through the same
// runtime.runOneOff seam every other command in this codebase is checked through.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrap } from "../../../framework/commands/lifecycle/bootstrap.ts";
import { useDeployment } from "../../../framework/runtime/deployment.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import type { Context } from "../../../framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

const DATA_DIR = "/srv/openclaw/data";
const CONFIG_PATH = `${DATA_DIR}/config/openclaw.json`;
const TARGET_ENV_PATH = `${DATA_DIR}/config/.env`;

// A genuinely new custom provider: not one of OpenClaw's built-in overlays, and its entry
// carries nothing yet — exactly the shape whose apiKey-only write the real schema refuses
// until baseUrl exists too.
const LIVE_CONFIG = { models: { providers: { custom: {} } } };

const deployment = await mkdtemp(join(tmpdir(), "oc-bootstrap-order-check-"));
try {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  await writeFile(
    resolve(deployment, "config", "desired-state.json"),
    JSON.stringify([
      { path: "models.providers.custom.baseUrl", value: "http://localhost:11434/v1" },
      { path: "models.providers.custom.models", value: [{ id: "local-model" }] },
    ]),
  );
  useDeployment(deployment);

  const calls: { kind: string; args: string[] }[] = [];
  const ctx = {
    settings: {
      dataDir: DATA_DIR,
      env: { OPENCLAW_GATEWAY_TOKEN: "test-token" },
      image: "ghcr.io/openclaw/openclaw:extended-stable",
      gatewayPort: "18789",
      serviceUrl: "http://127.0.0.1:18789",
    },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> {
        return true;
      },
      async readFile(path: string): Promise<string> {
        if (path === CONFIG_PATH) return JSON.stringify(LIVE_CONFIG);
        if (path === TARGET_ENV_PATH) return "CUSTOM_API_KEY=secret-value\n";
        return "";
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    paths: {
      toContainer: (path: string) => path,
    },
    runtime: {
      async pullImage(): Promise<void> {
        calls.push({ kind: "pull", args: [] });
      },
      async runOneOff(_service: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (args[1] === "config" && args[3] === "--batch-file") calls.push({ kind: "apply-config", args });
        else if (args[1] === "config" && typeof args[3] === "string" && args[3].startsWith("models.providers.")) {
          calls.push({ kind: "configure-provider", args });
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async start(): Promise<void> {
        calls.push({ kind: "start", args: [] });
      },
      async waitForHealth(): Promise<void> {
        calls.push({ kind: "wait-for-health", args: [] });
      },
      async imageReference(): Promise<string | undefined> {
        return undefined;
      },
    },
  } as unknown as Context;

  await withOutputSink(() => {}, () => bootstrap(ctx, ["--no-pull"]));

  const kinds = calls.map((call) => call.kind);
  check("both steps ran", kinds.includes("apply-config") && kinds.includes("configure-provider"), true);
  check(
    "declared settings are applied before the provider's apiKey is written",
    kinds.indexOf("apply-config") < kinds.indexOf("configure-provider"),
    true,
  );
  check(
    "the provider write names the new custom provider, not a built-in one",
    calls.find((call) => call.kind === "configure-provider")?.args.includes("models.providers.custom.apiKey"),
    true,
  );
  check("the start sequence still runs after both", kinds.indexOf("configure-provider") < kinds.indexOf("start"), true);
} finally {
  await rm(deployment, { recursive: true, force: true });
}

// --- set try: the exact same ordering requirement, at a lower cost than another full run --
//
// set try's own bring-up (tools/framework/commands/sets/set-try.ts) makes the identical two
// calls for the identical reason — its provider comes from the SAME desired-state.json a set
// carries. Driving it behaviourally here would mean building a real, checksum-valid set
// artifact and unpacking it just to prove a two-line reorder already proven above; that cost
// buys nothing this file's own live-instance test suite has not already paid for elsewhere.
// What this guards against is a future edit silently swapping the two calls back — a plain
// source-order check is honest about being exactly that, not a second behavioural proof.
{
  const setTrySource = await (await import("node:fs/promises")).readFile(
    new URL("../../../framework/commands/sets/set-try.ts", import.meta.url),
    "utf8",
  );
  const applyAt = setTrySource.indexOf("await applyConfig(tryCtx, []);");
  const configureAt = setTrySource.indexOf("await configureProvider(tryCtx, []);");
  check("set try's own bring-up makes both calls", applyAt >= 0 && configureAt >= 0, true);
  check("set try applies declared settings before configuring the provider, same as bootstrap", applyAt < configureAt, true);
}

process.stderr.write(failed === 0 ? "all bootstrap provider-order checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
