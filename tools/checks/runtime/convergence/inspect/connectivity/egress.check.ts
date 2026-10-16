// `./clawwright inspect` — the outbound half of reachability: the probe runs INSIDE the
// gateway container, because Runtime.probe() curls from the operator machine and cannot
// see a name that resolves there and nowhere else — the 2026-09-20 outage, invisible to
// every probe for a day. It asks only the endpoints the live configuration names, in one
// exec, and reports what cannot be reached as EGRESS_UNREACHABLE, a warning: the instance
// is up and the outside world is not this deployment's fault. See ../fixture.ts for the
// shared stub and on-disk deployment.

import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { EGRESS_EXEC_TIMEOUT_MS, egressProbeScript } from "#framework/commands/orchestration/inspect/egress-probe.ts";
import { gatherInspection, renderJson, printProblem } from "#framework/commands/orchestration/inspect/gather.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import { computePlan } from "#framework/commands/orchestration/plan.ts";
import { PROBLEM_CODES } from "#framework/service/inspection.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { HelperNotRunning } from "#framework/runtime/runtime.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { currentComposition } from "#framework/commands/management/lock.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "../fixture.ts";
import type { TargetSpec } from "../fixture.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

function codes(problems: readonly { code: string }[]): string[] {
  return problems.map((entry) => entry.code).sort();
}

interface ProbeAnswer { url: string; state: string; detail?: string }
interface ExecCall { service: string; command: string; args: string[]; input: string; timeoutMs?: number }

/** A context whose outbound probe is fully recorded: every exec lands in execCalls, the
 *  probe answers from `answers` keyed by raw url — the check never touches the network. */
function egressContext(
  spec: TargetSpec,
  answers: Record<string, ProbeAnswer>,
  execFails = false,
): { ctx: Context; execCalls: ExecCall[]; probeCalls: string[] } {
  const base = stubContext(spec);
  const execCalls: ExecCall[] = [];
  const probeCalls: string[] = [];
  const ctx = {
    ...base,
    runtime: {
      ...base.runtime,
      // The inbound probes (healthz/startupz/readyz — bare names, no scheme) are
      // Runtime.probe's legitimate job and keep answering 200, so the clean baseline of
      // the fixture survives; only an outbound-shaped call is recorded — and thrown on,
      // so a regression that probed the outside world from the operator machine would
      // both trip the probeCalls count below and fail the inspection's own no-finding
      // checks.
      async probe(endpoint: string): Promise<number> {
        if (!endpoint.includes("://")) return 200;
        probeCalls.push(endpoint);
        throw new Error("Runtime.probe must not be used for outbound reachability");
      },
      async execCommand(service: string, command: string, args: string[], execOptions: { input?: string; timeoutMs?: number }): Promise<ExecResult> {
        execCalls.push({ service, command, args, input: execOptions.input ?? "", timeoutMs: execOptions.timeoutMs });
        if (execFails) throw new HelperNotRunning(service);
        const urls = JSON.parse(execOptions.input ?? "[]") as string[];
        const answered = urls.map((url) => ({ ...(answers[url] ?? { state: "ok" }), url }));
        return { code: 0, stdout: JSON.stringify(answered), stderr: "" };
      },
    },
  } as unknown as Context;
  return { ctx, execCalls, probeCalls };
}

