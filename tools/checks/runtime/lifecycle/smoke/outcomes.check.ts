// Smoke verdict classification, exit behavior, and HTTP probe results.

import { checks, report, runChecks } from "#framework/commands/lifecycle/smoke.ts";
import type { Check, SmokeResult } from "#framework/commands/lifecycle/smoke.ts";
import { CouldNotCheck, NotChecked } from "#framework/commands/check-outcome.ts";
import type { Context } from "#framework/core/context.ts";
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
  const summary = await runChecks(stubContext({}), [
    { name: "sails through", run: async () => {} },
    { name: "assertion misses", run: () => { throw new Error("the property does not hold"); } },
    { name: "inapplicable here", run: () => { throw new NotChecked("no drift-safe setting declared"); } },
    { name: "instance unreachable", run: () => { throw new CouldNotCheck("could not reach the instance: no transport"); } },
  ] satisfies Check[], (result) => seen.push(result));

  check("all four outcomes are reachable in one run, spelled as themselves", summary.results.map((result) => result.status), ["passed", "failed", "not-checked", "could-not-check"]);
  check("each outcome is counted once, as itself", [summary.passed, summary.failed, summary.notChecked, summary.couldNotCheck], [1, 1, 1, 1]);
  check("every check reported as it finished, not at the end", seen.map((result) => result.name), ["sails through", "assertion misses", "inapplicable here", "instance unreachable"]);
  check("a verdict-less check carries its reason", summary.results[3].detail?.includes("could not reach the instance"), true);
  check("an inapplicable check carries its reason too", summary.results[2].detail?.includes("no drift-safe setting"), true);
}

// --- the exit contract: unreachable checks cannot pass ---------------------------------------

{
  let message = "";
  try {
    report({ results: [{ name: "instance unreachable", status: "could-not-check" }], passed: 7, failed: 0, notChecked: 0, couldNotCheck: 1 }, false);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("a run whose check could not be checked does not pass", message.includes("did not pass"), true);
  check("and says so in the shared vocabulary", message.includes("could not be checked"), true);

  let failedMessage = "";
  try {
    report({ results: [{ name: "assertion misses", status: "failed" }], passed: 7, failed: 1, notChecked: 0, couldNotCheck: 0 }, false);
  } catch (error) {
    failedMessage = error instanceof Error ? error.message : String(error);
  }
  check("an outright failed check still fails the run", failedMessage.includes("1 failed"), true);

  let refused = false;
  try {
    report({ results: [{ name: "inapplicable here", status: "not-checked" }], passed: 7, failed: 0, notChecked: 1, couldNotCheck: 0 }, false);
  } catch {
    refused = true;
  }
  check("a run whose only non-passes are deliberate not-checked ones still passes", refused, false);

  const line = capture(() => report({ results: [{ name: "inapplicable here", status: "not-checked" }], passed: 7, failed: 0, notChecked: 1, couldNotCheck: 0 }, false));
  check("the summary line speaks the shared vocabulary, not the old SKIP", line.includes("not checked") && !line.includes("skipped"), true);
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
  check("naming the endpoint and the code", lying.results[0].detail?.includes("healthz returned 404"), true);

  const unreachable = await runChecks(stubContext({ probe: () => { throw new Error("docker unreachable"); } }), [probes], () => {});
  check("a runtime that cannot even run the probe is could-not-check, not failed", unreachable.results.map((result) => result.status), ["could-not-check"]);
  check("naming what it could not do", unreachable.results[0].detail?.includes("could not probe healthz"), true);
  check("and such a run refuses to report success", (() => {
    try { report(unreachable, false); return false; } catch { return true; }
  })(), true);

  const unwell = await runChecks(stubContext({ health: async () => "unhealthy" }), [health], () => {});
  check("an unhealthy verdict is a failed verdict", unwell.results.map((result) => result.status), ["failed"]);

  const silent = await runChecks(stubContext({ health: () => { throw new Error("docker inspect failed"); } }), [health], () => {});
  check("a runtime that cannot answer at all is could-not-check", silent.results.map((result) => result.status), ["could-not-check"]);
}

process.stderr.write(failed === 0 ? "all smoke outcome checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
