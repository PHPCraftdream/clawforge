// `./clawforge set receipts` — inspect durable acceptance evidence written for a set.

import { die, info, log } from "../../core/log.ts";
import { emit, isCaptured } from "../../core/output.ts";
import { listReceipts, readReceipt, type AcceptanceReceipt } from "../../set/artifacts/receipt.ts";
import type { Context } from "../../core/context.ts";

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (result === undefined || result.startsWith("--")) die(`${flag} needs a value`);
  if (args.indexOf(flag, index + 1) >= 0) die(`${flag} may be given only once`);
  return result;
}

function validateArgs(args: string[]): { setId?: string; receiptId?: string; json: boolean } {
  const known = new Set(["--set-id", "--receipt", "--json"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!known.has(arg)) die(`unknown argument: ${arg}`);
    if (arg !== "--json") index += 1;
  }
  const setId = value(args, "--set-id");
  const receiptId = value(args, "--receipt");
  if (receiptId !== undefined && setId === undefined) die("--receipt requires --set-id");
  return { setId, receiptId, json: args.includes("--json") };
}

function showLine(receipt: AcceptanceReceipt): void {
  log(`receipt ${receipt.receiptId}`);
  info(`set       ${receipt.setName} (${receipt.setId})`);
  info(`verdict   ${receipt.verdict} (${receipt.coverage} coverage)`);
  info(`source    ${receipt.source}`);
  info(`finished  ${receipt.finishedAt}`);
  info(`checks    ${receipt.counts.passed} passed, ${receipt.counts.failed} failed, ` +
    `${receipt.counts.notChecked} not checked, ${receipt.counts.couldNotCheck} could not check`);
  for (const [recipe, checks] of Object.entries(receipt.checks)) {
    info(`recipe    ${recipe}`);
    for (const check of checks) info(`  ${check.status.padEnd(15)} ${check.name}${check.detail === undefined ? "" : `  ${check.detail}`}`);
  }
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
    log(`${receipt.verdict.padEnd(12)} ${receipt.receiptId}  ${receipt.finishedAt}  ${receipt.setName}`);
  }
}
