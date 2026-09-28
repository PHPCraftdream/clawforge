// `./clawforge incident` — contain, preserve, rotate, audit, collect: OpenClaw's own incident
// runbook, run by the framework because the five steps each need something only it can reach
// (the expose module, the deployment's own .env, the security gate, a bounded log read).
//
// contain: turns off, on the target, only the `tailscale serve` route(s) that proxy to THIS
// gateway (tailscaleGatewayRoutes/tailscaleServeOffCommand in expose/tailscale.ts) — never
// `tailscale serve reset`, which would also drop every other service's own route on that host.
// When the route shape cannot be parsed reliably, nothing is turned off and the operator gets
// the exact manual command instead of a guess. A gateway published on 0.0.0.0/:: refuses the
// whole run first — before the lock, before any mutation — unless --keep-exposure says the
// operator has already judged that acceptable. A contain failure (most commonly: this account
// is not the tailscale operator on the target) is noted in the report, never thrown — rotate
// runs regardless, because leaving a stale token in place is worse than leaving a stale route.
//
// preserve: before rotate recreates the container (and its json-file log with it), a log tail
// and an env-redacted `docker inspect` of the running container go into the evidence directory.
//
// rotate: a fresh OPENCLAW_GATEWAY_TOKEN, generated the same way bootstrap does, written to
// .env and recreated into the running container so it actually takes effect — a repo-env
// value like this one is fixed at container-creation time, restart alone would not apply it.
// Every MCP client paired against the old token needs `./clawforge mcp-creds` again.
//
// audit: the security gate (security/audit.ts) plus `openclaw doctor --lint --json`,
// both informational here — this command reports what they found, it does not gate on it.
//
// collect: a bounded log tail (of whatever is running by then), both audit outputs and a short
// status summary, joined with preserve's own files into ONE manifest naming everything this run
// wrote — into a private, owner-only directory under this deployment's own folder
// (apps/<name>/incidents/<ts>/ — the whole apps/ tree is gitignored, so this is never part of
// the repository's tracked history). Every file goes through maskSecrets() before it is
// written: these are raw captures, not the log/info calls that already carry known secrets
// registered for masking. Written unconditionally, even when rotate or audit failed: a failed
// phase's own IncidentPhaseFailure carries the report so the operator still sees where the
// evidence landed, and the original failure still reaches them afterwards as a non-zero exit.
//
// Mutating — guarded() takes the instance lock, and it is marked destructive. --dry-run prints
// the plan and performs none of it, not even taking the lock, on upgrade's own precedent.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, warn, die, registerSecret, maskSecrets } from "../../../core/io/log.ts";
import { emit, isCaptured } from "../../../core/io/output.ts";
import type { Context } from "../../../core/context.ts";
import { guarded } from "../../../runtime/instance-lock.ts";
import { generateGatewayToken } from "../../../integration/provision.ts";
import { envFile, deploymentDir, deploymentName } from "../../../runtime/deployment.ts";
import { upsertEnvValue } from "../../../security/privacy/private-config.ts";
import { replacePrivateFile, createPrivateFile, protectPrivateDirectory } from "../../../security/privacy/private-file.ts";
import { probeTailscale, tailscaleGatewayRoutes, tailscaleServeOffCommand } from "../expose/tailscale.ts";
import { summarizeExposure, exposureOneLiner } from "../expose/status.ts";
import { safeConnectionFacts } from "../../../runtime/runtime.ts";
import { runSecurityAudit, type SecurityAuditReport } from "../../../security/audit.ts";
import { blockingProblems } from "../../../service/inspection.ts";
import type { CommandArgument } from "../../../core/app.ts";
import { parseDeclaredArgs } from "../../../core/arguments.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "../../interface/groups/shared-arguments.ts";

