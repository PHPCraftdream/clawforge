// `./clawforge incident` — contain, rotate, audit, collect: OpenClaw's own incident runbook,
// run by the framework because the four steps each need something only it can reach (the
// expose module, the deployment's own .env, the security gate, a bounded log read).
//
// contain: stop external exposure. `tailscale serve` is turned off on the target when active
// (never touches anything else there); a gateway published on 0.0.0.0/:: refuses the whole
// run first — before the lock, before any mutation — unless --keep-exposure says the operator
// has already judged that acceptable.
//
// rotate: a fresh OPENCLAW_GATEWAY_TOKEN, generated the same way bootstrap does, written to
// .env and recreated into the running container so it actually takes effect — a repo-env
// value like this one is fixed at container-creation time, restart alone would not apply it.
// Every MCP client paired against the old token needs `./clawforge mcp-creds` again.
//
// audit: the security gate (security-audit/index.ts) plus `openclaw doctor --lint --json`,
// both informational here — this command reports what they found, it does not gate on it.
//
// collect: a bounded log tail, both audit outputs and a short status summary, into a private,
// owner-only directory under this deployment's own folder (apps/<name>/incidents/<ts>/ — the
// whole apps/ tree is gitignored, so this is never part of the repository's tracked history),
// with a manifest naming what is inside. Every file goes through maskSecrets() before it is
// written: these are raw captures, not the log/info calls that already carry known secrets
// registered for masking.
//
// Mutating — guarded() takes the instance lock, and it is marked destructive. --dry-run prints
// the plan and performs none of it, not even taking the lock, on upgrade's own precedent.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, warn, die, registerSecret, maskSecrets } from "../core/log.ts";
import { emit, isCaptured } from "../core/output.ts";
import type { Context } from "../core/context.ts";
import { guarded } from "../runtime/instance-lock.ts";
import { envFile, deploymentDir, deploymentName } from "../runtime/deployment.ts";
import { upsertEnvValue } from "../security/private-config.ts";
import { replacePrivateFile, createPrivateFile, protectPrivateDirectory } from "../security/private-file.ts";
import { probeTailscale, tailscaleServeActive, tailscaleServeResetCommand } from "../expose/tailscale.ts";
import { summarizeExposure, exposureOneLiner } from "../expose/status.ts";
import { runSecurityAudit, type SecurityAuditReport } from "../security-audit/index.ts";
import { blockingProblems } from "../service/inspection.ts";

interface IncidentOptions {
  readonly dryRun: boolean;
  readonly keepExposure: boolean;
  readonly tail: string;
}

export interface IncidentPhase {
  readonly phase: "contain" | "rotate" | "audit" | "collect";
  readonly actions: readonly string[];
  readonly notes: readonly string[];
}

export interface IncidentReport {
  readonly deployment: string;
  readonly dryRun: boolean;
  readonly phases: readonly IncidentPhase[];
  readonly security: SecurityAuditReport;
  /** Where the evidence was written, absent in --dry-run. */
  readonly archive?: string;
}

function parseArgs(args: string[]): IncidentOptions {
  let dryRun = false;
  let keepExposure = false;
  let tail = "500";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--keep-exposure") keepExposure = true;
    else if (arg === "--json") continue;
    else if (arg === "--break-lock") continue;
    else if (arg === "--break-foreign-lock") index += 1;
    else if (arg === "--tail") {
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) die("--tail needs a number of lines");
      tail = value;
      index += 1;
    } else die(`unknown argument: ${arg}`);
  }
  return { dryRun, keepExposure, tail };
}

/** Refuses the whole run while the gateway may still be reachable from outside this host —
 *  checked before anything else, mutating or not: a plan printed for an instance still
 *  publicly bound would be worth nothing. `undefined` facts (not running, or this runtime
 *  cannot introspect it) has nothing to refuse on. */
export async function refuseIfPubliclyExposed(ctx: Context, options: IncidentOptions): Promise<void> {
  let facts: { bindAddress?: string; port?: string } | undefined;
  try {
    facts = await ctx.runtime.runningConnectionFacts?.();
  } catch {
    facts = undefined;
  }
  if (facts === undefined) return;
  const summary = summarizeExposure(ctx, facts);
  if (!summary.wildcard) return;

  if (!options.keepExposure) {
    die(
      `the gateway is published on ${summary.bindAddress}:${summary.port} — reachable from every interface on ` +
        "this host. Refusing to run an incident response while it may still be reachable from outside: set " +
        "OC_BIND_ADDRESS=127.0.0.1 in .env and ./clawforge up to recreate, or pass --keep-exposure if this " +
        "exposure is already handled elsewhere (a reverse proxy, a security group, ...).",
    );
  }
  warn(`proceeding with the gateway published on ${summary.bindAddress}:${summary.port} — --keep-exposure was given`);
}

