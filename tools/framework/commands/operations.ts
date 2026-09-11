// `./clawforge operations [<id>]` — what mutating runs did to this instance.
//
// The journal is written by the commands that change things; this is how anyone reads it.
// Without it the record would be a file on the target that only someone who already knew
// where to look could find, which is not much better than no record at all.

import { log, info, warn, die } from "../log.ts";
import { emit, isCaptured } from "../output.ts";
import { listOperations, readOperation, operationsDir } from "../operations.ts";
import type { Context } from "../context.ts";

const DEFAULT_LIMIT = 10;

export async function operations(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = args.includes("--json");
  let limit = DEFAULT_LIMIT;
  let wanted: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--limit") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      if (Number.isNaN(value) || value <= 0) die("--limit needs a positive number");
      limit = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) die(`unknown argument: ${arg}`);
    wanted = arg;
  }

  if (wanted !== undefined) {
    const record = await readOperation(ctx, wanted);
    if (record === undefined) die(`no operation "${wanted}" recorded in ${operationsDir(ctx)}`);

    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify(record, null, 2)}\n`);
      return;
    }

    log(`${record.id} — ${record.command} on ${record.deployment}`);
    info(`started   ${record.startedAt}`);
    info(`finished  ${record.finishedAt ?? "(never — the run did not reach the end)"}`);
    info(`outcome   ${record.outcome ?? "unknown"}`);
    if (record.configSnapshot !== undefined) {
      info(`snapshot  ${record.configSnapshot}`);
      info(`          put it back with: ./clawforge rollback --operation ${record.id}`);
    }
    for (const step of record.steps) {
      const line = `${step.status.padEnd(8)} ${step.id}${step.detail === undefined ? "" : `  ${step.detail}`}`;
      if (step.status === "failed") warn(line);
      else info(line);
    }
    if (record.note !== undefined) info(record.note);
    return;
  }

  const ids = (await listOperations(ctx)).slice(0, limit);
  const records = [];
  for (const id of ids) {
    const record = await readOperation(ctx, id);
    if (record !== undefined) records.push(record);
  }

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify({ operations: records }, null, 2)}\n`);
    return;
  }

  if (records.length === 0) {
    log("no operations recorded yet");
    info(`they appear in ${operationsDir(ctx)} once something changes the instance`);
    return;
  }

  log(`${records.length} most recent operation(s)`);
  for (const record of records) {
    // An operation with no outcome did not reach its own end — killed, disconnected, or
    // still running. Saying "unknown" is the honest answer and is also the one worth
    // noticing, so it is not dressed up as a result.
    const outcome = record.outcome ?? "unfinished";
    const failed = record.steps.filter((step) => step.status === "failed").length;
    info(`${record.id}  ${outcome}${failed > 0 ? `, ${failed} failed step(s)` : ""}`);
  }
  info("details: ./clawforge operations <id>");
}
