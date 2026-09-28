// The security gate `doctor` and `accept` run, and only those two — it execs into the
// instance twice per call, which is why `inspect`/`plan` do not run it on every call.
//
// Two kinds of finding, from places OpenClaw itself cannot see:
//
// In-instance: `openclaw security audit --json` and `openclaw secrets audit --json`, run
// through the same sidecar CLI path every other command uses (openclaw-cli.ts). Their
// severities differ (critical/warn/info vs error/warn/info) and their finding shape differs
// (checkId+title+detail+remediation vs code+message+jsonPath) — normalized here into the
// same two codes doctor/accept read: SECURITY_AUDIT_CRITICAL / SECURITY_AUDIT_WARN. "info"
// findings (attack-surface summaries, OAuth residue) are not foot-guns and are dropped.
//
// Host-side, because the container cannot see its own Docker plumbing:
//   - the gateway published on 0.0.0.0/:: (runningConnectionFacts' bindAddress) — blocking
//     unless the deployment explicitly acknowledges it in config/security-suppressions.json.
//   - on a Linux target with UFW active, Docker's DOCKER-USER chain runs ahead of UFW's own
//     rules, so a published port can be reachable despite what UFW reports. A failed probe
//     (no iptables, no permission) is reported as "could not check", never as fine.
//   - permissions of the deployment's own secret files (.env, secrets/*), reusing
//     unprotectedPrivateFile from private-file.ts rather than re-implementing it.
//
// Suppressions live in config/security-suppressions.json, by upstream checkId/code, each
// with a reason. A suppressed finding is still returned in `findings` (so --json/verbose
// output shows it) but excluded from `problems` — the list doctor/accept actually count.
// Never a secret value anywhere: upstream's own messages avoid them, and jsonPath/file are
// paths, not content.

import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "../core/context.ts";
import { deploymentDir, envFile, secretsDir } from "../runtime/deployment.ts";
import { problem, type Problem, type Severity } from "../service/inspection.ts";
import { openclawCliJson } from "../service/openclaw-cli.ts";
import { summarizeExposure, safeConnectionFacts } from "../expose/status.ts";
import { unprotectedPrivateFile } from "../security/private-file.ts";

export type SecurityFindingSource = "security-audit" | "secrets-audit";

export interface SecurityFinding {
  readonly source: SecurityFindingSource;
  /** security audit's own checkId, or secrets audit's own code — the identity a suppression
   *  matches on. */
  readonly checkId: string;
  readonly severity: Severity;
  /** Human text only, never a secret value — upstream's own contract, kept here. */
  readonly message: string;
  /** security audit's own per-finding remediation, when it gave one — more specific than
   *  the generic "re-run the audit" nextAction, so it wins when present. */
  readonly remediation?: string;
  readonly suppressed: boolean;
  readonly suppressedReason?: string;
}

export interface SecurityAuditReport {
  /** Every in-instance finding, including suppressed ones — what --json/verbose shows. */
  readonly findings: readonly SecurityFinding[];
  /** Non-suppressed in-instance findings plus every host-side finding, ready to merge into
   *  a caller's own problem list. */
  readonly problems: readonly Problem[];
}

interface UpstreamSecurityAuditFinding {
  readonly checkId?: unknown;
  readonly severity?: unknown;
  readonly title?: unknown;
  readonly detail?: unknown;
  readonly remediation?: unknown;
}

interface UpstreamSecretsAuditFinding {
  readonly code?: unknown;
  readonly severity?: unknown;
  readonly message?: unknown;
  readonly jsonPath?: unknown;
}

function mapSecurityAuditSeverity(value: unknown): Severity | undefined {
  if (value === "critical") return "blocking";
  if (value === "warn") return "warning";
  return undefined; // "info" — not a foot-gun, and always present (the attack-surface summary)
}

function mapSecretsAuditSeverity(value: unknown): Severity | undefined {
  if (value === "error") return "blocking";
  if (value === "warn") return "warning";
  return undefined; // "info" — e.g. OAuth credentials out of scope for SecretRef migration
}

