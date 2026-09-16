// Shared fixture for the set-lifecycle.check.ts split (apply-rollback/snapshot-transitions/
// set-try-flow.check.ts, this same directory): a simulated transport (a files Map plus a
// dirs Set standing in for a real target filesystem), a Context builder, and the
// captured()/report() helpers every one of those files needs.
//
// One createFixture() call per check file — each gets its OWN root deployment directory
// and its OWN files/dirs Map, so nothing here is state shared BETWEEN check files (which
// tools/checks/run.ts imports one after another in the same process). Mutable state that
// MUST be shared across test blocks WITHIN one file (running/failPull/failStop/stopped/
// lastTryDir) is bundled into the returned `state` object instead of module-level `let`s,
// so a check file can flip `fixture.state.running = true` between its own blocks exactly
// the way the original single-file version did.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { toSettings } from "#framework/core/env.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecOptions } from "#framework/runtime/transport.ts";

export interface LifecycleFixtureState {
  running: boolean;
  failPull: boolean;
  failStop: boolean;
  stopped: number;
  lastTryDir: string;
}

export interface LifecycleFixture {
  readonly root: string;
  readonly sourceData: string;
  readonly files: Map<string, string>;
  readonly baseEnv: Record<string, string>;
  readonly ctx: Context;
  readonly state: LifecycleFixtureState;
  context(env: Record<string, string>): Context;
  captured(body: () => Promise<void>): Promise<{ output: string; error?: Error }>;
  report(output: string): { healthy: boolean; torndown: boolean };
  teardown(): Promise<void>;
}

export async function createFixture(): Promise<LifecycleFixture> {
  const root = await mkdtemp(join(tmpdir(), "clawforge-set-lifecycle-"));
  const previousDeployment = (() => {
    try {
      return deploymentDir();
    } catch {
      return undefined;
    }
  })();
  const sourceData = "/tmp/set-lifecycle-real/data";
  const files = new Map<string, string>([[`${sourceData}/config/openclaw.json`, "{}"], [`${sourceData}/workspace/MEMORY.md`, "keep me"]]);
  const dirs = new Set<string>(["/", "/tmp", "/tmp/set-lifecycle-real", sourceData, `${sourceData}/config`]);
  const state: LifecycleFixtureState = { running: false, failPull: false, failStop: false, stopped: 0, lastTryDir: "" };

  function mkdirp(path: string): void {
    const parts = path.split("/").filter(Boolean);
    for (let end = 1; end <= parts.length; end += 1) dirs.add(`/${parts.slice(0, end).join("/")}`);
  }

  const transport = {
    description: "fixture",
    exists: async (path: string) => files.has(path) || dirs.has(path),
    readFile: async (path: string) => {
      if (!files.has(path)) throw new Error("ENOENT");
      return files.get(path)!;
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    writePrivateFile: async (path: string, content: string) => {
      if (files.has(path)) throw new Error("EEXIST: file exists");
      files.set(path, content);
    },
    mkdirp: async (path: string) => {
      mkdirp(path);
    },
    listFiles: async (path: string) => [...files.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1)),
    remove: async (path: string) => {
      for (const file of files.keys()) if (file === path || file.startsWith(`${path}/`)) files.delete(file);
      for (const dir of dirs) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
    },
    exec: async (command: string, args: string[], options: ExecOptions = {}) => {
      let code = 0;
      let stdout = "";
      if (command === "mkdir") {
        const path = args.at(-1)!;
        if (!args.includes("-p") && dirs.has(path)) code = 1;
        else mkdirp(path);
      } else if (command === "test" && args[0] === "-d") code = dirs.has(args[1]) ? 0 : 1;
      else if (command === "stat") stdout = args.includes("%Y") ? "0" : args.includes("%y") ? "1970-01-01 00:00:00.000000000 +0000" : args.includes("%a") ? "700" : "1000:1000";
      else if (command === "rm") await transport.remove(args.at(-1)!);
      if (code !== 0 && !options.allowFailure) throw new Error(`${command} failed`);
      return { code, stdout, stderr: "" };
    },
  };

  function context(env: Record<string, string>): Context {
    const settings = toSettings(env);
    const configFile = `${settings.dataDir}/config/openclaw.json`;
    return {
      settings, transport,
      paths: { toTarget: async (path: string) => path, toContainer: (path: string) => path },
      runtime: {
        isRunning: async () => state.running,
        portConflict: async () => undefined,
        pullImage: async () => { if (state.failPull) throw new Error("fixture pull failed"); },
        start: async () => { state.running = true; },
        restart: async () => { state.running = true; },
        stop: async () => { state.stopped += 1; if (state.failStop) throw new Error("fixture teardown failed"); state.running = false; },
        waitForHealth: async () => {},
        health: async () => "healthy", probe: async () => 200, startedAt: async () => 1,
        imageReference: async () => settings.image,
        runningImageIdentity: async () => (state.running ? { imageId: "img-1", digests: [settings.image], containerId: "container-1" } : undefined),
        runOneOff: async (_service: string, args: string[]) => {
          let stdout = "{}";
          if (args.includes("onboard")) files.set(configFile, "{}");
          if (args.includes("--batch-file")) {
            const entries = JSON.parse(files.get(args[args.indexOf("--batch-file") + 1])!);
            const config = JSON.parse(files.get(configFile) ?? "{}");
            for (const { path, value } of entries) {
              const parts = path.split("."); let node = config;
              for (const key of parts.slice(0, -1)) node = node[key] ??= {};
              node[parts.at(-1)!] = value;
            }
            files.set(configFile, JSON.stringify(config));
          }
          if (args[0] === "agents") stdout = "[]";
          if (args[0] === "cron") stdout = '{"jobs":[]}';
          return { code: 0, stdout, stderr: "" };
        },
      },
    } as unknown as Context;
  }

  async function captured(body: () => Promise<void>): Promise<{ output: string; error?: Error }> {
    let output = ""; let error: Error | undefined;
    let machine = "";
    try {
      await withOutputSink((chunk) => { output += chunk; }, body, (chunk) => { machine += chunk; });
    } catch (failure) {
      error = failure as Error;
    }
    return { output: machine || output, error };
  }

  function report(output: string): { healthy: boolean; torndown: boolean } {
    return JSON.parse(output.slice(output.lastIndexOf('{\n  "name"')));
  }

  await mkdir(join(root, "config"));
  const baseEnv = { OC_DATA_DIR: sourceData, OC_BIND_ADDRESS: "127.0.0.1", OC_TARGET_LOCATION: process.platform === "win32" ? "wsl" : "local", OPENCLAW_IMAGE: "fixture@sha256:abc", OPENCLAW_GATEWAY_TOKEN: "fixture-token-12345" };
  await writeFile(join(root, ".env"), Object.entries(baseEnv).map(([key, value]) => `${key}=${value}`).join("\n"));
  await writeFile(join(root, "config", "desired-state.json"), '[{"path":"gateway.mode","value":"local"},{"path":"gateway.controlUi.allowedOrigins","value":["http://127.0.0.1:18789"]}]');
  useDeployment(root);
  const ctx = context(baseEnv);

  async function teardown(): Promise<void> {
    if (previousDeployment !== undefined) useDeployment(previousDeployment);
    await rm(root, { recursive: true, force: true });
  }

  return { root, sourceData, files, baseEnv, ctx, state, context, captured, report, teardown };
}
