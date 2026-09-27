// `./clawforge inspect` — the operator side of the deployment: the folder's .env against the
// running container, the declaration a re-declare would read, and the local secret store
// recovery would read back from. None of the three needs the instance up to be compared,
// which is when they matter most — a stopped container is gone, and with it the values only
// these files still hold. The findings name variables and paths, never values: .env and the
// store mix a real secret with the plumbing, so nothing parsed from them is printable. See
// fixture.ts for the shared stub and on-disk deployment.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gatherInspection, renderJson, doctor } from "#framework/commands/orchestration/inspect/gather.ts";
import { status } from "#framework/commands/interface/status.ts";
import { DockerRuntime } from "#framework/runtime/runtime-docker.ts";
import { blockingProblems } from "#framework/service/inspection.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { secretStoreFile, deploymentName, useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { setupFixtureDeployment, teardownFixtureDeployment, codes } from "./fixture.ts";
import type { TargetSpec } from "./fixture.ts";
import type { Context } from "#framework/core/context.ts";
import type { ConnectionFacts } from "#framework/commands/recover-env/facts.ts";
import type { ExecResult, Transport } from "#framework/runtime/transport.ts";
import type { Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

/** The fixture's stub plus, when the case asks for one, the runtime's optional answer about
 *  the running container — the capability ENV_STALE compares against, and whose absence is
 *  its own honest case below. */
function folderContext(spec: TargetSpec, facts?: ConnectionFacts): Context {
  const base = stubContext(spec);
  if (facts === undefined) return base;
  return { ...base, runtime: { ...base.runtime, runningConnectionFacts: async () => facts } } as unknown as Context;
}

const { deployment, goodChecksums, stubContext } = await setupFixtureDeployment();

async function doctorOutcome(ctx: Context): Promise<{ failed: boolean; output: string }> {
  let output = "";
  try {
    await withOutputSink((chunk) => { output += chunk; }, () => doctor(ctx, ["--json"]));
    return { failed: false, output };
  } catch {
    return { failed: true, output };
  }
}

const ENV_PATH = join(deployment, ".env");
const STORE_PATH = join(deployment, "secrets", "local.env");
const DECLARATION_PATH = join(deployment, "config", "desired-state.json");
// The exact content fixture.ts writes — restored verbatim after the cases that remove it.
const DECLARATION = JSON.stringify([
  { path: "gateway.mode", value: "local" },
  { path: "agents.defaults.model.primary", value: "zai/glm-5.3-flash" },
]);

// The sentinel the cases plant in .env (real ones mix it in beside the connection facts) —
// the one string this file may assert about, and only as the needle of an includes() that
// must come back false.
const TOKEN = "tok-folder-check-secret-value";

// The container as the stub answers for it; the .env below matches it fact for fact.
const CONTAINER_FACTS: ConnectionFacts = {
  dataDir: "/srv/clawforge/data",
  port: "18790",
  composeProject: "folder-check",
  image: "ghcr.io/openclaw/openclaw:extended-stable",
};
const MATCHING_ENV = [
  "OC_DATA_DIR=/srv/clawforge/data",
  "OPENCLAW_GATEWAY_PORT=18790",
  "OC_COMPOSE_PROJECT=folder-check",
  "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable",
  `OPENCLAW_GATEWAY_TOKEN=${TOKEN}`,
  // Not a connection fact: nothing may care about it beyond the comparison's silence.
  "KEEP_ME=keep",
  "",
].join("\n");
const STALE_ENV = MATCHING_ENV.replace("OPENCLAW_GATEWAY_PORT=18790", "OPENCLAW_GATEWAY_PORT=9999");
// The complete store: every required-and-present name holds a value — ZAI_API_KEY (provider
// "zai") AND OPENCLAW_GATEWAY_TOKEN, which is required from repo-env and therefore also the
// store's business the moment a store file exists.
const COMPLETE_STORE = "ZAI_API_KEY=k\nOPENCLAW_GATEWAY_TOKEN=stored-gateway-token\n";
// A store in use but missing one value — the one name the case is about.
const INCOMPLETE_STORE = "OPENCLAW_GATEWAY_TOKEN=stored-gateway-token\n";

const CLEAN = { targetEnv: COMPLETE_STORE, mirrorChecksums: goodChecksums };

// Between cases: bare folder again, declaration exactly as the fixture wrote it.
async function reset(): Promise<void> {
  await rm(ENV_PATH, { force: true });
  await rm(STORE_PATH, { force: true });
  await writeFile(DECLARATION_PATH, DECLARATION);
}

async function writeEnv(content: string): Promise<void> {
  await writeFile(ENV_PATH, content, "utf8");
}

async function writeStore(content: string): Promise<void> {
  await mkdir(resolve(deployment, "secrets"), { recursive: true });
  await writeFile(STORE_PATH, content, "utf8");
}

// Every inspection answer and every doctor run passes through these, so the one assertion
// the token may appear in is about all of them at once.
let allJson = "";
let allOutput = "";

try {
  // --- A. the false positive: a folder that matches -----------------------------------------

  {
    await reset();
    await writeEnv(MATCHING_ENV);
    await writeStore(COMPLETE_STORE);
    const inspection = await gatherInspection(folderContext(CLEAN, CONTAINER_FACTS));
    allJson += JSON.stringify(renderJson(inspection));
    check("a folder that matches the running container produces no finding", inspection.problems, []);
    check("every fact is observed, in table order, as a match", inspection.observed.connectionFacts, [
      { name: "OC_DATA_DIR", state: "match" },
      { name: "OPENCLAW_GATEWAY_PORT", state: "match" },
      { name: "OC_COMPOSE_PROJECT", state: "match" },
      { name: "OPENCLAW_IMAGE", state: "match" },
    ]);
    check("the store is observed complete", inspection.observed.secretStore, { file: secretStoreFile("local"), missing: [] });
    check("no .env value reaches the answer", JSON.stringify(renderJson(inspection)).includes(TOKEN), false);
  }

  // --- B. one drifted fact, named and valueless ----------------------------------------------

  {
    await reset();
    await writeEnv(STALE_ENV);
    await writeStore(COMPLETE_STORE);
    const inspection = await gatherInspection(folderContext(CLEAN, CONTAINER_FACTS));
    allJson += JSON.stringify(renderJson(inspection));
    const findings = inspection.problems.filter((entry) => entry.code === "ENV_STALE");
    const detail = findings[0]?.detail ?? "";
    check("one drifted port is the only finding", codes(inspection.problems), ["ENV_STALE"]);
    check("the finding is advisory", findings.map((entry) => entry.severity), ["warning"]);
    check("the finding names which variable drifted", detail.includes("OPENCLAW_GATEWAY_PORT"), true);
    check("and no other fact's name", [detail.includes("OC_DATA_DIR"), detail.includes("OC_COMPOSE_PROJECT"), detail.includes("OPENCLAW_IMAGE")], [false, false, false]);
    check("neither side's port value reaches the answer", [JSON.stringify(renderJson(inspection)).includes("9999"), JSON.stringify(renderJson(inspection)).includes("18790")], [false, false]);
    check("the token beside them stays out too", JSON.stringify(renderJson(inspection)).includes(TOKEN), false);
    check("the stale fact is named in the observations, the matches beside it", inspection.observed.connectionFacts, [
      { name: "OC_DATA_DIR", state: "match" },
      { name: "OPENCLAW_GATEWAY_PORT", state: "stale" },
      { name: "OC_COMPOSE_PROJECT", state: "match" },
      { name: "OPENCLAW_IMAGE", state: "match" },
    ]);
  }

  // --- B2. UX-03: an empty OC_COMPOSE_PROJECT is the directory-derived default, not drift -----

  {
    await reset();
    await writeEnv(MATCHING_ENV.replace("OC_COMPOSE_PROJECT=folder-check", "OC_COMPOSE_PROJECT="));
    await writeStore(COMPLETE_STORE);
    // The container the runtime computes for an unset override IS deploymentName() (deployment.ts's
    // composeProjectName()) — the same directory-derived name a fresh bootstrap's container carries.
    const facts = { ...CONTAINER_FACTS, composeProject: deploymentName() };
    const inspection = await gatherInspection(folderContext(CLEAN, facts));
    allJson += JSON.stringify(renderJson(inspection));
    check("an empty OC_COMPOSE_PROJECT matching the directory-derived name is not ENV_STALE", inspection.problems, []);
    check("the fact is observed as a match, not stale", inspection.observed.connectionFacts, [
      { name: "OC_DATA_DIR", state: "match" },
      { name: "OPENCLAW_GATEWAY_PORT", state: "match" },
      { name: "OC_COMPOSE_PROJECT", state: "match" },
      { name: "OPENCLAW_IMAGE", state: "match" },
    ]);
  }

  // --- B3. an empty OC_COMPOSE_PROJECT still reports a genuinely different running project ----

  {
    await reset();
    await writeEnv(MATCHING_ENV.replace("OC_COMPOSE_PROJECT=folder-check", "OC_COMPOSE_PROJECT="));
    await writeStore(COMPLETE_STORE);
    const facts = { ...CONTAINER_FACTS, composeProject: "genuinely-different-project" };
    const inspection = await gatherInspection(folderContext(CLEAN, facts));
    allJson += JSON.stringify(renderJson(inspection));
    check("an empty OC_COMPOSE_PROJECT still reports a genuinely different running project", codes(inspection.problems), ["ENV_STALE"]);
    check("the finding names the compose project", inspection.problems[0]?.detail.includes("OC_COMPOSE_PROJECT") ?? false, true);
  }

  // --- C. a store that exists but is missing a required value ---------------------------------

  {
    await reset();
    await writeEnv(MATCHING_ENV);
    await writeStore(INCOMPLETE_STORE);
    const inspection = await gatherInspection(folderContext(CLEAN, CONTAINER_FACTS));
    allJson += JSON.stringify(renderJson(inspection));
    const findings = inspection.problems.filter((entry) => entry.code === "STORE_INCOMPLETE");
    const detail = findings[0]?.detail ?? "";
    check("a store that exists missing a required value is STORE_INCOMPLETE", codes(inspection.problems), ["STORE_INCOMPLETE"]);
    check("the finding is advisory", findings.map((entry) => entry.severity), ["warning"]);
    check("it names the secret, what uses it, and where the copy belongs", detail.includes("ZAI_API_KEY") && detail.includes("provider zai") && detail.includes(secretStoreFile("local")), true);
    check("a matching .env adds no ENV_STALE beside it", inspection.problems.some((entry) => entry.code === "ENV_STALE"), false);
  }

  // --- D. the declaration is gone --------------------------------------------------------------

  {
    await reset();
    await writeEnv(MATCHING_ENV);
    await writeStore(COMPLETE_STORE);
    await rm(DECLARATION_PATH, { force: true });
    const inspection = await gatherInspection(folderContext(CLEAN, CONTAINER_FACTS));
    allJson += JSON.stringify(renderJson(inspection));
    check("a running instance with no desired-state.json is DECLARATION_MISSING", codes(inspection.problems), ["DECLARATION_MISSING"]);
    check("the finding is advisory", inspection.problems.map((entry) => entry.severity), ["warning"]);
    check("a folder nobody can re-declare from does not block the doctor", blockingProblems(inspection.problems).length, 0);
    await writeFile(DECLARATION_PATH, DECLARATION);
  }

  // --- E. all three at once, and doctor's advisory exit -----------------------------------------

  {
    await reset();
    await writeEnv(STALE_ENV);
    await writeStore(INCOMPLETE_STORE);
    await rm(DECLARATION_PATH, { force: true });
    const inspection = await gatherInspection(folderContext(CLEAN, CONTAINER_FACTS));
    allJson += JSON.stringify(renderJson(inspection));
    check("the three folder findings arrive together, and alone", codes(inspection.problems), ["DECLARATION_MISSING", "ENV_STALE", "STORE_INCOMPLETE"]);
    const outcome = await doctorOutcome(folderContext(CLEAN, CONTAINER_FACTS));
    allOutput += outcome.output;
    check("doctor does not fail on the three warnings alone", outcome.failed, false);
    const payload = JSON.parse(outcome.output) as { problems: { code: string }[] };
    const payloadCodes = payload.problems.map((entry) => entry.code);
    check("the payload still reports all three", ["DECLARATION_MISSING", "ENV_STALE", "STORE_INCOMPLETE"].every((code) => payloadCodes.includes(code)), true);
    check("the stale .env points at recover-env", outcome.output.includes("./clawforge recover-env"), true);
    check("the missing declaration points at apply-config --dump", outcome.output.includes("./clawforge apply-config --dump"), true);
    check("the incomplete store points at secrets --dump", outcome.output.includes("./clawforge secrets --dump"), true);
    check("no .env value reaches the doctor output", outcome.output.includes(TOKEN), false);
    await writeFile(DECLARATION_PATH, DECLARATION);
  }

  // --- F. stopped, on a bare folder ---------------------------------------------------------------

  {
    // DECLARATION_MISSING sits below gatherInspection's not-running early return: "missing"
    // for WHOM only has an answer while something is running to be re-declared.
    await reset();
    await rm(DECLARATION_PATH, { force: true });
    const inspection = await gatherInspection(stubContext({ mirrorChecksums: goodChecksums, running: false }));
    allJson += JSON.stringify(renderJson(inspection));
    check("a stopped instance on a bare folder reports only down and the missing secret", codes(inspection.problems), ["GATEWAY_DOWN", "SECRET_MISSING"]);
    await writeFile(DECLARATION_PATH, DECLARATION);
  }

  // --- G. STORE_INCOMPLETE survives the container being gone --------------------------------------

  {
    await reset();
    await writeEnv(MATCHING_ENV);
    await writeStore(INCOMPLETE_STORE);
    const inspection = await gatherInspection(stubContext({ ...CLEAN, running: false }));
    allJson += JSON.stringify(renderJson(inspection));
    check("an incomplete store is a finding even while stopped", codes(inspection.problems), ["GATEWAY_DOWN", "STORE_INCOMPLETE"]);
    check("the missing name is observed on the stopped answer too", inspection.observed.secretStore?.missing, ["ZAI_API_KEY"]);
  }

  // --- H. the absent store is the healthy shape ----------------------------------------------------

  {
    await reset();
    await writeEnv(MATCHING_ENV);
    const inspection = await gatherInspection(folderContext(CLEAN, CONTAINER_FACTS));
    allJson += JSON.stringify(renderJson(inspection));
    check("an absent store is not a finding — bootstrap works without one", inspection.problems, []);
    check("its absence is reported as a gap, never as completeness", inspection.observed.secretStore, undefined);
  }

  // --- I. a runtime that cannot introspect the container -------------------------------------------

  {
    await reset();
    await writeEnv(MATCHING_ENV);
    await writeStore(COMPLETE_STORE);
    const inspection = await gatherInspection(stubContext(CLEAN));
    allJson += JSON.stringify(renderJson(inspection));
    check("a runtime without the capability produces no ENV_STALE", inspection.problems, []);
    check("and reports no fact comparison at all", inspection.observed.connectionFacts, undefined);
  }

  // --- J. a name the target no longer holds is not the store's business -----------------------------

  {
    await reset();
    await writeEnv(MATCHING_ENV);
    await writeStore(INCOMPLETE_STORE);
    const inspection = await gatherInspection(stubContext({ mirrorChecksums: goodChecksums }));
    allJson += JSON.stringify(renderJson(inspection));
    check("a secret missing on the target too is SECRET_MISSING's business, not the store's", codes(inspection.problems), ["SECRET_MISSING"]);
  }
} finally {
  await teardownFixtureDeployment(deployment);
}

check("no .env value reached any inspection answer", allJson.includes(TOKEN), false);
check("no .env value reached any doctor output", allOutput.includes(TOKEN), false);

// --- K. UX-05: a deployment nobody has bootstrapped yet ------------------------------------
//
// Every runtime call that shells out to compose — even a read like `compose ps` — writes its
// own private env file into a directory beside the data directory (runtime-docker.ts's
// #withEnvFile). On a fresh deployment the data directory does not exist, and creating a
// place beside it is exactly the mkdir a still-root-owned parent refuses — before the fix a
// raw transport error ("wsl.exe ... mkdir -p <data>-locks failed (exit 1): ... Permission
// denied"), not an answer. Driven against a REAL DockerRuntime with a stubbed transport —
// the seam a hand-built Runtime stub (this file's own stubContext) cannot exercise, since the
// bug lives inside #withEnvFile itself.
{
  const NOT_BOOTSTRAPPED_DATA_DIR = "/srv/clawforge/data";

  function preBootstrapTransport(options: { dataDirExists: boolean; mkdirDetail?: string }): { transport: Transport; execLog: string[][] } {
    const execLog: string[][] = [];
    const transport = {
      description: "stub-target",
      async exists(path: string): Promise<boolean> {
        return options.dataDirExists && (path === NOT_BOOTSTRAPPED_DATA_DIR || path.startsWith(`${NOT_BOOTSTRAPPED_DATA_DIR}/`));
      },
      async readFile(path: string): Promise<string> {
        throw new Error(`ENOENT: ${path}`);
      },
      async exec(command: string, args: string[]): Promise<ExecResult> {
        execLog.push([command, ...args]);
        if (command === "stat") return { code: 1, stdout: "", stderr: "no such file" };
        return { code: 0, stdout: "", stderr: "" };
      },
      async mkdirp(path: string): Promise<void> {
        execLog.push(["mkdir", "-p", path]);
        throw new Error(
          `mkdir -p ${path} failed (exit 1): ${options.mkdirDetail ?? `mkdir: cannot create directory '${path}': Permission denied`}`,
        );
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async listFiles(): Promise<string[]> { return []; },
    } as unknown as Transport;
    return { transport, execLog };
  }

  function notBootstrappedContext(transport: Transport): Context {
    const settings = {
      dataDir: NOT_BOOTSTRAPPED_DATA_DIR,
      image: "ghcr.io/openclaw/openclaw:extended-stable",
      env: {},
      serviceUrl: "http://127.0.0.1:18789",
    } as Settings;
    const paths = { toTarget: async (path: string) => path, toContainer: (path: string) => path } as unknown as PathBridge;
    const runtime = new DockerRuntime(transport, settings, paths, { service: "gateway" });
    return { settings, transport, paths, runtime } as unknown as Context;
  }

  const previousNotBootstrapped = (() => { try { return deploymentDir(); } catch { return undefined; } })();
  const notBootstrappedDeployment = await mkdtemp(join(tmpdir(), "clawforge-not-bootstrapped-check-"));
  useDeployment(notBootstrappedDeployment);
  try {
    {
      const { transport, execLog } = preBootstrapTransport({ dataDirExists: false });
      const ctx = notBootstrappedContext(transport);
      const inspection = await gatherInspection(ctx);
      check("the answer is a clean finding, not a thrown transport error", inspection.problems.map((entry) => entry.code), ["NOT_BOOTSTRAPPED"]);
      check("the finding is blocking", inspection.problems[0]?.severity, "blocking");
      check("the remedy is bootstrap, not up", inspection.problems[0]?.nextAction, "./clawforge bootstrap");
      check("GATEWAY_DOWN is not ALSO reported — up is not a working remedy pre-bootstrap", inspection.problems.some((entry) => entry.code === "GATEWAY_DOWN"), false);
      check("the raw transport error never reaches the finding's detail", inspection.problems[0]?.detail.includes("Permission denied"), false);
      check("the mkdir this bug is about really was attempted (proving the mechanism)", execLog.some((call) => call[0] === "mkdir" && call.includes("-p")), true);
    }

    {
      const { transport } = preBootstrapTransport({ dataDirExists: false });
      const ctx = notBootstrappedContext(transport);
      let doctorOutput = "";
      let doctorError = "";
      try {
        await withOutputSink((chunk) => { doctorOutput += chunk; }, () => doctor(ctx, ["--json"]));
      } catch (caught) {
        doctorError = caught instanceof Error ? caught.message : String(caught);
      }
      check("doctor fails (NOT_BOOTSTRAPPED is blocking)", doctorError !== "", true);
      check("doctor's refusal names the code and the remedy", doctorError.includes("NOT_BOOTSTRAPPED") && doctorError.includes("./clawforge bootstrap"), true);
      check("doctor's refusal never carries the raw transport error", doctorError.includes("Permission denied"), false);
      const payload = JSON.parse(doctorOutput) as { problems: { code: string }[] };
      check("the JSON payload carries exactly the one finding", payload.problems.map((entry) => entry.code), ["NOT_BOOTSTRAPPED"]);
    }

    {
      const { transport, execLog } = preBootstrapTransport({ dataDirExists: false });
      const ctx = notBootstrappedContext(transport);
      let statusOutput = "";
      let statusError = "";
      try {
        await withOutputSink((chunk) => { statusOutput += chunk; }, () => status(ctx, []));
      } catch (caught) {
        statusError = caught instanceof Error ? caught.message : String(caught);
      }
      check("status does not throw", statusError, "");
      check("status says nothing is deployed yet", statusOutput.includes("nothing deployed yet"), true);
      check("status points at bootstrap", statusOutput.includes("./clawforge bootstrap"), true);
      check("status never prints the raw transport error", statusOutput.includes("Permission denied"), false);
      check("status stops after the first failed runtime call", execLog.filter((call) => call[0] === "mkdir").length, 1);
    }

    {
      // The boundary: a data directory that DOES exist is a different failure, never hidden
      // behind NOT_BOOTSTRAPPED.
      const { transport } = preBootstrapTransport({
        dataDirExists: true,
        mkdirDetail: "mkdir: cannot create directory '/srv/clawforge/data-locks': No space left on device",
      });
      const ctx = notBootstrappedContext(transport);
      let threw: unknown;
      try {
        await gatherInspection(ctx);
      } catch (error) {
        threw = error;
      }
      check("a mkdir failure with the data directory already present is NOT read as NOT_BOOTSTRAPPED", threw instanceof Error, true);
      check("its real cause still reaches the caller", (threw as Error | undefined)?.message.includes("No space left on device"), true);
    }
  } finally {
    if (previousNotBootstrapped !== undefined) useDeployment(previousNotBootstrapped);
    await rm(notBootstrappedDeployment, { recursive: true, force: true });
  }
}

process.stderr.write(failed === 0 ? "all inspect folder checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
