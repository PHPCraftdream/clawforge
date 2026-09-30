// `./clawforge set receipts` — inspect durable acceptance evidence written for a set.

import { die, info, log } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { listReceipts, readReceipt, type AcceptanceReceipt } from "#src/set/artifacts/receipt.ts";
import type { Context } from "#src/core/context.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";

/** The slice of `set`'s declaration `receipts`'s own argv actually uses. */
export const SET_RECEIPTS_ARGUMENTS: CommandArgument[] = [
  { name: "set-id", description: "With receipts: filter by immutable set id", kind: "option", valueName: "id" },
  { name: "receipt", description: "With receipts: show this receipt; requires --set-id", kind: "option", valueName: "id" },
  { name: "json", description: "Emit the manifest and its id, or the findings, as JSON", kind: "flag" },
];

function validateArgs(args: string[]): { setId?: string; receiptId?: string; json: boolean } {
  const parsed = parseDeclaredArgs(SET_RECEIPTS_ARGUMENTS, args);
  const setId = parsed["set-id"] as string | undefined;
  const receiptId = parsed.receipt as string | undefined;
  if (receiptId !== undefined && setId === undefined) die("--receipt requires --set-id");
  return { setId, receiptId, json: parsed.json === true };
}

function showLine(receipt: AcceptanceReceipt): void {
  log(`receipt ${receipt.receiptId}`);
  info(`set       ${receipt.setName} (${receipt.setId})`);
  info(`verdict   ${receipt.verdict} (${receipt.coverage} coverage)`);
  info(`source    ${receipt.source}`);
  info(`security  ${securitySummary(receipt)}`);
  if (receipt.recordedVerdict !== undefined) info(`recorded  ${receipt.recordedVerdict} (legacy verdict without gate evidence)`);
  info(`finished  ${receipt.finishedAt}`);
  info(`checks    ${receipt.counts.passed} passed, ${receipt.counts.failed} failed, ` +
    `${receipt.counts.notChecked} not checked, ${receipt.counts.couldNotCheck} could not check`);
  for (const [recipe, checks] of Object.entries(receipt.checks)) {
    info(`recipe    ${recipe}`);
    for (const check of checks) info(`  ${check.status.padEnd(15)} ${check.name}${check.detail === undefined ? "" : `  ${check.detail}`}`);
  }
}

function securitySummary(receipt: AcceptanceReceipt): string {
  if (receipt.security === undefined) {
    return receipt.source === "set-try" ? "not run; trial checks and runtime only" : "not recorded";
  }
  const reasons = receipt.security.reasons.length === 0 ? "" : `: ${receipt.security.reasons.join(", ")}`;
  return `${receipt.security.blocking} blocking${reasons}`;
}

/** The persistence root is deploymentDir(), while the optional root in the persistence API
 *  keeps that API independently testable. This command intentionally has no runtime calls. */
export async function setReceipts(_ctx: Context, args: string[]): Promise<void> {
  const { setId, receiptId, json } = validateArgs(args);
  if (receiptId !== undefined && setId !== undefined) {
    const receipt = await readReceipt(setId, receiptId);
    if (json || isCaptured()) emit(`${JSON.stringify(receipt, null, 2)}\n`);
    else showLine(receipt);
    return;
  }
  const receipts = await listReceipts(setId);
  if (json || isCaptured()) {
    emit(`${JSON.stringify(receipts, null, 2)}\n`);
    return;
  }
  if (receipts.length === 0) {
    log("no acceptance receipts");
    return;
  }
  for (const receipt of receipts) {
    log(`${receipt.verdict.padEnd(12)} ${receipt.receiptId}  ${receipt.finishedAt}  ${receipt.setName}  (security: ${securitySummary(receipt)})`);
  }
}
