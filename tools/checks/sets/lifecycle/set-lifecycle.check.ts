import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSet } from "../../../framework/commands/sets/set.ts";
import { setTry } from "../../../framework/commands/sets/set-try.ts";
import { apply } from "../../../framework/commands/orchestration/apply.ts";
import { rollback } from "../../../framework/commands/orchestration/rollback.ts";
import { useDeployment, deploymentDir, envFile } from "../../../framework/runtime/deployment.ts";
import { setSourceDir } from "../../../framework/set/artifacts/source.ts";
import { readInstalledSet } from "../../../framework/set/artifacts/install.ts";
import { listReceipts } from "../../../framework/set/artifacts/receipt.ts";
import { parseEnv, toSettings } from "../../../framework/core/env.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import type { Context } from "../../../framework/core/context.ts";
import type { ExecOptions } from "../../../framework/runtime/transport.ts";

const root = await mkdtemp(join(tmpdir(), "clawforge-set-lifecycle-"));
const previousDeployment = (() => { try { return deploymentDir(); } catch { return undefined; } })();
const sourceData = "/tmp/set-lifecycle-real/data";
const files = new Map<string, string>([[`${sourceData}/config/openclaw.json`, "{}"], [`${sourceData}/workspace/MEMORY.md`, "keep me"]]);
const dirs = new Set<string>(["/", "/tmp", "/tmp/set-lifecycle-real", sourceData, `${sourceData}/config`]);
let running = false;
let failPull = false;
let failStop = false;
let stopped = 0;
let lastTryDir = "";

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
  writeFile: async (path: string, content: string) => { files.set(path, content); },
  mkdirp: async (path: string) => { mkdirp(path); },
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
    else if (command === "stat") stdout = args.includes("%Y") ? "0" : args.includes("%a") ? "700" : "1000:1000";
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
      isRunning: async () => running,
      portConflict: async () => undefined,
      pullImage: async () => { if (failPull) throw new Error("fixture pull failed"); },
      start: async () => { running = true; },
      restart: async () => { running = true; },
      stop: async () => { stopped += 1; if (failStop) throw new Error("fixture teardown failed"); running = false; },
      waitForHealth: async () => {},
      health: async () => "healthy", probe: async () => 200, startedAt: async () => 1,
      imageReference: async () => settings.image,
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
  try { await withOutputSink((chunk) => { output += chunk; }, body, (chunk) => { machine += chunk; }); } catch (failure) { error = failure as Error; }
  return { output: machine || output, error };
}
function report(output: string): { healthy: boolean; torndown: boolean } {
  return JSON.parse(output.slice(output.lastIndexOf('{\n  "name"')));
}

