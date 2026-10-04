// Smoke verdict classification, exit behavior, and HTTP probe results.

import { checks, report, runChecks, probeRefusal, providerMissingDetail, smokeDidNotPassMessage, smokePassedMessage } from "#framework/commands/lifecycle/smoke/index.ts";
import { couldNotDo } from "#framework/commands/lifecycle/smoke/verdict.ts";
import type { Check, SmokeResult } from "#framework/commands/lifecycle/smoke/index.ts";
import { CouldNotCheck, NotChecked } from "#framework/commands/check-outcome.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish } from "#checks/kit/harness.ts";

/** Captures everything report() prints, without withOutputSink(): that helper makes
 *  isCaptured() true and reroutes log() into the sink, so patching the raw writer keeps
 *  the ordinary path a real terminal run takes. */
function capture(body: () => void): string {
  const originalErr = process.stderr.write.bind(process.stderr);
  let out = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: string): boolean => {
    out += chunk;
    return true;
  };
  try {
    body();
  } finally {
    process.stderr.write = originalErr;
  }
  return out;
}

function stubContext(runtime: Record<string, unknown>): Context {
  return { settings: {}, runtime } as unknown as Context;
}

check("the suite still has the eight checks the help and README promise", checks.length, 8);

check("could-not-check is not a species of not-checked — the run gate depends on the difference", new CouldNotCheck("x") instanceof NotChecked, false);

// --- classification: four outcomes, reachable in one run, never folded together ---------------

{
  const seen: SmokeResult[] = [];
  const unreachableReason = "could not reach the instance: no transport";
  const inapplicableReason = "no drift-safe setting declared";
  const summary = await runChecks(stubContext({}), [
    { name: "sails through", run: async () => {} },
    { name: "assertion misses", run: () => { throw new Error("the property does not hold"); } },
    { name: "inapplicable here", run: () => { throw new NotChecked(inapplicableReason); } },
    { name: "instance unreachable", run: () => { throw new CouldNotCheck(unreachableReason); } },
  ] satisfies Check[], (result) => seen.push(result));

  check("all four outcomes are reachable in one run, spelled as themselves", summary.results.map((result) => result.status), ["passed", "failed", "not-checked", "could-not-check"]);
  check("each outcome is counted once, as itself", [summary.passed, summary.failed, summary.notChecked, summary.couldNotCheck], [1, 1, 1, 1]);
  check("every check reported as it finished, not at the end", seen.map((result) => result.name), ["sails through", "assertion misses", "inapplicable here", "instance unreachable"]);
  check("a verdict-less check carries its reason", summary.results[3].detail, unreachableReason);
  check("an inapplicable check carries its reason too", summary.results[2].detail, inapplicableReason);
}

// --- the exit contract: unreachable checks cannot pass ---------------------------------------

