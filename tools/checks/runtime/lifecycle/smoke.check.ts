// The smoke suite's outcome machinery: each check lands on one of the four shared
// check-outcome values (commands/check-outcome.ts), the four stay distinct, and a check
// that could not obtain a verdict can never be the reason a run reports success.
//
// Driven through smoke.ts's own seams — runChecks() classifies and counts, report() owns
// the exit contract — with synthetic checks, plus the two real bodies that can run
// without an instance (the HTTP probes and the runtime-health check) against a stub
// runtime. The deeper bodies need a live target; `./clawforge smoke` itself is what
// covers them.

import { checks, report, runChecks } from "#framework/commands/lifecycle/smoke.ts";
import type { Check, SmokeResult } from "#framework/commands/lifecycle/smoke.ts";
import { CouldNotCheck, NotChecked } from "#framework/commands/check-outcome.ts";
import type { Context } from "#framework/core/context.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";

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

// --- the exit contract -----------------------------------------------------------------------
//
// The whole reason could-not-check exists: a smoke check that cannot reach the instance
// must not be able to report as passing — not in the counts, and not in the verdict.

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

// --- two real check bodies, against a stub runtime --------------------------------------------
//
// The gateway answering is a verdict; the runtime failing to even run the probe is not.

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

// --- the drift check's cleanup is a restore, not a question -----------------------------------
//
// The verdict is already in when the finally's applyConfig runs. Its failure must stay a
// failed check that says what to repair — the instance may still hold the drifted value —
// not could-not-check, which would report the question as never asked.

{
  const root = await mkdtemp(join(tmpdir(), "clawforge-smoke-drift-"));
  let previous: string | undefined;
  try { previous = deploymentDir(); } catch { /* no deployment selected in this check */ }
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "desired-state.json"), JSON.stringify([
      { path: "agents.defaults.model.primary", value: "fixture-model" },
    ]));
    useDeployment(root);

    // The restore must be the failing call, not the declaration applying during the
    // check: applyConfig runs once inside the try (the verdict depends on it) and once
    // in the finally (the cleanup under test). Counting the batch calls keeps the setup
    // honest — if the first apply had failed, this case would be testing nothing.
    let batchCalls = 0;
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const dataDir = "/srv/clawforge";
    files.set(`${dataDir}/config/openclaw.json`, JSON.stringify({ agents: { defaults: { model: { primary: "fixture-model" } } } }));
    const ctx = {
      settings: { dataDir },
      transport: {
        async exec(command: string, args: string[]) {
          if (command === "mkdir") {
            const target = args[args.length - 1];
            if (dirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
            dirs.add(target);
            return { code: 0, stdout: "", stderr: "" };
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
        },
      },
      paths: { toContainer: (path: string) => path },
      runtime: {
        async runOneOff(_service: string, args: string[]) {
          if (!args.includes("--batch-file")) return { code: 0, stdout: "", stderr: "" };
          batchCalls += 1;
          if (batchCalls === 1) return { code: 0, stdout: "", stderr: "" };
          throw new Error("docker unreachable");
        },
      },
    } as unknown as Context;

    const drift = checks.find((entry) => entry.name === "desired state overrides manual drift");
    if (drift === undefined) throw new Error("smoke.ts no longer has the drift check under its documented name");

    const summary = await withOutputSink(() => {}, () => runChecks(ctx, [drift], () => {}));
    check("the setup drove both applyConfig calls — the verdict came from the first", batchCalls, 2);
    check("a restore that fails after the verdict stays a failed check", summary.results.map((result) => result.status), ["failed"]);
    check("saying the instance may still hold the drifted value", summary.results[0].detail?.includes("may still hold the drifted value"), true);
    check("naming the path it could not restore", summary.results[0].detail?.includes("agents.defaults.model.primary"), true);
    check("naming the repair", summary.results[0].detail?.includes("apply-config"), true);
  } finally {
    if (previous === undefined) useDeployment(root);
    else useDeployment(previous);
    await rm(root, { recursive: true, force: true });
  }
}

process.stderr.write(failed === 0 ? "all smoke outcome checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
