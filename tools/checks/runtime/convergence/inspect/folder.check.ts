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
import { gatherInspection, renderJson, printProblem, RECREATE_SWITCHES_IMAGES } from "#framework/commands/orchestration/inspect/gather.ts";
import { storeIncompleteDetail } from "#framework/commands/orchestration/inspect/drift.ts";
import { commandLine } from "#framework/core/io/invocation/render.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import { status } from "#framework/commands/interface/status.ts";
import { DockerRuntime } from "#framework/runtime/docker/runtime-docker.ts";
import { blockingProblems, problem } from "#framework/service/inspection.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { secretStoreFile, deploymentName, useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { currentComposition, lockFile } from "#framework/commands/management/lock.ts";
import { setupFixtureDeployment, teardownFixtureDeployment, codes } from "./fixture.ts";
import type { TargetSpec } from "./fixture.ts";
import type { Context } from "#framework/core/context.ts";
import type { ConnectionFacts } from "#framework/commands/operate/recover-env/facts.ts";
import type { ExecResult, Transport } from "#framework/runtime/transport/transport.ts";
import type { Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";
import { check, finish } from "#checks/kit/harness.ts";

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
    await withOutputSink((chunk) => { output += chunk; }, () => orchestrationCommands.doctor.run(ctx, ["--json"]));
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

  // --- A2. a key with interior whitespace is ENV_LINE_INVALID, a pure fact needing no target -----

  {
    await reset();
    const badKey = "MY KEY";
    await writeEnv(`${MATCHING_ENV}\n${badKey}=oops\n`);
    await writeStore(COMPLETE_STORE);
    const inspection = await gatherInspection(folderContext(CLEAN, CONTAINER_FACTS));
    allJson += JSON.stringify(renderJson(inspection));
    check("a key with interior whitespace is ENV_LINE_INVALID", codes(inspection.problems), ["ENV_LINE_INVALID"]);
    check("the finding is advisory", inspection.problems.map((entry) => entry.severity), ["warning"]);
    check("it names the bad key, not any value", inspection.problems[0]?.detail.includes(badKey) ?? false, true);
    check("no .env value reaches the answer", JSON.stringify(renderJson(inspection)).includes(TOKEN), false);
  }

  {
    // Available even with no target reached at all — a fact about the file, not the instance.
    await reset();
    await writeEnv(`${MATCHING_ENV}\nMY KEY=oops\n`);
    const inspection = await gatherInspection(stubContext({ mirrorChecksums: goodChecksums, running: false }));
    allJson += JSON.stringify(renderJson(inspection));
    check("ENV_LINE_INVALID is reported even on a stopped, unbootstrapped-looking folder", inspection.problems.some((entry) => entry.code === "ENV_LINE_INVALID"), true);
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

  // --- an empty OC_COMPOSE_PROJECT is the directory-derived default, not drift -----------

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

  // --- an empty OC_COMPOSE_PROJECT still reports a genuinely different running project ----

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
    check("it names the secret, what uses it, and where the copy belongs", detail.includes(storeIncompleteDetail("ZAI_API_KEY", "provider zai", secretStoreFile("local"))), true);
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
    check("the stale .env points at recover-env", outcome.output.includes(commandLine(["recover-env"])), true);
    check("the missing declaration points at apply-config --dump", outcome.output.includes(commandLine(["apply-config", "--dump"])), true);
    check("the incomplete store points at secrets --dump", outcome.output.includes(commandLine(["secrets", "--dump"])), true);
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

  // --- K. IMAGE_UNPINNED / IMAGE_TAG_MOVED: a tag is a name every OTHER deployment on this
  // Docker daemon can move out from under this one. Read straight off
  // ctx.settings.image and the runtime's own digest reads — nothing here writes anything, the
  // same as every other finding in this file. -------------------------------------------------

  const TAG = "ghcr.io/openclaw/openclaw:extended-stable";
  const RUNNING_DIGEST = "ghcr.io/openclaw/openclaw@sha256:abc";
  const MOVED_DIGEST = "ghcr.io/openclaw/openclaw@sha256:moved00000000000000000000000000000000000000000000000000000000";

  {
    await reset();
    await writeEnv(MATCHING_ENV);
    await writeStore(COMPLETE_STORE);
    const inspection = await gatherInspection(folderContext(CLEAN, CONTAINER_FACTS));
    allJson += JSON.stringify(renderJson(inspection));
    check(
      "a digest-pinned image provokes neither finding",
      inspection.problems.some((entry) => entry.code === "IMAGE_UNPINNED" || entry.code === "IMAGE_TAG_MOVED"),
      false,
    );
  }

  {
    await reset();
    await writeEnv(MATCHING_ENV);
    await writeStore(COMPLETE_STORE);
    const inspection = await gatherInspection(folderContext({ ...CLEAN, image: TAG }, CONTAINER_FACTS));
    allJson += JSON.stringify(renderJson(inspection));
    check("a bare tag is IMAGE_UNPINNED", codes(inspection.problems), ["IMAGE_UNPINNED"]);
    check("the finding is advisory", inspection.problems.map((entry) => entry.severity), ["warning"]);
    check("it names the tag", inspection.problems[0]?.detail.includes(TAG) ?? false, true);
  }

  {
    // The tag has NOT moved (imageReference() and runningImageIdentity() agree by default) —
    // IMAGE_UNPINNED alone, never paired with IMAGE_TAG_MOVED over a fact that has not happened.
    await reset();
    await writeEnv(MATCHING_ENV);
    await writeStore(COMPLETE_STORE);
    const inspection = await gatherInspection(folderContext({ ...CLEAN, image: TAG, runningDigest: RUNNING_DIGEST }, CONTAINER_FACTS));
    allJson += JSON.stringify(renderJson(inspection));
    check("a tag that has not moved is not ALSO reported as moved", codes(inspection.problems), ["IMAGE_UNPINNED"]);
  }

  {
    // The tag now resolves somewhere else than what is actually running — some OTHER
    // deployment on this daemon pulling it is exactly how. The lock is re-pinned
    // to the same "moved" digest first, the same way operator-edit.check.ts avoids an
    // incidental warning crowding a case that is not testing it: lock.ts's own digest read
    // (currentComposition's image.digest) is the identical runtime.imageReference() call this
    // finding reads, so the fixture's plain default lock would otherwise also read as drifted
    // here — a second, true but unrelated finding this case is not about.
    await reset();
    await writeEnv(MATCHING_ENV);
    await writeStore(COMPLETE_STORE);
    const movedSpec: TargetSpec = { ...CLEAN, image: TAG, localImageDigest: MOVED_DIGEST, runningDigest: RUNNING_DIGEST };
    await writeFile(lockFile(), `${JSON.stringify(await currentComposition(folderContext(movedSpec, CONTAINER_FACTS)), null, 2)}\n`, "utf8");
    const inspection = await gatherInspection(folderContext(movedSpec, CONTAINER_FACTS));
    allJson += JSON.stringify(renderJson(inspection));
    check("a moved tag reports both findings together", codes(inspection.problems), ["IMAGE_TAG_MOVED", "IMAGE_UNPINNED"]);
    const moved = inspection.problems.find((entry) => entry.code === "IMAGE_TAG_MOVED");
    check("the moved finding names the tag", moved?.detail.includes(TAG) ?? false, true);
    check("and both digests — what it now resolves to, and what is actually running", [moved?.detail.includes(MOVED_DIGEST), moved?.detail.includes(RUNNING_DIGEST)], [true, true]);
    check("and explains what a recreate would do", moved?.detail.includes(RECREATE_SWITCHES_IMAGES) ?? false, true);
    check("both findings are warnings, not blocking", inspection.problems.every((entry) => entry.severity === "warning"), true);
    // Restored for every case after this one.
    await writeFile(lockFile(), `${JSON.stringify(await currentComposition(stubContext({})), null, 2)}\n`, "utf8");
  }

  {
    // Stopped: nothing running to compare a "moved" tag against, so IMAGE_TAG_MOVED cannot
    // fire — but IMAGE_UNPINNED is a fact about .env alone, and survives being stopped.
    await reset();
    await writeEnv(MATCHING_ENV);
    await writeStore(COMPLETE_STORE);
    const inspection = await gatherInspection(stubContext({ ...CLEAN, image: TAG, running: false }));
    allJson += JSON.stringify(renderJson(inspection));
    check("IMAGE_UNPINNED survives being stopped; IMAGE_TAG_MOVED needs a running instance", codes(inspection.problems), ["GATEWAY_DOWN", "IMAGE_UNPINNED"]);
  }
} finally {
  await teardownFixtureDeployment(deployment);
}

check("no .env value reached any inspection answer", allJson.includes(TOKEN), false);
check("no .env value reached any doctor output", allOutput.includes(TOKEN), false);

// --- K. a deployment nobody has bootstrapped yet --------------------------------------------
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
        await withOutputSink((chunk) => { doctorOutput += chunk; }, () => orchestrationCommands.doctor.run(ctx, ["--json"]));
      } catch (caught) {
        doctorError = caught instanceof Error ? caught.message : String(caught);
      }
      check("doctor fails (NOT_BOOTSTRAPPED is blocking)", doctorError !== "", true);
      check("doctor's refusal names the code and the remedy", doctorError.includes("NOT_BOOTSTRAPPED") && doctorError.includes(commandLine(["bootstrap"])), true);
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
      check("status never prints the raw transport error", statusOutput.includes("Permission denied"), false);
      check("status stops after the first failed runtime call", execLog.filter((call) => call[0] === "mkdir").length, 1);
      // Captured output is always the JSON envelope for this command, whether or not --json
      // was asked for (isCaptured() — see status.ts's emitStatusReport()).
      const payload = JSON.parse(statusOutput) as { bootstrapped: boolean; running: boolean };
      check("status reports not bootstrapped instead of throwing", payload.bootstrapped, false);
      check("status reports not running", payload.running, false);
    }

    {
      // status declares only --json — any other argument (e.g. a misplaced --app) must be
      // refused before anything is even asked of the transport.
      const { transport, execLog } = preBootstrapTransport({ dataDirExists: false });
      const ctx = notBootstrappedContext(transport);
      let message: string | undefined;
      try {
        await status(ctx, ["--bogus"]);
      } catch (caught) {
        message = caught instanceof Error ? caught.message : String(caught);
      }
      check("status refuses an unknown argument", message, "unknown argument: --bogus");
      check("and never touches the transport at all", execLog.length, 0);
    }

    {
      // A bootstrapped, running instance — status --json reports the same facts as the text
      // path, structured instead of the container table.
      const runtime = {
        description: "docker",
        async isRunning() { return true; },
        async imageReference() { return "ghcr.io/openclaw/openclaw@sha256:deadbeef"; },
        async probe(endpoint: string) { return endpoint === "readyz" ? 0 : 200; },
        async health() { return "healthy"; },
        async runningConnectionFacts() { return { bindAddress: "127.0.0.1", port: "18789" }; },
      };
      const transport = {
        description: "stub-target",
        async exec() {
          return {
            code: 0,
            stdout: "12M\t/srv/clawforge/data/config\n34M\t/srv/clawforge/data/workspace\n1.0K\t/srv/clawforge/data/auth-secrets\n",
            stderr: "",
          };
        },
      } as unknown as Transport;
      const ctx = {
        settings: {
          bindAddress: "127.0.0.1",
          gatewayPort: "18789",
          dataDir: "/srv/clawforge/data",
          image: "ghcr.io/openclaw/openclaw:extended-stable",
          serviceUrl: "http://127.0.0.1:18789",
        },
        transport,
        runtime,
      } as unknown as Context;

      let output = "";
      await withOutputSink((chunk) => { output += chunk; }, () => status(ctx, ["--json"]));
      const payload = JSON.parse(output) as Record<string, unknown>;
      check("status --json parses as one JSON document", typeof payload, "object");
      check("reports bootstrapped", payload.bootstrapped, true);
      check("reports running", payload.running, true);
      check("reports the resolved image", payload.image, "ghcr.io/openclaw/openclaw@sha256:deadbeef");
      check("reports every health probe plus the runtime's own verdict", payload.health, {
        healthz: 200, startupz: 200, readyz: 0, runtime: "healthy",
      });
      check("reports exposure the same way expose status does", payload.exposure, {
        bindAddress: "127.0.0.1", port: "18789", running: true, loopback: true, wildcard: false,
      });
      check("reports data usage parsed from du -sh, size and path split apart", payload.dataUsage, [
        { size: "12M", path: "/srv/clawforge/data/config" },
        { size: "34M", path: "/srv/clawforge/data/workspace" },
        { size: "1.0K", path: "/srv/clawforge/data/auth-secrets" },
      ]);
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

// --- printProblem: a blocking finding must not read as merely a warning -----------------------

{
  // Patches the raw writer directly, not withOutputSink: that helper makes isCaptured() true,
  // which is not what a real terminal run is — the same reasoning smoke's own outcomes check
  // applies to report()'s text output.
  function captureStderr(body: () => void): string {
    const original = process.stderr.write.bind(process.stderr);
    let out = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr.write as any) = (chunk: string): boolean => { out += chunk; return true; };
    try {
      body();
    } finally {
      process.stderr.write = original;
    }
    return out;
  }

  const blockingLine = captureStderr(() => printProblem(problem("NOT_BOOTSTRAPPED", "test detail")));
  check("a blocking finding prints blocking:, not warning:", blockingLine.includes("blocking:") && !blockingLine.includes("warning:"), true);

  const warningLine = captureStderr(() => printProblem(problem("PROVIDER_MISSING", "test detail")));
  check("a warning finding still prints warning:", warningLine.includes("warning:") && !warningLine.includes("blocking:"), true);
}

finish("inspect folder");