{
  let message = "";
  try {
    report({ results: [{ name: "instance unreachable", status: "could-not-check" }], passed: 7, failed: 0, notChecked: 0, couldNotCheck: 1 }, false);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("a run whose check could not be checked does not pass", message.includes(smokeDidNotPassMessage(1, 0, 1, ["instance unreachable"])), true);
  check("and says so in the shared vocabulary", message, smokeDidNotPassMessage(1, 0, 1, ["instance unreachable"]));

  let failedMessage = "";
  try {
    report({ results: [{ name: "assertion misses", status: "failed" }], passed: 7, failed: 1, notChecked: 0, couldNotCheck: 0 }, false);
  } catch (error) {
    failedMessage = error instanceof Error ? error.message : String(error);
  }
  check("an outright failed check still fails the run", failedMessage.includes(smokeDidNotPassMessage(1, 1, 0, ["assertion misses"])), true);

  let refused = false;
  try {
    report({ results: [{ name: "inapplicable here", status: "not-checked" }], passed: 7, failed: 0, notChecked: 1, couldNotCheck: 0 }, false);
  } catch {
    refused = true;
  }
  check("a run whose only non-passes are deliberate not-checked ones still passes", refused, false);

  const line = capture(() => report({ results: [{ name: "inapplicable here", status: "not-checked" }], passed: 7, failed: 0, notChecked: 1, couldNotCheck: 0 }, false));
  check("the summary line speaks the shared vocabulary, not the old SKIP", line.includes(smokePassedMessage(7, 1)) && !line.includes("skipped"), true);
}

// --- real probe bodies against a stub runtime ------------------------------------------------

{
  const probes = checks.find((entry) => entry.name === "gateway answers all HTTP probes");
  const health = checks.find((entry) => entry.name === "runtime reports the container healthy");
  if (probes === undefined || health === undefined) throw new Error("smoke.ts no longer has the probe or health check under its documented name");

  const well = await runChecks(stubContext({ probe: async () => 200 }), [probes], () => {});
  check("a gateway answering every probe passes", well.results.map((result) => result.status), ["passed"]);

  const lying = await runChecks(stubContext({ probe: async () => 404 }), [probes], () => {});
  check("a probe answered with something other than 200 is a failed verdict", lying.results.map((result) => result.status), ["failed"]);
  check("naming the endpoint and the code", lying.results[0].detail?.includes(probeRefusal("healthz", 404)), true);

  const unreachable = await runChecks(stubContext({ probe: () => { throw new Error("docker unreachable"); } }), [probes], () => {});
  check("a runtime that cannot even run the probe is could-not-check, not failed", unreachable.results.map((result) => result.status), ["could-not-check"]);
  check("naming what it could not do", unreachable.results[0].detail?.includes(couldNotDo("probe healthz", "docker unreachable")), true);
  check("and such a run refuses to report success", (() => {
    try { report(unreachable, false); return false; } catch { return true; }
  })(), true);

  const unwell = await runChecks(stubContext({ health: async () => "unhealthy" }), [health], () => {});
  check("an unhealthy verdict is a failed verdict", unwell.results.map((result) => result.status), ["failed"]);

  const silent = await runChecks(stubContext({ health: () => { throw new Error("docker inspect failed"); } }), [health], () => {});
  check("a runtime that cannot answer at all is could-not-check", silent.results.map((result) => result.status), ["could-not-check"]);
}

// --- a silent agent names PROVIDER_MISSING as the cause, when it applies ------------------

{
  const agent = checks.find((entry) => entry.name === "agent answers end to end");
  if (agent === undefined) throw new Error("smoke.ts no longer has the agent-answers check under its documented name");

  function agentContext(liveConfig: unknown, reply: string): Context {
    return {
      settings: { dataDir: "/srv/openclaw/data" },
      transport: {
        async readFile(path: string): Promise<string> {
          if (path === "/srv/openclaw/data/config/openclaw.json") return JSON.stringify(liveConfig);
          throw new Error(`unexpected read: ${path}`);
        },
      },
      runtime: {
        runOneOff: async () => ({ code: 0, stdout: reply, stderr: "" }),
      },
    } as unknown as Context;
  }

  const silentReply = "(no reply)";
  const noProvider = await runChecks(agentContext({ models: { providers: {} } }, silentReply), [agent], () => {});
  check("a silent agent with no provider configured fails", noProvider.results.map((result) => result.status), ["failed"]);
  check("naming PROVIDER_MISSING's own remedy and the cause in plain words", noProvider.results[0].detail, providerMissingDetail(new Error(`agent replied: ${silentReply}`)));

  const configured = await runChecks(agentContext({ models: { providers: { zai: { apiKey: "k" } } } }, silentReply), [agent], () => {});
  check("a silent agent with a provider configured fails on the plain symptom instead", configured.results.map((result) => result.status), ["failed"]);
  check("without inventing a provider cause that does not apply", configured.results[0].detail?.includes("configure-provider"), false);
  check("naming what the agent actually said", configured.results[0].detail, `agent replied: ${silentReply}`);

  const answered = await runChecks(agentContext({ models: { providers: { zai: { apiKey: "k" } } } }, "SMOKE-OK"), [agent], () => {});
  check("an agent that actually answers still passes", answered.results.map((result) => result.status), ["passed"]);

  // Without a provider the real CLI was seen hanging 10+ minutes: the call is bounded by
  // coreutils timeout INSIDE the container, since killing wsl.exe/ssh here leaves it running.
  let seen: { args: string[]; entrypoint?: string } | undefined;
  const bounded = agentContext({ models: { providers: { zai: { apiKey: "k" } } } }, "SMOKE-OK");
  (bounded.runtime as unknown as { runOneOff: unknown }).runOneOff = async (_service: string, args: string[], options: { entrypoint?: string }) => {
    seen = { args, entrypoint: options.entrypoint };
    return { code: 0, stdout: "SMOKE-OK", stderr: "" };
  };
  await runChecks(bounded, [agent], () => {});
  check("the agent call runs under coreutils timeout in the container", seen?.entrypoint, "timeout");
  check("with a kill grace and a hard deadline before node", seen?.args.slice(0, 4).join(" "), "-k 10 120 node");
  check("and OpenClaw's own --timeout below that deadline", seen?.args.includes("--timeout"), true);

  // The real bug report (docs/first-hour-acceptance.md, 2026-09-27 run): the CLI itself
  // failed before ever replying, so the check never reached the verdict branch above — the
  // hint must still apply on THIS failure path, not just a silent reply.
  function unreachableAgentContext(liveConfig: unknown, symptom: string): Context {
    return {
      settings: { dataDir: "/srv/openclaw/data" },
      transport: {
        async readFile(path: string): Promise<string> {
          if (path === "/srv/openclaw/data/config/openclaw.json") return JSON.stringify(liveConfig);
          throw new Error(`unexpected read: ${path}`);
        },
      },
      runtime: {
        runOneOff: async () => { throw new Error(symptom); },
      },
    } as unknown as Context;
  }

  const symptom = "docker compose --profile cli run --rm -T cli agent ... failed (exit 1)";
  const unreachableNoProvider = await runChecks(unreachableAgentContext({ models: { providers: {} } }, symptom), [agent], () => {});
  check("an unreachable agent stays could-not-check, not failed", unreachableNoProvider.results.map((result) => result.status), ["could-not-check"]);
  check(
    "but still names PROVIDER_MISSING, keeping the real symptom alongside it",
    unreachableNoProvider.results[0].detail,
    providerMissingDetail(new CouldNotCheck(couldNotDo("ask the agent", symptom))),
  );

  const unreachableConfigured = await runChecks(unreachableAgentContext({ models: { providers: { zai: { apiKey: "k" } } } }, symptom), [agent], () => {});
  check("an unreachable agent with a provider configured stays could-not-check too", unreachableConfigured.results.map((result) => result.status), ["could-not-check"]);
  check("without inventing a provider cause that does not apply", unreachableConfigured.results[0].detail?.includes("configure-provider"), false);
}

finish("smoke outcome");
