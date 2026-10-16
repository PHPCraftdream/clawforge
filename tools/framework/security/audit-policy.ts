// Pure half of the security gate: parsing OpenClaw's `security audit --json` findings and the
// OC_AUDIT_BLOCK threshold. Knows no check names — which findings exist is OpenClaw's business.

export type AuditSeverity = "critical" | "warn" | "info";
export type AuditBlockPolicy = "critical" | "warn";

export interface ParsedAuditFinding {
  readonly checkId: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: AuditSeverity;
  readonly remediation?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseAuditFindings(value: unknown): readonly ParsedAuditFinding[] | undefined {
  const root = record(value);
  if (root === undefined || !Array.isArray(root.findings)) return undefined;
  const parsed: ParsedAuditFinding[] = [];
  for (const value of root.findings) {
    const finding = record(value);
    if (finding === undefined) return undefined;
    // A severity this version does not know (or "info") is not a foot-gun to act on; skipping
    // it keeps a newer OpenClaw from turning the whole audit into "unavailable".
    if (finding.severity !== "critical" && finding.severity !== "warn") continue;
    if ((finding.checkId !== undefined && typeof finding.checkId !== "string") ||
      (finding.title !== undefined && typeof finding.title !== "string") ||
      (finding.detail !== undefined && typeof finding.detail !== "string") ||
      (finding.remediation !== undefined && typeof finding.remediation !== "string")) return undefined;
    const checkId = typeof finding.checkId === "string" ? finding.checkId : "unknown";
    const title = typeof finding.title === "string" ? finding.title : checkId;
    const detail = typeof finding.detail === "string" ? finding.detail : title;
    if (checkId.trim() === "" || title.trim() === "" || detail.trim() === "") return undefined;
    parsed.push({
      checkId,
      title,
      detail,
      severity: finding.severity,
      ...(typeof finding.remediation === "string" ? { remediation: finding.remediation } : {}),
    });
  }
  return parsed;
}

export interface AuditPolicy {
  readonly block: AuditBlockPolicy;
}

export function parseAuditPolicy(block: string | undefined): AuditPolicy {
  const threshold = block ?? "critical";
  if (threshold !== "critical" && threshold !== "warn") {
    throw new Error("OC_AUDIT_BLOCK must be critical or warn");
  }
  return { block: threshold };
}

export function auditFindingBlocks(severity: AuditSeverity, policy: AuditPolicy): boolean {
  if (severity === "info") return false;
  return policy.block === "warn" || severity === "critical";
}