/** Drives both incident's own parser and its openclawCommands declaration. */
export const INCIDENT_ARGUMENTS: CommandArgument[] = [
  { name: "dry-run", description: "Print the plan without changing anything", kind: "flag" },
  { name: "keep-exposure", description: "Proceed even though the gateway is published on every interface", kind: "flag" },
  { name: "tail", description: "Lines of log to collect (default 500)", kind: "option", valueName: "n" },
  { name: "json", description: "Emit the report as JSON", kind: "flag" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

interface IncidentOptions {
  readonly dryRun: boolean;
  readonly keepExposure: boolean;
  readonly tail: string;
}

export interface IncidentPhase {
  readonly phase: "contain" | "preserve" | "rotate" | "audit" | "collect";
  readonly actions: readonly string[];
  readonly notes: readonly string[];
}

export interface IncidentReport {
  readonly deployment: string;
  readonly dryRun: boolean;
  readonly phases: readonly IncidentPhase[];
  /** Absent when audit itself threw before producing one — the report still reaches the
   *  operator, with the audit phase's own note naming why. */
  readonly security?: SecurityAuditReport;
  /** Where the evidence was written, absent in --dry-run. */
  readonly archive?: string;
}

/** Thrown by runPhases when rotate or audit fails. Carries the report built so far — contain,
 *  preserve and collect all still ran, so the operator sees exactly what this run did before
 *  the original failure reaches them as a non-zero exit (incident() rethrows `cause`
 *  unchanged). */
export class IncidentPhaseFailure extends Error {
  readonly report: IncidentReport;
  constructor(report: IncidentReport, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "IncidentPhaseFailure";
    this.report = report;
  }
}

function parseArgs(args: string[]): IncidentOptions {
  const parsed = parseDeclaredArgs(INCIDENT_ARGUMENTS, args);
  const tail = parsed.tail === undefined
    ? "500"
    : !/^\d+$/.test(parsed.tail as string) ? die("--tail needs a number of lines") : parsed.tail as string;
  return { dryRun: parsed["dry-run"] === true, keepExposure: parsed["keep-exposure"] === true, tail };
}

/** Refuses the whole run while the gateway may still be reachable from outside this host —
 *  checked before anything else, mutating or not: a plan printed for an instance still
 *  publicly bound would be worth nothing. `undefined` facts (not running, or this runtime
 *  cannot introspect it) has nothing to refuse on. */
export async function refuseIfPubliclyExposed(ctx: Context, options: IncidentOptions): Promise<void> {
  const facts = await safeConnectionFacts(ctx);
  if (facts === undefined) return;
  const summary = summarizeExposure(ctx, facts);
  if (!summary.wildcard) return;

  if (!options.keepExposure) {
    die(
      `the gateway is published on ${summary.bindAddress}:${summary.port} — reachable from every interface on ` +
        "this host. Refusing to run an incident response while it may still be reachable from outside. To fix " +
        `it: set OC_BIND_ADDRESS=127.0.0.1 in ${envFile()}, then run ./clawforge up to recreate the gateway on ` +
        "loopback. Or pass --keep-exposure if this exposure is already handled elsewhere (a reverse proxy, a " +
        "security group, ...).",
    );
  }
  warn(`proceeding with the gateway published on ${summary.bindAddress}:${summary.port} — --keep-exposure was given`);
}

/** Turns off only the tailscale serve route(s) that proxy to THIS gateway. Never throws: a
 *  contain failure (most commonly, this account is not the tailscale operator on the target)
 *  is reported as a note, because leaving a stale exposure noted is better than skipping
 *  rotate over it — rotate runs regardless of what happens here. */
export async function containExposure(ctx: Context, options: IncidentOptions): Promise<IncidentPhase> {
  const actions: string[] = [];
  const notes: string[] = [];

  const probe = await probeTailscale(ctx);
  if (!probe.present || !probe.loggedIn) {
    actions.push(`tailscale: ${probe.detail} — nothing to turn off`);
    return { phase: "contain", actions, notes };
  }

  const routes = await tailscaleGatewayRoutes(ctx, ctx.settings.gatewayPort);
  if (routes === undefined) {
    notes.push(
      "could not reliably parse `tailscale serve status --json` on the target — turned nothing off. If this " +
        "gateway is exposed through tailscale serve, turn it off yourself: `tailscale serve --https=443 off` " +
        "(match the port `tailscale serve status` shows), or `tailscale serve reset` to clear every route on " +
        "that host, including any that belong to other services.",
    );
    return { phase: "contain", actions, notes };
  }
  if (routes.length === 0) {
    actions.push("tailscale serve has no route to this gateway — nothing to turn off");
    return { phase: "contain", actions, notes };
  }

  for (const route of routes) {
    const command = tailscaleServeOffCommand(route);
    const label = `${route.hostPort}${route.mountPoint}`;
    if (options.dryRun) {
      actions.push(`would run: ${command.join(" ")} (turn off tailscale serve route ${label})`);
      continue;
    }
    const result = await ctx.transport.exec(command[0], command.slice(1), { allowFailure: true });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      const hint = /access denied|operator/i.test(detail)
        ? " — this account is likely not the tailscale operator on the target; run `sudo tailscale set " +
          "--operator=$USER` there, then re-run incident to finish containment"
        : "";
      notes.push(`could not turn off tailscale serve route ${label} (exit ${result.code}): ${detail}${hint}`);
      continue;
    }
    actions.push(`ran: ${command.join(" ")} (turned off route ${label})`);
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

  const token = generateGatewayToken();
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
  const facts = await safeConnectionFacts(ctx);
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

/** Saves a log tail and an env-redacted `docker inspect` of the container running RIGHT NOW, before
 *  rotate's reconcile() can recreate it and take the old one's json-file log with it. Never
 *  throws: a snapshot failure is noted, not fatal — rotate must still run. */
export async function preserveEvidence(
  ctx: Context,
  options: IncidentOptions,
  dir: string,
): Promise<IncidentPhase & { files: readonly string[] }> {
  const actions: string[] = [];
  const notes: string[] = [];

  if (options.dryRun) {
    actions.push("would preserve a log tail and `docker inspect` of the current container before rotate recreates it");
    return { phase: "preserve", actions, notes, files: [] };
  }

  let snapshot: { logs: string; inspect: string } | undefined;
  try {
    snapshot = await ctx.runtime.captureIncidentSnapshot?.(options.tail);
  } catch (error) {
    notes.push(`could not snapshot the running container before rotate: ${(error as Error).message}`);
    return { phase: "preserve", actions, notes, files: [] };
  }
  if (snapshot === undefined) {
    notes.push(`${ctx.runtime.description} has nothing running to snapshot, or cannot introspect it — no pre-rotate evidence to preserve`);
    return { phase: "preserve", actions, notes, files: [] };
  }

  await protectPrivateDirectory(dir);
  await createPrivateFile(resolve(dir, "pre-rotate-logs.txt"), maskSecrets(snapshot.logs));
  await createPrivateFile(resolve(dir, "pre-rotate-inspect.json"), maskSecrets(snapshot.inspect));
  actions.push(`preserved the pre-rotate container's log tail and inspect into ${dir}`);
  return { phase: "preserve", actions, notes, files: ["pre-rotate-logs.txt", "pre-rotate-inspect.json"] };
}

export async function collectEvidence(
  ctx: Context,
  options: IncidentOptions,
  dir: string,
  preservedFiles: readonly string[],
  security: SecurityAuditReport | undefined,
  doctorLint: { raw: string; error?: string } | undefined,
): Promise<IncidentPhase & { archive?: string }> {
  const actions: string[] = [];
  if (options.dryRun) {
    actions.push("would collect a bounded log tail, both audit outputs and a status summary into a private incidents/ directory");
    return { phase: "collect", actions, notes: [] };
  }

  await protectPrivateDirectory(dir);

  const logs = await ctx.runtime.readLogs(options.tail).catch((error: unknown) => `(could not read logs: ${(error as Error).message})`);
  await createPrivateFile(resolve(dir, "logs.txt"), maskSecrets(logs));
  await createPrivateFile(resolve(dir, "security-audit.json"), maskSecrets(JSON.stringify(security ?? { findings: [], problems: [] }, null, 2)));
  await createPrivateFile(resolve(dir, "doctor-lint.json"), maskSecrets(doctorLint === undefined || doctorLint.raw === "" ? "{}" : doctorLint.raw));
  await createPrivateFile(resolve(dir, "status.txt"), maskSecrets(await captureStatus(ctx)));

  const files = [...preservedFiles, "logs.txt", "security-audit.json", "doctor-lint.json", "status.txt"];
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

/** contain → preserve → rotate → audit → collect. Preserve and collect always run and always
 *  write their evidence — collect's write is unconditional even when rotate or audit failed —
 *  so a phase failure is carried on the thrown IncidentPhaseFailure rather than swallowed: the
 *  operator sees the full report AND the original error still reaches them as a non-zero exit
 *  (incident() below). */
export async function runPhases(ctx: Context, options: IncidentOptions): Promise<IncidentReport> {
  const contain = await containExposure(ctx, options).catch((error: unknown): IncidentPhase => ({
    phase: "contain",
    actions: [],
    notes: [`contain failed unexpectedly: ${(error as Error).message} — rotate proceeds regardless`],
  }));

  const dir = incidentDir(new Date().toISOString().replaceAll(/[:.]/g, "-"));
  const preserve = await preserveEvidence(ctx, options, dir);

  let rotate: IncidentPhase;
  let rotateError: unknown;
  try {
    rotate = await rotateToken(ctx, options);
  } catch (error) {
    rotateError = error;
    rotate = { phase: "rotate", actions: [], notes: [`rotate failed: ${(error as Error).message}`] };
  }

  let audit: IncidentPhase;
  let security: SecurityAuditReport | undefined;
  let doctorLint: { raw: string; error?: string } | undefined;
  let auditError: unknown;
  try {
    const result = await runAudits(ctx);
    audit = result.phase;
    security = result.security;
    doctorLint = result.doctorLint;
  } catch (error) {
    auditError = error;
    audit = { phase: "audit", actions: [], notes: [`audit failed: ${(error as Error).message}`] };
  }

  const collect = await collectEvidence(ctx, options, dir, preserve.files, security, doctorLint);

  const report: IncidentReport = {
    deployment: deploymentName(),
    dryRun: options.dryRun,
    phases: [
      contain,
      { phase: preserve.phase, actions: preserve.actions, notes: preserve.notes },
      rotate,
      audit,
      { phase: collect.phase, actions: collect.actions, notes: collect.notes },
    ],
    security,
    archive: collect.archive,
  };

  const failure = rotateError ?? auditError;
  if (failure !== undefined) throw new IncidentPhaseFailure(report, failure);
  return report;
}

export async function incident(ctx: Context, args: string[]): Promise<void> {
  const options = parseArgs(args);
  const jsonOnly = args.includes("--json");

  // Before anything else, mutating or not: a plan for an instance that may still be publicly
  // reachable is not a plan worth printing.
  await refuseIfPubliclyExposed(ctx, options);

  let report: IncidentReport;
  try {
    report = options.dryRun
      ? await runPhases(ctx, options)
      : await guarded(ctx, "incident", args, () => runPhases(ctx, options));
  } catch (error) {
    if (!(error instanceof IncidentPhaseFailure)) throw error;
    // Evidence is already on disk (preserve/collect ran unconditionally) — the report is shown
    // so the operator knows where, and then the ORIGINAL failure propagates unchanged.
    if (jsonOnly || isCaptured()) emit(`${JSON.stringify(error.report, null, 2)}\n`);
    else render(error.report);
    throw error.cause;
  }

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  render(report);
}