export async function containExposure(ctx: Context, options: IncidentOptions): Promise<IncidentPhase> {
  const actions: string[] = [];
  const notes: string[] = [];

  const probe = await probeTailscale(ctx);
  if (!probe.present || !probe.loggedIn) {
    actions.push(`tailscale: ${probe.detail} — nothing to turn off`);
  } else {
    const active = await tailscaleServeActive(ctx);
    if (!active) {
      actions.push("tailscale serve was not active — nothing to turn off");
    } else if (options.dryRun) {
      actions.push("would run: tailscale serve reset (turn off tailscale serve on the target)");
    } else {
      const command = tailscaleServeResetCommand();
      const result = await ctx.transport.exec(command[0], command.slice(1), { allowFailure: true });
      if (result.code !== 0) {
        throw new Error(`tailscale serve reset failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
      }
      actions.push("ran: tailscale serve reset");
    }
  }

  return { phase: "contain", actions, notes };
}

const TOKEN_LINE = /^OPENCLAW_GATEWAY_TOKEN=(.*)$/m;

export async function rotateToken(ctx: Context, options: IncidentOptions): Promise<IncidentPhase> {
  const actions: string[] = [];
  const notes: string[] = [];
  const path = envFile();
  const content = await readFile(path, "utf8");
  const current = TOKEN_LINE.exec(content)?.[1]?.trim();

  if (current === undefined || current === "") {
    actions.push("no OPENCLAW_GATEWAY_TOKEN configured — nothing to rotate");
    return { phase: "rotate", actions, notes };
  }

  if (options.dryRun) {
    actions.push("would rotate OPENCLAW_GATEWAY_TOKEN and recreate the gateway to apply it");
    return { phase: "rotate", actions, notes };
  }

  const token = randomBytes(32).toString("hex");
  registerSecret(token);
  await replacePrivateFile(path, upsertEnvValue(content, "OPENCLAW_GATEWAY_TOKEN", token));
  actions.push(`rotated OPENCLAW_GATEWAY_TOKEN in ${path}`);

  if (!(await ctx.runtime.isRunning())) {
    notes.push("the instance is stopped — the next ./clawforge up will carry the new token");
  } else if (typeof ctx.runtime.reconcile !== "function") {
    notes.push(`${ctx.runtime.description} cannot recreate the container — run ./clawforge up to apply the new token`);
  } else {
    actions.push("recreating the gateway so the new token takes effect");
    await ctx.runtime.reconcile();
    await ctx.runtime.waitForHealth();
    actions.push("gateway is healthy on the new token");

    if (typeof ctx.runtime.runningEnvironment === "function") {
      const running = await ctx.runtime.runningEnvironment();
      if (running?.OPENCLAW_GATEWAY_TOKEN === token) {
        actions.push("confirmed: the running container holds the new token — the old one no longer works");
      } else {
        notes.push("could not confirm the running container holds the new token — check by hand before trusting the old one is gone");
      }
    } else {
      notes.push(`${ctx.runtime.description} cannot read the running container's environment, so the new token is in force but unconfirmed here`);
    }
  }

  notes.push("every MCP client paired against the old token needs new credentials: ./clawforge mcp-creds");
  return { phase: "rotate", actions, notes };
}

async function runDoctorLint(ctx: Context): Promise<{ raw: string; error?: string }> {
  try {
    const result = await ctx.runtime.runOneOff("cli", ["doctor", "--lint", "--json", "--non-interactive"], {
      profile: "cli", input: "", allowFailure: true,
    });
    return { raw: result.stdout };
  } catch (error) {
    return { raw: "", error: (error as Error).message };
  }
}

export async function runAudits(ctx: Context): Promise<{ phase: IncidentPhase; security: SecurityAuditReport; doctorLint: { raw: string; error?: string } }> {
  const security = await runSecurityAudit(ctx);
  const doctorLint = await runDoctorLint(ctx);
  const blocking = blockingProblems(security.problems).length;
  const actions = [
    `security gate: ${security.problems.length} finding(s), ${blocking} blocking`,
    doctorLint.error === undefined ? "openclaw doctor --lint recorded" : `openclaw doctor --lint could not run: ${doctorLint.error}`,
  ];
  return { phase: { phase: "audit", actions, notes: [] }, security, doctorLint };
}

/** A short status summary, built from the runtime directly rather than the `status` command
 *  — this module stays a top-level one (like expose/), and top-level modules do not import
 *  from commands/. */
async function captureStatus(ctx: Context): Promise<string> {
  const lines: string[] = [`target: ${ctx.transport.description} / runtime: ${ctx.runtime.description}`];
  let facts: { bindAddress?: string; port?: string } | undefined;
  try {
    facts = await ctx.runtime.runningConnectionFacts?.();
  } catch {
    facts = undefined;
  }
  lines.push(`exposure: ${exposureOneLiner(summarizeExposure(ctx, facts))}`);
  let running = false;
  try {
    running = await ctx.runtime.isRunning();
  } catch {
    running = false;
  }
  lines.push(`running: ${running}`);
  if (running) {
    lines.push(`health: ${await ctx.runtime.health().catch(() => "unknown")}`);
    for (const endpoint of ["healthz", "startupz", "readyz"]) {
      const code = await ctx.runtime.probe(endpoint).catch(() => 0);
      lines.push(`probe ${endpoint}: ${code}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The private, operator-side directory this run's evidence goes into — a sibling of
 *  secrets/, never inside the repository's tracked tree (apps/ is gitignored wholesale). */
function incidentDir(timestamp: string): string {
  return resolve(deploymentDir(), "incidents", timestamp);
}

export async function collectEvidence(
  ctx: Context,
  options: IncidentOptions,
  security: SecurityAuditReport,
  doctorLint: { raw: string; error?: string },
): Promise<IncidentPhase & { archive?: string }> {
  const actions: string[] = [];
  if (options.dryRun) {
    actions.push("would collect a bounded log tail, both audit outputs and a status summary into a private incidents/ directory");
    return { phase: "collect", actions, notes: [] };
  }

  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const dir = incidentDir(timestamp);
  await protectPrivateDirectory(dir);

  const logs = await ctx.runtime.readLogs(options.tail).catch((error: unknown) => `(could not read logs: ${(error as Error).message})`);
  await createPrivateFile(resolve(dir, "logs.txt"), maskSecrets(logs));
  await createPrivateFile(resolve(dir, "security-audit.json"), maskSecrets(JSON.stringify(security, null, 2)));
  await createPrivateFile(resolve(dir, "doctor-lint.json"), maskSecrets(doctorLint.raw === "" ? "{}" : doctorLint.raw));
  await createPrivateFile(resolve(dir, "status.txt"), maskSecrets(await captureStatus(ctx)));

  const files = ["logs.txt", "security-audit.json", "doctor-lint.json", "status.txt"];
  await createPrivateFile(
    resolve(dir, "manifest.json"),
    `${JSON.stringify({ createdAt: new Date().toISOString(), deployment: deploymentName(), files }, null, 2)}\n`,
  );

  actions.push(`collected evidence into ${dir}`);
  return { phase: "collect", actions, notes: [], archive: dir };
}

function render(report: IncidentReport): void {
  log(`incident response for ${report.deployment}${report.dryRun ? " — dry run, nothing changed" : ""}`);
  for (const phase of report.phases) {
    log(phase.phase);
    for (const action of phase.actions) info(action);
    for (const note of phase.notes) warn(note);
  }
  if (report.archive !== undefined) info(`evidence: ${report.archive}`);
}

async function runPhases(ctx: Context, options: IncidentOptions): Promise<IncidentReport> {
  const contain = await containExposure(ctx, options);
  const rotate = await rotateToken(ctx, options);
  const { phase: audit, security, doctorLint } = await runAudits(ctx);
  const collect = await collectEvidence(ctx, options, security, doctorLint);

  return {
    deployment: deploymentName(),
    dryRun: options.dryRun,
    phases: [contain, rotate, audit, { phase: collect.phase, actions: collect.actions, notes: collect.notes }],
    security,
    archive: collect.archive,
  };
}

export async function incident(ctx: Context, args: string[]): Promise<void> {
  const options = parseArgs(args);
  const jsonOnly = args.includes("--json");

  // Before anything else, mutating or not: a plan for an instance that may still be publicly
  // reachable is not a plan worth printing.
  await refuseIfPubliclyExposed(ctx, options);

  const report = options.dryRun
    ? await runPhases(ctx, options)
    : await guarded(ctx, "incident", args, () => runPhases(ctx, options));

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  render(report);
}
