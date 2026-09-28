// `./clawforge incident` — contain/preserve/rotate/audit/collect, each phase exercised directly
// through its exported function against a stub context, plus runPhases for the two guarantees
// that only show up in the orchestration: preserve runs (and writes) before rotate can destroy
// what it captures, and preserve/collect's evidence is written unconditionally even when rotate
// or audit throws — with the original failure still propagating, unwrapped, to the caller. The
// full command's own wiring (guarded(), the lock) is exercised elsewhere for every other
// mutating command; this file's job is the runbook logic itself.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  refuseIfPubliclyExposed, containExposure, rotateToken, runAudits, preserveEvidence, collectEvidence, runPhases,
  IncidentPhaseFailure,
} from "#framework/commands/operate/incident/index.ts";
import { useDeployment, envFile } from "#framework/runtime/deployment.ts";
import { unprotectedPrivateFile } from "#framework/security/privacy/private-file.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { Context } from "#framework/core/context.ts";
import { redactInspectEnv } from "#framework/runtime/docker/incident-snapshot.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

async function withDeployment<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(resolve(tmpdir(), "clawforge-incident-check-"));
  await mkdir(resolve(dir, "config"), { recursive: true });
  await mkdir(resolve(dir, "secrets"), { recursive: true });
  useDeployment(dir);
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface StubOptions {
  connectionFacts?: { bindAddress?: string; port?: string };
  tailscale?: { present: boolean; loggedIn: boolean; serveJson?: string; offResult?: ExecResult };
  transportExec?: Context["transport"]["exec"];
  running?: boolean;
  hasReconcile?: boolean;
  reconcile?: () => Promise<void>;
  runningEnvironment?: () => Promise<Record<string, string> | undefined>;
  cliAnswers?: Record<string, string>;
  captureSnapshot?: () => Promise<{ logs: string; inspect: string } | undefined>;
  readLogs?: (tail?: string) => Promise<string>;
}

