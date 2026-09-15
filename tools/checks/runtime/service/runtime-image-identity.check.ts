// What DockerRuntime asks the target, and what it puts on the target's command line.
//
// Two topics, one stubbed transport: the image identity it reports (the running container's,
// never the configured tag) and the environment compose is given (a file, never `env VAR=…`
// arguments — the gateway token used to be visible in `ps` for the duration of every
// container command, and longest for the ones that run longest).

import assert from "node:assert/strict";
import { DockerRuntime } from "#framework/runtime/runtime-docker.ts";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import type { Transport } from "#framework/runtime/transport.ts";
import type { Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";

const previous=(()=>{try{return deploymentDir();}catch{return undefined;}})();
useDeployment("/fixture/deployment");
try {
  const calls: string[][]=[];
  let running=true;
  const transport={
    exec:async(_command:string,args:string[])=>{
      calls.push(args);
      const stdout=args[0]==="compose"?"container-one":args[0]==="inspect"
        ?JSON.stringify({Image:"sha256:running-image",State:{Running:running}})
        :JSON.stringify({RepoDigests:["repo@sha256:running-digest"],Config:{Labels:{"org.opencontainers.image.version":"v1"}}});
      return {code:0,stdout,stderr:""};
    },
    mkdirp:async()=>{},
    writeFile:async()=>{},
  } as unknown as Transport;
  const runtime=new DockerRuntime(transport,{env:{},image:"moving-tag",dataDir:"/srv/openclaw/data"} as Settings,{toTarget:async(path:string)=>path} as PathBridge,{service:"gateway"});
  const identity=await runtime.runningImageIdentity();
  assert.equal(identity?.imageId,"sha256:running-image");
  assert.equal(identity?.version,"v1");
  assert.deepEqual(identity?.digests,["repo@sha256:running-digest"]);
  assert.equal(calls.some(args=>args.includes("moving-tag")),false);
  running=false;
  assert.equal(await runtime.runningImageIdentity(),undefined);
  process.stderr.write("all running image identity checks passed\n");

  // --- the environment reaches compose as a file, not as arguments ------------------------

  const TOKEN = "gateway-token-that-must-not-be-seen";
  const env = { OPENCLAW_GATEWAY_TOKEN: TOKEN, OC_DATA_DIR: "/srv/openclaw/data", OPENCLAW_IMAGE: "ghcr.io/openclaw/openclaw:pinned" };

  const execCalls: { args: string[]; options?: { env?: Record<string, string> } }[] = [];
  const writes: { path: string; content: string; mode?: string }[] = [];
  const created: string[] = [];
  const envTransport = {
    exec: async (_command: string, args: string[], options?: { env?: Record<string, string> }) => {
      execCalls.push({ args, options });
      return { code: 0, stdout: "", stderr: "" };
    },
    mkdirp: async (path: string) => {
      created.push(path);
    },
    writeFile: async (path: string, content: string, mode?: string) => {
      writes.push({ path, content, mode });
    },
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
  assert.equal(everyArgument.includes(TOKEN), false, "nor may the token be an argument");
  assert.equal(everyArgument.some((argument) => argument.includes(TOKEN)), false, "nor part of one");
  assert.equal(everyArgument.includes("env"), false, "and no `env VAR=value` prefix is built here either");

  // Written once, beside the data directory (never inside it — restore replaces that whole
  // tree), owner-only, and carrying the WHOLE environment: --env-file replaces the project
  // directory's own .env rather than adding to it.
  assert.equal(writes.length, 1, "the environment file is written once per runtime, not per call");
  assert.equal(writes[0].path, "/srv/openclaw/data-locks/compose.env");
  assert.equal(writes[0].mode, "600");
  assert.deepEqual(created, ["/srv/openclaw/data-locks"]);
  for (const [name, value] of Object.entries(env)) {
    assert.ok(writes[0].content.includes(`${name}=${value}`), `${name} must be in the environment file`);
  }

  // The flag is a compose top-level option: after the subcommand it is not one.
  for (const call of execCalls) {
    const envFileAt = call.args.indexOf("--env-file");
    assert.notEqual(envFileAt, -1, `every compose call passes --env-file: ${call.args.join(" ")}`);
    assert.equal(call.args[envFileAt + 1], "/srv/openclaw/data-locks/compose.env");
    assert.ok(envFileAt < call.args.findIndex((argument) => argument === "up" || argument === "restart" || argument === "run"));
  }

  // A recipe's own stack goes the same way: its variables come from the deployment's .env too.
  const stack = envRuntime.stack("recipe-confluence", "/fixture/deployment/recipes/confluence/docker-compose.yml");
  execCalls.length = 0;
  await stack.up();
  assert.equal(execCalls[0].args.includes("--env-file"), true, "a side stack gets the same environment file");
  assert.equal(execCalls[0].args.includes(TOKEN), false);
  assert.equal(writes.length, 1, "and reuses the file already written");

  process.stderr.write("all compose environment checks passed\n");
} finally { if(previous!==undefined)useDeployment(previous); }
