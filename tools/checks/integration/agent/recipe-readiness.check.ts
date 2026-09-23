// Regression for the audited bug (2026-09-23, P2-04): after `compose up`, install used to
// print "<name> is running" and call afterStart the instant `up` returned, with no check
// beyond "does a container from this project exist" — which a single live sidecar
// satisfies even while a multi-service recipe's own main service crashed. A recipe that
// declares `readiness.services` must now catch exactly that: primary down, sidecar up.
// Split out of recipe.check.ts, which outgrew the check-file line limit when this landed.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { listBrokenRecipes, loadRecipe, listRecipes, useRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import { DockerRuntime } from "#framework/runtime/runtime-docker.ts";
import type { Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";
import type { Transport } from "#framework/runtime/transport.ts";
import type { Stack, StackServiceState } from "#framework/runtime/runtime.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

/** Runs `fn`, returns the thrown message. Records a failure (and returns "") if it did not throw. */
async function messageOf<T>(name: string, fn: () => Promise<T>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  failed += 1;
  process.stderr.write(`  FAIL ${name}\n    expected a throw, got none\n`);
  return "";
}

/** A fresh stub `ctx` whose stack() returns spies recording build/up calls, and whose transport is
 *  an in-memory filesystem with just enough shell for the instance lock: plain `mkdir` of an
 *  existing directory fails, which is the entire acquisition mechanism — `mkdir -p` and `mkdir -m`
 *  only prepare directories, `rmdir` refuses a non-empty one, and `test -d` reads it back. Copied
 *  in reduced form from recipe.check.ts's, same reasoning as recipe-hook-freshness.check.ts's copy:
 *  check files run for their side effects, and a shared fixture would make this one's passing
 *  depend on another file's. */
function stubContext(env: Record<string, string>): { ctx: Context; calls: string[] } {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const ctx = {
    settings: { env, dataDir: "/srv/clawforge-recipe-readiness-check" },
    transport: {
      description: "stub",
      async exec(command: string, args: string[]) {
        if (command === "mkdir" && args[0] !== "-p" && args[0] !== "-m") {
          const target = args[args.length - 1];
          if (dirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
          dirs.add(target);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "mkdir") {
          dirs.add(args[args.length - 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rmdir") {
          const target = args[args.length - 1];
          const hasFile = [...files.keys()].some((entry) => entry.startsWith(`${target}/`));
          const hasChild = [...dirs].some((entry) => entry.startsWith(`${target}/`));
          if (hasFile || hasChild) return { code: 1, stdout: "", stderr: "Directory not empty" };
          dirs.delete(target);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-d") {
          return { code: dirs.has(args[1]) ? 0 : 1, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
      },
      async remove(path: string): Promise<void> {
        files.delete(path);
        dirs.delete(path);
        for (const key of files.keys()) {
          if (key.startsWith(`${path}/`)) files.delete(key);
        }
        for (const key of dirs) {
          if (key.startsWith(`${path}/`)) dirs.delete(key);
        }
      },
    },
    runtime: {
      stack() {
        return {
          async build() {
            calls.push("build");
          },
          async up() {
            calls.push("up");
          },
          async down() {},
          async status() {},
          async followLogs() {},
          async readLogs(tail: string) {
            return `stubbed log tail=${tail}\n`;
          },
          async isRunning() {
            return false;
          },
          async serviceStates() {
            return { app: { running: true } };
          },
        };
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

/** A stub stack with scripted per-poll service states, the shape install's readiness loop
 *  consumes; `states` is called once per poll. */
function stubStack(calls: string[], states: () => Record<string, StackServiceState> | Promise<Record<string, StackServiceState>>): Stack {
  return {
    async build() { calls.push("build"); },
    async up() { calls.push("up"); },
    async down() {},
    async status() {},
    async followLogs() {},
    async readLogs(tail: string) { return `stubbed log tail=${tail}\n`; },
    async isRunning() { return true; },
    // Wrapped, not assigned directly: Stack.serviceStates() must answer a promise, and the
    // readiness loop hands that answer to a bounding helper that calls .then on it.
    serviceStates: async () => states(),
  };
}

const scratch = resolve(tmpdir(), `clawforge-recipe-readiness-check-${Date.now()}`);

async function writeRecipe(name: string, json: unknown): Promise<void> {
  const dir = resolve(scratch, name);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "recipe.json"), JSON.stringify(json), "utf8");
}

try {
  await mkdir(scratch, { recursive: true });
  useRecipesDir(scratch);
  useDeployment(resolve(scratch, "example-deployment"));

  // --- install: readiness checks every required service, not just "any container alive" ----

  await writeRecipe("multi-service", {
    description: "Multi-service recipe",
    readiness: { services: ["primary", "sidecar"], timeoutMs: 50 },
  });

  {
    const { ctx, calls } = stubContext({});
    ctx.runtime.stack = () => ({
      async build() { calls.push("build"); },
      async up() { calls.push("up"); },
      async down() {},
      async status() {},
      async followLogs() {},
      async readLogs(tail: string) { return `stubbed log tail=${tail}\n`; },
      // The old, coarse probe: still true, because the sidecar is alive. Proves the fix does
      // not lean on isRunning() at all for this decision.
      async isRunning() { return true; },
      async serviceStates() {
        return { primary: { running: false }, sidecar: { running: true } };
      },
    });
    let output = "";
    let message = "";
    try {
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["install", "multi-service"]));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check("build and up still ran before readiness caught the failure", calls, ["build", "up"]);
    check("install refuses instead of silently reporting running", message.includes("did not reach a ready state"), true);
    check("the readiness detail names the failed primary service", output.includes("primary"), true);
    check("the readiness detail does not call this ready", output.includes('"status":"ready"'), false);
  }

  // The healthy counterpart: every declared service running clears readiness and afterStart runs.

  await writeRecipe("multi-service-healthy", {
    description: "Multi-service recipe, all services up",
    readiness: { services: ["primary", "sidecar"], timeoutMs: 50 },
  });

  {
    const { ctx, calls } = stubContext({});
    ctx.runtime.stack = () => ({
      async build() { calls.push("build"); },
      async up() { calls.push("up"); },
      async down() {},
      async status() {},
      async followLogs() {},
      async readLogs(tail: string) { return `stubbed log tail=${tail}\n`; },
      async isRunning() { return true; },
      async serviceStates() {
        return { primary: { running: true }, sidecar: { running: true, health: "healthy" } };
      },
    });
    let output = "";
    await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["install", "multi-service-healthy"]));
    check("build and up ran", calls, ["build", "up"]);
    check("install reports ready once every declared service is up and healthy", output.includes('"status":"ready"'), true);
  }

  // --- P3-01: malformed ports/variables are rejected at load, isolated at listing, and ---
  // --- surfaced as a visible catalog entry rather than a thrown render (docs/review- ------
  // --- 2026-09-23-xs-round-4.md) -----------------------------------------------------------

  const malformedManifests: Array<{ name: string; json: unknown; expects: string }> = [
    { name: "bad-port-host-type", json: { description: "port host is not an integer", ports: [{ host: "8080", container: 80 }] }, expects: "ports[0].host must be an integer" },
    { name: "bad-port-host-range-low", json: { description: "port host is 0", ports: [{ host: 0, container: 80 }] }, expects: "ports[0].host must be an integer between 1 and 65535" },
    { name: "bad-port-host-range-high", json: { description: "port host exceeds 65535", ports: [{ host: 70000, container: 80 }] }, expects: "ports[0].host must be an integer between 1 and 65535" },
    { name: "bad-port-null-element", json: { description: "ports array holds a null element", ports: [null] }, expects: "ports[0] must be an object" },
    { name: "bad-variables-array", json: { description: "variables is an array, not an object", variables: ["FOO"] }, expects: "variables must be an object" },
    { name: "bad-variables-value-type", json: { description: "variables has a non-string value", variables: { FOO: 42 } }, expects: "variables.FOO must be a string" },
  ];

  for (const { name, json, expects } of malformedManifests) {
    await writeRecipe(name, json);
    const message = await messageOf(`loadRecipe rejects ${name}`, () => loadRecipe(name));
    check(`${name}: error names the actual problem`, message.includes(expects), true);
  }

  const namesAfterMalformedManifests = (await listRecipes()).map((entry) => entry.name).sort();
  check(
    "(a) malformed ports/variables manifests do not break listRecipes for the working recipes",
    namesAfterMalformedManifests,
    ["multi-service", "multi-service-healthy"],
  );

  const brokenEntries = await listBrokenRecipes();
  const brokenNames = brokenEntries.map((entry) => entry.name).sort();
  check(
    "(b) every malformed manifest is reported by listBrokenRecipes, none silently dropped",
    brokenNames,
    malformedManifests.map((entry) => entry.name).sort(),
  );
  for (const { name, expects } of malformedManifests) {
    const found = brokenEntries.find((entry) => entry.name === name);
    check(`(b) listBrokenRecipes names the actual problem for ${name}`, found !== undefined && found.error.includes(expects), true);
  }

  {
    const { ctx } = stubContext({});
    let listed = "";
    await withOutputSink((chunk) => {
      listed += chunk;
    }, () => recipe(ctx, ["list"]));
    check(
      "(a) recipe list renders the working recipes without throwing over a broken manifest",
      listed.includes("multi-service"),
      true,
    );
    for (const { name } of malformedManifests) {
      check(`(b) recipe list surfaces ${name} as a visible broken entry, not a silent omission`, listed.includes(name), true);
    }
  }

  // --- P2-09 (runtime backend): the compose ps listing must include stopped containers ----
  // --- (--all) and aggregate replicas, or a crashed service silently leaves the -----------
  // --- requirement set and a surviving sidecar answers for the whole recipe ----------------

  {
    const dockerCalls: string[][] = [];
    let psOutput = "";
    const transport = {
      description: "stub",
      async mkdirp(_path: string): Promise<void> {},
      async exec(command: string, args: string[]) {
        if (command === "docker" && args.includes("ps")) {
          dockerCalls.push(args);
          return { code: 0, stdout: psOutput, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      async writeFile(_path: string, _content: string | Uint8Array, _mode?: string): Promise<void> {},
      async remove(_path: string): Promise<void> {},
    };
    const runtime = new DockerRuntime(
      transport as unknown as Transport,
      { env: {}, dataDir: "/srv/clawforge-recipe-readiness-check" } as unknown as Settings,
      { toTarget: async (path: string) => path } as unknown as PathBridge,
      { service: "app" },
    );
    const stack = runtime.stack("readiness-check", "/tmp/readiness-check/compose.yml");

    psOutput = [
      JSON.stringify({ Service: "gateway", State: "running" }),
      JSON.stringify({ Service: "worker", State: "exited" }),
    ].join("\n");
    const states = await stack.serviceStates();
    check(
      "(a) the compose ps listing is requested with --all so stopped containers are reported",
      dockerCalls.some((args) => args.includes("ps") && args.includes("--all") && args.includes("--format")),
      true,
    );
    check(
      "(a) a stopped container is part of the reported states, not filtered out of them",
      states,
      { gateway: { running: true }, worker: { running: false } },
    );

    psOutput = [
      JSON.stringify({ Service: "worker", State: "running" }),
      JSON.stringify({ Service: "worker", State: "exited" }),
      JSON.stringify({ Service: "api", State: "running", Health: "healthy" }),
      JSON.stringify({ Service: "api", State: "running", Health: "starting" }),
    ].join("\n");
    const replicas = await stack.serviceStates();
    check("(d) one stopped replica out of several keeps the whole service not running", replicas.worker?.running, false);
    check(
      "(d) one unhealthy replica out of several keeps the whole service not healthy",
      replicas.api,
      { running: true, health: "starting" },
    );
  }

  // --- P2-09 (default derivation): with no readiness declared, the required set comes -----
  // --- from the full listing, so a crashed service is a named failure, not a shrunk set ----

  await writeRecipe("no-readiness-crashed-service", {
    description: "No readiness declaration; one of two services crashed",
  });

  {
    const { ctx, calls } = stubContext({});
    ctx.runtime.stack = () => stubStack(calls, () => ({ sidecar: { running: true }, worker: { running: false } }));
    let output = "";
    let message = "";
    try {
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["install", "no-readiness-crashed-service"]));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check("(a) default readiness derivation fails install over the stopped service", message.includes("did not reach a ready state"), true);
    check("(a) the failure names the stopped service instead of accepting the live sidecar", output.includes("not running: worker"), true);
    check("(a) the default-derived readiness report never calls this ready", output.includes('"status":"ready"'), false);
  }

  // --- P2-09 (grace): a ready answer must HOLD for the grace window; a flip inside it ------
  // --- fails readiness, naming the service that flipped ------------------------------------

  await writeRecipe("ready-then-crash", {
    description: "Reports running on the first poll, crashes before the grace window closes",
  });

  {
    const { ctx, calls } = stubContext({});
    const polls: Array<Record<string, StackServiceState>> = [
      { app: { running: true } },
      { app: { running: false } },
    ];
    let poll = 0;
    ctx.runtime.stack = () => stubStack(calls, () => polls[Math.min(poll++, polls.length - 1)]);
    let output = "";
    let message = "";
    try {
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["install", "ready-then-crash"]));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check("(b) a service ready on the first poll but failed within the grace window does not pass", message.includes("did not reach a ready state"), true);
    check("(b) the flip is attributed to the grace window and names the service", output.includes("grace window") && output.includes("app"), true);
    check("(b) the grace-window flip is not reported as ready", output.includes('"status":"ready"'), false);
  }

  // --- P2-09 (probe bound): a hung serviceStates() must not defeat the readiness -----------
  // --- deadline — it fires with a timeout message and an unknown verdict -------------------

  await writeRecipe("hung-state-probe", {
    description: "serviceStates never resolves",
    readiness: { services: ["app"], timeoutMs: 50 },
  });

  {
    const { ctx, calls } = stubContext({});
    ctx.runtime.stack = () => stubStack(calls, () => new Promise<Record<string, StackServiceState>>(() => {}));
    let output = "";
    let message = "";
    const startedAt = Date.now();
    try {
      await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["install", "hung-state-probe"]));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check("(c) a hung state probe still lets the readiness deadline fire", message.includes("did not reach a ready state"), true);
    check("(c) the failure carries a timeout message and an unknown verdict, not a hang", output.includes("timed out") && output.includes('"status":"unknown"'), true);
    check("(c) the deadline bounded the hung probe instead of waiting forever", Date.now() - startedAt < 5000, true);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all recipe readiness checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
