// What DockerRuntime asks the target: the image identity it reports (the running container's,
// never the configured tag), what health() says about a stopped container, and how many execs
// the container-id lookups cost. One stubbed transport, no daemon.

import assert from "node:assert/strict";
import { DockerRuntime } from "#framework/runtime/docker/runtime-docker.ts";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import type { ExecResult, Transport } from "#framework/runtime/transport/transport.ts";
import type { Settings } from "#framework/core/env.ts";
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
} finally { if(previous!==undefined)useDeployment(previous); }
