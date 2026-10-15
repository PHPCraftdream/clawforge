// check:requires linux-host
// Direct invocation on Windows uses WSL rather than an unsupported local target.
// OC_RESTORE_DOCKER_SMOKE=1 selects real Docker containers and an HTTP/data gateway.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { UserError } from "#framework/core/io/log.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { toSettings, DEFAULT_WSL_DISTRO } from "#framework/core/env.ts";
import { LocalPathBridge } from "#framework/core/paths.ts";
import type { Context } from "#framework/core/context.ts";
import { LocalTransport, WslTransport } from "#framework/runtime/transport/transport.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { buildStack } from "#framework/runtime/docker/side-stack/index.ts";
import { composeProjectOverride, selectedDeployment, useComposeProjectOverride, useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { clearRecipesDir, useRecipesDir, recipeProjectName } from "#framework/service/recipe.ts";
import { guardedWith, lockHeldHere } from "#framework/runtime/lock/instance-lock.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { finish, typeAssert } from "#checks/kit/harness.ts";
import { restoreArchive } from "#framework/commands/lifecycle/restore/index.ts";
const restore = openclawCommands.restore.run;
const push = openclawCommands.push.run;
import { openclawCommands } from "#framework/commands/interface/index.ts";

const id = randomBytes(8).toString("hex");
const local = await mkdtemp(resolve(tmpdir(), "restore-ownership-"));
const deployment = resolve(local, `app-${id}`);
const previousRoot = selectedDeployment();
const previousOverride = composeProjectOverride();
const base: Transport = process.platform === "win32" ? new WslTransport(process.env.OC_WSL_DISTRO ?? DEFAULT_WSL_DISTRO) : new LocalTransport();
const target = (await base.exec("mktemp", ["-d", `/tmp/clawwright-restore-${id}-XXXXXX`])).stdout.trim();
const operator = (await base.exec("id", ["-u"])).stdout.trim();
const group = (await base.exec("id", ["-g"])).stdout.trim();
const fixturePrefix = operator === "0" || operator === "1000" ? [] : ["sudo", "-n"];
async function fixtureExec(command: string, args: string[]) {
  const [head, ...rest] = [...fixturePrefix, command, ...args];
  return base.exec(head, rest);
}
async function readData(path: string) {
  return (await fixtureExec("cat", [path])).stdout;
}
const data = `${target}/data`;
const archive = `${target}/snapshot.tar.gz`;
const envFile = `${target}/empty.env`;
const recipeFile = `${target}/recipes/cache/compose.yml`;
const foreignFile = `${target}/foreign/compose.yml`;
const docker = process.env.OC_RESTORE_DOCKER_SMOKE === "1";
const gateway = `cf-restore-gateway-${id}`;
const events: string[] = [];
const records = new Map<string, { file: string; running: boolean }>();
const containerId = (project: string) => createHash("sha256").update(project).digest("hex");
let wrappedQueries = 0;
const ownershipRefusal = (error: unknown): boolean => {
  assert.ok(error instanceof UserError);
  assert.equal(error.cause, undefined, "ownership refusal discards raw inventory errors");
  assert.ok(!String(error).includes("fixture-daemon-secret"));
  return true;
};
const projects = new Set<string>();
let running = false;
let healthWaits = 0;
let preview = false;
let unknown = false;
let ctx: Context;
const transport: Transport = {
  description: `restore-fixture:${base.description}:${id}`,
  readFile: base.readFile.bind(base), writeFile: base.writeFile.bind(base),
  exists: base.exists.bind(base), mkdirp: base.mkdirp.bind(base), remove: base.remove.bind(base),
  listFiles: base.listFiles.bind(base), clientInvocation: base.clientInvocation.bind(base),
  async exec(command, args, options) {
    if ((command === "mv" && args[0] === data) || (command === "tar" && args.includes("-xzf"))) events.push(command);
    const wrapped = command === "sh" && args[2] === "recipe-docker";
    const dockerArgs = wrapped ? args.slice(3) : command === "docker" ? args : undefined;
    if (wrapped) {
      assert.equal(args[0], "-c");
      assert.equal(options?.allowFailure, true);
      assert.equal(options?.stream, false);
      wrappedQueries++;
    }
    if (dockerArgs?.[0] === "ps") {
      assert.equal(lockHeldHere(ctx), !preview, "execution holds the lock; preview is read-only and lock-free");
      if (unknown) throw new Error("recipe inventory unavailable: fixture-daemon-secret");
      if (!docker) {
        const project = dockerArgs.find((arg) => arg.startsWith("label=com.docker.compose.project="))?.split("=")[2] ?? "";
        const record = records.get(project);
        return { code: 0, stdout: record !== undefined && (dockerArgs.includes("--all") || record.running) ? containerId(project) : "", stderr: "" };
      }
    }
    if (!docker && dockerArgs?.[0] === "inspect") {
      const requested = dockerArgs.slice(1);
      assert.ok(requested.every((item) => [...records.keys()].some((project) => containerId(project) === item)), "inspect only known full container IDs");
      return { code: 0, stderr: "", stdout: JSON.stringify([...records].filter(([project]) => requested.includes(containerId(project))).map(([project, record]) => ({
        Id: containerId(project), Image: `sha256:${containerId("image")}`,
        Config: { Env: [], Labels: {
          "com.docker.compose.project": project,
          "com.docker.compose.service": "cache",
          "com.docker.compose.project.working_dir": record.file.slice(0, record.file.lastIndexOf("/")),
          "com.docker.compose.project.config_files": record.file,
        } },
        State: { Status: record.running ? "running" : "exited", ExitCode: 0, Error: "", OOMKilled: false, Paused: false, Restarting: false },
        Mounts: [{ Type: "bind", Source: `${data}/workspace`, Destination: "/data", RW: false }],
        HostConfig: { RestartPolicy: { Name: "no" }, Privileged: false, Devices: [], VolumesFrom: [], Tmpfs: {} },
      }))) };
    }
    // No deterministic Docker request, including the isolated shell wrapper, reaches the host.
    if (!docker && (dockerArgs !== undefined || (command === "sh" && args.some((arg) => /\bdocker\b/.test(arg)))))
      throw new Error("unexpected Docker request in deterministic restore fixture");
    return base.exec(command, args, options);
  },
};
const paths = new LocalPathBridge([]);
paths.toTarget = async (path) => path.startsWith(local) ? `${target}${path.slice(local.length).replaceAll("\\", "/")}` : path;
const settings = toSettings({ OC_DATA_DIR: data, OC_BACKUP_DIR: `${target}/backups`, OC_SNAPSHOT_DIR: target });
const httpScript = "require('node:http').createServer((q,s)=>s.end(require('node:fs').readFileSync('/data/value'))).listen(8080,'0.0.0.0')";
const runtime = {
  async isRunning() {
    if (!docker) return running;
    const result = await base.exec("docker", ["inspect", "--format", "{{.State.Running}}", gateway], { allowFailure: true });
    return result.code === 0 && result.stdout.trim() === "true";
  },
  async stop() { events.push("stop"); if (docker) await base.exec("docker", ["stop", gateway]); running = false; },
  async start() {
    events.push("start");
    if (docker) {
      await base.exec("docker", ["rm", "--force", gateway], { allowFailure: true });
      await base.exec("docker", ["run", "--detach", "--name", gateway, "--mount", `type=bind,src=${data}/workspace,dst=/data,readonly`, "node:24", "node", "-e", httpScript]);
    }
    running = true;
  },
  async waitForHealth() {
    healthWaits++;
    if (docker) await base.exec("docker", ["exec", gateway, "node", "-e", "const end=Date.now()+10000;(async()=>{while(Date.now()<end){try{if(await (await fetch('http://127.0.0.1:8080')).text()==='B')return}catch{}await require('node:timers/promises').setTimeout(100)}process.exit(1)})()"], { timeoutMs: 15000 });
    else assert.equal(await readData(`${data}/workspace/value`), "B");
  },
  stack(project: string, definition: string, ownership?: { verifyOwnership: boolean; legacyProjects?: readonly string[]; recipeName?: string }) {
    return buildStack(transport, paths, () => settings, (action) => action(envFile), project, definition, ownership);
  },
};
ctx = { settings, transport, runtime, paths } as unknown as Context;
async function resetA() {
  if (fixturePrefix.length > 0 && await base.exists(data)) await fixtureExec("chown", ["-R", `${operator}:${group}`, data]);
  await base.mkdirp(`${data}/workspace`);
  await base.mkdirp(`${data}/config`);
  await base.writeFile(`${data}/workspace/value`, "A");
  await base.writeFile(`${data}/config/openclaw.json`, "{}");
  await base.writeFile(`${data}/config/.env`, "SENTINEL=original\n");
  await runtime.start(); events.length = 0;
}
async function compose(project: string, file: string, action: string[]) {
  await base.exec("docker", ["compose", "--project-name", project, "--file", file, ...action]);
}
async function clearPolicy() {
  records.clear();
  if (docker) for (const project of projects) await compose(project, project === recipeProjectName("cache") ? foreignFile : recipeFile, ["down"]);
}
try {
  await mkdir(deployment, { recursive: true });
  useDeployment(deployment); useComposeProjectOverride(`cf-${id}`); useRecipesDir(resolve(local, "recipes"));
  await mkdir(resolve(local, "recipes", "cache"), { recursive: true });
  await writeFile(resolve(local, "recipes", "cache", "recipe.json"), JSON.stringify({ description: "restore ownership data fixture" }));
  await writeFile(resolve(local, "recipes", "cache", "compose.yml"), "services: {}\n");
  await base.mkdirp(`${target}/recipes/cache`); await base.mkdirp(`${target}/foreign`);
  await base.writeFile(envFile, "");
  const fixtureCompose = `services:\n  cache:\n    image: node:24\n    command: [node, -e, ${JSON.stringify(httpScript)}]\n    volumes:\n      - ${data}/workspace:/data:ro\n`;
  await base.writeFile(recipeFile, fixtureCompose); await base.writeFile(foreignFile, fixtureCompose);
  await base.mkdirp(`${target}/staging/data/workspace`); await base.mkdirp(`${target}/staging/data/config`);
  await base.writeFile(`${target}/staging/data/workspace/value`, "B");
  await base.writeFile(`${target}/staging/data/config/openclaw.json`, "{}");
  await base.exec("tar", ["-czf", archive, "-C", `${target}/staging`, "data"]);
  await base.writeFile(`${archive}.secrets.env`, "SNAPSHOT_ONLY=must-not-install\n");
  const legacy = `${deploymentName()}-recipe-cache`;
  const current = recipeProjectName("cache");
  for (const policy of ["legacy", "foreign", "unknown"] as const) {
    const project = policy === "legacy" ? legacy : current;
    unknown = policy === "unknown";
    if (!unknown) {
      if (docker) { projects.add(project); await resetA(); await compose(project, policy === "legacy" ? recipeFile : foreignFile, ["up", "--detach"]); await compose(project, policy === "legacy" ? recipeFile : foreignFile, ["stop"]); }
      else records.set(project, { file: policy === "legacy" ? recipeFile : foreignFile, running: false });
    }
    // Establish why policy refuses, independently of the sanitized public error.
    preview = true;
    const evidence = await runtime.stack(current, recipeFile, { verifyOwnership: true, legacyProjects: [legacy] }).inspect!();
    if (unknown) {
      assert.ok(evidence.unknown.length > 0);
      assert.ok(evidence.unknown.every((item) => item.cause === "transport"));
      assert.ok(!JSON.stringify(evidence).includes("fixture-daemon-secret"));
    } else {
      assert.deepEqual(evidence.unknown, [], "ownership refusal must not be a malformed fixture");
      assert.equal(evidence.containers.length, 1);
      assert.equal(evidence.containers[0]?.provenance, policy === "legacy" ? "legacy" : "foreign");
      assert.equal(evidence.containers[0]?.state, "exited");
    }
    preview = false;
    for (const command of ["restore", "no-start", "push"] as const) {
      await resetA();
      let failure: unknown;
      await withOutputSink(() => {}, async () => {
        try {
          if (command === "push") await openclawCommands.push.run(ctx, [archive, "--force"]);
          else await openclawCommands.restore.run(ctx, [archive, "--force", ...(command === "no-start" ? ["--no-start"] : [])]);
        } catch (error) { failure = error; }
      });
      ownershipRefusal(failure);
      const observation = { policy, command, bytes: await base.readFile(`${data}/workspace/value`), running: await runtime.isRunning(), events: [...events], secrets: await base.readFile(`${data}/config/.env`).catch(() => "absent") };
      console.log(JSON.stringify(observation));
      assert.equal(observation.bytes, "A");
      assert.equal(observation.running, true);
      assert.deepEqual(events, []);
      assert.equal(observation.secrets, "SENTINEL=original\n");
      if (docker && !unknown) { const state = await base.exec("docker", ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`]); assert.notEqual(state.stdout.trim(), ""); }
    }
    preview = true;
    for (const command of [restore, push]) {
      await resetA();
      await assert.rejects(() => withOutputSink(() => {}, () => command(ctx, [archive, "--dry-run"])),
        ownershipRefusal);
      assert.equal(await base.readFile(`${data}/workspace/value`), "A");
      assert.equal(await runtime.isRunning(), true);
      assert.deepEqual(events, []);
    }
    preview = false;
    unknown = false; await clearPolicy();
  }
  await resetA();
  await withOutputSink(() => {}, () => openclawCommands.restore.run(ctx, [archive, "--force"]));
  assert.equal(await readData(`${data}/workspace/value`), "B"); assert.equal(await runtime.isRunning(), true); assert.equal(healthWaits, 1);
  await resetA();
  let outcome: Awaited<ReturnType<typeof restoreArchive>> | undefined;
  // The direct API uses the same execution lock as public restore.
  await withOutputSink(() => {}, async () => { outcome = await guardedWith(ctx, "restore", { breakLock: false }, () => restoreArchive(ctx, archive, { force: true, noStart: true })); });
  assert.ok(outcome);
  assert.equal(outcome.restored, true);
  assert.ok(!outcome.started);
  assert.equal(outcome.reason, "no-start");
  assert.equal(await readData(`${data}/workspace/value`), "B"); assert.equal(await runtime.isRunning(), false); assert.equal(healthWaits, 1);
  await resetA();
  await withOutputSink(() => {}, () => openclawCommands.push.run(ctx, [archive, "--force"]));
  assert.equal(await readData(`${data}/workspace/value`), "B");
  assert.equal(await readData(`${data}/config/.env`), "SNAPSHOT_ONLY=must-not-install\n");
  assert.equal(await runtime.isRunning(), true);
  assert.equal(healthWaits, 2);
  assert.ok(wrappedQueries > 0, "deterministic restore intercepts isolated sh Docker queries");
  typeAssert("public restore/no-start/push ownership refusal preserves bytes, gateway and secrets; cutover restores and starts");
} finally {
  unknown = false;
  if (docker) { await clearPolicy().catch(() => {}); await base.exec("docker", ["rm", "--force", gateway], { allowFailure: true }); }
  await fixtureExec("rm", ["-rf", target]);
  clearRecipesDir(); useComposeProjectOverride(previousOverride);
  if (previousRoot !== undefined) useDeployment(previousRoot);
  await rm(local, { recursive: true, force: true });
}
finish("restore-ownership");
