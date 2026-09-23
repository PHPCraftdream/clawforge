// P2-10's two reachability holes, driven through the REAL surfaces rather than by calling
// the underlying functions — that is the whole point of the regression:
//
//   (1) the bootstrap order. `./clawforge recover-env` dispatched through the real
//       entry/cli.ts runApp with no OC_DATA_DIR in .env must REACH recovery — its own
//       refusal is the answer, never the settings parser's "OC_DATA_DIR is not set in
//       .env" that every other command still gets. The recovery-first bootstrap is then
//       proven to fill exactly that fact from a stubbed container: two docker calls, no
//       compose anywhere.
//
//   (2) --adopt-runtime over MCP. The tool schema is generated from the shared command
//       declaration, so the flag the parser accepts and the diagnostics recommend has to
//       be declared there: a real serveMcp session lists it in tools/list, accepts it in
//       tools/call where an undeclared argument is still rejected, and the shared
//       declaration alone drives the schema, the validation and the argv.
//
// The control case in the middle pins the boundary the fix must not blur: a command
// WITHOUT the recovery dispatch still dies in the settings parser on the same .env.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runApp } from "#framework/entry/cli.ts";
import { managementCommands } from "#framework/commands/interface/groups/openclawCommands.management.ts";
import { recoverEnvBeforeContext } from "#framework/commands/recover-env/index.ts";
import { inputSchema, toArgv, validate } from "#framework/integration/mcp-schema.ts";
import { useDeployment, deploymentDir, envFile } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { spawnLocal, type ExecResult, type Transport } from "#framework/runtime/transport.ts";
import type { AppDefinition } from "#framework/core/app.ts";

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

/** Captures a run's output and turns a thrown refusal into its message. The body may be
 *  any runner — runApp resolves to a code, the recovery runners to void. */