function stubContext(options: StubOptions = {}): Context & { execCalls: string[][] } {
  const execCalls: string[][] = [];
  const tailscale = options.tailscale ?? { present: false, loggedIn: false };
  const transportExec: Context["transport"]["exec"] = async (command, args, opts) => {
    execCalls.push([command, ...args]);
    if (options.transportExec !== undefined) return options.transportExec(command, args, opts);
    if (command === "sh" && args[0] === "-c" && args[1] === "command -v tailscale") {
      return tailscale.present ? { code: 0, stdout: "/usr/bin/tailscale\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (command === "tailscale" && args[0] === "status") {
      return { code: 0, stdout: JSON.stringify({ BackendState: tailscale.loggedIn ? "Running" : "NeedsLogin" }), stderr: "" };
    }
    if (command === "tailscale" && args.join(" ") === "serve status --json") {
      return { code: 0, stdout: tailscale.serveJson ?? "{}", stderr: "" };
    }
    if (command === "tailscale" && args[0] === "serve" && args.includes("off")) {
      return tailscale.offResult ?? { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
  };

  const ctx = {
    settings: { bindAddress: "127.0.0.1", gatewayPort: "18789" },
    transport: { description: "stub", exec: transportExec },
    runtime: {
      description: "stub-runtime",
      async runningConnectionFacts() { return options.connectionFacts; },
      async isRunning() { return options.running ?? true; },
      ...(options.hasReconcile === false ? {} : { reconcile: options.reconcile ?? (async () => {}) }),
      async waitForHealth() {},
      async runningEnvironment() { return options.runningEnvironment?.(); },
      async runOneOff(_service: string, args: string[]) {
        const key = args.slice(0, 2).join(" ");
        const stdout = options.cliAnswers?.[key] ?? "{}";
        return { code: 0, stdout, stderr: "" } satisfies ExecResult;
      },
      async readLogs(tail?: string) { return options.readLogs?.(tail) ?? "log line one\nlog line two\n"; },
      async health() { return "healthy"; },
      async probe() { return 200; },
      async captureIncidentSnapshot(_tail?: string) { return options.captureSnapshot?.(); },
    },
  } as unknown as Context;
  return Object.assign(ctx, { execCalls });
}

const GATEWAY_ROUTE_JSON = JSON.stringify({
  Web: { "box.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } } } },
});

// --- refuseIfPubliclyExposed: the gate before anything else runs ---------------------------

await withDeployment(async () => {
  const ctx = stubContext({ connectionFacts: { bindAddress: "0.0.0.0", port: "18789" } });
  let thrown = "";
  try {
    await refuseIfPubliclyExposed(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  checkTrue("a publicly bound gateway refuses outright without --keep-exposure", thrown.includes("every interface"));
  checkTrue("naming the override", thrown.includes("--keep-exposure"));
  checkTrue("naming the exact fix", thrown.includes("OC_BIND_ADDRESS=127.0.0.1") && thrown.includes("./clawforge up"));
});

await withDeployment(async () => {
  const ctx = stubContext({ connectionFacts: { bindAddress: "0.0.0.0", port: "18789" } });
  let captured = "";
  await withOutputSink((chunk) => { captured += chunk; }, () =>
    refuseIfPubliclyExposed(ctx, { dryRun: false, keepExposure: true, tail: "500" }));
  checkTrue("--keep-exposure proceeds instead of refusing", captured.includes("warning:"));
});

await withDeployment(async () => {
  const ctx = stubContext({ connectionFacts: { bindAddress: "127.0.0.1", port: "18789" } });
  let thrown = false;
  try {
    await refuseIfPubliclyExposed(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  } catch {
    thrown = true;
  }
  check("a loopback-bound gateway is never refused", thrown, false);
});

await withDeployment(async () => {
  const ctx = stubContext({ connectionFacts: undefined });
  let thrown = false;
  try {
    await refuseIfPubliclyExposed(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  } catch {
    thrown = true;
  }
  check("not running: nothing to refuse", thrown, false);
});

// --- contain: only the route(s) proxying to THIS gateway, never a blanket reset -------------

await withDeployment(async () => {
  const ctx = stubContext({ tailscale: { present: false, loggedIn: false } });
  const phase = await containExposure(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  checkTrue("tailscale absent: nothing to turn off", phase.actions.some((line) => line.includes("nothing to turn off")));
  check("no serve exec attempted at all", ctx.execCalls.some((call) => call[0] === "tailscale" && call[1] === "serve"), false);
});

await withDeployment(async () => {
  const ctx = stubContext({ tailscale: { present: true, loggedIn: true, serveJson: "{}" } });
  const phase = await containExposure(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  checkTrue("tailscale present but no route to this gateway: nothing to turn off", phase.actions.some((line) => line.includes("no route to this gateway")));
});

await withDeployment(async () => {
  const ctx = stubContext({ tailscale: { present: true, loggedIn: true, serveJson: GATEWAY_ROUTE_JSON } });
  const phase = await containExposure(ctx, { dryRun: true, keepExposure: false, tail: "500" });
  checkTrue("dry-run: prints the exact off command", phase.actions.some((line) => line.includes("would run: tailscale serve --https=443 off")));
  check("dry-run: never actually turns it off", ctx.execCalls.some((call) => call.includes("off")), false);
});

await withDeployment(async () => {
  const ctx = stubContext({ tailscale: { present: true, loggedIn: true, serveJson: GATEWAY_ROUTE_JSON } });
  const phase = await containExposure(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  checkTrue("the gateway's own route is actually turned off", ctx.execCalls.some((call) => call.join(" ") === "tailscale serve --https=443 off"));
  checkTrue("and reported", phase.actions.some((line) => line.includes("ran: tailscale serve --https=443 off")));
});

await withDeployment(async () => {
  const mixed = JSON.stringify({
    Web: {
      "box.ts.net:443": {
        Handlers: {
          "/": { Proxy: "http://127.0.0.1:18789" },
          "/other": { Proxy: "http://127.0.0.1:9999" },
        },
      },
      "box.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } },
    },
  });
  const ctx = stubContext({ tailscale: { present: true, loggedIn: true, serveJson: mixed } });
  const phase = await containExposure(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  const offCalls = ctx.execCalls.filter((call) => call.includes("off"));
  check("only the gateway's own route is turned off — every other service's route is left alone", offCalls, [["tailscale", "serve", "--https=443", "off"]]);
  check("reported as exactly one route turned off", phase.actions.filter((line) => line.startsWith("ran:")).length, 1);
});

await withDeployment(async () => {
  const ctx = stubContext({ tailscale: { present: true, loggedIn: true, serveJson: "not valid json" } });
  const phase = await containExposure(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  check("unparseable status: nothing is turned off", ctx.execCalls.some((call) => call.includes("off")), false);
  checkTrue("the operator gets the exact manual command instead", phase.notes.some((line) => line.includes("tailscale serve --https=443 off")));
});

await withDeployment(async () => {
  const ctx = stubContext({
    tailscale: { present: true, loggedIn: true, serveJson: GATEWAY_ROUTE_JSON, offResult: { code: 1, stdout: "", stderr: "Access denied: serve config denied" } },
  });
  const phase = await containExposure(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  checkTrue("a permission failure is noted, never thrown", phase.notes.some((line) => line.includes("Access denied")));
  checkTrue("with the operator fix named", phase.notes.some((line) => line.includes("sudo tailscale set --operator=$USER")));
});

await withDeployment(async (dir) => {
  // End-to-end: contain fails on a permission error, and rotate still runs to completion.
  await writeFile(resolve(dir, ".env"), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  const ctx = stubContext({
    running: true,
    tailscale: { present: true, loggedIn: true, serveJson: GATEWAY_ROUTE_JSON, offResult: { code: 1, stdout: "", stderr: "Access denied: serve config denied" } },
  });
  const report = await runPhases(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  const contain = report.phases.find((phase) => phase.phase === "contain")!;
  checkTrue("contain's permission failure surfaces as a note on the report", contain.notes.some((line) => line.includes("Access denied")));
  const rewritten = await readFile(resolve(dir, ".env"), "utf8");
  const newToken = /^OPENCLAW_GATEWAY_TOKEN=(.*)$/m.exec(rewritten)?.[1];
  checkTrue("rotate still ran despite contain's failure", newToken !== undefined && newToken !== "old-token-value-0123456789");
});

// --- rotate: the gateway token --------------------------------------------------------------

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, ".env"), "OC_BIND_ADDRESS=127.0.0.1\n", "utf8");
  const ctx = stubContext({});
  const phase = await rotateToken(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  checkTrue("no token configured: nothing to rotate", phase.actions.some((line) => line.includes("nothing to rotate")));
  check("the file is untouched", await readFile(resolve(dir, ".env"), "utf8"), "OC_BIND_ADDRESS=127.0.0.1\n");
});

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, ".env"), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  const ctx = stubContext({});
  const phase = await rotateToken(ctx, { dryRun: true, keepExposure: false, tail: "500" });
  checkTrue("dry-run: prints the plan", phase.actions.some((line) => line.includes("would rotate")));
  check("dry-run: the token is untouched", await readFile(resolve(dir, ".env"), "utf8"), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n");
});

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, ".env"), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  let confirmedToken: string | undefined;
  const ctx = stubContext({
    running: true,
    runningEnvironment: async () => (confirmedToken === undefined ? undefined : { OPENCLAW_GATEWAY_TOKEN: confirmedToken }),
    reconcile: async () => {
      const written = await readFile(envFile(), "utf8");
      confirmedToken = /^OPENCLAW_GATEWAY_TOKEN=(.*)$/m.exec(written)?.[1];
    },
  });
  const phase = await rotateToken(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  const rewritten = await readFile(resolve(dir, ".env"), "utf8");
  const newToken = /^OPENCLAW_GATEWAY_TOKEN=(.*)$/m.exec(rewritten)?.[1];
  checkTrue("a new token is written", newToken !== undefined && newToken !== "old-token-value-0123456789" && newToken !== "");
  checkTrue("the recreate is performed", phase.actions.some((line) => line.includes("recreating the gateway")));
  checkTrue("the new token is confirmed in force", phase.actions.some((line) => line.includes("confirmed")));
  checkTrue("MCP clients are told to re-pair", phase.notes.some((line) => line.includes("mcp-creds")));
  check("no secret value ever appears in the phase's own text", JSON.stringify(phase).includes(newToken ?? "\0"), false);
});

await withDeployment(async () => {
  await writeFile(resolve(envFile()), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  // "Old token rejected", modeled: the runtime claims to have recreated, but the container it
  // reports back from still holds the value .env had BEFORE this rotation.
  const ctx = stubContext({ running: true, runningEnvironment: async () => ({ OPENCLAW_GATEWAY_TOKEN: "old-token-value-0123456789" }) });
  const phase = await rotateToken(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  check("a container still answering with the old token is not reported as confirmed", phase.actions.some((line) => line.includes("confirmed")), false);
  checkTrue("it is reported as unconfirmed instead", phase.notes.some((line) => line.includes("could not confirm")));
});

await withDeployment(async () => {
  await writeFile(resolve(envFile()), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  const ctx = stubContext({ running: false });
  const phase = await rotateToken(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  checkTrue("a stopped instance is told the next start carries the new token", phase.notes.some((line) => line.includes("./clawforge up")));
});

await withDeployment(async () => {
  await writeFile(resolve(envFile()), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  const ctx = stubContext({ running: true, hasReconcile: false });
  const phase = await rotateToken(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  checkTrue("a runtime that cannot recreate is told to run up by hand", phase.notes.some((line) => line.includes("./clawforge up")));
});

// --- audit: the security gate plus doctor --lint --------------------------------------------

await withDeployment(async () => {
  const ctx = stubContext({ running: true, cliAnswers: { "security audit": JSON.stringify({ findings: [] }), "secrets audit": JSON.stringify({ findings: [] }) } });
  const { phase, security } = await runAudits(ctx);
  checkTrue("the audit phase names how many findings and how many are blocking", phase.actions[0].includes("0 finding(s), 0 blocking"));
  check("the security report travels back to the caller", security.problems.length, 0);
});

// --- preserve: a pre-rotate snapshot, written before rotate gets a chance to destroy it -------

await withDeployment(async (dir) => {
  const ctx = stubContext({});
  const archiveDir = resolve(dir, "incidents", "preserve-dry-run");
  const preserved = await preserveEvidence(ctx, { dryRun: true, keepExposure: false, tail: "500" }, archiveDir);
  checkTrue("dry-run: prints the plan and writes nothing", preserved.actions.some((line) => line.includes("would preserve")));
  check("dry-run: nothing listed as preserved", preserved.files, []);
});

await withDeployment(async (dir) => {
  const ctx = stubContext({ captureSnapshot: async () => undefined });
  const archiveDir = resolve(dir, "incidents", "preserve-nothing-running");
  const preserved = await preserveEvidence(ctx, { dryRun: false, keepExposure: false, tail: "500" }, archiveDir);
  checkTrue("nothing running to snapshot: noted, not fatal", preserved.notes.some((line) => line.includes("no pre-rotate evidence")));
  check("nothing listed as preserved", preserved.files, []);
});

await withDeployment(async () => {
  const ctx = stubContext({ captureSnapshot: () => { throw new Error("docker inspect timed out"); } });
  const archiveDir = "unused"; // never reached: the snapshot call itself throws before any write
  const preserved = await preserveEvidence(ctx, { dryRun: false, keepExposure: false, tail: "500" }, archiveDir);
  checkTrue("a snapshot failure is noted, never thrown out of preserveEvidence", preserved.notes.some((line) => line.includes("docker inspect timed out")));
});

await withDeployment(async (dir) => {
  const ctx = stubContext({ captureSnapshot: async () => ({ logs: "the old container's own log\n", inspect: '[{"Id":"abc123"}]' }) });
  const archiveDir = resolve(dir, "incidents", "preserve-real");
  const preserved = await preserveEvidence(ctx, { dryRun: false, keepExposure: false, tail: "500" }, archiveDir);
  check("both files are listed", preserved.files, ["pre-rotate-logs.txt", "pre-rotate-inspect.json"]);
  check("the log tail is actually written", await readFile(resolve(archiveDir, "pre-rotate-logs.txt"), "utf8"), "the old container's own log\n");
  check("the inspect dump is actually written", await readFile(resolve(archiveDir, "pre-rotate-inspect.json"), "utf8"), '[{"Id":"abc123"}]');
  const exposure = await unprotectedPrivateFile(resolve(archiveDir, "pre-rotate-logs.txt")).catch((error: Error) => error.message);
  check("owner-only", exposure, undefined);
});

// --- collect: a private evidence archive, including whatever preserve already wrote ----------

await withDeployment(async (dir) => {
  const ctx = stubContext({ running: false, cliAnswers: {} });
  const { security } = await runAudits(ctx);
  const archiveDir = resolve(dir, "incidents", "collect-dry-run");
  const collected = await collectEvidence(ctx, { dryRun: true, keepExposure: false, tail: "500" }, archiveDir, [], security, { raw: "" });
  checkTrue("dry-run: prints the plan and writes nothing", collected.actions.some((line) => line.includes("would collect")));
  check("dry-run: no archive path is reported", collected.archive, undefined);
});

await withDeployment(async (dir) => {
  const ctx = stubContext({ running: false, cliAnswers: {} });
  const { security } = await runAudits(ctx);
  const archiveDir = resolve(dir, "incidents", "collect-real");
  const collected = await collectEvidence(ctx, { dryRun: false, keepExposure: false, tail: "500" }, archiveDir, [], security, { raw: '{"ok":true,"findings":[]}' });
  check("a real run reports the archive path", collected.archive, archiveDir);

  for (const name of ["logs.txt", "security-audit.json", "doctor-lint.json", "status.txt", "manifest.json"]) {
    const exposure = await unprotectedPrivateFile(resolve(archiveDir, name)).catch((error: Error) => error.message);
    check(`${name} exists and is owner-only`, exposure, undefined);
  }
  const manifest = JSON.parse(await readFile(resolve(archiveDir, "manifest.json"), "utf8")) as { files: string[] };
  check("the manifest names every collected file", manifest.files.sort(), ["doctor-lint.json", "logs.txt", "security-audit.json", "status.txt"]);
});

await withDeployment(async (dir) => {
  const ctx = stubContext({ running: false, cliAnswers: {} });
  const archiveDir = resolve(dir, "incidents", "collect-audit-missing");
  await collectEvidence(ctx, { dryRun: false, keepExposure: false, tail: "500" }, archiveDir, ["pre-rotate-logs.txt"], undefined, undefined);
  const manifest = JSON.parse(await readFile(resolve(archiveDir, "manifest.json"), "utf8")) as { files: string[] };
  check("preserved files are folded into the manifest even when audit never ran", manifest.files.sort(), ["doctor-lint.json", "logs.txt", "pre-rotate-logs.txt", "security-audit.json", "status.txt"]);
  const securityFile = JSON.parse(await readFile(resolve(archiveDir, "security-audit.json"), "utf8")) as { problems: unknown[] };
  check("a missing security report falls back to an empty one rather than crashing", securityFile.problems, []);
});

// --- runPhases: the two orchestration guarantees ----------------------------------------------

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, ".env"), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  let containerLogs = "the log line from BEFORE rotate recreates the container\n";
  const ctx = stubContext({
    running: true,
    captureSnapshot: async () => ({ logs: containerLogs, inspect: '[{"Id":"old-container"}]' }),
    readLogs: async () => containerLogs,
    // Models the real bug this phase exists to fix: compose's recreate removes the old
    // container, and its json-file log goes with it — read AFTER this point, it is gone.
    reconcile: async () => { containerLogs = ""; },
  });

  const report = await runPhases(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  const archive = report.archive!;
  const preRotate = await readFile(resolve(archive, "pre-rotate-logs.txt"), "utf8");
  checkTrue("the pre-rotate log tail survives the recreate that wipes the live container's own log", preRotate.includes("BEFORE rotate"));
  const postRotate = await readFile(resolve(archive, "logs.txt"), "utf8");
  check("logs.txt, read after rotate, reflects the wiped, recreated container", postRotate, "");
});

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, ".env"), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  const ctx = stubContext({
    running: true,
    captureSnapshot: async () => ({ logs: "log line before the failure\n", inspect: '[{"Id":"c1"}]' }),
    reconcile: async () => { throw new Error("compose up failed: network unreachable"); },
  });

  let thrown: unknown;
  try {
    await runPhases(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  } catch (error) {
    thrown = error;
  }
  checkTrue("rotate's failure is carried as an IncidentPhaseFailure", thrown instanceof IncidentPhaseFailure);
  const failure = thrown as IncidentPhaseFailure;
  check("its cause is the original, unwrapped error — what incident() rethrows to the operator", (failure.cause as Error)?.message, "compose up failed: network unreachable");
  checkTrue("the report it carries names where evidence landed", typeof failure.report.archive === "string" && failure.report.archive.length > 0);

  const archive = failure.report.archive!;
  const preRotateLogs = await readFile(resolve(archive, "pre-rotate-logs.txt"), "utf8");
  checkTrue("pre-rotate evidence was written before rotate ever threw", preRotateLogs.includes("before the failure"));
  const manifest = JSON.parse(await readFile(resolve(archive, "manifest.json"), "utf8")) as { files: string[] };
  checkTrue("collect still ran and wrote a manifest despite the failure", manifest.files.includes("pre-rotate-logs.txt"));
  const rotatePhase = failure.report.phases.find((phase) => phase.phase === "rotate")!;
  checkTrue("the rotate phase in the report notes its own failure", rotatePhase.notes.some((line) => line.includes("network unreachable")));
});

// --- preserved docker inspect never holds environment values ---------------------------------
{
  const raw = JSON.stringify([{ Id: "c1", Config: { Env: ["OPENCLAW_GATEWAY_TOKEN=tok-123", "ZAI_API_KEY=key-456", "PATH=/usr/bin"] } }]);
  const redacted = redactInspectEnv(raw);
  check("inspect env values are redacted", /tok-123|key-456|\/usr\/bin/.test(redacted), false);
  checkTrue("inspect env names are kept", redacted.includes("OPENCLAW_GATEWAY_TOKEN=<redacted>"));
  check("unparseable inspect output is withheld, not written raw", redactInspectEnv("not json tok-123").includes("tok-123"), false);
}

finish("incident");
