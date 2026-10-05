// What DockerRuntime puts on the target's command line: the environment compose is given (a
// file, never `env VAR=…` arguments — the gateway token used to be visible in `ps` for the
// duration of every container command, and longest for the ones that run longest), reconcile
// re-reading the deployment .env from disk, and Compose's own parsing of the serialised values.

import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime, serializeComposeEnv } from "#framework/runtime/docker/runtime-docker.ts";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { requires } from "#checks/kit/harness.ts";
import type { Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";
const previous=(()=>{try{return deploymentDir();}catch{return undefined;}})();
useDeployment("/fixture/deployment");
try {
  // --- the environment reaches compose as a file, not as arguments ------------------------

  const TOKEN = "gateway-token-that-must-not-be-seen";
  const env = { OPENCLAW_GATEWAY_TOKEN: TOKEN, OC_DATA_DIR: "/srv/openclaw/data", OPENCLAW_IMAGE: "ghcr.io/openclaw/openclaw:pinned" };
  for (const value of ["line\nvalue", "line\rvalue", "zero\0value", "bell\x07value"]) {
    assert.throws(() => serializeComposeEnv({ BAD: value }), /BAD/);
  }
  assert.throws(() => serializeComposeEnv({ "INVALID-NAME": "value" }), /invalid environment/);

  const execCalls: { args: string[]; options?: { env?: Record<string, string>; unsetEnv?: string[] } }[] = [];
  const writes: { path: string; content: string; mode?: string }[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  const privateDirectories: string[][] = [];
  const envTransport = {
    exec: async (_command: string, args: string[], options?: { env?: Record<string, string>; unsetEnv?: string[] }) => {
      if (_command === "mkdir") privateDirectories.push(args);
      else execCalls.push({ args, options });
      return { code: 0, stdout: "", stderr: "" };
    },
    mkdirp: async (path: string) => {
      created.push(path);
    },
    writeFile: async (path: string, content: string, mode?: string) => {
      writes.push({ path, content, mode });
    },
    remove: async (path: string) => { removed.push(path); },
  } as unknown as Transport;

  const envRuntime = new DockerRuntime(
    envTransport,
    { env, dataDir: "/srv/openclaw/data", image: "ghcr.io/openclaw/openclaw:pinned" } as unknown as Settings,
    { toTarget: async (path: string) => path } as PathBridge,
    { service: "gateway" },
  );

  await envRuntime.start();
  await envRuntime.restart();
  await envRuntime.runOneOff("cli", ["config", "get", "gateway.mode"], { profile: "cli" });

  // Asked of exec's OPTIONS first, because that is where the hazard starts: the remote
  // transports turn options.env into an `env VAR=value …` prefix on the target's command
  // line (transport.ts, withEnvPrefix), so a runtime that hands the environment to exec has
  // already put the token in `ps` — whatever the arguments look like at this layer.
  const everyArgument = execCalls.flatMap((call) => call.args);
  assert.equal(execCalls.some((call) => call.options?.env !== undefined), false, "the environment must not be handed to exec at all");
  assert.deepEqual(execCalls.map((call) => call.options?.unsetEnv), [Object.keys(env), Object.keys(env), Object.keys(env)]);
  assert.equal(everyArgument.includes(TOKEN), false, "nor may the token be an argument");
  assert.equal(everyArgument.some((argument) => argument.includes(TOKEN)), false, "nor part of one");
  assert.equal(everyArgument.includes("env"), false, "and no `env VAR=value` prefix is built here either");

  // Each operation owns its file, outside the replaceable data directory. It also writes an
  // owner record (pid, machine, this process's own start time) beside it, BEFORE it — so a
  // crash between the two writes still leaves an owner a later run can judge by when sweeping
  // an abandoned directory (runtime-docker.ts's #sweepStaleComposeEnvs).
  const envWrites = writes.filter((write) => write.path.endsWith("/compose.env"));
  const ownerWrites = writes.filter((write) => write.path.endsWith("/owner.json"));
  assert.equal(envWrites.length, 3, "each compose operation gets its own environment file");
  assert.equal(ownerWrites.length, 3, "and its own owner record");
  assert.equal(new Set(writes.map((write) => write.path)).size, writes.length, "concurrent runtimes cannot share the file");
  for (const write of envWrites) {
    assert.match(write.path, /^\/srv\/openclaw\/data-locks\/compose-[0-9a-f-]+\/compose\.env$/);
    assert.equal(write.mode, "600");
  }
  for (const write of ownerWrites) {
    assert.match(write.path, /^\/srv\/openclaw\/data-locks\/compose-[0-9a-f-]+\/owner\.json$/);
  }
  assert.equal(created.length, 3, "the temporary directory is prepared for each operation");
  assert.ok(privateDirectories.every((args) => args[0] === "-m" && args[1] === "700"));
  for (const [name, value] of Object.entries(env)) {
    assert.ok(envWrites[0].content.includes(`${name}=${JSON.stringify(value)}`), `${name} must be in the environment file`);
  }
  // Owner before env, not after: writes[] is in call order, so an owner write's index must
  // precede its sibling env write's for every operation.
  for (let index = 0; index < 3; index += 1) {
    const ownerIndex = writes.indexOf(ownerWrites[index]);
    const envIndex = writes.indexOf(envWrites[index]);
    assert.ok(ownerIndex < envIndex, "the owner record is written before the token-bearing file");
  }

  // The flag is a compose top-level option: after the subcommand it is not one.
  for (const call of execCalls) {
    const envFileAt = call.args.indexOf("--env-file");
    assert.notEqual(envFileAt, -1, `every compose call passes --env-file: ${call.args.join(" ")}`);
    assert.match(call.args[envFileAt + 1] ?? "", /^\/srv\/openclaw\/data-locks\/compose-[0-9a-f-]+\/compose\.env$/);
    assert.ok(envFileAt < call.args.findIndex((argument) => argument === "up" || argument === "restart" || argument === "run"));
  }

  // A recipe's own stack goes the same way: its variables come from the deployment's .env too.
  const stack = envRuntime.stack("recipe-confluence", "/fixture/deployment/recipes/confluence/docker-compose.yml");
  execCalls.length = 0;
  await stack.up();
  assert.equal(execCalls[0].args.includes("--env-file"), true, "a side stack gets the same environment file");
  assert.equal(execCalls[0].args.includes(TOKEN), false);
  assert.equal(writes.filter((write) => write.path.endsWith("/compose.env")).length, 4, "the side stack gets its own temporary file");
  assert.equal(writes.filter((write) => write.path.endsWith("/owner.json")).length, 4, "and its own owner record");
  // One removal per operation's whole temporary directory, not one per file inside it.
  assert.deepEqual(
    removed,
    [...new Set(writes.map((write) => write.path.slice(0, write.path.lastIndexOf("/"))))],
    "temporary directories are removed after each operation",
  );

  const failedWrites: string[] = [];
  const failedRemovals: string[] = [];
  const failingTransport = {
    ...envTransport,
    exec: async (command: string) => {
      if (command === "docker") throw new Error("compose failed");
      return { code: 0, stdout: "", stderr: "" };
    },
    writeFile: async (path: string) => { failedWrites.push(path); },
    remove: async (path: string) => { failedRemovals.push(path); },
  } as unknown as Transport;
  await assert.rejects(
    new DockerRuntime(failingTransport, { env, dataDir: "/srv/openclaw/data", image: env.OPENCLAW_IMAGE } as unknown as Settings, { toTarget: async (path: string) => path } as PathBridge, { service: "gateway" }).start(),
    /compose failed/,
  );
  assert.equal(failedWrites.length, 2, "the owner record and the environment file both land before compose ever runs");
  assert.deepEqual(
    failedRemovals,
    [...new Set(failedWrites.map((path) => path.slice(0, path.lastIndexOf("/"))))],
    "the whole temporary directory is removed when compose fails, not once per file in it",
  );

  // Hold A's command open while B queries the same instance.
  const activeFiles = new Map<string, string>();
  const observed: string[] = [];
  let releaseA!: () => void;
  let enteredA!: () => void;
  const holdA = new Promise<void>((resolve) => { releaseA = resolve; });
  const readyA = new Promise<void>((resolve) => { enteredA = resolve; });
  const concurrent = {
    mkdirp: async () => {},
    writeFile: async (path: string, body: string) => { activeFiles.set(path, body); },
    remove: async (path: string) => { activeFiles.delete(`${path}/compose.env`); activeFiles.delete(`${path}/owner.json`); },
    exec: async (_command: string, args: string[]) => {
      if (_command !== "docker") return { code: 0, stdout: "", stderr: "" };
      const path = args[args.indexOf("--env-file") + 1];
      if (args.includes("up")) { enteredA(); await holdA; }
      const body = activeFiles.get(path);
      assert.ok(body, "another operation must not remove this operation's file");
      observed.push(JSON.parse(body.slice(body.indexOf("=") + 1).trim()) as string);
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as Transport;
  const isolated = (image: string) => new DockerRuntime(concurrent, {
    dataDir: "/srv/shared/data", image, env: { OPENCLAW_IMAGE: image },
  } as unknown as Settings, { toTarget: async (path: string) => path } as PathBridge, { service: "gateway" });
  const first = isolated("image-a").start();
  await readyA;
  try { await isolated("image-b").isRunning(); }
  finally { releaseA(); await first; }
  assert.deepEqual(observed, ["image-b", "image-a"]);
  assert.equal(activeFiles.size, 0, "both operations clean up their own files");

  // --- reconcile re-reads the deployment .env from disk, not the process-start snapshot --

  const root = await mkdtemp(join(tmpdir(), "clawforge-reconcile-check-"));
  const previousReconcile = (() => { try { return deploymentDir(); } catch { return undefined; } })();
  useDeployment(root);
  try {
    const dataDir = "/srv/clawforge-reconcile-data";
    const OLD = "stale-synthetic-value";
    const NEW = "rotated-synthetic-value";
    const NAME = "CLAWFORGE_RECONCILE_PROBE";
    // .env on disk already holds the rotation; the runtime was built before it happened.
    await writeFile(join(root, ".env"), `OC_DATA_DIR=${dataDir}\nOPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:pinned\n${NAME}=${NEW}\n`, "utf8");
    const staleSettings = {
      env: { OC_DATA_DIR: dataDir, OPENCLAW_IMAGE: "ghcr.io/openclaw/openclaw:pinned", [NAME]: OLD },
      dataDir,
      image: "ghcr.io/openclaw/openclaw:pinned",
    } as unknown as Settings;
    const freshWrites: { path: string; content: string; mode?: string }[] = [];
    const freshCalls: string[][] = [];
    const reconcileTransport = {
      exec: async (_command: string, args: string[]) => {
        if (_command === "docker") freshCalls.push(args);
        return { code: 0, stdout: "container-one", stderr: "" };
      },
      mkdirp: async () => {},
      writeFile: async (path: string, content: string, mode?: string) => { freshWrites.push({ path, content, mode }); },
      remove: async () => {},
    } as unknown as Transport;
    const reconcileRuntime = new DockerRuntime(
      reconcileTransport,
      staleSettings,
      { toTarget: async (path: string) => path } as PathBridge,
      { service: "gateway" },
    );
    await reconcileRuntime.reconcile();
    const envWrite = freshWrites.find((write) => write.path.endsWith("compose.env"));
    assert.ok(envWrite, "reconcile composes from a temporary environment file");
    assert.ok(envWrite.content.includes(`${NAME}=${JSON.stringify(NEW)}`), "reconcile interpolates the value now on disk");
    assert.equal(envWrite.content.includes(OLD), false, "the snapshot value this process was built with must not reach compose");
    const up = freshCalls.find((args) => args.includes("up"));
    assert.ok(up, "reconcile runs compose up");
    assert.ok(up.includes("--detach"), "detached, like start()");
    assert.equal(up.includes("restart"), false, "restart keeps a container's environment and cannot deliver a rotated value");
    // After reconcile, later calls keep the fresh values (a stale snapshot reverted incident's token).
    freshWrites.length = 0;
    await reconcileRuntime.start();
    const after = freshWrites.find((write) => write.path.endsWith("compose.env"))?.content ?? "";
    assert.ok(after.includes(`${NAME}=${JSON.stringify(NEW)}`) && !after.includes(OLD), "after reconcile, later calls keep the fresh value");
    freshWrites.length = 0;
    await new DockerRuntime(reconcileTransport, staleSettings, { toTarget: async (path: string) => path } as PathBridge, { service: "gateway" }).start();
    const snapshot = freshWrites.find((write) => write.path.endsWith("compose.env"))?.content ?? "";
    assert.ok(snapshot.includes(`${NAME}=${JSON.stringify(OLD)}`), "start() without reconcile speaks the process-start snapshot");
    process.stderr.write("all reconcile freshness checks passed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    if (previousReconcile !== undefined) useDeployment(previousReconcile);
  }

  process.stderr.write("all compose environment checks passed\n");
} finally { if(previous!==undefined)useDeployment(previous); }

// Compose parses the values independently of the serializer; no daemon is needed.
await requires("docker", "Compose parser preserves literal values and deployment precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawforge-compose-env-check-"));
  const probe = "CLAWFORGE_COMPOSE_ENV_PROBE";
  const expected = {
    QUOTE: "a'b", TRAIL: "ends\\", BOTH: "a\\'b", SLASHES: "two\\\\", DOLLAR: "left$UNSET_X-right",
    HASH: "left # right", SPACE: " two ", DOUBLE: 'say "hello"', TAB: "one\ttwo", DOLLAR_SLASH: "\\$HOME", EMPTY: "",
  };
  const inherited = process.env[probe];
  process.env[probe] = "host-value";
  try {
    const values = { ...expected, [probe]: "deployment-value" };
    const definition = join(root, "compose.json");
    const file = join(root, "compose.env");
    await writeFile(definition, JSON.stringify({ services: { probe: { image: "busybox", environment: { PROBE: "${" + probe + "}" } } } }));
    await writeFile(file, serializeComposeEnv(values), { mode: 0o600 });
    const result = await spawnLocal("docker", ["compose", "--env-file", file, "--file", definition, "config", "--environment"], { unsetEnv: Object.keys(values) });
    const parsed = new Map(result.stdout.split(/\r?\n/).map((line) => {
      const split = line.indexOf("=");
      return [line.slice(0, split), line.slice(split + 1)];
    }));
    for (const [name, value] of Object.entries(values)) assert.equal(parsed.get(name), value, `${name} survives Compose parsing`);
    process.stderr.write("Compose preserves literal values and deployment precedence\n");
  } finally {
    if (inherited === undefined) delete process.env[probe];
    else process.env[probe] = inherited;
    await rm(root, { recursive: true, force: true });
  }
});