try {
  await mkdir(join(root, "config"));
  const baseEnv = { OC_DATA_DIR: sourceData, OC_BIND_ADDRESS: "127.0.0.1", OC_TARGET_LOCATION: process.platform === "win32" ? "wsl" : "local", OPENCLAW_IMAGE: "fixture@sha256:abc", OPENCLAW_GATEWAY_TOKEN: "fixture-token-12345" };
  await writeFile(join(root, ".env"), Object.entries(baseEnv).map(([key, value]) => `${key}=${value}`).join("\n"));
  await writeFile(join(root, "config", "desired-state.json"), '[{"path":"gateway.mode","value":"local"},{"path":"gateway.controlUi.allowedOrigins","value":["http://127.0.0.1:18789"]}]');
  useDeployment(root);
  const ctx = context(baseEnv);
  const built = await buildSet(ctx, "lifecycle");
  const external = join(root, "incoming.tar.gz");
  await rename(built.artifact, external);

  const before = JSON.stringify([...files]);
  const dryRun = await captured(() => apply(ctx, ["--set", external, "--dry-run", "--json"]));
  assert.equal(dryRun.error, undefined);
  assert.equal(JSON.stringify([...files]), before, "dry-run must not record an installed id or mutate target files");
  assert.equal(await access(built.artifact).then(() => true, () => false), false, "dry-run must not cache an artifact");

  const first = await captured(() => apply(ctx, ["--set", external, "--json"]));
  assert.equal(first.error, undefined, first.error?.message);
  assert.equal((await readInstalledSet(ctx))?.id, built.id);
  await access(built.artifact);
  await rm(external);
  await writeFile(join(root, "config", "desired-state.json"), '[{"path":"gateway.mode","value":"local"},{"path":"agents.defaults.name","value":"second"}]');
  const next = await buildSet(ctx, "lifecycle");
  const second = await captured(() => apply(ctx, ["--set", next.artifact, "--json"]));
  assert.equal(second.error, undefined, second.error?.message);
  assert.equal((await readInstalledSet(ctx))?.previous?.id, built.id);
  const rolledBack = await captured(() => rollback(ctx, ["--set", "--json"]));
  assert.equal(rolledBack.error, undefined, rolledBack.error?.message);
  assert.equal((await readInstalledSet(ctx))?.id, built.id);
  assert.equal(files.get(`${sourceData}/workspace/MEMORY.md`), "keep me");

  // The "second" set just rolled back from declared agents.defaults.name, which "lifecycle"
  // (the one just reinstalled) never did — apply-config is additive only (a batch config
  // set, never an unset), so reinstalling "lifecycle" alone would leave that key in place.
  const restoredConfig = JSON.parse(files.get(`${sourceData}/config/openclaw.json`) ?? "{}");
  assert.equal(
    restoredConfig?.agents?.defaults?.name,
    undefined,
    "rollback --set must undo a setting the newer set added but the older one never declared",
  );
  assert.equal(restoredConfig?.gateway?.mode, "local", "the previous set's own declared settings are still in force after rollback");

  const dependencies = {
    findFreePort: async () => 24567,
    createContext: async () => { lastTryDir = deploymentDir(); return context(parseEnv(await readFile(envFile(), "utf8"))); },
  };
  running = false;
  const tried = await captured(() => setTry(ctx, ["--set", next.artifact, "--json"], dependencies));
  assert.equal(tried.error, undefined, tried.error?.message);
  assert.equal(report(tried.output).torndown, true);
  assert.equal(report(tried.output).healthy, false, "no acceptance checks is not a verified deployment");
  assert.equal(await access(lastTryDir).then(() => true, () => false), false);
  assert.equal(deploymentDir(), root);
  assert.equal(setSourceDir(), undefined);

  failPull = true;
  const failedTry = await captured(() => setTry(ctx, ["--set", next.artifact, "--json"], dependencies));
  assert.match(failedTry.error?.message ?? "", /pull failed/);
  assert.equal(report(failedTry.output).torndown, true);
  assert.equal(report(failedTry.output).healthy, false);
  assert.equal(deploymentDir(), root);
  failPull = false;
  failStop = true;
  const incomplete = await captured(() => setTry(ctx, ["--set", next.artifact, "--json"], dependencies));
  assert.match(incomplete.error?.message ?? "", /cleanup failed/);
  assert.equal(report(incomplete.output).torndown, false);
  await access(lastTryDir);
  assert.ok(stopped >= 3, "even a failed bootstrap must attempt teardown");
  assert.equal(files.get(`${sourceData}/workspace/MEMORY.md`), "keep me");
  assert.equal(setSourceDir(), undefined);
  failStop = false;
  const kept = await captured(() => setTry(ctx, ["--set", next.artifact, "--json", "--keep"], dependencies));
  assert.equal(kept.error, undefined, kept.error?.message);
  assert.equal(report(kept.output).torndown, false);
  await access(join(lastTryDir, "config", "desired-state.json"));
  const keptApp = await import(pathToFileURL(join(lastTryDir, "app.ts")).href);
  assert.equal(keptApp.default.service.name, "gateway");
  assert.equal(deploymentDir(), root);
  assert.equal(setSourceDir(), undefined);
  const evidence = await listReceipts(next.id);
  assert.equal(evidence.length, 4, "success, startup failure, teardown failure and kept trials each leave evidence");
  assert.ok(evidence.every((receipt) => receipt.verdict === "not-verified"), "empty acceptance never certifies a set");

  // --- apply --set must refuse before recording a set whose required image the runtime
  // does not run, not record it as installed with nothing said about the mismatch. -------
  {
    const beforeMismatch = await readInstalledSet(ctx);
    const mismatchedCtx = context({ ...baseEnv, OPENCLAW_IMAGE: "fixture@sha256:def" });
    const mismatched = await captured(() => apply(mismatchedCtx, ["--set", next.artifact, "--json"]));
    assert.match(mismatched.error?.message ?? "", /cannot be installed here/);
    assert.match(mismatched.error?.message ?? "", /fixture@sha256:def/);
    assert.equal(
      (await readInstalledSet(ctx))?.id,
      beforeMismatch?.id,
      "a refused apply --set must not overwrite the previously-installed set",
    );
  }

  process.stderr.write("all set lifecycle checks passed\n");
} finally {
  if (previousDeployment !== undefined) useDeployment(previousDeployment);
  await rm(root, { recursive: true, force: true });
}
