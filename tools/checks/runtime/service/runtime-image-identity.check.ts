// What DockerRuntime asks the target, and what it puts on the target's command line.
//
// Three topics, one stubbed transport: the image identity it reports (the running container's,
// never the configured tag), the environment compose is given (a file, never `env VAR=…`
// arguments — the gateway token used to be visible in `ps` for the duration of every
// container command, and longest for the ones that run longest), and that a
// crash-abandoned temporary environment file from a PAST call is swept before the next one,
// never a live or foreign one.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime, serializeComposeEnv } from "#framework/runtime/docker/runtime-docker.ts";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import type { ExecOptions, ExecResult, Transport } from "#framework/runtime/transport/transport.ts";
import { createTransport, spawnLocal } from "#framework/runtime/transport/transport.ts";
import { parseEnv, locksDir, type Settings } from "#framework/core/env.ts";
import { machineName, ownProcessStartedAt } from "#framework/runtime/lock/process-identity.ts";
import type { PathBridge } from "#framework/core/paths.ts";

const previous=(()=>{try{return deploymentDir();}catch{return undefined;}})();
useDeployment("/fixture/deployment");
try {
  const calls: string[][]=[];
  let running=true;
  let composePsCode = 0;
  let composePsStdout = "container-one";
  let dockerPsCode = 0;
  const transport={
    exec:async(command:string,args:string[])=>{
      calls.push(args);
      // #containerId() asks Docker directly by label rather than
      // through `docker compose ... ps` — same simulated backend state as the compose-ps
      // branch below, just a different shape of call reaching it.
      if (command === "docker" && args[0] === "ps" && args.some((arg) => arg.startsWith("label=com.docker.compose.service="))) {
        return {code:composePsCode,stdout:composePsStdout,stderr:"synthetic compose failure"};
      }
      if(command === "docker" && args[0] === "ps") return {code:dockerPsCode,stdout:"",stderr:"synthetic daemon failure"};
      if(args[0] === "compose") return {code:composePsCode,stdout:composePsStdout,stderr:"synthetic compose failure"};
      const stdout=args[0]==="inspect"
        ?JSON.stringify({Image:"sha256:running-image",State:{Running:running}})
        :JSON.stringify({RepoDigests:["repo@sha256:running-digest"],Config:{Labels:{"org.opencontainers.image.version":"v1"}}});
      return {code:0,stdout,stderr:""};
    },
    mkdirp:async()=>{},
    writeFile:async()=>{},
    remove:async()=>{},
  } as unknown as Transport;
  const runtime=new DockerRuntime(transport,{env:{},image:"moving-tag",dataDir:"/srv/openclaw/data"} as Settings,{toTarget:async(path:string)=>path} as PathBridge,{service:"gateway"});
  const identity=await runtime.runningImageIdentity();
  assert.equal(identity?.imageId,"sha256:running-image");
  assert.equal(identity?.version,"v1");
  assert.deepEqual(identity?.digests,["repo@sha256:running-digest"]);
  assert.equal(calls.some(args=>args.includes("moving-tag")),false);
  running=false;
  assert.equal(await runtime.runningImageIdentity(),undefined);
  composePsStdout = "";
  assert.equal(await runtime.isRunning(), false, "a successful empty compose ps means stopped");
  composePsCode = 125;
  await assert.rejects(runtime.isRunning(), /synthetic compose failure/);
  const probeStack = runtime.stack("recipe-probe", "/fixture/recipe/compose.yml");
  assert.equal(await probeStack.isRunning(), false, "a successful empty Docker ps means no sidecar is running");
  dockerPsCode = 125;
  await assert.rejects(probeStack.isRunning(), /synthetic daemon failure/);
  process.stderr.write("all running image identity checks passed\n");

  // --- health() distinguishes missing / stopped / starting / healthy / unhealthy ----------
  //
  // Docker leaves the LAST healthcheck verdict in `.State.Health.Status` in place after a
  // plain `docker stop` rather than clearing it — a container stopped while healthy, or one
  // that failed its last check right before stopping, both used to read "unhealthy" for as
  // long as they sat stopped. `.State.Running` is checked FIRST, before the health verdict is
  // even asked about.
  {
    const healthSettings = { env: {}, dataDir: "/srv/openclaw/data", image: "x" } as Settings;
    const healthPaths = { toTarget: async (path: string) => path } as unknown as PathBridge;

    /** A container that answers `docker ps --all --quiet --filter label=...` with
     *  "container-one", and `docker inspect` with EXACTLY the text health()'s own format
     *  string produces (`"{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}
     *  {{else}}none{{end}}"`) for the given running/health-status pair. No container at all
     *  when `present` is false; a failing inspect when `inspectCode` is given non-zero. */
    function runtimeReportingHealth(options: { present?: boolean; inspectCode?: number; running?: boolean; healthStatus?: string }): DockerRuntime {
      const present = options.present ?? true;
      const healthTransport = {
        description: "stub",
        async exec(command: string, args: string[]): Promise<ExecResult> {
          if (command === "docker" && args[0] === "ps") {
            return { code: 0, stdout: present ? "container-one\n" : "", stderr: "" };
          }
          if (command === "docker" && args[0] === "inspect") {
            if (options.inspectCode !== undefined && options.inspectCode !== 0) {
              return { code: options.inspectCode, stdout: "", stderr: "no such container" };
            }
            const runningText = options.running ?? true;
            const health = options.healthStatus ?? "none";
            return { code: 0, stdout: `${runningText} ${health}\n`, stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        async mkdirp(): Promise<void> {},
        async writeFile(): Promise<void> {},
        async remove(): Promise<void> {},
      } as unknown as Transport;
      return new DockerRuntime(healthTransport, healthSettings, healthPaths, { service: "gateway" });
    }

    assert.equal(await runtimeReportingHealth({ present: false }).health(), "missing", "no container at all is missing");
    assert.equal(await runtimeReportingHealth({ inspectCode: 1 }).health(), "missing", "a container the inspect itself cannot answer for is missing");
    assert.equal(await runtimeReportingHealth({ running: true, healthStatus: "healthy" }).health(), "healthy", "a running, healthy container reports healthy");
    assert.equal(await runtimeReportingHealth({ running: true, healthStatus: "unhealthy" }).health(), "unhealthy", "a running, genuinely unhealthy container still reports unhealthy");
    assert.equal(await runtimeReportingHealth({ running: true, healthStatus: "none" }).health(), "none", "a running container with no healthcheck at all reports none");
    // The bug's exact repro: stopped WHILE it was healthy, and Docker never cleared the field.
    assert.equal(await runtimeReportingHealth({ running: false, healthStatus: "healthy" }).health(), "stopped", "a stopped container that was healthy before stopping reports stopped, not healthy");
    // The other half of the same bug: stopped mid-failure, which is exactly what read as
    // "unhealthy" before the fix.
    assert.equal(await runtimeReportingHealth({ running: false, healthStatus: "unhealthy" }).health(), "stopped", "a stopped container that last failed its check reports stopped, not unhealthy");
    assert.equal(await runtimeReportingHealth({ running: false, healthStatus: "none" }).health(), "stopped", "a stopped container with no healthcheck at all still reports stopped");
    process.stderr.write("all runtime health checks passed\n");
  }

  // --- the container-id lookup costs one exec, not a whole compose invocation -------------
  //
  // health(), startedAt(), runningConnectionFacts(), runningImageIdentity() and
  // runningEnvironment() each used to reach for their own #containerId() — a full
  // #withEnvFile round trip (mkdirp, `mkdir -m 700`, the env file write, the cleanup remove:
  // four execs, each a separate wsl.exe spawn) plus its own "docker compose ... ps ..." exec,
  // just to ask Docker "which container is this service's, right now". #containerId() now
  // asks Docker directly (`docker ps --filter label=...`, no compose invocation and no
  // environment file at all — recover-env's own bootstrap.ts already took this shortcut, for
  // the same reason). Measured for the exact bundle these five methods make in one
  // gatherInspection pass:
  //   BEFORE: 6 + 6 + 6 + 7 + 6 = 31 execs (health, startedAt, connectionFacts,
  //     imageIdentity, environment — imageIdentity paying one more for its own image
  //     inspect).
  //   AFTER:  2 + 2 + 2 + 3 + 2 = 11 execs — asserted below, so a regression that
  //     reintroduces #compose() for any of them is caught here.
  {
    const costCalls: string[][] = [];
    const costTransport = {
      description: "stub",
      async exec(command: string, args: string[]): Promise<ExecResult> {
        costCalls.push([command, ...args]);
        if (command === "docker" && args[0] === "ps") return { code: 0, stdout: "container-one\n", stderr: "" };
        if (command === "docker" && args[0] === "image") {
          return { code: 0, stdout: JSON.stringify({ RepoDigests: ["repo@sha256:image"], Config: { Labels: {} } }), stderr: "" };
        }
        if (command === "docker" && args[0] === "inspect") {
          const format = args[args.indexOf("--format") + 1] ?? "";
          if (format.includes("json")) {
            return {
              code: 0,
              stdout: JSON.stringify({
                Image: "sha256:running",
                State: { Running: true, StartedAt: "2026-09-20T00:00:00.000000000Z" },
                Config: { Env: ["A=1"] },
              }),
              stderr: "",
            };
          }
          if (format.includes("State.Health")) return { code: 0, stdout: "true healthy\n", stderr: "" };
          if (format.includes("StartedAt")) return { code: 0, stdout: "2026-09-20T00:00:00.000000000Z\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      // Never reached if #containerId() truly bypasses #withEnvFile.
      async mkdirp(): Promise<void> { costCalls.push(["mkdirp-should-not-be-called"]); },
      async writeFile(): Promise<void> { costCalls.push(["writeFile-should-not-be-called"]); },
      async remove(): Promise<void> { costCalls.push(["remove-should-not-be-called"]); },
    } as unknown as Transport;
    const costRuntime = new DockerRuntime(
      costTransport,
      { env: {}, dataDir: "/srv/openclaw/data", image: "x" } as Settings,
      { toTarget: async (path: string) => path } as unknown as PathBridge,
      { service: "gateway" },
    );

    await costRuntime.health();
    await costRuntime.startedAt();
    await costRuntime.runningConnectionFacts();
    await costRuntime.runningImageIdentity();
    await costRuntime.runningEnvironment();

    assert.equal(costCalls.some((call) => call[0].endsWith("-should-not-be-called")), false, "no #withEnvFile plumbing at all for any of the five container-id lookups");
    assert.equal(costCalls.length, 11, "the whole bundle costs 11 execs, not the old 31");
    process.stderr.write("all runtime container-lookup cost checks passed\n");
  }

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
const compose = await spawnLocal("docker", ["compose", "version"], { allowFailure: true }).catch(() => undefined);
if (compose?.code !== 0) {
  process.stderr.write("skip Compose parser check: Docker Compose is unavailable\n");
} else {
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
}

// The live counterpart: what restart cannot do and reconcile can, proven against a real
// disposable container with a synthetic value — the value in force is read back from docker
// inspect, not from anything this process mocked.
const composeLive = await spawnLocal("docker", ["compose", "version"], { allowFailure: true }).catch(() => undefined);
const runnableImage = await (async () => {
  if (composeLive?.code !== 0) return undefined;
  for (const candidate of ["alpine:3.20", "busybox:latest"]) {
    const probeImage = await spawnLocal("docker", ["image", "inspect", candidate], { allowFailure: true }).catch(() => undefined);
    if (probeImage?.code === 0) return candidate;
  }
  return undefined;
})();
if (runnableImage === undefined) {
  process.stderr.write("skip live recreate checks: Docker Compose or a runnable image is unavailable\n");
} else {
  const previousLive = (() => { try { return deploymentDir(); } catch { return undefined; } })();
  const scratch = await mkdtemp(join(tmpdir(), "clawforge-recreate-live-"));
  // The deployment directory's basename becomes the compose project name, and mkdtemp's random
  // suffix may contain uppercase — compose project names must be lowercase — so the deployment
  // is its own subdirectory named from lowercase hex instead.
  const project = `deploy-${randomBytes(6).toString("hex")}`;
  // Forward slashes even on Windows: locksDir() slices the data directory at the last "/", so
  // the runtime's temporary compose.env lands beside it only if the path carries slashes — and
  // the .env content must agree, since reconcile() re-reads that file verbatim.
  const deployDir = join(scratch, project).replaceAll("\\", "/");
  const dataDir = `${deployDir}/data`;
  const definitionPath = join(scratch, "compose.json");
  const envPath = join(deployDir, ".env");
  const NAME = "CLAWFORGE_PROBE_VAR";
  const OLD = "old-synthetic-value";
  const NEW = "new-synthetic-value";
  const envBody = (probeValue: string) =>
    `OC_DATA_DIR=${dataDir}\nOPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:pinned\n${NAME}=${probeValue}\n`;
  await mkdir(deployDir, { recursive: true });
  await writeFile(definitionPath, JSON.stringify({
    services: {
      probe: {
        image: runnableImage,
        command: ["sleep", "300"],
        environment: { [NAME]: `\${${NAME}}` },
      },
    },
  }));
  await writeFile(envPath, envBody(OLD), "utf8");
  useDeployment(deployDir);
  const local = await createTransport({ location: "local" });
  // DockerRuntime composes the framework's own docker-compose.yml (the real gateway
  // definition); the fixture proves the recreate mechanics with a scratch definition instead —
  // everything else (env-file plumbing, project naming, the up verb, real docker) is
  // unmodified, and the real instance's definition stays out of the test. Built on the local
  // transport's prototype rather than a spread: a class instance's methods do not survive one.
  const fixtureTransport: Transport = Object.assign(Object.create(Object.getPrototypeOf(local)), local, {
    exec: (command: string, args: string[], options?: ExecOptions) => {
      if (args.includes("--file")) {
        const at = args.indexOf("--file");
        const redirected = [...args];
        redirected[at + 1] = definitionPath;
        return local.exec(command, redirected, options);
      }
      return local.exec(command, args, options);
    },
  });
  // serviceUrl is never probed here: the fixture has no healthz, and the real gateway listens
  // at that URL on this machine — probing it from a check would touch the real instance.
  const runtime = new DockerRuntime(
    fixtureTransport,
    { env: parseEnv(envBody(OLD)), dataDir, image: "ghcr.io/openclaw/openclaw:pinned", serviceUrl: "http://127.0.0.1:18789" } as unknown as Settings,
    { toTarget: async (path) => path } as PathBridge,
    { service: "probe" },
  );
  try {
    // The daemon's answer, not this process's: the container id compose runs and the
    // environment docker recorded into it at creation.
    const valueInForce = async (): Promise<{ id: string; values: Map<string, string> }> => {
      const listed = await spawnLocal("docker", ["compose", "--project-name", project, "--file", definitionPath, "ps", "--quiet", "probe"]);
      const id = listed.stdout.trim();
      const inspected = await spawnLocal("docker", ["inspect", "--format", "{{json .Config.Env}}", id]);
      const entries = JSON.parse(inspected.stdout.trim()) as string[];
      return {
        id,
        values: new Map(entries.map((entry) => {
          const at = entry.indexOf("=");
          return [entry.slice(0, at), entry.slice(at + 1)] as const;
        })),
      };
    };
    await runtime.start();
    const baseline = await valueInForce();
    assert.ok(baseline.values.get(NAME) === OLD, "the created container runs the initial value");
    await runtime.restart();
    const afterRestart = await valueInForce();
    // The audited bug mechanism, pinned live: compose restart re-runs the command inside the
    // existing container, whose Config.Env was interpolated once at creation — no rotation can
    // cross that boundary, however fresh the .env on disk has become.
    assert.ok(afterRestart.id === baseline.id, "restart keeps the container compose created");
    assert.ok(afterRestart.values.get(NAME) === OLD, "restart leaves the created environment in force");
    // Rotate the deployment .env on disk; the runtime keeps the snapshot it was built with.
    await writeFile(envPath, envBody(NEW), "utf8");
    await runtime.reconcile();
    const afterReconcile = await valueInForce();
    assert.ok(afterReconcile.id !== baseline.id, "reconcile replaces the container when the interpolated environment changed");
    assert.ok(afterReconcile.values.get(NAME) === NEW, "the running container holds the rotated value");
    process.stderr.write("live recreate checks passed\n");
  } finally {
    // stop() takes the fixture project down through the same plumbing the test used; the
    // explicit down is belt and braces for the case where that plumbing itself failed.
    await runtime.stop().catch(() => {});
    await spawnLocal("docker", ["compose", "--project-name", project, "--file", definitionPath, "down", "--volumes"], { allowFailure: true }).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
    if (previousLive !== undefined) useDeployment(previousLive);
  }
}

// --- a crash-abandoned compose-<uuid> directory from a PAST call is swept ------------------
//
// A crash mid `docker compose` call (crash 139, an OOM kill — anything that skips this
// process's own finally block) used to leave `<data>-locks/compose-<uuid>/compose.env` behind
// forever, carrying OPENCLAW_GATEWAY_TOKEN in plain text. #sweepStaleComposeEnvs removes only
// ones whose recorded owner (pid, machine) is provably gone: this machine, and a pid that does
// not exist. A live pid, an unreadable/missing owner (a sibling call still mid-write toward its
// own would look the same for an instant), or a different machine's own clawforge are each
// left alone — in-memory stub only, no docker and no network.
{
  const DATA_DIR = "/srv/compose-sweep/data";
  const LOCKS = locksDir(DATA_DIR);

  function sweepTransport() {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const removed: string[] = [];
    return {
      files,
      dirs,
      removed,
      transport: {
        description: "stub",
        exec: async (command: string, args: string[]) => {
          if (command === "mkdir") dirs.add(args[args.length - 1] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        },
        readFile: async (path: string) => {
          const value = files.get(path);
          if (value === undefined) throw new Error(`no such file: ${path}`);
          return value;
        },
        writeFile: async (path: string, content: string | Uint8Array) => {
          files.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8"));
        },
        exists: async (path: string) => files.has(path) || dirs.has(path),
        mkdirp: async (path: string) => { dirs.add(path); },
        remove: async (path: string) => {
          removed.push(path);
          files.delete(path);
          dirs.delete(path);
          for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key);
        },
        listFiles: async (dir: string) => {
          const prefix = `${dir}/`;
          return [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
        },
      } as unknown as Transport,
    };
  }

  const sweepPaths = { toTarget: async (path: string) => path } as unknown as PathBridge;
  const sweepRuntime = (transport: Transport) =>
    new DockerRuntime(transport, { dataDir: DATA_DIR, env: {} } as Settings, sweepPaths, { service: "app" });

  {
    const { transport, files } = sweepTransport();
    files.set(`${LOCKS}/compose-deaddead/owner.json`, JSON.stringify({ pid: 99999999, machine: machineName(), startedAt: new Date(0).toISOString() }));
    files.set(`${LOCKS}/compose-deaddead/compose.env`, 'OPENCLAW_GATEWAY_TOKEN="leaked-token"\n');
    await sweepRuntime(transport).start();
    assert.equal(files.has(`${LOCKS}/compose-deaddead/compose.env`), false, "a dead-owner compose.env is swept");
    assert.equal(files.has(`${LOCKS}/compose-deaddead/owner.json`), false, "its owner record goes with it");
  }

  {
    const { transport, files } = sweepTransport();
    files.set(`${LOCKS}/compose-0badf00d/compose.env`, 'OPENCLAW_GATEWAY_TOKEN="leaked-token"\n');
    await sweepRuntime(transport).start();
    assert.equal(files.has(`${LOCKS}/compose-0badf00d/compose.env`), true, "a directory with no readable owner is never swept");
  }

  {
    const { transport, files } = sweepTransport();
    // This process's own real start time, not "now": localLiveness()'s reuse check compares
    // the recorded startedAt against the actual pid's start time queried live (ps/wmic) — a
    // fresh "now" here would look like a pid reused moments ago rather than this same process.
    files.set(`${LOCKS}/compose-a11e0000/owner.json`, JSON.stringify({ pid: process.pid, machine: machineName(), startedAt: ownProcessStartedAt() }));
    files.set(`${LOCKS}/compose-a11e0000/compose.env`, 'OPENCLAW_GATEWAY_TOKEN="leaked-token"\n');
    await sweepRuntime(transport).start();
    assert.equal(files.has(`${LOCKS}/compose-a11e0000/compose.env`), true, "a live owner's compose.env is never swept");
  }

  {
    const { transport, files } = sweepTransport();
    files.set(`${LOCKS}/compose-f0e1cafe/owner.json`, JSON.stringify({ pid: 99999999, machine: `${machineName()}-elsewhere`, startedAt: new Date(0).toISOString() }));
    files.set(`${LOCKS}/compose-f0e1cafe/compose.env`, 'OPENCLAW_GATEWAY_TOKEN="leaked-token"\n');
    await sweepRuntime(transport).start();
    assert.equal(files.has(`${LOCKS}/compose-f0e1cafe/compose.env`), true, "a foreign machine's directory is never swept from here");
  }

  {
    const { transport, dirs } = sweepTransport();
    await sweepRuntime(transport).start();
    assert.equal([...dirs].some((path) => path.startsWith(`${LOCKS}/compose-`)), false, "no compose-* directory survives an ordinary successful call");
  }

  process.stderr.write("all compose-env sweep checks passed\n");
}

// --- tasks #7/#8: digest resolution, a pinned recreate, and the exit code a migration
// failure (upstream: 78) is told apart from one still starting by -------------------------
{
  useDeployment("/fixture/deployment");
  const calls: { command: string; args: string[] }[] = [];
  const writes: { path: string; content: string }[] = [];
  let containerIdStdout = "container-x", exitCodeStdout = "78\n";
  const transport = {
    exec: async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === "docker" && args[0] === "buildx") {
        return args.includes("bad-registry-ref")
          ? { code: 1, stdout: "", stderr: "not found" }
          : { code: 0, stdout: "Name:      x\nMediaType: y\nDigest:    sha256:deadbeef\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "ps" && args.includes("--all")) return { code: 0, stdout: containerIdStdout, stderr: "" };
      if (args[0] === "compose" && args.includes("ps")) return { code: 0, stdout: containerIdStdout, stderr: "" };
      if (command === "docker" && args[0] === "inspect" && args.includes("{{.State.ExitCode}}")) return { code: 0, stdout: exitCodeStdout, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    mkdirp: async () => {},
    writeFile: async (path: string, content: string) => { writes.push({ path, content }); },
    remove: async () => {},
  } as unknown as Transport;
  const runtime = new DockerRuntime(
    transport,
    { env: {}, image: "ghcr.io/openclaw/openclaw:extended-stable", dataDir: "/srv/openclaw/data" } as Settings,
    { toTarget: async (path: string) => path } as PathBridge,
    { service: "gateway", reconcileSettings: async () => ({ env: { OPENCLAW_IMAGE: "old-ref" }, image: "old-ref", dataDir: "/srv/openclaw/data" } as unknown as Settings) },
  );

  assert.equal(await runtime.resolveImageDigest!("ghcr.io/openclaw/openclaw:extended-stable"), "ghcr.io/openclaw/openclaw:extended-stable@sha256:deadbeef", "resolves a tag via buildx imagetools, keeping the tag alongside the digest");
  assert.equal(calls.some((call) => call.command === "docker" && call.args.includes("pull")), false, "resolving a digest never pulls");
  assert.equal(await runtime.resolveImageDigest!("myregistry:5000/repo:tag"), "myregistry:5000/repo:tag@sha256:deadbeef", "a registry port is not mistaken for the tag separator, and the tag survives alongside it");
  assert.equal(await runtime.resolveImageDigest!("bad-registry-ref"), undefined, "an unresolvable reference answers undefined, never a guess");

  await runtime.recreateWithImage!("ghcr.io/openclaw/openclaw@sha256:pinned");
  assert.equal(writes.some((write) => write.content.includes("OPENCLAW_IMAGE") && write.content.includes("sha256:pinned")), true, "recreateWithImage pins the compose env file to the given reference");
  assert.equal(calls.some((call) => call.args.includes("up") && call.args.includes("--detach")), true, "recreateWithImage recreates through compose up");

  assert.equal(await runtime.lastExitCode!(), 78, "reads the container's own exit code");
  containerIdStdout = "";
  assert.equal(await runtime.lastExitCode!(), undefined, "no container means no exit code to read");
  process.stderr.write("all upgrade-support runtime checks passed\n");
}