async function collectSecurityAuditFindings(ctx: Context): Promise<SecurityFinding[]> {
  const result = await openclawCliJson<{ findings?: UpstreamSecurityAuditFinding[] }>(ctx, ["security", "audit", "--json"]);
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const out: SecurityFinding[] = [];
  for (const entry of findings) {
    const severity = mapSecurityAuditSeverity(entry.severity);
    if (severity === undefined) continue;
    const checkId = typeof entry.checkId === "string" ? entry.checkId : "unknown";
    const message = typeof entry.detail === "string" ? entry.detail : typeof entry.title === "string" ? entry.title : checkId;
    const remediation = typeof entry.remediation === "string" ? entry.remediation : undefined;
    out.push({ source: "security-audit", checkId, severity, message, remediation, suppressed: false });
  }
  return out;
}

async function collectSecretsAuditFindings(ctx: Context): Promise<SecurityFinding[]> {
  const result = await openclawCliJson<{ findings?: UpstreamSecretsAuditFinding[] }>(ctx, ["secrets", "audit", "--json"]);
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const out: SecurityFinding[] = [];
  for (const entry of findings) {
    const severity = mapSecretsAuditSeverity(entry.severity);
    if (severity === undefined) continue;
    const checkId = typeof entry.code === "string" ? entry.code : "unknown";
    const message = typeof entry.message === "string" ? entry.message : checkId;
    const where = typeof entry.jsonPath === "string" && entry.jsonPath !== "" ? ` (${entry.jsonPath})` : "";
    out.push({ source: "secrets-audit", checkId, severity, message: `${message}${where}`, suppressed: false });
  }
  return out;
}

async function tryCollect(
  source: SecurityFindingSource,
  fn: () => Promise<SecurityFinding[]>,
): Promise<SecurityFinding[]> {
  try {
    return await fn();
  } catch (error) {
    // Never silent: a probe that could not even run is itself worth a (warning) finding, not
    // a gap in coverage nobody is told about.
    return [{
      source,
      checkId: "AUDIT_UNAVAILABLE",
      severity: "warning",
      message: `could not run: ${(error as Error).message}`,
      suppressed: false,
    }];
  }
}

// --- suppressions: config/security-suppressions.json --------------------------------------

export interface SecuritySuppression {
  readonly checkId: string;
  readonly reason: string;
}

interface SecuritySuppressions {
  readonly suppressions: SecuritySuppression[];
  readonly acknowledgePublicBind?: { readonly reason: string };
}

function suppressionsFile(): string {
  return resolve(deploymentDir(), "config", "security-suppressions.json");
}

/** Fails closed, like every other config reader here: a file that exists but cannot be
 *  parsed or validated must stop the gate, never read as "nothing suppressed". */
