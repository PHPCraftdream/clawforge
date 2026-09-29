// Acceptance evidence is durable, immutable and conservative about what it proves.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checksumOf } from "#framework/service/checksums.ts";
import { listReceipts, readReceipt, writeReceipt, type WriteReceiptInput } from "#framework/set/artifacts/receipt.ts";
import { canonicalJson } from "#framework/set/artifacts/model.ts";
import { check, finish } from "#checks/kit/harness.ts";

async function rejects(name: string, operation: () => Promise<unknown>): Promise<void> {
  try { await operation(); check(name, "did not reject", "rejected"); }
  catch { check(name, "rejected", "rejected"); }
}

const root = await mkdtemp(join(tmpdir(), "clawforge-set-receipt-check-"));
const setId = "a".repeat(64);
const base: Omit<WriteReceiptInput, "checks" | "receiptId" | "selection" | "source"> = {
  setId,
  setName: "demo",
  subjectVerified: true,
  security: { blocking: 0, reasons: [] },
  observations: { frameworkVersion: "0.1.0", openclawVersion: "2026.9", imageDigest: "sha256:" + "b".repeat(64) },
  startedAt: "2026-09-10T10:00:00.000Z",
  finishedAt: "2026-09-10T10:00:02.000Z",
};
const passed = {
  name: "server responds",
  kind: "mcp_responds",
  status: "passed" as const,
  detail: "one tool",
  definition: { kind: "mcp_responds", tools: ["search"] },
};
const skipped = {
  name: "agent answers",
  kind: "agent_answers",
  status: "not-checked" as const,
  detail: "model was not requested",
  definitionHash: checksumOf('{"agent":"demo","kind":"agent_answers"}'),
};

