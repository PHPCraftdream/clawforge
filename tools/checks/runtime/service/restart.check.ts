// `./clawforge restart` — the command that exists because `up` cannot do this.
//
// Applying a desired state edits openclaw.json inside a bind mount, which changes nothing
// the runtime compares, so `up` reports success and leaves the old settings live. This
// covers the three things the command owes its caller: it refuses when there is nothing to
// restart, it does not restart into a config whose secrets are missing, and it waits for
// health rather than returning as soon as the container is told to come back.

import { resolve } from "node:path";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
const up = openclawCommands.up.run;
const restart = openclawCommands.restart.run;
const down = openclawCommands.down.run;

useDeployment(resolve(monorepoRoot, "apps", "example app"));

const CONFIG_PATH = "/srv/openclaw/data/config/openclaw.json";
const TARGET_ENV_PATH = "/srv/openclaw/data/config/.env";

interface Recorder {
  restarted: boolean;
  waited: boolean;
}

/** `config` decides whether the secrets preflight passes: a config with no SecretRef needs
 *  nothing, one with a reference needs a variable the stubbed target does not supply. */
function makeCtx(options: { running: boolean; config: unknown }): { ctx: Context; seen: Recorder } {
  const seen: Recorder = { restarted: false, waited: false };
  const ctx = {
    settings: { dataDir: "/srv/openclaw/data", env: {}, serviceUrl: "http://127.0.0.1:18789" },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        if (path === CONFIG_PATH) return true;
        if (path === TARGET_ENV_PATH) return false;
        return true;
      },
      async readFile(path: string): Promise<string> {
        return path === CONFIG_PATH ? JSON.stringify(options.config) : "";
      },
      // restart now takes the instance lock, which is a directory it creates on the target.
      // Nothing here is about locking, so the target simply lets it be taken and released.
      async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
        return { code: 0, stdout: "", stderr: "" };
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
    },
    runtime: {
      async isRunning(): Promise<boolean> {
        return options.running;
      },
      async restart(): Promise<void> {
        seen.restarted = true;
      },
      async waitForHealth(): Promise<void> {
        seen.waited = true;
      },
    },
  } as unknown as Context;
  return { ctx, seen };
}

async function run(ctx: Context): Promise<string | undefined> {
  // Output captured: these commands log, and a check should not print their progress.
  return withOutputSink(
    () => {},
    async () => {
      try {
        await openclawCommands.restart.run(ctx, []);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  );
}

{
  const { ctx, seen } = makeCtx({ running: false, config: {} });
  const message = await run(ctx);
  check("a stopped instance is refused rather than silently started", message?.includes("./clawforge up"), true);
  check("nothing is restarted when there is nothing running", seen.restarted, false);
}

{
  const { ctx, seen } = makeCtx({
    running: true,
    config: { provider: { key: { source: "env", id: "REQUIRED_VAR" } } },
  });
  const message = await run(ctx);
  check("a config with a missing secret stops the restart", message !== undefined, true);
  check("the instance is left running rather than restarted into a crash loop", seen.restarted, false);
}

{
  const { ctx, seen } = makeCtx({ running: true, config: {} });
  const message = await run(ctx);
  check("a satisfiable config restarts cleanly", message, undefined);
  check("the runtime is asked to restart", seen.restarted, true);
  check("the command waits for health instead of returning immediately", seen.waited, true);
}

// --- an unrecognised argument is refused before the lock is ever taken -------------------
//
// up, restart and down all validate their argv the same way (parseDeclaredArgs against the
// same lock-takeover-only declaration) before calling guarded() — proven once here for all
// three by poisoning every transport/runtime method a lock claim or a mutation would reach;
// any call at all means the argument check ran too late.

function untouchableCtx(): Context {
  const poison = (label: string) => (): never => {
    throw new Error(`must not be called — the argument check runs first (${label})`);
  };
  return {
    settings: { dataDir: "/srv/openclaw/data", env: {}, serviceUrl: "http://127.0.0.1:18789" },
    transport: { description: "stub", exec: poison("transport.exec"), exists: poison("transport.exists") },
    runtime: {
      isRunning: poison("runtime.isRunning"),
      start: poison("runtime.start"),
      restart: poison("runtime.restart"),
      stop: poison("runtime.stop"),
      waitForHealth: poison("runtime.waitForHealth"),
      portConflict: poison("runtime.portConflict"),
    },
  } as unknown as Context;
}

async function runCommand(command: (ctx: Context, args: string[]) => Promise<void>, args: string[]): Promise<string | undefined> {
  return withOutputSink(() => {}, async () => {
    try {
      await command(untouchableCtx(), args);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

for (const [name, command] of [["up", up], ["restart", restart], ["down", down]] as [string, (ctx: Context, args: string[]) => Promise<void>][]) {
  const message = await runCommand(command, ["--bogus"]);
  check(`${name} refuses an unknown argument before touching the transport or runtime`, message, "unknown argument: --bogus");
}

{
  // The unrecognised-argument scenario, specifically: down must not forward --rmi to compose,
  // nor even reach the lock.
  const message = await runCommand(down, ["--rmi", "all"]);
  check("down refuses --rmi all before taking the lock or touching compose", message, "unknown argument: --rmi");
}

finish("restart");