async function readSuppressions(): Promise<SecuritySuppressions> {
  let file: string;
  try {
    file = suppressionsFile();
  } catch {
    return { suppressions: [] }; // no deployment selected
  }

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { suppressions: [] };
    throw new Error(`could not read ${file}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`could not parse ${file}: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must contain an object`);
  }
  const body = parsed as Record<string, unknown>;

  const suppressions: SecuritySuppression[] = [];
  if (body.suppressions !== undefined) {
    if (!Array.isArray(body.suppressions)) throw new Error(`${file}: "suppressions" must be an array`);
    for (const entry of body.suppressions) {
      const checkId = (entry as Record<string, unknown> | null)?.checkId;
      const reason = (entry as Record<string, unknown> | null)?.reason;
      if (typeof checkId !== "string" || checkId.trim() === "" || typeof reason !== "string" || reason.trim() === "") {
        throw new Error(`${file}: each suppression needs a non-empty "checkId" and "reason"`);
      }
      suppressions.push({ checkId, reason });
    }
  }

  let acknowledgePublicBind: { reason: string } | undefined;
  if (body.acknowledgePublicBind !== undefined) {
    const reason = (body.acknowledgePublicBind as Record<string, unknown> | null)?.reason;
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(`${file}: "acknowledgePublicBind" needs a non-empty "reason"`);
    }
    acknowledgePublicBind = { reason };
  }

  return { suppressions, acknowledgePublicBind };
}

function applySuppressions(findings: readonly SecurityFinding[], suppressions: readonly SecuritySuppression[]): SecurityFinding[] {
  const byCheckId = new Map(suppressions.map((entry) => [entry.checkId, entry.reason]));
  return findings.map((finding) => {
    const reason = byCheckId.get(finding.checkId);
    return reason === undefined ? finding : { ...finding, suppressed: true, suppressedReason: reason };
  });
}

// --- host-side: exposure Docker/UFW hide from the instance ---------------------------------

/** Whether `command` resolves on the target. Only the local transport throws for a missing
 *  command; over SSH/WSL it is an ordinary exit 127, indistinguishable from the tool failing. */
async function commandPresent(ctx: Context, command: string): Promise<boolean> {
  const found = await ctx.transport.exec("sh", ["-c", `command -v ${command}`], { allowFailure: true });
  return found.code === 0 && found.stdout.trim() !== "";
}

/** DOCKER-USER runs ahead of UFW's own chain, so a published port can bypass a firewall that
 *  looks active. `undefined` means "does not apply here" (no ufw on this target at all,
 *  confirmed inactive); a Problem otherwise — including the "could not check" case, which
 *  must never read as "fine". */
async function ufwDockerBypassProblem(ctx: Context): Promise<Problem | undefined> {
  if (!(await commandPresent(ctx, "ufw"))) return undefined; // ufw is not installed on this target — the check does not apply

  const status = await ctx.transport.exec("ufw", ["status"], { allowFailure: true });
  const text = `${status.stdout}\n${status.stderr}`;
  if (/Status:\s*inactive/i.test(text)) return undefined;
  if (!/Status:\s*active/i.test(text)) {
    return problem(
      "UFW_DOCKER_BYPASS",
      `could not determine whether UFW is active on ${ctx.runtime.description} (ufw status: ` +
        `${(status.stderr || status.stdout).trim().slice(0, 200) || `exit ${status.code}`}) — the gateway is public, ` +
        "and a published port bypasses an active UFW via the DOCKER-USER chain",
    );
  }

  if (!(await commandPresent(ctx, "iptables"))) {
    return problem("UFW_DOCKER_BYPASS", "UFW is active but iptables is not available on this target — could not check the DOCKER-USER chain");
  }
  const chain = await ctx.transport.exec("iptables", ["-L", "DOCKER-USER", "-n"], { allowFailure: true });
  if (chain.code !== 0) {
    return problem(
      "UFW_DOCKER_BYPASS",
      `UFW is active but the DOCKER-USER chain could not be read (${(chain.stderr || chain.stdout).trim().slice(0, 200) || `exit ${chain.code}`}, ` +
        "commonly needs root) — could not check whether the published port bypasses it",
    );
  }
  if (/\b(DROP|REJECT)\b/.test(chain.stdout)) return undefined; // some restricting rule exists — best-effort "fine"
  return problem("UFW_DOCKER_BYPASS", "UFW is active but DOCKER-USER has no DROP/REJECT rule — Docker publishes the port straight past it, bypassing UFW");
}

/** OpenClaw's findings that exist only because the in-container bind is not loopback
 *  (2026.6.x wording: "on a non-loopback bind", "bind is not loopback"). */
export const CONTAINER_BIND_FINDING = /non-loopback|bind is not loopback/i;

/** True only when the running container's published address is known and loopback. */
export async function publishedLoopbackOnly(ctx: Context): Promise<boolean> {
  const facts = await safeConnectionFacts(ctx);
  if (facts?.bindAddress === undefined) return false;
  return !summarizeExposure(ctx, facts).wildcard && /^(127\.|::1$|localhost$)/.test(facts.bindAddress);
}

async function hostExposureProblems(ctx: Context, acknowledge: { reason: string } | undefined): Promise<Problem[]> {
  const facts = await safeConnectionFacts(ctx);
  if (facts === undefined) return []; // not running, or this runtime cannot introspect it
  const summary = summarizeExposure(ctx, facts);
  if (!summary.wildcard) return [];

  const problems: Problem[] = [
    acknowledge !== undefined
      ? problem(
        "GATEWAY_EXPOSURE_ACKNOWLEDGED",
        `the gateway is published on ${summary.bindAddress}:${summary.port} (every interface) — acknowledged: ${acknowledge.reason}`,
      )
      : problem(
        "GATEWAY_PUBLICLY_BOUND",
        `the gateway is published on ${summary.bindAddress}:${summary.port} — reachable from every interface on this host, not loopback-only`,
      ),
  ];
  const ufw = await ufwDockerBypassProblem(ctx);
  if (ufw !== undefined) problems.push(ufw);
  return problems;
}

// --- host-side: the deployment's own secret files -------------------------------------------

/** .env plus every file under secrets/ — reusing unprotectedPrivateFile rather than a second
 *  implementation of what "owner-only" means on this platform. Local node:fs paths only:
 *  these live beside the deployment, on the operator's own machine, never on the target. */
async function privateFileProblems(): Promise<Problem[]> {
  const candidates: string[] = [];
  try {
    candidates.push(envFile());
    const entries = await readdir(secretsDir(), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isFile()) candidates.push(resolve(secretsDir(), entry.name));
  } catch {
    return []; // no deployment selected
  }

  const problems: Problem[] = [];
  for (const file of candidates) {
    const exists = await access(file).then(() => true, () => false);
    if (!exists) continue;
    const exposure = await unprotectedPrivateFile(file);
    if (exposure !== undefined) problems.push(problem("PRIVATE_FILE_INSECURE", `${file} is not owner-only (${exposure})`));
  }
  return problems;
}

// --- entry point -----------------------------------------------------------------------------

export async function runSecurityAudit(ctx: Context): Promise<SecurityAuditReport> {
  const suppressions = await readSuppressions();

  // A synchronous throw (a test stub with no isRunning at all) is as possible here as a
  // rejection, and either one must degrade to "not running" rather than take doctor/accept
  // down with it — this gate is an add-on, never the reason the command itself fails.
  let running: boolean;
  try {
    running = await ctx.runtime.isRunning();
  } catch {
    running = false;
  }
  // Concurrent: each audit is its own OpenClaw CLI start, seconds apiece.
  const inInstance = running
    ? (await Promise.all([
      tryCollect("security-audit", () => collectSecurityAuditFindings(ctx)),
      tryCollect("secrets-audit", () => collectSecretsAuditFindings(ctx)),
    ])).flat()
    : [];

  // The gateway binds "lan" INSIDE its container so Docker can publish the port; audited from
  // in there it reads as non-loopback. When the host publishes it on loopback only, those
  // findings describe a bind nothing outside this host can reach: reported, not blocking.
  const loopbackOnly = running && await publishedLoopbackOnly(ctx);
  const findings = applySuppressions(inInstance, suppressions.suppressions).map((finding) =>
    loopbackOnly && finding.source === "security-audit" && CONTAINER_BIND_FINDING.test(finding.message)
      ? { ...finding, severity: "warning" as const, message: `${finding.message} (container-internal bind; the host publishes the gateway on loopback only)` }
      : finding
  );
  const inInstanceProblems = findings
    .filter((finding) => !finding.suppressed)
    .map((finding) =>
      problem(
        finding.severity === "blocking" ? "SECURITY_AUDIT_CRITICAL" : "SECURITY_AUDIT_WARN",
        `${finding.source} ${finding.checkId}: ${finding.message}`,
        finding.remediation ?? (finding.source === "security-audit" ? "./clawforge cli security audit --json" : "./clawforge cli secrets audit --json"),
      )
    );

  const hostProblems = running ? await hostExposureProblems(ctx, suppressions.acknowledgePublicBind) : [];
  const fileProblems = await privateFileProblems();

  return {
    findings,
    problems: [...inInstanceProblems, ...hostProblems, ...fileProblems],
  };
}
