// `./clawforge inspect` — the outbound half of reachability: the probe runs INSIDE the
// gateway container, because Runtime.probe() curls from the operator machine and cannot
// see a name that resolves there and nowhere else — the 2026-09-20 outage, invisible to
// every probe for a day. It asks only the endpoints the live configuration names, in one
// exec, and reports what cannot be reached as EGRESS_UNREACHABLE, a warning: the instance
// is up and the outside world is not this deployment's fault. See fixture.ts for the
// shared stub and on-disk deployment.

import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { EGRESS_EXEC_TIMEOUT_MS, egressProbeScript } from "#framework/commands/orchestration/inspect/egress-probe.ts";
import { gatherInspection, renderJson, doctor } from "#framework/commands/orchestration/inspect/gather.ts";
import { PROBLEM_CODES } from "#framework/service/inspection.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { HelperNotRunning } from "#framework/runtime/runtime.ts";
import { spawnLocal } from "#framework/runtime/transport.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "./fixture.ts";
import type { TargetSpec } from "./fixture.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

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

try {
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
    check("a name that does not resolve says so, with the endpoint and where it is configured", findings[0]?.detail.includes("does not resolve from inside") && findings[0]?.detail.includes(PROVIDER_URL) && findings[0]?.detail.includes("models.providers.zai.baseUrl") && findings[0]?.detail.includes("(ENOTFOUND)"), true);
    check("an endpoint that resolves but does not answer says that instead", findings[1]?.detail.includes("but does not answer") && findings[1]?.detail.includes(PROXY_URL) && findings[1]?.detail.includes("channels.telegram.proxy") && findings[1]?.detail.includes("(ECONNREFUSED)"), true);
    check("the finding is advisory", findings.map((entry) => entry.severity), ["warning", "warning"]);
    check("an unreachable outside world does not make a running instance unhealthy", renderJson(inspection).healthy, true);
    check("the states are recorded as observed", inspection.observed.egress?.map((entry) => entry.state), ["dns", "unreachable"]);
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
    check("a configured value that is not a URL is its own finding", findings[0]?.detail.includes("is not a usable URL") && findings[0]?.detail.includes("channels.telegram.proxy"), true);
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
    check("the timeout finding says the deadline ran out", findings[0]?.detail.includes("deadline"), true);
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
    const started = Date.now();
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
    return { code: result.code, answers, elapsedMs: Date.now() - started };
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
      const url = `http://127.0.0.1:${silentPort}/silent`;
      const run = await runProbeScript(1500, [url]);
      check("a server that never answers does not hang the probe child either", run.code, 0);
      check("the answer is the timeout observation", run.answers[0]?.url === url ? run.answers[0]?.state : undefined, "timeout");
      check("the detail names the budget the probe was given", run.answers[0]?.detail?.includes("1500"), true);
      check("the deadline lands near the budget, not at the guard", run.elapsedMs > 1400 && run.elapsedMs < 10000, true);
    }
  } finally {
    httpHanging.closeAllConnections();
    for (const socket of silentSockets) socket.destroy();
    await new Promise<void>((resolve) => httpHanging.close(() => resolve()));
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
} finally {
  await teardownFixtureDeployment(deployment);
}

process.stderr.write(failed === 0 ? "all inspect egress checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