const contextFixture = await setupFixtureDeployment();
const { goodChecksums, stubContext } = contextFixture;
const deployment = await mkdtemp(resolve(tmpdir(), "clawwright-egress-check-"));
let deploymentFixture: Awaited<ReturnType<typeof createDeploymentFixture>>;
try {
  deploymentFixture = await createDeploymentFixture({ root: deployment });
} catch (error) {
  await rm(deployment, { recursive: true, force: true });
  await teardownFixtureDeployment(contextFixture.deployment);
  throw error;
}
try {
  await rm(resolve(deployment, ".env"));
  await rm(resolve(deployment, "recipes", "local"), { recursive: true });
  await writeFile(resolve(deployment, "config", "desired-state.json"), JSON.stringify([
    { path: "gateway.mode", value: "local" },
    { path: "agents.defaults.model.primary", value: "zai/glm-5.3-flash" },
  ]));
  await mkdir(resolve(deployment, "recipes", "demo", "agent"), { recursive: true });
  await writeFile(resolve(deployment, "recipes", "demo", "agent", "config.json"), JSON.stringify({
    agentId: "onboarding", mcpServerName: "demo-mcp", cronJobName: "demo-refresh", cronSchedule: "17 3 * * *",
  }));
  await writeFile(resolve(deployment, "recipes", "demo", "agent", "AGENTS.md"), "# the agent's instructions\n");
  await writeFile(resolve(deployment, "recipes", "demo", "agent", "cron-message.txt"), "refresh yourself\n");
  await writeFile(resolve(deployment, "recipes", "demo", "server.ts"), "// server\n");
  await mkdir(resolve(deployment, "recipes", "demo", "data"), { recursive: true });
  await writeFile(resolve(deployment, "recipes", "demo", "data", "page.md"), "# page\n");
  await writeFile(resolve(deployment, "config", "deployment.lock.json"),
    `${JSON.stringify(await currentComposition(stubContext({})), null, 2)}\n`, "utf8");

async function doctorOutcome(ctx: Context): Promise<{ failed: boolean; output: string }> {
  let output = "";
  try {
    await withOutputSink((chunk) => { output += chunk; }, () => orchestrationCommands.doctor.run(ctx, ["--json"]));
    return { failed: false, output };
  } catch {
    return { failed: true, output };
  }
}

// NOTE: TargetSpec.liveConfig overrides top-level keys wholesale, so "models" must be
// given whole — spreading a partial "models" in would drop providers.zai entirely.
const ENDPOINTS_LIVE = {
  gateway: { mode: "local", auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } },
  agents: { defaults: { model: { primary: "zai/glm-5.3-flash" } } },
  models: { providers: { zai: { baseUrl: "https://api.provider.example/anthropic" } } },
  channels: { telegram: { proxy: "socks5h://127.0.0.1:9050" } },
};
const CLEAN = { targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: goodChecksums };
const PROVIDER_URL = "https://api.provider.example/anthropic";
const PROXY_URL = "socks5h://127.0.0.1:9050";
const BOTH_OK = [
  { path: "models.providers.zai.baseUrl", endpoint: PROVIDER_URL, state: "ok" },
  { path: "channels.telegram.proxy", endpoint: PROXY_URL, state: "ok" },
];

  // --- A. the exec path: one exec, stdin, gateway ------------------------------------------

  {
    const { ctx, execCalls, probeCalls } = egressContext({ ...CLEAN, liveConfig: ENDPOINTS_LIVE }, {});
    const inspection = await gatherInspection(ctx);
    check("the outbound probe never goes through Runtime.probe()", probeCalls.length, 0);
    check("exactly one container exec carries the whole probe", execCalls.length, 1);
    check("the exec names the gateway service", execCalls[0]?.service, "gateway");
    check("the exec runs node -e", [execCalls[0]?.command, execCalls[0]?.args[0]], ["node", "-e"]);
    check("endpoints travel on stdin, not the command line", JSON.parse(execCalls[0]?.input ?? "[]"), [PROVIDER_URL, PROXY_URL]);
    check("every reachable endpoint is recorded, provider first", inspection.observed.egress, BOTH_OK);
    check("a fully reachable outbound config produces no finding", inspection.problems, []);
  }

  // --- B. unreachable: one finding per endpoint, advisory ----------------------------------

  {
    const { ctx } = egressContext(
      { ...CLEAN, liveConfig: ENDPOINTS_LIVE },
      { [PROVIDER_URL]: { url: PROVIDER_URL, state: "dns", detail: "ENOTFOUND" }, [PROXY_URL]: { url: PROXY_URL, state: "unreachable", detail: "ECONNREFUSED" } },
    );
    const inspection = await gatherInspection(ctx);
    const findings = inspection.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE");
    check("each unreachable endpoint is its own finding", codes(inspection.problems), ["EGRESS_UNREACHABLE", "EGRESS_UNREACHABLE"]);
    check("the finding is advisory", findings.map((entry) => entry.severity), ["warning", "warning"]);
    check("an unreachable outside world does not make a running instance unhealthy", renderJson(inspection).healthy, true);
    check("the states are recorded as observed", inspection.observed.egress?.map((entry) => entry.state), ["dns", "unreachable"]);
  }

  {
    const first = resolve(deployment, "recipes", "declared-proxy");
    const second = resolve(deployment, "recipes", "ambiguous-proxy");
    const manifest = { description: "Declared egress owner", consumerEndpoints: [{ configPath: "channels.telegram.proxy", service: "http-bridge" }] };
    await mkdir(first);
    await writeFile(resolve(first, "recipe.json"), JSON.stringify(manifest));
    await writeFile(resolve(first, "prepare.ts"), 'throw new Error("inspection must not evaluate hooks");\n');
    try {
      const answers = {
        [PROVIDER_URL]: { url: PROVIDER_URL, state: "dns", detail: "ENOTFOUND" },
        [PROXY_URL]: { url: PROXY_URL, state: "unreachable", detail: "ECONNREFUSED" },
      };
      const inspect = () => gatherInspection(egressContext({ ...CLEAN, liveConfig: ENDPOINTS_LIVE }, answers).ctx);
      const mapped = await inspect();
      const failures = mapped.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE");
      const mappedNext = failures[1]?.next;
      check("declared path selects recipe diagnostic", mappedNext?.kind === "clawwright" ? mappedNext.argv : undefined, ["recipe", "inspect", "declared-proxy", "--json"]);
      check("mapped failure identifies exact declared service", failures[1]?.detail.includes("declared-proxy") && failures[1]?.detail.includes("http-bridge"), true);
      check("unowned provider does not inherit proxy ownership", failures[0]?.next, PROBLEM_CODES.EGRESS_UNREACHABLE.next);
      check("mapping preserves actual probe results", mapped.observed.egress?.map((entry) => entry.state), ["dns", "unreachable"]);
      await mkdir(second);
      await writeFile(resolve(second, "recipe.json"), JSON.stringify(manifest));
      const ambiguous = await inspect();
      check("ambiguous ownership is reported", ambiguous.problems.some((entry) => entry.code === "SET_RECIPE_INVALID"), true);
      check("ambiguity preserves independent egress observations", ambiguous.observed.egress?.map((entry) => entry.state), ["dns", "unreachable"]);
      check("ambiguity never chooses a recipe owner", ambiguous.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE").map((entry) => entry.next), [PROBLEM_CODES.EGRESS_UNREACHABLE.next, PROBLEM_CODES.EGRESS_UNREACHABLE.next]);
      await rm(second, { recursive: true });
      await writeFile(resolve(first, "recipe.json"), '{"description":"PRIVATE_MANIFEST_VALUE","consumerEndpoints":[{"configPath":"channels.telegram.proxy","service":"../bad"}]}');
      const malformed = await inspect();
      check("malformed ownership remains an explicit gap", malformed.problems.some((entry) => entry.code === "SET_RECIPE_INVALID"), true);
      check("bad declaration does not erase other probe facts", malformed.observed.egress?.map((entry) => entry.state), ["dns", "unreachable"]);
      check("bad declaration details do not leak manifest values", malformed.problems.some((entry) => entry.detail.includes("PRIVATE_MANIFEST_VALUE")), false);
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  }

  // --- C. invalid URL, and an empty provider naming nothing --------------------------------

  {
    const { ctx, execCalls } = egressContext(
      {
        ...CLEAN,
        liveConfig: {
          ...ENDPOINTS_LIVE,
          models: { providers: { zai: {} } },
          channels: { telegram: { proxy: "not a url at all" } },
        },
      },
      { "not a url at all": { url: "not a url at all", state: "invalid" } },
    );
    const inspection = await gatherInspection(ctx);
    const findings = inspection.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE");
    check("an empty baseUrl names no endpoint", JSON.parse(execCalls[0]?.input ?? "[]"), ["not a url at all"]);
    check("invalid endpoint remains an advisory finding", findings.map((entry) => [entry.code, entry.severity]), [["EGRESS_UNREACHABLE", "warning"]]);
    check("invalid endpoint keeps its exact consumer path", inspection.observed.egress?.map((entry) => [entry.path, entry.state]), [["channels.telegram.proxy", "invalid"]]);
  }

  // --- D. nothing named, nothing asked ------------------------------------------------------

  {
    // The fixture's default live config names zero endpoints (providers.zai is empty, no
    // channels) — the probe must not exec at all rather than answer "all reachable" about
    // a question nobody asked.
    const { ctx, execCalls } = egressContext(CLEAN, {});
    const inspection = await gatherInspection(ctx);
    check("a deployment naming no endpoints asks nothing at all", execCalls.length, 0);
    check("and reports no egress observation", inspection.observed.egress, undefined);
    check("and no finding", inspection.problems, []);
  }

  // --- E. a runtime that cannot exec at all -------------------------------------------------

  {
    const inspection = await gatherInspection(stubContext(CLEAN));
    check("a runtime that cannot exec degrades to a gap, not a failure", inspection.observed.egress, undefined);
    check("and no finding", inspection.problems, []);
  }

  // --- F. the container refuses the exec ----------------------------------------------------

  {
    const { ctx } = egressContext({ ...CLEAN, liveConfig: ENDPOINTS_LIVE }, {}, true);
    const inspection = await gatherInspection(ctx);
    check("a container that refuses the exec produces no finding", inspection.problems, []);
    check("and no egress answer either", inspection.observed.egress, undefined);
  }

  // --- G. advisory: the table and doctor's exit ----------------------------------------------

  {
    const { ctx } = egressContext(
      { ...CLEAN, liveConfig: ENDPOINTS_LIVE },
      { [PROVIDER_URL]: { url: PROVIDER_URL, state: "dns", detail: "ENOTFOUND" }, [PROXY_URL]: { url: PROXY_URL, state: "unreachable", detail: "ECONNREFUSED" } },
    );
    const outcome = await doctorOutcome(ctx);
    const payload = JSON.parse(outcome.output) as { problems: { code: string }[] };
    check("the code is advisory in the table itself", PROBLEM_CODES.EGRESS_UNREACHABLE.severity, "warning");
    check("doctor exits zero on egress findings alone", outcome.failed, false);
    check("but still reports them", payload.problems.map((entry) => entry.code), ["EGRESS_UNREACHABLE", "EGRESS_UNREACHABLE"]);
  }

  // --- H. the JSON shape ---------------------------------------------------------------------

  {
    const { ctx } = egressContext({ ...CLEAN, liveConfig: ENDPOINTS_LIVE }, {});
    const inspection = await gatherInspection(ctx);
    check("inspect --json carries the egress observations on observed", (renderJson(inspection) as { observed: { egress?: unknown } }).observed.egress, BOTH_OK);
  }

  // --- I. a stopped instance is asked nothing -------------------------------------------------

  {
    // No targetEnv here: with the secret present the down finding would be the whole
    // answer, and the point is that it stands alone beside SECRET_MISSING — either way,
    // nothing may be probed on an instance that is not running.
    const { ctx, execCalls, probeCalls } = egressContext({ mirrorChecksums: goodChecksums, running: false, liveConfig: ENDPOINTS_LIVE }, {});
    const inspection = await gatherInspection(ctx);
    check("a stopped instance is never asked to reach anything", execCalls.length + probeCalls.length, 0);
    check("the down finding stands alone", codes(inspection.problems), ["GATEWAY_DOWN", "SECRET_MISSING"]);
    check("and no egress is reported for it", inspection.observed.egress, undefined);
  }

  // --- J. credentials in a proxy URL never leave the redactor ---------------------------------

  {
    const { ctx } = egressContext(
      {
        ...CLEAN,
        liveConfig: {
          ...ENDPOINTS_LIVE,
          models: { providers: { zai: {} } },
          channels: { telegram: { proxy: "socks5h://alice:not-a-real-password@tor.example:9050" } },
        },
      },
      {},
    );
    const inspection = await gatherInspection(ctx);
    check("the reported endpoint keeps its host and loses its credentials", inspection.observed.egress, [{ path: "channels.telegram.proxy", endpoint: "socks5h://***@tor.example:9050", state: "ok" }]);
    check("the credential value reaches no output at all", JSON.stringify(renderJson(inspection)).includes("not-a-real-password"), false);
  }

  {
    const declarationPath = resolve(deployment, "config", "desired-state.json");
    const original = await readFile(declarationPath, "utf8");
    const credentialUrl = "socks5h://demo-user:demo-pass@proxy.example:9050";
    const desiredUrl = "socks5h://other-user:other-pass@proxy.example:9050";
    const liveConfig = {
      channels: { telegram: { proxy: credentialUrl } },
      settings: { public: "visible", nested: { apiKey: "live-key", endpoint: "https://host.example/?token=live-token" } },
    };
    const declared = [
      { path: "channels.telegram.proxy", value: desiredUrl },
      { path: "settings", value: { public: "changed", nested: { apiKey: "declared-key", endpoint: "https://host.example/?token=declared-token" } } },
    ];
    try {
      await writeFile(declarationPath, JSON.stringify(declared));
      const ctx = stubContext({ ...CLEAN, liveConfig });
      const inspection = await gatherInspection(ctx);
      const drift = inspection.problems.filter((entry) => entry.code === "CONFIG_DRIFT");
      check("credential and unrelated nested configuration both drift", drift.map((entry) => entry.code), ["CONFIG_DRIFT"]);
      checkTrue("consolidated drift identifies both affected config paths", drift.length === 1 && drift[0]!.detail.includes("channels.telegram.proxy") && drift[0]!.detail.includes("settings"));
      check("ordinary nested values remain useful", inspection.observed.config.settings, {
        public: "visible", nested: { apiKey: "[redacted]", endpoint: "[redacted]" },
      });
      check("credential URL is redacted in observed config", inspection.observed.config["channels.telegram.proxy"], "[redacted]");
      check("credential URL is redacted in declared config", inspection.declared.config[0]?.value, "[redacted]");
      check("ordinary declared config stays readable", inspection.declared.config[1]?.value, {
        public: "changed", nested: { apiKey: "[redacted]", endpoint: "[redacted]" },
      });
      const serialized = JSON.stringify(renderJson(inspection));
      for (const secret of ["demo-user", "demo-pass", "other-user", "other-pass", "live-key", "declared-key", "live-token", "declared-token"]) {
        check(`inspect JSON excludes ${secret}`, serialized.includes(secret), false);
      }
      const plan = await computePlan(ctx);
      const planDrift = plan.problems.filter((entry) => entry.code === "CONFIG_DRIFT");
      check("plan remains aware of both config drift paths", planDrift.length, 1);
      checkTrue("plan drift identifies both affected config paths", planDrift.length === 1 && planDrift[0]!.detail.includes("channels.telegram.proxy") && planDrift[0]!.detail.includes("settings"));
      check("plan JSON excludes config credentials", JSON.stringify(plan).includes("demo-pass"), false);
      const output: string[] = [];
      await withOutputSink((chunk) => output.push(chunk), () => orchestrationCommands.inspect.run(ctx, ["--json"]));
      await withOutputSink((chunk) => output.push(chunk), async () => {
        try { await orchestrationCommands.doctor.run(ctx, ["--json"]); }
        catch { /* Config drift makes doctor fail after reporting it. */ }
      });
      for (const entry of drift) await withOutputSink((chunk) => output.push(chunk), async () => printProblem(entry));
      check("CLI/MCP and doctor problem text exclude config credentials", output.join("").includes("demo-pass"), false);
      await writeFile(declarationPath, '{"path":"settings.nested.apiKey","value":"malformed-private-value",');
      const malformed = await gatherInspection(ctx);
      check("invalid desired JSON does not expose its source", JSON.stringify(renderJson(malformed)).includes("malformed-private-value"), false);
    } finally {
      await writeFile(declarationPath, original);
    }
  }

  // --- K. the whole-exec deadline, and timeout as a first-class observation ----------------

  {
    const { ctx, execCalls } = egressContext({ ...CLEAN, liveConfig: ENDPOINTS_LIVE }, {});
    await gatherInspection(ctx);
    check("the egress exec carries a deadline of its own", execCalls[0]?.timeoutMs, EGRESS_EXEC_TIMEOUT_MS);
  }

  {
    const { ctx } = egressContext(
      { ...CLEAN, liveConfig: ENDPOINTS_LIVE },
      { [PROVIDER_URL]: { url: PROVIDER_URL, state: "timeout", detail: "no answer within 5000ms" }, [PROXY_URL]: { url: PROXY_URL, state: "ok" } },
    );
    const inspection = await gatherInspection(ctx);
    const findings = inspection.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE");
    check("a timeout answer is a finding, not a broken probe", findings.length, 1);
    check("the timeout observation is recorded as observed", inspection.observed.egress?.map((entry) => entry.state), ["timeout", "ok"]);
    check("a timed-out endpoint alone keeps the instance healthy", renderJson(inspection).healthy, true);
  }

  // --- L. the REAL probe script against servers that never finish ---------------------------
  //
  // Everything above stubs the runtime, so the script itself could hang forever and stay
  // green — the gap that motivated it. These cases exec the actual egressProbeScript() in a
  // real child node process against real localhost servers that never finish, with a
  // deliberately small budget, and require the child to EXIT ON ITS OWN with its answers —
  // never to be collected by the guard timeout below.

  async function runProbeScript(budgetMs: number, urls: string[]): Promise<{ code: number; answers: ProbeAnswer[]; elapsedMs: number }> {
    // Monotonic: the wall clock can step (VM clock sync) while the child's timer keeps running.
    const started = performance.now();
    const result = await spawnLocal(process.execPath, ["-e", egressProbeScript(budgetMs)], {
      input: JSON.stringify(urls),
      allowFailure: true,
      // Far above every budget under test: this guard exists so a regression FAILS instead
      // of hanging the whole suite. A child that needs it has already failed the checks.
      timeoutMs: 15000,
    });
    let answers: ProbeAnswer[] = [];
    try {
      answers = JSON.parse(result.stdout) as ProbeAnswer[];
    } catch {
      // The exit and answer checks below report this; nothing to add here.
    }
    return { code: result.code, answers, elapsedMs: performance.now() - started };
  }

  const httpHanging = createServer((_request, response) => {
    // Headers leave immediately; the body is never ended — the shape that used to keep the
    // probe child alive forever after fetch() had already resolved.
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("body starts and is never ended");
  });
  const silentSockets: { destroy(): void }[] = [];
  // node 18.2 gave http.Server closeAllConnections() but never net.Server, so the sockets
  // this one accepts are kept only to be destroyed by the teardown below — a server that
  // never answered must not keep the process alive on the way out either.
  const silent = createNetServer((socket) => { silentSockets.push(socket); });
  try {
    await new Promise<void>((resolve) => httpHanging.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const httpPort = (httpHanging.address() as { port: number }).port;
    const silentPort = (silent.address() as { port: number }).port;

    {
      const url = `http://127.0.0.1:${httpPort}/never-ends`;
      const run = await runProbeScript(1500, [url]);
      check("a body that never ends does not keep the probe child alive", run.code, 0);
      check("headers alone still prove reachability", run.answers, [{ url, state: "ok" }]);
      check("the child exited on its own, well before the guard", run.elapsedMs < 10000, true);
    }

    {
      // A credentialed HTTP proxy URL (channels.telegram.proxy): fetch refuses userinfo
      // outright, so the probe must ask without it — and still answer with the URL it got.
      const url = `http://probe-user:probe-pass@127.0.0.1:${httpPort}/proxy`;
      const run = await runProbeScript(1500, [url]);
      check("a credentialed proxy URL is probed, not refused for its userinfo", run.answers, [{ url, state: "ok" }]);
    }

    {
      const url = `http://127.0.0.1:${silentPort}/silent`;
      const run = await runProbeScript(1500, [url]);
      check("a server that never answers does not hang the probe child either", run.code, 0);
      check("the answer is the timeout observation", run.answers[0]?.url === url ? run.answers[0]?.state : undefined, "timeout");
      check("the deadline lands near the budget, not at the guard", run.elapsedMs > 1400 && run.elapsedMs < 10000, true);
    }
  } finally {
    httpHanging.closeAllConnections();
    for (const socket of silentSockets) socket.destroy();
    await new Promise<void>((resolve) => httpHanging.close(() => resolve()));
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
} finally {
  await deploymentFixture.dispose();
  await teardownFixtureDeployment(contextFixture.deployment);
}

finish("inspect egress");
