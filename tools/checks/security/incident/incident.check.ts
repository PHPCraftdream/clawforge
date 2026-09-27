// `./clawforge incident` — contain/rotate/audit/collect, each phase exercised directly through
// its exported function against a stub context. The full command's own wiring (guarded(), the
// lock) is exercised elsewhere for every other mutating command; this file's job is the
// runbook logic itself: what gets turned off, what gets rotated and confirmed, what gets
// written where, and — first of all — when the whole run refuses outright.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  refuseIfPubliclyExposed, containExposure, rotateToken, runAudits, collectEvidence,
} from "#framework/incident/index.ts";
import { useDeployment, envFile } from "#framework/runtime/deployment.ts";
import { unprotectedPrivateFile } from "#framework/security/private-file.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(`  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`);
}

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
  tailscale?: { present: boolean; loggedIn: boolean; serveActive: boolean };
  transportExec?: Context["transport"]["exec"];
  running?: boolean;
  hasReconcile?: boolean;
  runningEnvironment?: () => Promise<Record<string, string> | undefined>;
  cliAnswers?: Record<string, string>;
}

function stubContext(options: StubOptions = {}): Context & { execCalls: string[][] } {
  const execCalls: string[][] = [];
  const tailscale = options.tailscale ?? { present: false, loggedIn: false, serveActive: false };
  const transportExec: Context["transport"]["exec"] = async (command, args, opts) => {
    execCalls.push([command, ...args]);
    if (options.transportExec !== undefined) return options.transportExec(command, args, opts);
    if (command === "sh" && args[0] === "-c" && args[1] === "command -v tailscale") {
      return tailscale.present ? { code: 0, stdout: "/usr/bin/tailscale\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (command === "tailscale" && args[0] === "status") {
      return { code: 0, stdout: JSON.stringify({ BackendState: tailscale.loggedIn ? "Running" : "NeedsLogin" }), stderr: "" };
    }
    if (command === "tailscale" && args[0] === "serve" && args[1] === "status") {
      return tailscale.serveActive ? { code: 0, stdout: "https://box.ts.net/ proxy http://127.0.0.1:18789\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    }
    if (command === "tailscale" && args[0] === "serve" && args[1] === "reset") {
      return { code: 0, stdout: "", stderr: "" };
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
      ...(options.hasReconcile === false ? {} : { reconcile: async () => {} }),
      async waitForHealth() {},
      async runningEnvironment() { return options.runningEnvironment?.(); },
      async runOneOff(_service: string, args: string[]) {
        const key = args.slice(0, 2).join(" ");
        const stdout = options.cliAnswers?.[key] ?? "{}";
        return { code: 0, stdout, stderr: "" } satisfies ExecResult;
      },
      async readLogs(_tail?: string) { return "log line one\nlog line two\n"; },
      async health() { return "healthy"; },
      async probe() { return 200; },
    },
  } as unknown as Context;
  return Object.assign(ctx, { execCalls });
}

// --- refuseIfPubliclyExposed: the gate before anything else runs ---------------------------

await withDeployment(async () => {
  const ctx = stubContext({ connectionFacts: { bindAddress: "0.0.0.0", port: "18789" } });
  let thrown = "";
  try {
    await refuseIfPubliclyExposed(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  check("a publicly bound gateway refuses outright without --keep-exposure", thrown.includes("every interface"), true);
  check("naming the override", thrown.includes("--keep-exposure"), true);
});

await withDeployment(async () => {
  const ctx = stubContext({ connectionFacts: { bindAddress: "0.0.0.0", port: "18789" } });
  let captured = "";
  await withOutputSink((chunk) => { captured += chunk; }, () =>
    refuseIfPubliclyExposed(ctx, { dryRun: false, keepExposure: true, tail: "500" }));
  check("--keep-exposure proceeds instead of refusing", captured.includes("warning:"), true);
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

// --- contain: tailscale serve --------------------------------------------------------------

await withDeployment(async () => {
  const ctx = stubContext({ tailscale: { present: false, loggedIn: false, serveActive: false } });
  const phase = await containExposure(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  check("tailscale absent: nothing to turn off, and no reset attempted", phase.actions.some((line) => line.includes("nothing to turn off")), true);
  check("no exec beyond the presence probe", ctx.execCalls.some((call) => call[0] === "tailscale" && call[1] === "serve" && call[2] === "reset"), false);
});

await withDeployment(async () => {
  const ctx = stubContext({ tailscale: { present: true, loggedIn: true, serveActive: false } });
  const phase = await containExposure(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  check("tailscale present but not serving: nothing to turn off", phase.actions.some((line) => line.includes("was not active")), true);
});

await withDeployment(async () => {
  const ctx = stubContext({ tailscale: { present: true, loggedIn: true, serveActive: true } });
  const phase = await containExposure(ctx, { dryRun: true, keepExposure: false, tail: "500" });
  check("dry-run: prints the plan", phase.actions.some((line) => line.includes("would run: tailscale serve reset")), true);
  check("dry-run: never actually resets it", ctx.execCalls.some((call) => call.join(" ") === "tailscale serve reset"), false);
});

await withDeployment(async () => {
  const ctx = stubContext({ tailscale: { present: true, loggedIn: true, serveActive: true } });
  const phase = await containExposure(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  check("active serve is actually turned off", ctx.execCalls.some((call) => call.join(" ") === "tailscale serve reset"), true);
  check("and reported", phase.actions.some((line) => line.includes("ran: tailscale serve reset")), true);
});

// --- rotate: the gateway token --------------------------------------------------------------

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, ".env"), "OC_BIND_ADDRESS=127.0.0.1\n", "utf8");
  const ctx = stubContext({});
  const phase = await rotateToken(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  check("no token configured: nothing to rotate", phase.actions.some((line) => line.includes("nothing to rotate")), true);
  check("the file is untouched", await readFile(resolve(dir, ".env"), "utf8"), "OC_BIND_ADDRESS=127.0.0.1\n");
});

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, ".env"), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  const ctx = stubContext({});
  const phase = await rotateToken(ctx, { dryRun: true, keepExposure: false, tail: "500" });
  check("dry-run: prints the plan", phase.actions.some((line) => line.includes("would rotate")), true);
  check("dry-run: the token is untouched", await readFile(resolve(dir, ".env"), "utf8"), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n");
});

await withDeployment(async (dir) => {
  await writeFile(resolve(dir, ".env"), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  let confirmedToken: string | undefined;
  const ctx = stubContext({
    running: true,
    runningEnvironment: async () => (confirmedToken === undefined ? undefined : { OPENCLAW_GATEWAY_TOKEN: confirmedToken }),
  });
  // The stub's own "recreate" sets what the running container would report — modeling a
  // runtime that actually applied the new token.
  (ctx.runtime as { reconcile: () => Promise<void> }).reconcile = async () => {
    const written = await readFile(envFile(), "utf8");
    confirmedToken = /^OPENCLAW_GATEWAY_TOKEN=(.*)$/m.exec(written)?.[1];
  };
  const phase = await rotateToken(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  const rewritten = await readFile(resolve(dir, ".env"), "utf8");
  const newToken = /^OPENCLAW_GATEWAY_TOKEN=(.*)$/m.exec(rewritten)?.[1];
  check("a new token is written", newToken !== undefined && newToken !== "old-token-value-0123456789" && newToken !== "", true);
  check("the recreate is performed", phase.actions.some((line) => line.includes("recreating the gateway")), true);
  check("the new token is confirmed in force", phase.actions.some((line) => line.includes("confirmed")), true);
  check("MCP clients are told to re-pair", phase.notes.some((line) => line.includes("mcp-creds")), true);
  check("no secret value ever appears in the phase's own text", JSON.stringify(phase).includes(newToken ?? "\0"), false);
});

await withDeployment(async () => {
  await writeFile(resolve(envFile()), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  // "Old token rejected", modeled: the runtime claims to have recreated, but the container it
  // reports back from still holds the value .env had BEFORE this rotation — the same shape a
  // real gateway would answer with if the old token were still the one in force. This must
  // never be read as success.
  const ctx = stubContext({ running: true, runningEnvironment: async () => ({ OPENCLAW_GATEWAY_TOKEN: "old-token-value-0123456789" }) });
  const phase = await rotateToken(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  check("a container still answering with the old token is not reported as confirmed", phase.actions.some((line) => line.includes("confirmed")), false);
  check("it is reported as unconfirmed instead", phase.notes.some((line) => line.includes("could not confirm")), true);
});

await withDeployment(async () => {
  await writeFile(resolve(envFile()), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  const ctx = stubContext({ running: false });
  const phase = await rotateToken(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  check("a stopped instance is told the next start carries the new token", phase.notes.some((line) => line.includes("./clawforge up")), true);
});

await withDeployment(async () => {
  await writeFile(resolve(envFile()), "OPENCLAW_GATEWAY_TOKEN=old-token-value-0123456789\n", "utf8");
  const ctx = stubContext({ running: true, hasReconcile: false });
  const phase = await rotateToken(ctx, { dryRun: false, keepExposure: false, tail: "500" });
  check("a runtime that cannot recreate is told to run up by hand", phase.notes.some((line) => line.includes("./clawforge up")), true);
});

// --- audit: the security gate plus doctor --lint --------------------------------------------

await withDeployment(async () => {
  const ctx = stubContext({ running: true, cliAnswers: { "security audit": JSON.stringify({ findings: [] }), "secrets audit": JSON.stringify({ findings: [] }) } });
  const { phase, security } = await runAudits(ctx);
  check("the audit phase names how many findings and how many are blocking", phase.actions[0].includes("0 finding(s), 0 blocking"), true);
  check("the security report travels back to the caller", security.problems.length, 0);
});

// --- collect: a private evidence archive -----------------------------------------------------

await withDeployment(async () => {
  const ctx = stubContext({ running: false, cliAnswers: {} });
  const { security } = await runAudits(ctx);
  const collected = await collectEvidence(ctx, { dryRun: true, keepExposure: false, tail: "500" }, security, { raw: "" });
  check("dry-run: prints the plan and writes nothing", collected.actions.some((line) => line.includes("would collect")), true);
  check("dry-run: no archive path is reported", collected.archive, undefined);
});

await withDeployment(async () => {
  const ctx = stubContext({ running: false, cliAnswers: {} });
  const { security } = await runAudits(ctx);
  const collected = await collectEvidence(ctx, { dryRun: false, keepExposure: false, tail: "500" }, security, { raw: '{"ok":true,"findings":[]}' });
  check("a real run reports the archive path", typeof collected.archive === "string" && collected.archive.length > 0, true);

  const archive = collected.archive!;
  for (const name of ["logs.txt", "security-audit.json", "doctor-lint.json", "status.txt", "manifest.json"]) {
    const exposure = await unprotectedPrivateFile(resolve(archive, name)).catch((error: Error) => error.message);
    check(`${name} exists and is owner-only`, exposure, undefined);
  }
  const manifest = JSON.parse(await readFile(resolve(archive, "manifest.json"), "utf8")) as { files: string[] };
  check("the manifest names every collected file", manifest.files.sort(), ["doctor-lint.json", "logs.txt", "security-audit.json", "status.txt"]);
});

process.stderr.write(failed === 0 ? "all incident checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
