// Authored command regressions; disposable fixture, no real runtime execution.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { upsertEnvLine } from "#framework/core/env.ts";
import { createContext, type Context } from "#framework/core/context.ts";
import { ArgumentError } from "#framework/core/command/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { buildStack } from "#framework/runtime/docker/side-stack/index.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import type { Stack, StackInspection } from "#framework/runtime/runtime.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";

useLinuxHost();
const root = await mkdtemp(join(tmpdir(), "clawforge-recipe-inspect-"));
const fixture = await createDeploymentFixture({ root }).catch(async (error) => {
  await rm(root, { recursive: true, force: true }); throw error;
});
try {
  const envFile = join(root, ".env");
  await writeFile(envFile, upsertEnvLine(await readFile(envFile, "utf8"), "OC_COMPOSE_PROJECT", "recipe-inspect-fixture"));
  const base = await createContext({ transport: fixture.transport() });
  const holder = JSON.stringify({ operationId: "other-owner", what: "install", by: "fixture", takenAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
  const lockDirectory = join(root, "data-locks", "operation.lock");
  await mkdir(lockDirectory, { recursive: true });
  const holderFile = join(lockDirectory, "holder.json");
  await writeFile(holderFile, holder);
  const hookSentinel = "recipe inspect must not import hooks";
  for (const hook of ["prepare", "verify", "onboard"]) {
    await writeFile(join(root, "recipes", "local", `${hook}.ts`), `throw new Error(${JSON.stringify(hookSentinel)});\n`);
  }
  const recipeDirectory = join(fixture.root, "recipes", "local");
  const beforeEntries = await readdir(recipeDirectory);
  const beforeManifest = createHash("sha256").update(await readFile(join(recipeDirectory, "recipe.json"))).digest("hex");
  const evidence: StackInspection = {
    containers: [{ id: "fixture-container", project: "fixture-project", provenance: "matched", service: "api", state: "exited", exitCode: 9, imageId: "fixture-image", logs: "sanitized log", startError: "sanitized error" }],
    namespaces: [{ project: "fixture-project", status: "present" }, { project: "legacy-project", status: "unknown" }],
    unknown: [{ project: "legacy-project", cause: "transport", detail: "probe unavailable" }],
  };
  const calls: { logs?: boolean; tail?: number }[] = [];
  let supported = true;
  let builds = 0;
  const forbidden: string[] = [];
  const ctx: Context = {
    ...base,
    runtime: {
      ...base.runtime,
      stack: () => {
        builds++;
        return new Proxy({
          inspect: supported ? async (options?: { logs?: boolean; tail?: number }) => {
            calls.push(options ?? {});
            return evidence;
          } : undefined,
        }, {
          get(target, property) {
            if (property === "inspect") return target.inspect;
            return () => { forbidden.push(String(property)); throw new Error(`unexpected stack call: ${String(property)}`); };
          },
        }) as unknown as Stack;
      },
    } as Context["runtime"],
  };
  async function run(argv: string[]) {
    let output = "";
    await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, argv));
    return JSON.parse(output);
  }
  check("inspect identifies selected recipe without --json", (await run(["inspect", "local"])).recipe, "local");
  check("default log tail is bounded", calls.at(-1), { logs: true, tail: 100 });
  check("explicit JSON identifies selected recipe", (await run(["inspect", "local", "--json"])).recipe, "local");
  check("inspect lists the manifest action", (await run(["inspect", "local"])).actions, [
    { name: "x", effect: "read", description: ["no-op", "control", "action"].join(String.fromCharCode(32)), arguments: [] },
  ]);
  {
    // The human path prints to stderr; capture it by borrowing the writer for one call.
    const original = process.stderr.write.bind(process.stderr);
    let human = "";
    process.stderr.write = ((chunk: unknown) => { human += String(chunk); return true; }) as typeof process.stderr.write;
    try { await recipe(ctx, ["inspect", "local"]); } finally { process.stderr.write = original; }
    checkTrue("the human inspect line lists the action", human.includes(["action", JSON.stringify("x"), "(read)"].join(String.fromCharCode(32))));
  }
  for (const [raw, expected] of [["0", 1], ["1", 1], ["200", 200], ["999999", 200]] as const) {
    const result = await run(["inspect", "local", "--tail", raw]);
    check(`tail ${raw} is clamped in report`, result.tail, expected);
    check(`tail ${raw} is clamped before runtime`, calls.at(-1), { logs: true, tail: expected });
  }
  check("held lock remains unchanged", await readFile(holderFile, "utf8"), holder);
  check("inspect makes no lock or other transport contacts", fixture.contacts(), []);
  check("inspect never calls lifecycle or fallback stack methods", forbidden, []);

  supported = false;
  const unavailable = await run(["inspect", "local"]);
  check("unsupported inspect is unknown, not absent", unavailable.namespaces[0].status, "unknown");
  check("unsupported inspect retains one typed unknown observation", unavailable.unknown.map(({ cause }: { cause: string }) => cause), ["transport"]);
  check("unsupported inspect invents no containers", unavailable.containers, []);
  check("unsupported inspect does not use legacy fallback methods", forbidden, []);

  const before = builds;
  let missing: unknown;
  try { await run(["inspect", "absent-recipe"]); } catch (error) { missing = error; }
  checkTrue("missing name uses the existing prepare refusal", missing instanceof ArgumentError);
  check("missing name is refused before constructing a stack", builds, before);
  for (const tail of ["-1", "1.5", "not-a-number"]) {
    let error: unknown;
    try { await run(["inspect", "local", "--tail", tail]); } catch (caught) { error = caught; }
    checkTrue(`tail ${tail} uses the existing count refusal`, error instanceof ArgumentError);
  }
  check("invalid inputs make no transport contacts", fixture.contacts(), []);
  const project = "inspect-owned";
  const legacy = "inspect-legacy";
  const definition = "/srv/fixture/recipes/local/compose.yml";
  const id = "a".repeat(64);
  const secret = "inspect-private-value";
  const unicodeSecret = "秘密 café\t spaced value";
  const logInput = `service api exited\n${secret}\n${unicodeSecret}\nexit code 9`;
  const dockerReads: string[][] = [];
  const inventoryTransport: Transport = {
    ...base.transport,
    async exec(command, incoming) {
      check("real inspect uses isolated wrapper", command, "sh");
      check("real inspect wrapper protocol", incoming[2], "recipe-docker");
      const args = incoming.slice(3);
      dockerReads.push(args);
      if (args[0] === "ps") {
        if (args.includes(`label=com.docker.compose.project=${legacy}`)) return { code: 1, stdout: "", stderr: secret };
        return { code: 0, stdout: id, stderr: "" };
      }
      if (args[0] === "inspect") return { code: 0, stderr: "", stdout: JSON.stringify([{
        Id: id, Image: `sha256:${"b".repeat(64)}`, Mounts: [],
        State: { Status: "exited", ExitCode: 9, Error: unicodeSecret },
        Config: { Env: [`TOKEN=${secret}`, `PASSWORD=${unicodeSecret}`], Labels: {
          "com.docker.compose.service": "api", "com.docker.compose.project": project,
          "com.docker.compose.project.working_dir": "/srv/fixture/recipes/local",
          "com.docker.compose.project.config_files": definition,
        } },
      }]) };
      if (args[0] === "logs") return { code: 0, stdout: logInput, stderr: "" };
      throw new Error(`forbidden inventory operation: ${args[0]}`);
    },
  };
  const inventorySettings = { ...base.settings, dataDir: "/srv/fixture/data",
    backupDir: "/srv/fixture/backups", snapshotDir: "/srv/fixture/snapshots" };
  const real = buildStack(inventoryTransport, { ...base.paths, toTarget: async () => definition },
    () => inventorySettings, async () => { throw new Error("inspect requested environment write"); },
    project, definition, { verifyOwnership: true, legacyProjects: [legacy], recipeName: "local" });
  const observed = await real.inspect!({ logs: true, tail: 999999 });
  check("real inventory distinguishes present from unknown", observed.namespaces, [
    { project, status: "present" }, { project: legacy, status: "unknown" },
  ]);
  check("real inventory decodes stopped owned service", observed.containers.map(({ id, service, state, exitCode, provenance }) =>
    ({ id, service, state, exitCode, provenance })), [{ id, service: "api", state: "exited", exitCode: 9, provenance: "matched" }]);
  const logs = observed.containers[0]?.logs ?? "";
  checkTrue("real logs preserve explicit nonsecret prefix and newline boundary", logs.startsWith("service api exited\n"));
  checkTrue("real logs preserve explicit nonsecret suffix and newline boundary", logs.endsWith("\nexit code 9"));
  check("real logs preserve line boundaries", logs.split("\n").length, logInput.split("\n").length);
  checkTrue("real inventory keeps raw transport failures private", !JSON.stringify(observed).includes(secret));
  check("failed namespace retains explicit unknown evidence", observed.unknown.map(({ project, cause }) => ({ project, cause })), [{ project: legacy, cause: "transport" }]);
  checkTrue("real inventory keeps Unicode whitespace secrets private", [observed.containers[0]?.logs, observed.containers[0]?.startError, ...observed.unknown.map(x => x.detail)].every(value => !value?.includes(unicodeSecret)));
  checkTrue("real inventory uses only read-only operations", dockerReads.every((args) => ["ps", "inspect", "logs"].includes(args[0]!)));
  check("real inventory targets exactly the requested namespaces", dockerReads.filter((args) => args[0] === "ps").sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
    ["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`],
    ["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=com.docker.compose.project=${legacy}`],
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  check("real inventory inspects exactly the selected IDs", dockerReads.filter((args) => args[0] === "inspect"), [["inspect", id]]);
  check("real log request is bounded by backend for exactly the selected IDs", dockerReads.filter((args) => args[0] === "logs"), [["logs", "--tail", "200", id]]);
  check("all inspect paths preserve recipe entries", await readdir(recipeDirectory), beforeEntries);
  check("all inspect paths preserve manifest bytes", createHash("sha256").update(await readFile(join(recipeDirectory, "recipe.json"))).digest("hex"), beforeManifest);
  check("all inspect paths preserve held lock", await readFile(holderFile, "utf8"), holder);
} finally {
  await fixture.dispose();
}
finish("recipe-inspect");