try {
  const complete = await writeReceipt({
    ...base,
    receiptId: "receipt-complete",
    source: "accept",
    selection: { recipes: ["demo"], withModel: false, allRecipes: true },
    checks: { demo: [passed] },
  }, root);
  const roundTrip = await readReceipt(setId, complete.receiptId, root);
  check("write/read preserves the receipt and exact set identity", canonicalJson(roundTrip), canonicalJson(complete));
  check("a complete passing check is verified", complete.verdict, "verified");
  check("a complete passing check has complete coverage", complete.coverage, "complete");
  const unbound = await writeReceipt({
    ...base, receiptId: "receipt-unbound", subjectVerified: false, source: "accept",
    selection: { recipes: ["demo"], withModel: false, allRecipes: true },
    checks: { demo: [passed] },
  }, root);
  check("passing checks without verified artifact/runtime binding are not a verified set", unbound.verdict, "not-verified");
  check("definition is stored as a stable hash, never as the definition", JSON.stringify(complete).includes('"definition":'), false);
  await rejects("a receipt cannot be overwritten", () => writeReceipt({
    ...base,
    receiptId: "receipt-complete",
    source: "accept",
    selection: { recipes: ["demo"], withModel: false, allRecipes: true },
    checks: { demo: [passed] },
  }, root));
  await rejects("selected recipes must exactly match reported checks", () => writeReceipt({
    ...base,
    receiptId: "receipt-missing-recipe",
    source: "accept",
    selection: { recipes: ["demo", "other"], withModel: false, allRecipes: false },
    checks: { demo: [passed] },
  }, root));
  await rejects("selected recipes must be unique", () => writeReceipt({
    ...base,
    receiptId: "receipt-duplicate-recipe",
    source: "accept",
    selection: { recipes: ["demo", "demo"], withModel: false, allRecipes: false },
    checks: { demo: [passed] },
  }, root));
  await rejects("a model result cannot be passed when model use was disabled", () => writeReceipt({
    ...base,
    receiptId: "receipt-illegal-model-result",
    source: "accept",
    selection: { recipes: ["demo"], withModel: false, allRecipes: true },
    checks: { demo: [{ ...passed, kind: "agent_answers", status: "passed" }] },
  }, root));

  const partial = await writeReceipt({
    ...base,
    receiptId: "receipt-partial",
    source: "set-try",
    selection: { recipes: ["demo"], withModel: false, allRecipes: false },
    checks: { demo: [passed] },
  }, root);
  check("a selected recipe pass is not a full-set verification", [partial.coverage, partial.verdict], ["partial", "not-verified"]);

  const modelSkipped = await writeReceipt({
    ...base,
    receiptId: "receipt-model-skipped",
    source: "accept",
    selection: { recipes: ["demo"], withModel: false, allRecipes: true },
    checks: { demo: [passed, skipped] },
  }, root);
  check("model-skipped evidence is partial and not verified", [modelSkipped.coverage, modelSkipped.verdict, modelSkipped.counts.notChecked], ["partial", "not-verified", 1]);

  const empty = await writeReceipt({
    ...base,
    receiptId: "receipt-empty",
    source: "set-try",
    selection: { recipes: [], withModel: false, allRecipes: true },
    checks: {},
  }, root);
  check("empty acceptance is no coverage and not verified", [empty.coverage, empty.verdict], ["none", "not-verified"]);

  const failedResult = await writeReceipt({
    ...base,
    receiptId: "receipt-failed",
    source: "accept",
    selection: { recipes: ["demo"], withModel: true, allRecipes: true },
    checks: { demo: [{ ...passed, status: "failed", detail: "missing tool" }] },
  }, root);
  check("a failed verdict remains failed", [failedResult.coverage, failedResult.verdict], ["complete", "failed"]);

  const inaccessible = await writeReceipt({
    ...base,
    receiptId: "receipt-inaccessible",
    source: "set-try",
    selection: { recipes: ["demo"], withModel: true, allRecipes: true },
    checks: { demo: [{ ...passed, status: "could-not-check", detail: "server exited" }] },
  }, root);
  check("could-not-check evidence cannot be verified", [inaccessible.coverage, inaccessible.verdict], ["partial", "not-verified"]);

  const safeDetails = await writeReceipt({
    ...base,
    receiptId: "receipt-path-detail",
    source: "accept",
    selection: { recipes: ["demo"], withModel: true, allRecipes: true },
    checks: { demo: [{ ...passed, detail: "failed at C:\\Users\\private\\secret.txt" }] },
  }, root);
  check("machine paths are removed from diagnostics", safeDetails.checks.demo[0].detail?.includes("C:\\Users"), false);

  const all = await listReceipts(undefined, root);
  check("list returns all valid receipts", all.length, 8);
  check("list is deterministic when timestamps tie", all[0].receiptId, "receipt-complete");
  check("missing root lists as empty", await listReceipts("c".repeat(64), root), []);

  const blocked = await writeReceipt({
    ...base, receiptId: "receipt-blocked", source: "accept",
    security: { blocking: 1, reasons: ["GATEWAY_PUBLICLY_BOUND"] },
    selection: complete.selection, checks: { demo: [passed] },
  }, root);
  check("a blocking gate preserves passing checks and subject identity without certifying", [blocked.counts.passed, blocked.subjectVerified, blocked.coverage, blocked.verdict], [1, true, "complete", "not-verified"]);
  check("gate outcome survives rereading", await readReceipt(setId, blocked.receiptId, root), blocked);
  const blockedPath = join(root, "sets", "receipts", setId, `${blocked.receiptId}.json`);
  const { contentId: _blockedId, ...blockedPayload } = blocked;
  const forged = { ...blockedPayload, verdict: "verified" };
  await writeFile(blockedPath, JSON.stringify({ ...forged, contentId: checksumOf(canonicalJson(forged)) }));
  await rejects("even rehashed evidence cannot verify a blocked gate", () => readReceipt(setId, blocked.receiptId, root));
  await writeFile(blockedPath, JSON.stringify(blocked));
  const unchecked = await writeReceipt({
    ...base, receiptId: "receipt-no-gate", source: "accept", security: undefined,
    selection: complete.selection, checks: { demo: [passed] },
  }, root);
  check("new accept evidence without a gate never certifies", unchecked.verdict, "not-verified");
  const trial = await writeReceipt({
    ...base, receiptId: "receipt-trial", source: "set-try", security: undefined,
    selection: complete.selection, checks: { demo: [passed] },
  }, root);
  check("trial evidence retains its checks/runtime contract without claiming a gate", [trial.verdict, trial.security], ["verified", undefined]);
  const { security: _security, contentId: _contentId, ...legacyPayload } = complete;
  const legacy = { ...legacyPayload, receiptId: "receipt-legacy" };
  const legacyId = checksumOf(canonicalJson(legacy));
  const legacyPath = join(root, "sets", "receipts", setId, "receipt-legacy.json");
  const legacyText = JSON.stringify({ ...legacy, contentId: legacyId });
  await writeFile(legacyPath, legacyText);
  const old = await readReceipt(setId, "receipt-legacy", root);
  check("legacy verification is not a gate certification", [old.verdict, old.recordedVerdict, old.contentId], ["not-verified", "verified", legacyId]);
  check("legacy read leaves the hashed historical evidence untouched", await readFile(legacyPath, "utf8"), legacyText);
  const { recordedVerdict, contentId: _oldContentId, ...readPayload } = old;
  check("legacy checksum covers its recorded verdict", checksumOf(canonicalJson({ ...readPayload, verdict: recordedVerdict })), legacyId);
  check("listing legacy evidence also downgrades its verdict", (await listReceipts(setId, root)).find((receipt) => receipt.receiptId === "receipt-legacy")?.verdict, "not-verified");
  await writeFile(legacyPath, JSON.stringify({ ...legacy, subjectVerified: false, contentId: legacyId }));
  await rejects("legacy subject tampering is rejected", () => readReceipt(setId, "receipt-legacy", root));
  await rm(legacyPath);
  const rejectedSecurity: unknown[] = [
    null, { blocking: -1, reasons: [] }, { blocking: 0.5, reasons: [] },
    { blocking: 0, reasons: ["GATEWAY_PUBLICLY_BOUND"] },
    { blocking: 1, reasons: [] }, { blocking: 1, reasons: ["unsafe text /private/path"] },
  ];
  for (const security of rejectedSecurity) {
    await rejects("malformed or non-portable gate evidence is rejected", () => writeReceipt({
      ...base, receiptId: "receipt-invalid-gate", source: "accept", security: security as WriteReceiptInput["security"],
      selection: complete.selection, checks: { demo: [passed] },
    }, root));
  }

  await mkdir(join(root, "sets", "receipts", "not-a-set"));
  await rejects("list validates set directory names before reading them", () => listReceipts(undefined, root));

  const path = join(root, "sets", "receipts", setId, "receipt-complete.json");
  await writeFile(path, (await readFile(path, "utf8")).replace('"verdict": "verified"', '"verdict": "failed"'));
  await rejects("tampered content is rejected", () => readReceipt(setId, "receipt-complete", root));
  await rejects("a path-escaping set id is rejected", () => readReceipt("../outside", "receipt-complete", root));
  await rejects("a path-escaping receipt id is rejected", () => readReceipt(setId, "../outside", root));
  await rejects("malformed receipt input is rejected", () => writeReceipt({
    ...base,
    receiptId: "receipt-invalid",
    source: "accept",
    selection: { recipes: ["../outside"], withModel: false, allRecipes: true },
    checks: {},
  }, root));
} finally {
  await rm(root, { recursive: true, force: true });
}

finish("set receipt");
