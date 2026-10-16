import { check, finish } from "#checks/kit/harness.ts";
import { auditFindingBlocks, parseAuditFindings, parseAuditPolicy } from "#framework/security/audit-policy.ts";

check("audit policy defaults critical and promotes warnings only under warn", (() => {
  const critical = parseAuditPolicy(undefined);
  const warn = parseAuditPolicy("warn");
  return [auditFindingBlocks("critical", critical), auditFindingBlocks("warn", critical), auditFindingBlocks("warn", warn), auditFindingBlocks("info", warn)];
})(), [true, false, true, false]);

check("audit policy rejects invalid values", ["off", "", "WARN", "invalid"].map((value) => {
  try { parseAuditPolicy(value); return false; } catch { return true; }
}), [true, true, true, true]);

check("security audit parser validates findings and tolerates extra fields", [
  parseAuditFindings({ findings: [{ checkId: "GATEWAY_AUTH", title: "Gateway auth", detail: "Authentication is disabled", severity: "warn", remediation: "Enable authentication", upstreamExtra: true }] })?.length,
  ...["critical", "warn", "info"].map((severity) => parseAuditFindings({ findings: [{ checkId: "X", title: "X", detail: "detail", severity }] }) !== undefined),
  parseAuditFindings({ findings: [{ checkId: "X", title: "X", detail: "", severity: "warn" }] }) !== undefined,
  parseAuditFindings({ findings: [{ checkId: "X", title: "X", detail: "detail", severity: "bogus" }] })?.length,
  parseAuditFindings({}) !== undefined,
  parseAuditFindings({ findings: [{ checkId: "X", severity: "info" }] })?.length,
], [1, true, true, true, false, 0, false, 0]);

finish("audit policy");