async function capture(body: () => Promise<unknown>): Promise<{ output: string; error: string }> {
  let output = "";
  let error = "";
  try {
    await withOutputSink(
      (chunk) => {
        output += chunk;
      },
      body,
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { output, error };
}

const TOKEN = "not-a-real-token-check-only-value";

interface InspectAnswer {
  State?: { Running?: boolean };
  Mounts?: { Destination?: string; Source?: string }[];
  NetworkSettings?: { Ports?: Record<string, { HostPort?: string }[]> };
  Config?: { Labels?: Record<string, string>; Image?: string };
}

function goodInspect(): InspectAnswer {
  return {
    State: { Running: true },
    Mounts: [{ Destination: "/home/node/.openclaw", Source: "/srv/data/config" }],
    NetworkSettings: { Ports: { "18789/tcp": [{ HostPort: "18790" }] } },
    Config: {
      Labels: { "com.docker.compose.project": "fresh-project" },
      Image: "ghcr.io/openclaw/openclaw:extended-stable",
    },
  };
}

/** Answers the recovery bootstrap's label-filtered `docker ps` and inspect calls. Anything
 *  else is a failure, which is itself the
 *  assertion that no compose invocation (and no environment file on the target) is needed. */
function recoveryTransport(
  ids = "c0ffee\n",
  inspectAnswers: Record<string, InspectAnswer> = { c0ffee: goodInspect() },
): { transport: Transport; dockerCalls: string[][] } {
  const dockerCalls: string[][] = [];
  const transport = {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      if (command !== "docker") throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
      dockerCalls.push([...args]);
      if (args[0] === "ps") return { code: 0, stdout: ids, stderr: "" };
      if (args[0] === "inspect") {
        const answer = inspectAnswers[args[3] ?? ""];
        return answer === undefined
          ? { code: 1, stdout: "", stderr: "no such container" }
          : { code: 0, stdout: JSON.stringify(answer), stderr: "" };
      }
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    },
  } as unknown as Transport;
  return { transport, dockerCalls };
}

const previous = (() => {
  try { return deploymentDir(); } catch { return undefined; }
})();
const deployDir = await mkdtemp(join(tmpdir(), "clawforge-recover-env-dispatch-"));
useDeployment(deployDir);

const recoverDeclaration = managementCommands["recover-env"];
const recoverApp: AppDefinition = {
  name: "dispatch-fixture",
  description: "P2-10 dispatcher fixture",
  commands: { "recover-env": recoverDeclaration },
};

// .env WITHOUT OC_DATA_DIR — the fact recovery exists to fill, and the fact the settings
// parser dies on. Everything a transport needs is present.
const seedWithoutDataDir = [
  "OC_TARGET_LOCATION=local",
  "OPENCLAW_GATEWAY_PORT=9999",
  `OPENCLAW_GATEWAY_TOKEN=${TOKEN}`,
  "",
].join("\n");

try {
  // --- (1) the real CLI dispatcher reaches recovery with no OC_DATA_DIR -----------------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const { error } = await capture(() => runApp(recoverApp, ["recover-env"]));
    check(
      "the dispatcher reached recovery: the refusal is recovery's own, not the settings parser's",
      error.includes("not running") || error.includes("could not be inspected"),
      true,
    );
    check("the settings parser's OC_DATA_DIR refusal never appears", error.includes("OC_DATA_DIR is not set"), false);
    check("a refused recovery leaves .env byte-identical", await readFile(envFile(), "utf8"), seedWithoutDataDir);
  }

  // --- the control: without the recovery dispatch, the same .env dies in the parser ------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const plainApp: AppDefinition = {
      name: "control-fixture",
      description: "P2-10 control fixture",
      commands: { noop: { summary: "noop", run: async () => {} } },
    };
    const { error } = await capture(() => runApp(plainApp, ["noop"]));
    check("a command without the recovery dispatch still dies on the missing fact", error.includes("OC_DATA_DIR is not set"), true);
  }

  // --- (1) --help answers before anything is built, from the shared declaration ----------
  {
    const { output, error } = await capture(() => runApp(recoverApp, ["recover-env", "--help"]));
    check("recover-env --help runs without a Context and without error", error, "");
    check("the help lists --adopt-runtime from the shared declaration", output.includes("--adopt-runtime"), true);
    check("the help still lists --dry-run", output.includes("--dry-run"), true);
  }

  // --- (1) the recovery-first bootstrap fills the missing fact from the container --------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const { transport, dockerCalls } = recoveryTransport();
    const { output, error } = await capture(() => recoverEnvBeforeContext([], { transport, service: "gateway" }));
    check("the bootstrap run succeeds against a stubbed container", error, "");
    const merged = await readFile(envFile(), "utf8");
    check("the missing OC_DATA_DIR is filled from the container", merged.includes("OC_DATA_DIR=/srv/data"), true);
    check("the missing compose project is filled", merged.includes("OC_COMPOSE_PROJECT=fresh-project"), true);
    check("the missing image is filled", merged.includes("OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable"), true);
    check("a diverged port is NOT written without --adopt-runtime", merged.includes("OPENCLAW_GATEWAY_PORT=9999"), true);
    check("the container's port is nowhere in the file", merged.includes("18790"), false);
    check("the direction choice is reported", output.includes("--adopt-runtime"), true);
    check("the token line passes through untouched", merged.includes(`OPENCLAW_GATEWAY_TOKEN=${TOKEN}`), true);
    check("the read is two docker calls — no compose anywhere", dockerCalls.length, 2);
    check(
      "the ps lookup filters by Docker's own compose labels: this deployment's project, the app's service",
      dockerCalls[0]?.[0] === "ps" &&
        dockerCalls[0].includes(`label=com.docker.compose.project=${basename(deploymentDir())}`) &&
        dockerCalls[0].includes("label=com.docker.compose.service=gateway"),
      true,
    );
    check(
      "the inspect asks the found container for one whole-object JSON document",
      dockerCalls[1],
      ["inspect", "--format", "{{json .}}", "c0ffee"],
    );
  }

  // --- (1b) --adopt-runtime through the bootstrap merges the diverged values too ---------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const { transport } = recoveryTransport();
    const { error } = await capture(() => recoverEnvBeforeContext(["--adopt-runtime"], { transport, service: "gateway" }));
    check("the adopt-runtime bootstrap run succeeds", error, "");
    const merged = await readFile(envFile(), "utf8");
    check("a diverged port IS written under --adopt-runtime", merged.includes("OPENCLAW_GATEWAY_PORT=18790"), true);
    check(
      "every fact is adopted",
      merged.includes("OC_DATA_DIR=/srv/data") &&
        merged.includes("OC_COMPOSE_PROJECT=fresh-project") &&
        merged.includes("OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable"),
      true,
    );
    check("the token survives the adoption", merged.includes(`OPENCLAW_GATEWAY_TOKEN=${TOKEN}`), true);
  }

  // --- (1c) --dry-run through the bootstrap writes nothing -------------------------------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const { transport } = recoveryTransport();
    const { output, error } = await capture(() => recoverEnvBeforeContext(["--dry-run"], { transport, service: "gateway" }));
    check("the dry-run bootstrap run succeeds", error, "");
    check("a dry run leaves .env byte-identical", await readFile(envFile(), "utf8"), seedWithoutDataDir);
    check("the dry run names the fact it would fill", output.includes("OC_DATA_DIR=/srv/data"), true);
  }

  // --- (1d) stopped matches from `docker ps --all` must not hide a running instance ------
  {
    await writeFile(envFile(), seedWithoutDataDir, "utf8");
    const stopped = goodInspect();
    stopped.State = { Running: false };
    const { transport, dockerCalls } = recoveryTransport("stopped-id\nrunning-id\n", {
      "stopped-id": stopped,
      "running-id": {
        ...goodInspect(),
        Mounts: [{ Destination: "/home/node/.openclaw", Source: "/srv/live-data/config" }],
      },
    });
    const { error } = await capture(() => recoverEnvBeforeContext([], { transport, service: "gateway" }));
    check("a stopped matching container does not prevent recovery", error, "");
    check("the running container supplies the recovered data directory", (await readFile(envFile(), "utf8")).includes("OC_DATA_DIR=/srv/live-data"), true);
    check("all matching IDs are inspected until a running one is found", dockerCalls.filter((args) => args[0] === "inspect").map((args) => args[3]), ["stopped-id", "running-id"]);
  }

  // --- (2) the shared declaration drives the schema, the validation and the argv ---------
  {
    const schema = inputSchema(recoverDeclaration) as {
      properties: Record<string, { type?: string; description?: string }>;
      required: string[];
    };
    check("the generated tool schema exposes adopt-runtime", schema.properties["adopt-runtime"]?.type, "boolean");
    check("the generated tool schema still exposes dry-run", schema.properties["dry-run"]?.type, "boolean");
    check("the tool schema exposes nothing else", Object.keys(schema.properties).sort(), ["adopt-runtime", "dry-run"]);
    check("the schema carries the flag's meaning to the client", (schema.properties["adopt-runtime"]?.description ?? "").includes("authoritative"), true);
    check("validate accepts adopt-runtime", validate(recoverDeclaration, { "adopt-runtime": true }), []);
    check("validate accepts both flags together", validate(recoverDeclaration, { "dry-run": true, "adopt-runtime": true }), []);
    check("validate still rejects an undeclared argument", validate(recoverDeclaration, { "no-such-arg": true }), ["unknown argument: no-such-arg"]);
    check("validate rejects adopt-runtime given a value instead of a flag", validate(recoverDeclaration, { "adopt-runtime": "yes" }), ["adopt-runtime takes true or false"]);
    check("adopt-runtime is turned back into the argv the parser reads", toArgv(recoverDeclaration, { "adopt-runtime": true }), ["--adopt-runtime"]);
    check("adopt-runtime alone is not read-only", recoverDeclaration.readOnlyWhen?.(["--adopt-runtime"]), false);
    check("dry-run alone is still read-only", recoverDeclaration.readOnlyWhen?.(["--dry-run"]), true);
    check("the command details name the flag's meaning", (recoverDeclaration.details ?? "").includes("--adopt-runtime"), true);
  }

  // --- (2) a REAL serveMcp session: tools/list advertises it, tools/call accepts it ------
  {
    // OC_DATA_DIR is absent on purpose: MCP must run recovery without building a Context.
    const moduleUrl = (name: string) => new URL(`../../../framework/${name}.ts`, import.meta.url).href;
    const mcpScript = `
      const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp-server"))});
      const { managementCommands } = await import(${JSON.stringify(moduleUrl("commands/interface/groups/openclawCommands.management"))});
      const { useDeployment } = await import(${JSON.stringify(moduleUrl("runtime/deployment"))});
      useDeployment(${JSON.stringify(deployDir)});
      await serveMcp({
        name: "recover-fixture",
        description: "P2-10 MCP fixture",
        commands: { "recover-env": managementCommands["recover-env"] },
      });
    `;
    await writeFile(
      envFile(),
      [
        "OC_TARGET_LOCATION=local",
        `OPENCLAW_GATEWAY_TOKEN=${TOKEN}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const mcp = await spawnLocal(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", mcpScript], {
      input:
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recover-env", arguments: { "adopt-runtime": true } } })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recover-env", arguments: { "no-such": true } } })}\n`,
      timeoutMs: 30000,
    });
    check("the MCP session exits cleanly", mcp.code, 0);

    interface RpcResponse {
      id: number;
      result?: {
        tools?: { name: string; inputSchema?: { properties?: Record<string, { type?: string }> } }[];
        content?: { text?: string }[];
      };
    }
    const responses = mcp.stdout.trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as RpcResponse);

    const listed = responses.find((response) => response.id === 1);
    const tool = listed?.result?.tools?.find((entry) => entry.name === "recover-env");
    const properties = tool?.inputSchema?.properties ?? {};
    check("the live tools/list schema advertises adopt-runtime", properties["adopt-runtime"]?.type, "boolean");
    check("the live tools/list schema still advertises dry-run", properties["dry-run"]?.type, "boolean");

    const adopted = responses.find((response) => response.id === 2);
    const adoptedText = adopted?.result?.content?.[0]?.text ?? "";
    check("tools/call with adopt-runtime is not rejected as an unknown argument", adoptedText.includes("unknown argument: adopt-runtime"), false);
    check("MCP recovery reaches its own missing-container refusal with OC_DATA_DIR absent", adoptedText.includes("connection facts are recoverable only from a running container"), true);
    check("MCP recovery never reaches the settings parser's refusal", adoptedText.includes("OC_DATA_DIR is not set"), false);

    const rejected = responses.find((response) => response.id === 3);
    const rejectedText = rejected?.result?.content?.[0]?.text ?? "";
    check("tools/call with an undeclared argument IS still rejected", rejectedText.includes("unknown argument: no-such"), true);
  }
} finally {
  if (previous !== undefined) useDeployment(previous);
  await rm(deployDir, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all recover-env dispatch checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
